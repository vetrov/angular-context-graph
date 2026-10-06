import { z } from 'zod';

const string = z.string().min(1);
const filters = {
	snapshotId: string.optional(),
	unitIds: z.array(string).min(1).optional(),
	unit: string.optional(),
	detail: z.enum(['compact', 'full']).optional(),
	freshness: z.enum(['cached', 'verify']).optional(),
	contextId: string.optional(),
	types: z.array(string).optional(),
	familyIds: z.array(string).optional(),
	includeTypeOnly: z.boolean().optional(),
};
const page = { limit: z.number().int().min(1).max(200).optional(), cursor: string.optional() };
const traversal = {
	maxDepth: z.number().int().min(1).max(16).optional(),
	maxNodes: z.number().int().min(1).max(500).optional(),
	maxEdges: z.number().int().min(1).max(5000).optional(),
	maxPaths: z.number().int().min(1).max(20).optional(),
};
const schema = (fields) => z.object(fields).strict();
export const QUERY_TOOLS = {
	get_index_status: {
		description:
			'Inspect the saved snapshot, freshness, selected/missing compilation units, coverage and last indexing failure.',
		input: schema({
			snapshotId: filters.snapshotId,
			unitIds: filters.unitIds,
			unit: filters.unit,
			detail: filters.detail,
		}),
	},
	find_entities: {
		description:
			'Search saved entities in SQLite; exact names rank first. kinds accepts entity kinds or Angular roles (e.g. Service); roles filters roles explicitly. Owner matches for declaration members require includeMembers. Select a unit by name; request detail=full only for raw DTOs.',
		input: schema({
			...filters,
			...page,
			text: z.string().optional(),
			kinds: z.array(string).optional(),
			roles: z.array(string).optional(),
			match: z.enum(['substring', 'exact']).optional(),
			includeMembers: z.boolean().optional(),
			file: string.optional(),
		}),
	},
	get_entity: {
		description:
			'Read declaration facets and incoming/outgoing relationship counts in selected units.',
		input: schema({ ...filters, id: string }),
	},
	get_relationships: {
		description:
			'Read evidence-backed relationships and unresolved observations with unit and context filters.',
		input: schema({
			...filters,
			...page,
			id: string,
			direction: z.enum(['incoming', 'outgoing', 'both']).optional(),
		}),
	},
	explain_dependency: {
		description:
			'Find bounded static evidence paths between entity IDs. Paths never join observations from different compilation units. Empty results do not prove absence.',
		input: schema({ ...filters, ...traversal, sourceId: string, targetId: string }),
	},
	resolve_provider: {
		description:
			'Resolve an injection request in an explicit modeled InjectorContext. Return lookup trace, selected/candidate registrations and implementation evidence; runtime is not observed.',
		input: schema({ ...filters, requestId: string, contextId: string }),
	},
	explain_injection: {
		description:
			'Explain a class/service DI question in one compact answer: provider scopes, every indexed explicit dependency, nested class-provider dependencies (default depth 2), value-token selections and shared registrations with its component. Pass name or entityId; component or contextId selects a modeled construction context. A unique default build is selected and disclosed; otherwise choose a unit. Includes source locations, static evidence, unknowns and runtime assumptions. Never rebuilds the index.',
		input: schema({
			...filters,
			name: string.optional(),
			entityId: string.optional(),
			component: string.optional(),
			maxDepth: z.number().int().min(0).max(4).optional(),
			maxContexts: z.number().int().min(1).max(8).optional(),
			maxDependencies: z.number().int().min(1).max(100).optional(),
		}).refine(
			(v) => Boolean(v.name) !== Boolean(v.entityId),
			'Pass exactly one of name or entityId.',
		),
	},
	get_feature_context: {
		description:
			'Read a bounded route/application/component neighborhood with source evidence and unresolved boundaries.',
		input: schema({ ...filters, ...page, ...traversal, id: string }),
	},
	analyze_impact: {
		description:
			'Traverse incoming observations to find direct users and possible impact paths, with evidence and explicit bounds.',
		input: schema({ ...filters, ...page, ...traversal, id: string }),
	},
	find_unused_candidates: {
		description:
			'Return observed usage exclusions and declarations blocked by incomplete framework/dynamic/public/test coverage. Never a global unused verdict.',
		input: schema({ ...filters, ...page, kinds: z.array(string).optional() }),
	},
	get_source_evidence: {
		description:
			'Read a small original source span captured with an observation or occurrence ID. Remains readable if working files change.',
		input: schema({ ...filters, id: string }),
	},
};
export const INDEX_INPUT = schema({
	projects: z.array(string).optional(),
	full: z.boolean().optional(),
});
export const RESPONSE_SCHEMA = z
	.object({
		schemaVersion: z.literal(2),
		snapshotId: z.string().nullable(),
		freshness: z.object({ status: z.enum(['fresh', 'stale', 'unindexed']) }).passthrough(),
		unitIds: z.array(z.string()),
		coverage: z.array(z.record(z.string(), z.unknown())),
		results: z.array(z.record(z.string(), z.unknown())),
		truncated: z.boolean(),
		nextCursor: z.string().nullable(),
	})
	.passthrough();
export function query(service, method, args = {}) {
	const tool = QUERY_TOOLS[method];
	if (!tool)
		throw new Error(
			`Unknown query ${method}. Available: ${Object.keys(QUERY_TOOLS).join(', ')}`,
		);
	return RESPONSE_SCHEMA.parse(service[method](tool.input.parse(args)));
}
