import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphStore } from '../src/store.mjs';
import { indexWorkspace } from '../src/indexer.mjs';
import { QueryService } from '../src/queries.mjs';

const base =
	process.env.SEMANTIC_PROJECT ??
	fileURLToPath(new URL('../fixtures/tsconfig.json', import.meta.url));
test('target-version worker persists original evidence and unknowns, and warm/full indexing agree', async () => {
	const root = path.dirname(base);
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'angular-version-index-'));
	const store = new GraphStore(path.join(scratch, 'index.sqlite'));
	try {
		const options = {
			workspace: root,
			projects: [path.join(root, 'core-relations/tsconfig.json')],
		};
		const initial = await indexWorkspace(store, options);
		const unit = store.units(initial.id)[0];
		assert.ok(['20.3.33', '21.2.25', '22.2.1'].includes(unit.raw.versions.core));
		assert.equal(
			unit.normalized.observations.filter(
				(o) => o.to && o.endpointModel === 'prototype-compatibility',
			).length,
			unit.raw.edges.length,
		);
		assert.ok(unit.normalized.issues.some((i) => i.reason.includes('Opaque provider')));
		assert.ok(unit.normalized.observations.some((e) => e.type === 'SELECTS_PROVIDER'));
		const warm = await indexWorkspace(store, options);
		assert.equal(warm.id, initial.id);
		assert.equal(warm.metrics.reused, 1);
		const full = await indexWorkspace(store, { ...options, full: true });
		assert.equal(full.id, initial.id);
		assert.equal(new QueryService(store, root).get_index_status().freshness.status, 'fresh');
	} finally {
		store.close();
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});
