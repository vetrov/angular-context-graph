import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedInputs, hash, stableJson } from './inputs.mjs';
import { normalizeGraph, SCHEMA_VERSION, EXTRACTOR_VERSION, workspaceId, idFor } from './model.mjs';
import { discoverUnits } from './units.mjs';

const sourceDir = fileURLToPath(new URL('.', import.meta.url));
export const extractorFingerprint = () =>
	hash(
		fs
			.readdirSync(sourceDir)
			.filter((n) => n.endsWith('.mjs'))
			.sort()
			.map((n) => fs.readFileSync(path.join(sourceDir, n), 'utf8'))
			.join('\n'),
	);
export function workerExtract(project, { signal, timeoutMs = 120000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = fork(new URL('./index-worker.mjs', import.meta.url), [], {
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			serialization: 'advanced',
			execArgv: [],
			signal,
		});
		let errors = '';
		let received = false;
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Extraction timed out for ${project}`));
		}, timeoutMs);
		child.stderr.on('data', (data) => {
			errors = (errors + data).slice(-8000);
		});
		child.once('message', (result) => {
			received = true;
			clearTimeout(timer);
			result.error ? reject(new Error(result.error)) : resolve(result);
		});
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			if (code !== 0 || !received)
				reject(new Error(`Compiler worker failed (${code}): ${errors}`));
		});
		child.send({ project });
	});
}

export function acquireWriter(file) {
	const lock = `${file}.writer-lock`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(lock, 'wx');
			fs.writeFileSync(
				fd,
				JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
			);
			fs.closeSync(fd);
			return () => fs.unlinkSync(lock);
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
			let owner;
			try {
				owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
			} catch {
				throw new Error(
					'Index writer lock is unreadable; verify no writer is active before removing it.',
				);
			}
			try {
				process.kill(owner.pid, 0);
				throw new Error('Another index writer is active.');
			} catch (probe) {
				if (probe.code === 'ESRCH') fs.unlinkSync(lock);
				else throw probe;
			}
		}
	}
	throw new Error('Unable to acquire index writer');
}

export async function indexWorkspace(
	store,
	{
		workspace = process.cwd(),
		projects = [],
		full = false,
		signal,
		onProgress = () => {},
		extractUnit = workerExtract,
	} = {},
) {
	const root = fs.realpathSync(workspace);
	const wid = workspaceId(root);
	const release = acquireWriter(store.file);
	const startedAt = new Date().toISOString();
	const started = performance.now();
	const fingerprint = extractorFingerprint();
	let currentUnit = null;
	try {
		store.job(wid, { status: 'running', pid: process.pid, startedAt });
		const discovery = discoverUnits(root, projects);
		discovery.units.sort((a, b) => a.id.localeCompare(b.id));
		if (!discovery.units.length)
			throw new Error(
				`No supported compilation units. ${discovery.missingUnits.map((u) => u.reason).join(' ')}`,
			);
		const previous = store.current(wid);
		const cached = new Map((previous ? store.units(previous.id) : []).map((u) => [u.id, u]));
		const units = [];
		let rebuilt = 0;
		let reused = 0;
		for (const unit of discovery.units) {
			currentUnit = unit.id;
			signal?.throwIfAborted();
			const old = cached.get(unit.id);
			if (
				!full &&
				old &&
				previous.extractorFingerprint === fingerprint &&
				!changedInputs(old.raw.indexInputs).length
			) {
				units.push({ ...old, normalized: undefined });
				reused++;
				onProgress({ unit: unit.name, status: 'reused' });
				continue;
			}
			onProgress({ unit: unit.name, status: 'extracting' });
			const { graph, memoryBytes } = await extractUnit(unit.project, { signal });
			if (discovery.discoveryFile)
				graph.indexInputs.push({
					kind: 'file',
					file: discovery.discoveryFile,
					state: discovery.discoveryState,
				});
			if (changedInputs(graph.indexInputs).length)
				throw new Error('Inputs changed during extraction; retry indexing.');
			units.push({
				...unit,
				raw: graph,
				metrics: {
					elapsedMs: graph.elapsedMs,
					memoryBytes,
					sourceFiles: graph.typescript.sourceFiles,
				},
			});
			rebuilt++;
		}
		for (const unit of units)
			if (changedInputs(unit.raw.indexInputs).length)
				throw new Error('Inputs changed before snapshot publication; retry indexing.');
		const sid = idFor('snapshot', [
			wid,
			fingerprint,
			units.map((u) => ({ id: u.id, raw: { ...u.raw, elapsedMs: undefined } })),
			discovery.missingUnits,
		]);
		for (const unit of units) unit.normalized = normalizeGraph(unit.raw, unit, root, sid);
		for (const unit of units)
			if (changedInputs(unit.raw.indexInputs).length)
				throw new Error(
					'Inputs changed while evidence was being normalized; retry indexing.',
				);
		if (extractorFingerprint() !== fingerprint)
			throw new Error('Extractor code changed during indexing; retry indexing.');
		const manifest = {
			schemaVersion: SCHEMA_VERSION,
			id: sid,
			snapshotId: sid,
			workspaceId: wid,
			workspace: root,
			createdAt: new Date().toISOString(),
			extractorVersion: EXTRACTOR_VERSION,
			extractorFingerprint: fingerprint,
			unitIds: units.map((u) => u.id),
			missingUnits: discovery.missingUnits,
			discoveryMode: projects.length ? 'explicit' : 'angular-build',
			analysisPolicy:
				'strictTemplates analysis; original fine-grained overrides retained; no emit',
			coverage: units.flatMap((u) => u.normalized.coverage),
			complete: false,
			metrics: {
				elapsedMs: Math.round(performance.now() - started),
				rebuilt,
				reused,
				entities: units.reduce((n, u) => n + u.normalized.entities.length, 0),
				observations: units.reduce((n, u) => n + u.normalized.observations.length, 0),
			},
		};
		store.publish(manifest, units);
		store.job(wid, {
			status: 'complete',
			startedAt,
			finishedAt: new Date().toISOString(),
			snapshotId: sid,
			rebuilt,
			reused,
		});
		return { ...manifest, metrics: { ...manifest.metrics, rebuilt, reused } };
	} catch (error) {
		store.job(wid, {
			status: 'failed',
			startedAt,
			finishedAt: new Date().toISOString(),
			unitId: currentUnit,
			error: error.message,
		});
		throw error;
	} finally {
		release();
	}
}
