import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { GraphStore } from '../src/store.mjs';
import { QueryService } from '../src/queries.mjs';
import { query } from '../src/api.mjs';

const { values } = parseArgs({
	options: { workspace: { type: 'string' }, db: { type: 'string' } },
});
if (!values.workspace || !values.db)
	throw new Error('Pass --workspace and --db for an already indexed Workplace Hub workspace.');
const store = new GraphStore(values.db);
try {
	const service = new QueryService(store, values.workspace);
	const status = service.get_index_status();
	const manifest = store.snapshot(status.snapshotId);
	const unit = store.units(manifest.id)[0];
	const graph = unit.normalized;
	const nodes = new Map(graph.entities.map((n) => [n.id, n]));
	const page = graph.entities.find(
		(n) => n.kind === 'Component' && n.name === 'SupplierEditPage' && !n.external,
	);
	assert.ok(page, 'SupplierEditPage source component');
	const save = graph.entities.find(
		(n) => n.kind === 'Method' && n.name === 'save' && n.owner === page.id,
	);
	const request = graph.entities.find(
		(n) =>
			n.kind === 'InjectionRequest' &&
			n.classOwner === page.id &&
			nodes.get(n.token)?.name === 'SupplierFacade',
	);
	assert.ok(save && request, 'save method and facade injection request');
	const resolution = graph.resolutions.find(
		(r) => r.request === request.id && r.status === 'selected',
	);
	assert.ok(resolution);
	const registration = nodes.get(resolution.providers[0]);
	const target = registration.target;
	const provider = query(service, 'resolve_provider', {
		requestId: request.id,
		contextId: resolution.context,
	});
	assert.equal(provider.results[0].status, 'selected');
	const dependency = query(service, 'explain_dependency', {
		sourceId: save.id,
		targetId: target,
		contextId: resolution.context,
		maxDepth: 8,
		types: [
			'REFERENCES',
			'HAS_INJECTION_REQUEST',
			'RESOLVES_IN',
			'SELECTS_PROVIDER',
			'USES_CLASS',
		],
	});
	assert.ok(dependency.results.length, 'handler to facade provider path');
	const template = graph.observations.find(
		(e) => e.type === 'TEMPLATE_CALLS' && e.from === page.id && e.to === save.id,
	);
	assert.ok(template);
	const span = query(service, 'get_source_evidence', { id: template.occurrenceId });
	assert.equal(span.results[0].sourceSpan, 'save');
	const unknown = graph.coverage.find((c) => c.familyId === 'A06');
	assert.equal(unknown.unrepresented, 402);
	console.log(
		JSON.stringify(
			{
				schemaVersion: 2,
				snapshotId: manifest.id,
				freshness: status.freshness.status,
				versions: unit.raw.versions,
				metrics: manifest.metrics,
				page: page.name,
				handler: save.name,
				providerStatus: provider.results[0].status,
				implementation: nodes.get(target)?.name,
				templateEvidence: span.results[0].location,
				path: dependency.results[0].evidence.map((e) => ({
					type: e.type,
					from: nodes.get(e.from)?.name ?? nodes.get(e.from)?.kind,
					to: nodes.get(e.to)?.name ?? nodes.get(e.to)?.kind,
					sourceSpan: e.sourceSpan,
					location: e.location,
					targetResolution: e.targetResolution,
					semantics: e.semantics,
				})),
				unrepresentedTemplateOccurrences: unknown.unrepresented,
				runtimeObserved: false,
			},
			null,
			2,
		),
	);
} finally {
	store.close();
}
