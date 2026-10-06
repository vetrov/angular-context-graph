import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { GraphStore } from '../src/store.mjs';
import { indexWorkspace, acquireWriter } from '../src/indexer.mjs';
import { QueryService } from '../src/queries.mjs';
import { query, RESPONSE_SCHEMA } from '../src/api.mjs';
import { validateGraph } from '../src/model.mjs';
import { discoverUnits } from '../src/units.mjs';
import { createInputTracker } from '../src/inputs.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'angular-index-tests-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const coreStore = new GraphStore(path.join(scratch, 'core.sqlite'));
after(() => coreStore.close());
const core = await indexWorkspace(coreStore, {
	workspace: repo,
	projects: ['fixtures/core-relations/tsconfig.json'],
});
const unit = coreStore.units(core.id)[0];
const normalized = unit.normalized;
const raw = unit.raw;
const service = new QueryService(coreStore, repo);
const nodes = new Map(normalized.entities.map((n) => [n.id, n]));
const named = (name, kind) =>
	normalized.entities.find((n) => n.name === name && (!kind || n.kind === kind));
const method = (owner, name) =>
	normalized.entities.find(
		(n) => n.kind === 'Method' && n.name === name && nodes.get(n.owner)?.name === owner,
	);
const workerRequest = normalized.entities.find(
	(n) =>
		n.kind === 'InjectionRequest' &&
		nodes.get(n.classOwner)?.name === 'Leaf' &&
		nodes.get(n.owner)?.name === 'worker',
);
const contexts = normalized.entities.filter(
	(n) => n.kind === 'InjectorContext' && n.component === named('Leaf', 'Component').id,
);
const view = contexts.find(
	(n) =>
		n.relation === 'view' &&
		nodes.get(n.parent)?.component === named('ScopeBox', 'Component').id,
);
const content = contexts.find(
	(n) =>
		n.relation === 'content' &&
		nodes.get(n.parent)?.component === named('ScopeBox', 'Component').id,
);

