import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, stableJson } from './inputs.mjs';

export const SCHEMA_VERSION = 2;
export const EXTRACTOR_VERSION = 'proven-core-import:1';
export const idFor = (kind, value) => `${kind}:${hash(stableJson(value)).slice(0, 32)}`;
export const workspaceId = (root) => idFor('workspace', fs.realpathSync(root));
export const unitId = (unit) => idFor('unit', unit);
const families = {
	A02: ['ANGULAR_IMPORTS', 'DECLARES', 'ANGULAR_EXPORTS'],
	A03: ['TEMPLATE_USES', 'USES_DIRECTIVE', 'INSTANTIATES_DECLARATION', 'PLACES_DECLARATION'],
	A04: ['BINDS_INPUT', 'LISTENS_OUTPUT'],
	A05: ['USES_PIPE'],
	A06: ['TEMPLATE_CALLS', 'TEMPLATE_REFERENCES'],
	A08: ['HOST_REFERENCES', 'HOST_CALLS', 'HAS_HOST_BEHAVIOR'],
	A09: ['DECLARES_QUERY', 'LOCATES', 'READS_AS', 'QUERY_MAY_MATCH'],
	A10: ['DECLARES_SLOT', 'PROJECTS_TO'],
	A11: ['HAS_INJECTION_REQUEST', 'REQUESTS_TOKEN'],
	A12: [
		'DECLARES_SCOPE',
		'REGISTERS',
		'PROVIDES_TOKEN',
		'USES_CLASS',
		'ALIASES_TOKEN',
		'USES_FACTORY',
		'USES_VALUE',
	],
	A13: [
		'PARENT_INJECTOR',
		'RESOLVES_IN',
		'SELECTS_PROVIDER',
		'CANDIDATE_PROVIDER',
		'ALIAS_SELECTS_PROVIDER',
		'ALIAS_CANDIDATE_PROVIDER',
	],
	A14: ['BOOTSTRAPS', 'MOUNTS_SCOPE'],
	A15: [
		'HAS_ROUTE',
		'LAZY_LOADS',
		'RENDERS',
		'GUARDED_BY',
		'RESOLVED_BY',
		'MOUNTS_ROUTE',
		'MOUNT_OF',
		'ROUTE_PLACEMENT',
	],
	A18: ['FRAMEWORK_INVOKES'],
};
export const familyFor = (type) =>
	Object.entries(families).find(([, types]) => types.includes(type))?.[0] ??
	(type === 'OWNS_TEMPLATE' ? 'A01' : 'A26');
const contextKinds = new Set(['Application', 'InjectorContext', 'RouteMount']);
const occurrenceKinds = new Set([
	'ElementSite',
	'Query',
	'InjectionRequest',
	'InjectionResolution',
	'ProviderRegistration',
	'RouteDefinition',
	'ProjectionSlot',
	'HostBinding',
	'HostListener',
	'ScopeDefinition',
]);
const layerFor = (kind) =>
	contextKinds.has(kind) ? 'context' : occurrenceKinds.has(kind) ? 'occurrence' : 'declaration';
const familyForKind = (kind) =>
	({
		ElementSite: 'A03',
		Query: 'A09',
		InjectionRequest: 'A11',
		InjectionResolution: 'A13',
		ProviderRegistration: 'A12',
		RouteDefinition: 'A15',
		ProjectionSlot: 'A10',
		HostBinding: 'A08',
		HostListener: 'A08',
		ScopeDefinition: 'A12',
		Application: 'A14',
		InjectorContext: 'A13',
		RouteMount: 'A15',
	})[kind] ?? 'A26';
const calls = new Set(['CALLS', 'CONSTRUCTS', 'TEMPLATE_CALLS', 'HOST_CALLS']);
const runtime = new Set([
	'FRAMEWORK_INVOKES',
	'QUERY_MAY_MATCH',
	'PROJECTS_TO',
	'BOOTSTRAPS',
	'RENDERS',
	'LAZY_LOADS',
	'ROUTE_PLACEMENT',
	'PLACES_DECLARATION',
	'INSTANTIATES_DECLARATION',
]);
const reference = new Set([
	'REFERENCES',
	'TEMPLATE_REFERENCES',
	'HOST_REFERENCES',
	'IMPORTS_SYMBOL',
	'REEXPORTS_SYMBOL',
]);
const contextual = new Set(families.A13);
const endpointKinds = {
	TEMPLATE_USES: [['Component'], ['Component']],
	USES_DIRECTIVE: [['Component'], ['Directive']],
	BINDS_INPUT: [['Component'], ['Input']],
	LISTENS_OUTPUT: [['Component'], ['Output']],
	USES_PIPE: [['Component'], ['Pipe']],
	REQUESTS_TOKEN: [['InjectionRequest'], ['Token']],
	PROVIDES_TOKEN: [['ProviderRegistration'], ['Token']],
	SELECTS_PROVIDER: [['InjectionResolution'], ['ProviderRegistration']],
	CANDIDATE_PROVIDER: [['InjectionResolution'], ['ProviderRegistration']],
	RESOLVES_IN: [['InjectionRequest'], ['InjectionResolution']],
	PARENT_INJECTOR: [['InjectorContext'], ['InjectorContext']],
};

