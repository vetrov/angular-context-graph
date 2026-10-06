import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { GraphStore } from '../src/store.mjs';
import { QueryService } from '../src/queries.mjs';
import { query } from '../src/api.mjs';

const { values } = parseArgs({
	options: {
		workspace: { type: 'string' },
		db: { type: 'string' },
	},
});
if (!values.workspace || !values.db)
	throw new Error('Pass --workspace and --db for an already indexed Workplace Hub workspace.');
const file = path.resolve(values.db);
if (fs.existsSync(`${file}-wal`))
	throw new Error(
		'Close active database connections first: this read-only benchmark requires a checkpointed database without a WAL.',
	);
const before = fs.statSync(file);
const uri = pathToFileURL(file);
uri.searchParams.set('mode', 'ro');
uri.searchParams.set('immutable', '1');
// Avoid the normal store constructor's schema setup; this script never writes the database.
const store = Object.create(GraphStore.prototype);
store.file = file;
store.db = new DatabaseSync(uri.href, { readOnly: true });
try {
	const service = new QueryService(store, values.workspace);
	const measurements = [];
	const measure = (name, args = {}, label = name) => {
		const start = performance.now();
		const result = query(service, name, args);
		measurements.push({
			name: label,
			elapsedMs: Math.round(performance.now() - start),
			jsonChars: JSON.stringify(result).length,
			resultCount: result.results.length,
			truncated: result.truncated,
			freshness: result.freshness.status,
			checkMode: result.freshness.checkMode,
		});
		return result;
	};
	const di = measure(
		'explain_injection',
		{ name: 'RequestListService', component: 'Requests' },
		'explain_injection: cold',
	);
	const result = di.results[0];
	assert.equal(result.providerScopes[0].scope.owner.name, 'Requests');
	assert.deepEqual(
		result.dependencies.map((d) => d.token.name),
		['HttpClient', 'ListQueryState', 'DemoContext'],
	);
	const state = result.dependencies.find((d) => d.token.name === 'ListQueryState');
	assert.equal(state.status, 'selected');
	assert.equal(state.sharedWith[0].consumer.name, 'Requests');
	const kind = state.providerDependencies[0].dependencies.find(
		(d) => d.token.name === 'LIST_KIND',
	);
	assert.equal(kind.providers[0].value, 'requests');
	assert.equal(result.interpretation.runtimeObserved, false);
	assert.equal(di.truncated, false);
	measure(
		'explain_injection',
		{ name: 'RequestListService', component: 'Requests' },
		'explain_injection: warm',
	);
	measure('get_index_status');
	measure('find_entities', { text: 'RequestListService', limit: 10 });
	measure(
		'find_entities',
		{ text: 'RequestListService', kinds: ['InjectionRequest'], limit: 20 },
		'find_entities: injection requests',
	);
	measure('get_relationships', { id: result.entity.id, direction: 'both' });
	measure('resolve_provider', {
		requestId: state.requestId,
		contextId: result.context.id,
		unitIds: di.unitIds,
	});
	const after = fs.statSync(file);
	assert.equal(after.mtimeMs, before.mtimeMs);
	assert.equal(after.size, before.size);
	console.log(
		JSON.stringify(
			{
				verifiedAt: new Date().toISOString(),
				node: process.version,
				snapshotId: di.snapshotId,
				unitSelection: di.unitSelection,
				measurements,
				proof: {
					providedBy: 'Requests',
					dependencies: result.dependencies.map((d) => ({
						token: d.token.name,
						status: d.status,
						location: d.location,
					})),
					queryProviderStatus: state.status,
					listKind: kind.providers[0].value,
					sharing: state.sharedWith[0].staticResult,
					runtimeObserved: false,
				},
				indexRebuilt: false,
				databaseModified: false,
				interpretation:
					'Local query timings and JSON character counts, not model tokens or end-to-end agent latency. Stale snapshots remain usable as historical evidence.',
			},
			null,
			2,
		),
	);
} finally {
	store.close();
}