test('persists all legacy edges, original spans, independent uncertainty dimensions and all family coverage', () => {
	assert.equal(
		normalized.observations.filter((o) => o.endpointModel === 'prototype-compatibility' && o.to)
			.length,
		raw.edges.length,
	);
	assert.equal(normalized.coverage.length, 26);
	assert.ok(normalized.coverage.every((c) => c.status !== 'complete'));
	assert.ok(
		normalized.entities
			.filter((n) => n.layer === 'occurrence')
			.every((n) => n.familyId && 'ownerSymbolId' in n && 'siteId' in n && 'contextId' in n),
	);
	assert.equal(normalized.coverage.find((c) => c.familyId === 'A17').status, 'unsupported');
	for (const edge of normalized.observations.filter((o) => o.to)) {
		assert.ok(nodes.has(edge.from) && nodes.has(edge.to));
		assert.ok(edge.occurrenceId);
		assert.ok(edge.evidenceIds.length);
		assert.equal(
			edge.sourceSpan,
			fs
				.readFileSync(edge.location.file, 'utf8')
				.slice(
					edge.location.start,
					Math.min(edge.location.end, edge.location.start + 1000),
				),
		);
	}
	const hook = normalized.observations.find((e) => e.type === 'FRAMEWORK_INVOKES');
	assert.equal(hook.targetResolution, 'resolved');
	assert.equal(hook.semantics, 'possible-runtime-flow');
	const candidate = normalized.observations.find((e) => e.type === 'QUERY_MAY_MATCH');
	assert.equal(candidate.targetResolution, 'candidate-set');
	assert.ok(normalized.issues.some((i) => i.reason.includes('Opaque provider')));
	assert.ok(
		normalized.observations.some((o) => o.to === null && o.targetResolution === 'unresolved'),
	);
});
test('restart and deterministic export/import round trip preserve the graph', () => {
	const reopened = new GraphStore(coreStore.file);
	const imported = new GraphStore(path.join(scratch, 'imported.sqlite'));
	try {
		const bundle = reopened.exportSnapshot(core.id);
		imported.importSnapshot(bundle);
		assert.deepEqual(imported.exportSnapshot(core.id), bundle);
		assert.equal(new QueryService(reopened, repo).get_index_status().snapshotId, core.id);
	} finally {
		reopened.close();
		imported.close();
	}
});
test('unchanged indexing reuses compiler units and snapshot identities', async () => {
	const warm = await indexWorkspace(coreStore, {
		workspace: repo,
		projects: ['fixtures/core-relations/tsconfig.json'],
		extractUnit: () => {
			throw new Error('Should not compile unchanged unit');
		},
	});
	assert.equal(warm.id, core.id);
	assert.equal(warm.metrics.rebuilt, 0);
	assert.equal(warm.metrics.reused, 1);
});
test('provider answers retain distinct view and projected-content selections and traces', () => {
	for (const [context, expected] of [
		[view, 'ViewWorker'],
		[content, 'LocalWorker'],
	]) {
		const answer = query(service, 'resolve_provider', {
			requestId: workerRequest.id,
			contextId: context.id,
		});
		assert.equal(answer.results[0].status, 'selected');
		assert.equal(nodes.get(answer.results[0].providers[0].registration.target).name, expected);
		assert.ok(answer.results[0].trace.length);
		assert.ok(answer.results[0].evidence.length);
		assert.equal(answer.results[0].runtimeObserved, false);
	}
	assert.throws(
		() => query(service, 'resolve_provider', { requestId: workerRequest.id }),
		/contextId/,
	);
});
test('opaque lookup regions keep candidates and unresolved results', () => {
	const uncertain = normalized.resolutions.find(
		(r) => r.request === workerRequest.id && r.status === 'unresolved',
	);
	assert.ok(uncertain);
	const answer = query(service, 'resolve_provider', {
		requestId: workerRequest.id,
		contextId: uncertain.context,
	});
	assert.equal(answer.results[0].status, 'unresolved');
	assert.match(answer.results[0].reason, /Unknown/);
});
test('dependency paths join template handler, injected field, contextual provider and implementation', () => {
	const answer = query(service, 'explain_dependency', {
		sourceId: method('Leaf', 'save').id,
		targetId: named('ViewWorker', 'Class').id,
		contextId: view.id,
		maxDepth: 8,
	});
	assert.ok(answer.results.length);
	const evidence = answer.results[0].evidence;
	for (const type of [
		'REFERENCES',
		'HAS_INJECTION_REQUEST',
		'RESOLVES_IN',
		'SELECTS_PROVIDER',
		'USES_CLASS',
	])
		assert.ok(
			evidence.some((e) => e.type === type),
			type,
		);
	assert.ok(evidence.every((e) => e.compilationUnitId === unit.id));
});
test('reverse impact returns exact contract uses and bounded traversal remains explicit', () => {
	const answer = query(service, 'analyze_impact', {
		id: named('ScopeBox', 'Component').id,
		maxDepth: 1,
	});
	assert.ok(answer.results.some((r) => r.evidence[0].type === 'TEMPLATE_USES'));
	assert.equal(answer.boundedTraversal, true);
	const none = query(service, 'explain_dependency', {
		sourceId: method('Leaf', 'unused').id,
		targetId: named('Root', 'Component').id,
		maxDepth: 1,
	});
	assert.deepEqual(none.results, []);
	assert.match(none.interpretation, /does not prove/);
});
test('pagination cursors bind to snapshot and filters and cannot silently cross queries', () => {
	const first = query(service, 'find_entities', { kinds: ['Method'], limit: 2 });
	assert.equal(first.results.length, 2);
	assert.ok(first.nextCursor);
	const second = query(service, 'find_entities', {
		kinds: ['Method'],
		limit: 2,
		cursor: first.nextCursor,
	});
	assert.notEqual(second.results[0].id, first.results[0].id);
	assert.throws(
		() =>
			query(service, 'find_entities', {
				kinds: ['Property'],
				limit: 2,
				cursor: first.nextCursor,
			}),
		/Cursor/,
	);
	assert.throws(() => query(service, 'find_entities', { limit: 0 }));
});
test('framework/template/host-only usage excludes symbols; no incoming usage stays blocked by coverage', () => {
	let answer = query(service, 'find_unused_candidates', { limit: 200 });
	const results = [...answer.results];
	while (answer.nextCursor) {
		answer = query(service, 'find_unused_candidates', {
			limit: 200,
			cursor: answer.nextCursor,
		});
		results.push(...answer.results);
	}
	const unused = results.find((r) => r.entity.id === method('Leaf', 'unused').id);
	assert.equal(unused.status, 'blocked-by-coverage');
	assert.ok(unused.blockingFamilies.includes('A17'));
	const hook = results.find((r) => r.entity.id === method('Leaf', 'ngOnInit').id);
	assert.equal(hook.status, 'excluded');
	assert.ok(hook.incomingEvidence.some((e) => e.type === 'FRAMEWORK_INVOKES'));
	RESPONSE_SCHEMA.parse(answer);
});
test('schema and span corruption cannot replace a published snapshot', () => {
	const broken = structuredClone(raw);
	broken.edges[0].to = 'missing';
	assert.throws(() => validateGraph(broken), /Dangling/);
	const badSpan = structuredClone(raw);
	badSpan.edges[0].location.end = Number.MAX_SAFE_INTEGER;
	assert.throws(() => validateGraph(badSpan), /Invalid source span/);
	const bundle = coreStore.exportSnapshot(core.id);
	bundle.manifest.id = 'corrupt-snapshot';
	for (const u of bundle.units) {
		for (const n of u.normalized.entities) n.snapshotId = 'corrupt-snapshot';
		for (const e of u.normalized.observations) e.snapshotId = 'corrupt-snapshot';
	}
	bundle.units[0].normalized.observations[0].to = 'missing';
	assert.throws(() => coreStore.importSnapshot(bundle), /FOREIGN KEY/);
	assert.equal(coreStore.current(core.workspaceId).id, core.id);
});
test('single writer lock rejects concurrent writers', () => {
	const release = acquireWriter(coreStore.file);
	try {
		assert.throws(() => acquireWriter(coreStore.file), /writer is active/);
	} finally {
		release();
	}
});
test('conflicting compiler reads cannot be combined into one input snapshot', () => {
	const file = path.join(scratch, 'changing.ts');
	fs.writeFileSync(file, 'export const value=1;');
	const tracker = createInputTracker();
	const host = tracker.wrap({ readFile: (file) => fs.readFileSync(file, 'utf8') });
	host.readFile(file);
	fs.writeFileSync(file, 'export const value=2;');
	assert.throws(() => host.readFile(file), /Input changed/);
});