export function validateGraph(graph) {
	const nodes = new Map();
	const texts = new Map();
	const checkLocation = (location, allowEmpty = false) => {
		if (!location || location.file.includes('.ngtypecheck.') || !path.isAbsolute(location.file))
			throw new Error('Invalid original source location');
		if (!texts.has(location.file))
			texts.set(location.file, fs.readFileSync(location.file, 'utf8'));
		const text = texts.get(location.file);
		if (
			!Number.isInteger(location.start) ||
			!Number.isInteger(location.end) ||
			location.start < 0 ||
			location.end > text.length ||
			location.end < location.start ||
			(!allowEmpty && location.end === location.start)
		)
			throw new Error(`Invalid source span: ${stableJson(location)}`);
		const lines = text.slice(0, location.start).split('\n');
		if (location.line !== lines.length || location.column !== lines.at(-1).length + 1)
			throw new Error(`Incorrect source coordinates: ${location.file}:${location.start}`);
	};
	for (const node of graph.nodes) {
		if (nodes.has(node.id)) throw new Error(`Duplicate declaration identity: ${node.id}`);
		nodes.set(node.id, node);
		checkLocation(node.location, true);
	}
	for (const edge of graph.edges) {
		if (!nodes.has(edge.from) || !nodes.has(edge.to))
			throw new Error(`Dangling ${edge.type} endpoint`);
		checkLocation(edge.location);
		const kinds = endpointKinds[edge.type];
		if (
			kinds &&
			(!kinds[0].includes(nodes.get(edge.from).kind) ||
				!kinds[1].includes(nodes.get(edge.to).kind))
		)
			throw new Error(`Invalid ${edge.type} endpoint kind`);
	}
	return texts;
}

