import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const stableJson = (value) => JSON.stringify(sortValue(value));
function sortValue(value) {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortValue(value[key])]),
		);
	return value;
}

export function inputState(kind, file) {
	try {
		if (kind === 'file') return hash(fs.readFileSync(file));
		if (kind === 'directory') return directoryState(fs.readdirSync(file));
		if (kind === 'realpath') return fs.realpathSync(file);
		return fs.existsSync(file);
	} catch {
		return null;
	}
}

function directoryState(entries) {
	return stableJson(
		entries
			.filter(
				(name) =>
					name !== '.angular-context-graph' &&
					!/\.sqlite(?:-wal|-shm)?$|\.writer-lock$/.test(name),
			)
			.sort(),
	);
}

export function createInputTracker() {
	const records = new Map();
	const record = (kind, file, state = inputState(kind, file)) => {
		file = path.resolve(file);
		const key = `${kind}:${file}`;
		if (records.has(key) && records.get(key).state !== state)
			throw new Error(`Input changed while the compiler was reading it: ${file}`);
		records.set(key, { kind, file, state });
	};
	function wrap(host) {
		return new Proxy(host, {
			get(target, property) {
				const method = target[property];
				if (typeof method !== 'function') return method;
				return (...args) => {
					const result = method.apply(target, args);
					if (property === 'readFile' && typeof result === 'string')
						record('file', args[0], hash(result));
					if (['exists', 'fileExists', 'directoryExists'].includes(property))
						record('exists', args[0], result);
					if (property === 'readdir')
						record('directory', args[0], directoryState([...result]));
					if (property === 'realpath') record('realpath', args[0], result);
					return result;
				};
			},
		});
	}
	return {
		wrap,
		record,
		records: () =>
			[...records.values()].sort((a, b) =>
				`${a.kind}:${a.file}`.localeCompare(`${b.kind}:${b.file}`),
			),
	};
}

export function changedInputs(inputs) {
	return inputs
		.filter((input) => inputState(input.kind, input.file) !== input.state)
		.map((input) => ({ kind: input.kind, file: input.file }));
}