function temporaryWorkspace(name) {
	const root = path.join(scratch, name);
	fs.mkdirSync(root);
	fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
	fs.writeFileSync(
		path.join(root, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ES2022',
				module: 'ESNext',
				moduleResolution: 'bundler',
				strict: true,
				experimentalDecorators: true,
				skipLibCheck: true,
				types: [],
				noEmit: true,
			},
			include: ['*.ts'],
		}),
	);
	fs.writeFileSync(
		path.join(root, 'page.ts'),
		`import {Component} from '@angular/core'; @Component({standalone:true,templateUrl:'./page.html'}) export class Page {save(){} unused(){}}`,
	);
	fs.writeFileSync(path.join(root, 'page.html'), '<button (click)="save()">Save</button>');
	return root;
}
test('a killed writer retains its snapshot, reports interruption and recovers its lock', async () => {
	const root = temporaryWorkspace('crash');
	const db = path.join(root, '.angular-context-graph/index.sqlite');
	const store = new GraphStore(db);
	try {
		const initial = await indexWorkspace(store, {
			workspace: root,
			projects: ['tsconfig.json'],
		});
		const source = `import {GraphStore} from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
import {indexWorkspace} from ${JSON.stringify(new URL('../src/indexer.mjs', import.meta.url).href)};
const store=new GraphStore(${JSON.stringify(db)});
await indexWorkspace(store,{workspace:${JSON.stringify(root)},projects:['tsconfig.json'],full:true,onProgress:()=>process.stdout.write('ready'),extractUnit:()=>new Promise(()=>setInterval(()=>{},1000))});`;
		const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		try {
			await once(child.stdout, 'data');
			const exited = once(child, 'exit');
			child.kill('SIGKILL');
			await exited;
		} finally {
			child.kill('SIGKILL');
		}
		const status = new QueryService(store, root).get_index_status();
		assert.equal(status.snapshotId, initial.id);
		assert.equal(status.freshness.status, 'stale');
		assert.equal(status.freshness.lastJob.status, 'interrupted');
		const recovered = await indexWorkspace(store, {
			workspace: root,
			projects: ['tsconfig.json'],
		});
		assert.equal(recovered.id, initial.id);
		assert.equal(recovered.metrics.reused, 1);
		assert.equal(new QueryService(store, root).get_index_status().freshness.status, 'fresh');
	} finally {
		store.close();
	}
});
test('HTML changes remove old edges; incremental output equals a full rebuild; failures preserve evidence', async () => {
	const root = temporaryWorkspace('incremental');
	const store = new GraphStore(path.join(root, '.angular-context-graph/index.sqlite'));
	const queries = new QueryService(store, root);
	try {
		const initial = await indexWorkspace(store, {
			workspace: root,
			projects: ['tsconfig.json'],
		});
		const original = store
			.units(initial.id)[0]
			.normalized.observations.find((e) => e.type === 'TEMPLATE_CALLS');
		assert.ok(original);
		fs.writeFileSync(path.join(root, 'page.html'), '<p>No handler</p>');
		assert.equal(queries.get_index_status().freshness.status, 'stale');
		assert.equal(
			queries.get_source_evidence({ id: original.id }).results[0].sourceSpan,
			'save',
		);
		const incremental = await indexWorkspace(store, {
			workspace: root,
			projects: ['tsconfig.json'],
		});
		assert.notEqual(incremental.id, initial.id);
		assert.equal(incremental.metrics.rebuilt, 1);
		assert.equal(
			store
				.units(incremental.id)[0]
				.normalized.observations.some((e) => e.type === 'TEMPLATE_CALLS'),
			false,
		);
		const clean = await indexWorkspace(store, {
			workspace: root,
			projects: ['tsconfig.json'],
			full: true,
		});
		assert.equal(clean.id, incremental.id);
		fs.writeFileSync(path.join(root, 'page.html'), '<div [invalidProperty]="1"></div>');
		await assert.rejects(
			() => indexWorkspace(store, { workspace: root, projects: ['tsconfig.json'] }),
			/compilation failed/,
		);
		assert.equal(queries.get_index_status().snapshotId, clean.id);
		assert.equal(queries.get_index_status().freshness.lastJob.status, 'failed');
		fs.writeFileSync(path.join(root, 'page.html'), '<p>No handler</p>');
		await indexWorkspace(store, { workspace: root, projects: ['tsconfig.json'] });
		assert.equal(queries.get_index_status().freshness.status, 'fresh');
		fs.writeFileSync(path.join(root, 'new.ts'), 'export const newValue=1;');
		const added = await indexWorkspace(store, { workspace: root, projects: ['tsconfig.json'] });
		assert.equal(added.metrics.rebuilt, 1);
		assert.ok(queries.find_entities({ text: 'newValue' }).results.length);
		fs.unlinkSync(path.join(root, 'new.ts'));
		const removed = await indexWorkspace(store, {
			workspace: root,
			projects: ['tsconfig.json'],
		});
		assert.equal(removed.id, clean.id);
		fs.renameSync(path.join(root, 'page.ts'), path.join(root, 'renamed.ts'));
		const renamed = await indexWorkspace(store, {
			workspace: root,
			projects: ['tsconfig.json'],
		});
		assert.notEqual(renamed.id, removed.id);
		assert.ok(
			queries.find_entities({ text: 'Page' }).results[0].location.file.endsWith('renamed.ts'),
		);
	} finally {
		store.close();
	}
});
test('config and lockfile changes invalidate units even when source is unchanged', async () => {
	const root = temporaryWorkspace('config');
	const store = new GraphStore(path.join(root, '.angular-context-graph/index.sqlite'));
	try {
		await indexWorkspace(store, { workspace: root, projects: ['tsconfig.json'] });
		fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
		const next = await indexWorkspace(store, { workspace: root, projects: ['tsconfig.json'] });
		assert.equal(next.metrics.rebuilt, 1);
		fs.writeFileSync(
			path.join(root, 'tsconfig.json'),
			fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8') + '\n',
		);
		const config = await indexWorkspace(store, {
			workspace: root,
			projects: ['tsconfig.json'],
		});
		assert.equal(config.metrics.rebuilt, 1);
	} finally {
		store.close();
	}
});
test('build variants retain identity and unsupported replacements remain visible', () => {
	const root = temporaryWorkspace('discovery');
	fs.writeFileSync(
		path.join(root, 'angular.json'),
		JSON.stringify({
			projects: {
				app: {
					architect: {
						build: {
							builder: '@angular/build:application',
							options: { tsConfig: 'tsconfig.json' },
							configurations: {
								development: { optimization: false },
								production: {
									fileReplacements: [{ replace: 'a.ts', with: 'b.ts' }],
								},
							},
						},
					},
				},
			},
		}),
	);
	const discovery = discoverUnits(root);
	assert.equal(discovery.units.length, 2);
	assert.notEqual(discovery.units[0].id, discovery.units[1].id);
	assert.equal(discovery.missingUnits[0].status, 'unsupported');
	assert.match(discovery.missingUnits[0].reason, /replacements/);
});
test('overlapping units share declarations without deduplicating observations or crossing unit paths', async () => {
	const root = temporaryWorkspace('overlap');
	fs.writeFileSync(
		path.join(root, 'variant.json'),
		JSON.stringify({ extends: './tsconfig.json' }),
	);
	const store = new GraphStore(path.join(root, '.angular-context-graph/index.sqlite'));
	try {
		const manifest = await indexWorkspace(store, {
			workspace: root,
			projects: ['tsconfig.json', 'variant.json'],
		});
		const qs = new QueryService(store, root);
		const page = qs.find_entities({ text: 'Page', kinds: ['Component'] }).results[0];
		assert.equal(page.unitIds.length, 2);
		const calls = qs.get_relationships({ id: page.id, types: ['TEMPLATE_CALLS'] }).results;
		assert.equal(calls.length, 2);
		assert.notEqual(calls[0].id, calls[1].id);
		const filtered = qs.get_relationships({
			id: page.id,
			types: ['TEMPLATE_CALLS'],
			unitIds: [manifest.unitIds[0]],
		});
		assert.equal(filtered.results.length, 1);
	} finally {
		store.close();
	}
});