// Central import registry keeps Angular/TS identity shared and unit-local placements separate.
// The legacy mapping is persisted; unchanged inputs retain IDs. Move/rename migration is deferred.
export function normalizeGraph(graph, unit, root, snapshotId) {
	const texts = validateGraph(graph);
	const workspace = workspaceId(root);
	const uid = unit.id;
	const logical = (value) => value.replaceAll(`${root}${path.sep}`, 'workspace:/');
	const migration = new Map(
		graph.nodes.map((node) => [
			node.id,
			idFor(layerFor(node.kind), [
				workspace,
				layerFor(node.kind) === 'declaration' ? null : uid,
				logical(node.id),
			]),
		]),
	);
	const mapValue = (value) => {
		if (typeof value === 'string') return migration.get(value) ?? value;
		if (Array.isArray(value)) return value.map(mapValue);
		if (value && typeof value === 'object')
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, mapValue(item)]),
			);
		return value;
	};
	const location = (loc) =>
		loc
			? {
					...loc,
					uri: pathToFileURL(loc.file).href,
					logicalUri: logical(loc.file),
					realPath: fs.realpathSync(loc.file),
				}
			: null;
	const envelope = {
		workspaceId: workspace,
		compilationUnitId: uid,
		snapshotId,
		extractorVersion: EXTRACTOR_VERSION,
		versions: graph.versions,
	};
	const entities = graph.nodes.map((node) => ({
		...mapValue(node),
		legacyId: node.id,
		layer: layerFor(node.kind),
		familyId: familyForKind(node.kind),
		ownerSymbolId: migration.get(node.classOwner ?? node.owner) ?? null,
		siteId: node.site ? idFor('site', [uid, node.site]) : null,
		contextId: migration.get(node.context) ?? null,
		external: Boolean(
			node.external ||
			node.location.file.endsWith('.d.ts') ||
			path.relative(root, node.location.file).startsWith(`..${path.sep}`),
		),
		roles: [
			...new Set(
				[
					node.angularRole === 'Injectable' ? 'Service' : node.angularRole,
					...(['Component', 'Directive', 'Pipe'].includes(node.kind) ? [node.kind] : []),
				].filter(Boolean),
			),
		],
		location: location(node.location),
		...envelope,
	}));
	const byId = new Map(entities.map((n) => [n.id, n]));
	const observations = [];
	const issues = [];
	function observe(edge, more = {}) {
		const mapped = mapValue(edge);
		const oid = idFor('observation', [uid, edge, more]);
		const occurrenceId = idFor('occurrence', [uid, oid]);
		const source = texts.get(edge.location.file) ?? fs.readFileSync(edge.location.file, 'utf8');
		const sourceSpan = source.slice(
			edge.location.start,
			Math.min(edge.location.end, edge.location.start + 1000),
		);
		const candidate = edge.type.includes('CANDIDATE') || edge.type === 'QUERY_MAY_MATCH';
		const semantics = calls.has(edge.type)
			? 'compile-time-call'
			: contextual.has(edge.type)
				? 'contextual-resolution'
				: runtime.has(edge.type)
					? 'possible-runtime-flow'
					: reference.has(edge.type)
						? 'reference'
						: 'declaration';
		const siteId = edge.site ? idFor('site', [uid, edge.site]) : null;
		const record = {
			...mapped,
			...envelope,
			id: oid,
			familyId: familyFor(edge.type),
			location: location(edge.location),
			occurrenceId,
			ownerSymbolId: mapped.owner ?? mapped.from,
			siteId,
			contextId: mapped.context ?? null,
			targetResolution: candidate ? 'candidate-set' : 'resolved',
			semantics,
			legacyProvenance: edge.provenance,
			provenance:
				edge.provenance === 'angular-compiler'
					? 'angular-template-checker'
					: edge.provenance === 'angular-api-rule'
						? 'api-rule'
						: edge.provenance,
			conditions: [
				...(semantics === 'possible-runtime-flow'
					? [{ activation: 'possible', runtimeObserved: false }]
					: []),
				...(mapped.context ? [{ contextId: mapped.context, modeledPlacement: true }] : []),
			],
			candidateIds: candidate ? [mapped.to] : [],
			external: byId.get(mapped.to)?.external ?? false,
			evidenceIds: [oid],
			derivationRule: null,
			endpointModel: 'prototype-compatibility',
			sourceSpan,
			sourceSpanTruncated: edge.location.end - edge.location.start > 1000,
			...more,
		};
		observations.push(record);
		entities.push({
			...envelope,
			id: occurrenceId,
			kind: calls.has(edge.type)
				? 'ExpressionSite'
				: ['BINDS_INPUT', 'LISTENS_OUTPUT'].includes(edge.type)
					? 'BindingSite'
					: edge.type === 'USES_PIPE'
						? 'PipeSite'
						: 'SourceOccurrence',
			layer: 'occurrence',
			familyId: record.familyId,
			ownerSymbolId: record.ownerSymbolId,
			owner: mapped.from,
			siteId,
			contextId: record.contextId,
			location: record.location,
			observationId: oid,
		});
		return record;
	}
	for (const edge of graph.edges) observe(edge);
	for (const template of graph.templates ?? []) {
		const tid = idFor('template', [uid, template.owner, template.location.file]);
		entities.push({
			...envelope,
			id: tid,
			kind: 'Template',
			layer: 'occurrence',
			familyId: 'A01',
			ownerSymbolId: migration.get(template.owner),
			siteId: null,
			contextId: null,
			owner: migration.get(template.owner),
			inline: template.inline,
			location: location(template.location),
		});
		if (template.location.start < template.location.end)
			observe(
				{
					type: 'OWNS_TEMPLATE',
					from: template.owner,
					to: tid,
					location: template.location,
					provenance: 'angular-metadata',
					confidence: 'exact',
				},
				{ endpointModel: 'normalized' },
			);
	}
	const addIssue = (familyId, issue, category) => {
		const loc =
			issue.location ??
			(issue.file
				? {
						file: issue.file,
						start: issue.start,
						end: issue.end,
						...coordinates(issue.file, issue.start),
					}
				: null);
		const iid = idFor('issue', [uid, familyId, category, issue]);
		const mapped = mapValue(issue);
		const sourceSpan = loc
			? fs
					.readFileSync(loc.file, 'utf8')
					.slice(loc.start, Math.min(loc.end, loc.start + 1000))
			: null;
		const record = {
			...mapped,
			...envelope,
			id: iid,
			kind: 'AnalysisIssue',
			layer: 'evidence',
			familyId,
			category,
			location: location(loc),
			reason: issue.reason ?? 'Unresolved source occurrence',
		};
		issues.push(record);
		observations.push({
			...envelope,
			id: idFor('observation', iid),
			type: category,
			from: mapped.from ?? mapped.component ?? mapped.owner ?? null,
			to: null,
			familyId,
			location: record.location,
			sourceSpan,
			sourceSpanTruncated: Boolean(loc && loc.end - loc.start > 1000),
			locationLimitation: loc
				? null
				: 'The prototype did not provide an exact original source location for this issue.',
			ownerSymbolId: mapped.owner ?? mapped.component ?? null,
			siteId: null,
			contextId: mapped.context ?? null,
			targetResolution: 'unresolved',
			semantics: 'reference',
			provenance:
				familyId === 'A26'
					? 'typescript-checker'
					: ['core-issue', 'contextual-resolution'].includes(category)
						? 'api-rule'
						: 'angular-template-checker',
			reason: record.reason,
			candidateIds: [],
			external: false,
			evidenceIds: [iid],
			derivationRule: null,
			issueId: iid,
			conditions: [],
		});
	};
	for (const issue of graph.issues) addIssue('A03', issue, 'template-issue');
	for (const issue of graph.typescript?.unresolvedCalls ?? [])
		addIssue('A26', issue, 'unresolved-call');
	for (const issue of graph.typescript?.unresolvedModules ?? [])
		addIssue('A26', issue, 'unresolved-module');
	for (const issue of graph.templateExpressions?.unresolvedCalls ?? [])
		addIssue('A06', issue, 'unresolved-template-call');
	for (const issue of graph.templateExpressions?.unrepresentedDeclarations ?? [])
		addIssue('A06', issue, 'unrepresented-declaration');
	for (const issue of graph.angularCore?.issues ?? [])
		for (const family of issue.family.split('/')) addIssue(family, issue, 'core-issue');
	for (const resolution of graph.angularCore?.resolutions ?? [])
		if (resolution.status !== 'selected')
			addIssue(
				'A13',
				{
					...resolution,
					location: graph.nodes.find((n) => n.id === resolution.request)?.location,
					from: resolution.request,
					reason: resolution.reason ?? resolution.status,
				},
				'contextual-resolution',
			);
	const implemented = new Set([
		'A01',
		'A02',
		'A03',
		'A04',
		'A05',
		'A06',
		'A08',
		'A09',
		'A10',
		'A11',
		'A12',
		'A13',
		'A14',
		'A15',
		'A18',
		'A26',
	]);
	const coverage = Array.from({ length: 26 }, (_, i) => {
		const familyId = `A${String(i + 1).padStart(2, '0')}`;
		const known = observations.filter((o) => o.familyId === familyId && o.to);
		const unknown = observations.filter((o) => o.familyId === familyId && !o.to);
		return {
			...envelope,
			id: idFor('coverage', [uid, familyId]),
			kind: 'CoverageRecord',
			layer: 'evidence',
			familyId,
			status: implemented.has(familyId) ? 'partial' : 'unsupported',
			capabilitySupported: implemented.has(familyId),
			attempted: known.length + unknown.length,
			resolved: known.filter((o) => o.targetResolution === 'resolved').length,
			candidates: known.filter((o) => o.targetResolution === 'candidate-set').length,
			unresolved: unknown.length,
			unrepresented: unknown.filter((o) => o.type === 'unrepresented-declaration').length,
			expectedPopulation: null,
			locationQuality: 'original-source-validated',
			reason: implemented.has(familyId)
				? 'Only the proven extraction subset is indexed; runtime coverage is not established.'
				: 'No dedicated extractor for this family.',
			diagnostics: graph.diagnostics,
		};
	});
	return {
		entities: [...entities, ...issues, ...coverage].sort((a, b) => a.id.localeCompare(b.id)),
		observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
		issues,
		coverage,
		migration: Object.fromEntries(migration),
		resolutions: mapValue(graph.angularCore?.resolutions ?? []),
		legacyComplete: graph.complete,
	};
}

function coordinates(file, start) {
	const lines = fs.readFileSync(file, 'utf8').slice(0, start).split('\n');
	return { line: lines.length, column: lines.at(-1).length + 1 };
}
