import fs from 'node:fs';
import { workspaceId, SCHEMA_VERSION } from './model.mjs';
import { changedInputs, hash, stableJson } from './inputs.mjs';
import { extractorFingerprint } from './indexer.mjs';

const observedUsage = new Set([
	'CALLS',
	'CONSTRUCTS',
	'REFERENCES',
	'TEMPLATE_CALLS',
	'TEMPLATE_REFERENCES',
	'HOST_CALLS',
	'HOST_REFERENCES',
	'FRAMEWORK_INVOKES',
	'IMPORTS_SYMBOL',
	'REEXPORTS_SYMBOL',
]);
export class QueryService {
	constructor(store, workspace) {
		this.store = store;
		this.workspace = fs.realpathSync(workspace);
		this.workspaceId = workspaceId(this.workspace);
	}
	context(options = {}) {
		const manifest = options.snapshotId
			? this.store.snapshot(options.snapshotId)
			: this.store.current(this.workspaceId);
		if (!manifest) throw new Error('No indexed snapshot; run index first.');
		if (manifest.workspaceId !== this.workspaceId)
			throw new Error('Snapshot belongs to another workspace.');
		const unitIds = options.unitIds ?? manifest.unitIds;
		if (!unitIds.length || unitIds.some((id) => !manifest.unitIds.includes(id)))
			throw new Error('Unknown compilation unit filter.');
		const units = this.store.unitManifests(manifest.id).filter((u) => unitIds.includes(u.id));
		const changed = units.flatMap((u) =>
			changedInputs(u.inputs).map((input) => ({ ...input, unitId: u.id })),
		);
		let job = this.store.latestJob(this.workspaceId);
		if (job?.status === 'running') {
			try {
				process.kill(job.pid, 0);
			} catch (error) {
				if (error.code === 'ESRCH')
					job = {
						...job,
						status: 'interrupted',
						reason: 'The index writer exited before finishing.',
					};
			}
		}
		if (job?.error?.length > 4000)
			job = { ...job, error: job.error.slice(0, 4000), errorTruncated: true };
		const historical = this.store.current(this.workspaceId)?.id !== manifest.id;
		const outdatedExtractor = manifest.extractorFingerprint !== extractorFingerprint();
		const stale =
			changed.length > 0 ||
			outdatedExtractor ||
			job?.status === 'failed' ||
			job?.status === 'interrupted' ||
			job?.status === 'running';
		return {
			manifest,
			units,
			unitIds,
			freshness: {
				status: stale ? 'stale' : 'fresh',
				checkedAt: new Date().toISOString(),
				historical,
				changedInputs: changed.slice(0, 20),
				changedInputCount: changed.length,
				outdatedExtractor,
				lastJob: job,
			},
		};
	}
	envelope(context, results, extra = {}) {
		const response = {
			schemaVersion: SCHEMA_VERSION,
			snapshotId: context.manifest.id,
			freshness: context.freshness,
			unitIds: context.unitIds,
			coverage: context.manifest.coverage
				.filter((c) => context.unitIds.includes(c.compilationUnitId))
				.map((c) => ({
					unitId: c.compilationUnitId,
					familyId: c.familyId,
					status: c.status,
					attempted: c.attempted,
					resolved: c.resolved,
					candidates: c.candidates,
					unresolved: c.unresolved,
					unrepresented: c.unrepresented,
					expectedPopulation: c.expectedPopulation,
				})),
			results: [...results],
			truncated: false,
			nextCursor: null,
			...extra,
		};
		while (JSON.stringify(response).length > 64000 && response.results.length) {
			response.results.pop();
			response.truncated = true;
			response.responseBudgetReached = true;
		}
		return response;
	}
	page(context, method, options, results, extra = {}) {
		const limit = options.limit ?? 50;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200)
			throw new Error('limit must be an integer between 1 and 200');
		const signature = hash(
			stableJson({
				method,
				snapshot: context.manifest.id,
				filters: { ...options, cursor: undefined },
			}),
		);
		let offset = 0;
		if (options.cursor) {
			let cursor;
			try {
				cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
			} catch {
				throw new Error('Invalid cursor');
			}
			if (
				cursor.signature !== signature ||
				!Number.isInteger(cursor.offset) ||
				cursor.offset < 0 ||
				cursor.offset > results.length
			)
				throw new Error('Cursor does not match this snapshot and query.');
			offset = cursor.offset;
		}
		const response = this.envelope(context, results.slice(offset, offset + limit), {
			...extra,
		});
		const end = offset + response.results.length;
		response.nextCursor =
			response.results.length && end < results.length
				? Buffer.from(stableJson({ signature, offset: end })).toString('base64url')
				: null;
		response.truncated ||= Boolean(response.nextCursor) || Boolean(extra.boundedTraversal);
		return response;
	}
	entity(context, id) {
		const nodes = this.store.entity(context.manifest.id, id, context.unitIds);
		if (!nodes.length)
			throw new Error(`Unknown entity ${id}; find_entities returns unambiguous IDs.`);
		return nodes;
	}
	filtered(context, id, direction, options = {}) {
		return this.store
			.relationships(context.manifest.id, id, direction, context.unitIds)
			.filter(
				(edge) =>
					(!options.types?.length || options.types.includes(edge.type)) &&
					(!options.familyIds?.length || options.familyIds.includes(edge.familyId)) &&
					(!options.contextId ||
						!edge.contextId ||
						edge.contextId === options.contextId) &&
					(!edge.typeOnly || options.includeTypeOnly),
			);
	}
	get_index_status(options = {}) {
		if (!this.store.current(this.workspaceId) && !options.snapshotId)
			return {
				schemaVersion: SCHEMA_VERSION,
				snapshotId: null,
				freshness: { status: 'unindexed', lastJob: this.store.latestJob(this.workspaceId) },
				unitIds: [],
				coverage: [],
				results: [],
				truncated: false,
				nextCursor: null,
			};
		const c = this.context(options);
		return this.envelope(c, [
			{
				workspace: c.manifest.workspace,
				createdAt: c.manifest.createdAt,
				units: c.units.map(({ inputs, ...unit }) => unit),
				missingUnits: c.manifest.missingUnits,
				analysisPolicy: c.manifest.analysisPolicy,
				extractorVersion: c.manifest.extractorVersion,
				discoveryMode: c.manifest.discoveryMode,
				selectionScope:
					c.manifest.discoveryMode === 'explicit'
						? 'Only the supplied configs were selected; other workspace targets were not discovered.'
						: 'Supported angular.json build variants; unsupported variants are listed in missingUnits.',
				complete: false,
				metrics: c.manifest.metrics,
			},
		]);
	}
	find_entities(options = {}) {
		const c = this.context(options);
		const text = (options.text ?? '').toLowerCase();
		const all = this.store.entities(c.manifest.id, c.unitIds);
		const byId = new Map(all.map((n) => [n.id, n]));
		const nodes = all.filter(
			(n) =>
				(!options.kinds?.length
					? n.layer === 'declaration' || n.layer === 'context'
					: options.kinds.includes(n.kind)) &&
				(!options.file || n.location?.file.includes(options.file)) &&
				(!text ||
					[
						n.name,
						n.id,
						n.publicName,
						n.path,
						n.selector,
						byId.get(n.component)?.name,
						byId.get(n.classOwner)?.name,
						byId.get(n.owner)?.name,
					].some((value) => value?.toLowerCase().includes(text))),
		);
		const dedup = new Map();
		for (const node of nodes) {
			const prior = dedup.get(node.id);
			if (prior) prior.unitIds.push(node.compilationUnitId);
			else
				dedup.set(node.id, {
					...node,
					ownerName: byId.get(node.owner)?.name ?? null,
					componentName: byId.get(node.component ?? node.classOwner)?.name ?? null,
					unitIds: [node.compilationUnitId],
				});
		}
		return this.page(c, 'find_entities', options, [...dedup.values()]);
	}
	get_entity(options) {
		const c = this.context(options);
		const nodes = this.entity(c, options.id);
		return this.envelope(
			c,
			nodes.map((node) => {
				const edges = this.filtered(c, node.id, 'both', options).filter(
					(e) => e.compilationUnitId === node.compilationUnitId,
				);
				return {
					...node,
					incoming: counts(edges.filter((e) => e.to === node.id)),
					outgoing: counts(edges.filter((e) => e.from === node.id)),
				};
			}),
		);
	}
	get_relationships(options) {
		const c = this.context(options);
		this.entity(c, options.id);
		const edges = this.filtered(c, options.id, options.direction ?? 'both', options);
		if (!['incoming', 'outgoing', 'both'].includes(options.direction ?? 'both'))
			throw new Error('Invalid direction');
		return this.page(c, 'get_relationships', options, edges);
	}
	get_source_evidence(options) {
		const c = this.context(options);
		let edge = this.store.observation(c.manifest.id, options.id);
		if (!edge) {
			const occurrence = this.entity(c, options.id)[0];
			if (occurrence.observationId)
				edge = this.store.observation(c.manifest.id, occurrence.observationId);
		}
		if (!edge || !c.unitIds.includes(edge.compilationUnitId))
			throw new Error('Unknown observation or occurrence in selected units');
		return this.envelope(c, [
			{
				id: edge.id,
				occurrenceId: edge.occurrenceId ?? null,
				location: edge.location,
				sourceSpan: edge.sourceSpan ?? null,
				sourceSpanTruncated: edge.sourceSpanTruncated ?? false,
				targetResolution: edge.targetResolution,
				semantics: edge.semantics,
				provenance: edge.provenance,
				reason: edge.reason ?? null,
				evidenceIds: edge.evidenceIds,
			},
		]);
	}
	resolve_provider(options) {
		const c = this.context(options);
		const requests = this.entity(c, options.requestId);
		if (requests.some((n) => n.kind !== 'InjectionRequest'))
			throw new Error('requestId must identify an InjectionRequest');
		if (!options.contextId)
			throw new Error('resolve_provider requires an explicit InjectorContext ID');
		const contexts = this.entity(c, options.contextId);
		if (contexts.some((n) => n.kind !== 'InjectorContext'))
			throw new Error('contextId must identify an InjectorContext');
		const results = [];
		for (const request of requests) {
			if (!contexts.some((ctx) => ctx.compilationUnitId === request.compilationUnitId))
				continue;
			const resolution = this.store
				.resolutions(c.manifest.id, request.compilationUnitId)
				.find((r) => r.request === request.id && r.context === options.contextId);
			const opts = { ...options, unitIds: [request.compilationUnitId] };
			const local = { ...c, unitIds: opts.unitIds };
			const evidence = resolution
				? this.filtered(local, request.id, 'outgoing', opts).filter(
						(e) => e.type === 'RESOLVES_IN' && e.to === resolution.id,
					)
				: [];
			if (resolution) evidence.push(...this.filtered(local, resolution.id, 'outgoing', opts));
			const providers = (resolution?.providers ?? []).map((id) => ({
				registration: this.entity(local, id)[0],
				implementationEvidence: this.filtered(local, id, 'outgoing', opts).filter((e) =>
					[
						'USES_CLASS',
						'USES_FACTORY',
						'USES_VALUE',
						'ALIASES_TOKEN',
						'ALIAS_SELECTS_PROVIDER',
						'ALIAS_CANDIDATE_PROVIDER',
					].includes(e.type),
				),
			}));
			results.push({
				request,
				token: request.token ? this.entity(local, request.token)[0] : null,
				contextId: options.contextId,
				status: resolution?.status ?? 'unresolved',
				reason:
					resolution?.reason ??
					(resolution
						? null
						: 'No resolution was modeled for this request/context; caller or placement context may be unsupported.'),
				trace: resolution?.trace ?? [],
				providers,
				evidence,
				runtimeObserved: false,
			});
		}
		return this.envelope(c, results);
	}
	traverse(c, start, options = {}, direction = 'outgoing', target = null) {
		const maxDepth = options.maxDepth ?? 8,
			maxNodes = options.maxNodes ?? 200,
			maxEdges = options.maxEdges ?? 1000,
			maxPaths = options.maxPaths ?? 10;
		for (const [name, value, max] of [
			['maxDepth', maxDepth, 16],
			['maxNodes', maxNodes, 500],
			['maxEdges', maxEdges, 5000],
			['maxPaths', maxPaths, 20],
		])
			if (!Number.isInteger(value) || value < 1 || value > max)
				throw new Error(`${name} must be between 1 and ${max}`);
		const deadline = performance.now() + 250;
		let visitedEdges = 0;
		let truncated = false;
		const queue = [];
		const reached = [];
		const paths = [];
		const seen = new Set();
		for (const node of this.entity(c, start)) {
			queue.push({ id: start, unitId: node.compilationUnitId, path: [], ids: [start] });
			seen.add(`${node.compilationUnitId}:${start}`);
		}
		while (queue.length) {
			if (performance.now() > deadline || visitedEdges >= maxEdges || seen.size >= maxNodes) {
				truncated = true;
				break;
			}
			const current = queue.shift();
			const local = { ...c, unitIds: [current.unitId] };
			const edges = this.filtered(local, current.id, direction, options).filter(
				(edge) =>
					!target || edge.type !== 'CONTAINS' || options.types?.includes('CONTAINS'),
			);
			if (current.path.length >= maxDepth) {
				if (edges.some((e) => e.to)) truncated = true;
				continue;
			}
			for (const edge of edges) {
				if (++visitedEdges > maxEdges || performance.now() > deadline) {
					truncated = true;
					break;
				}
				if (!edge.to) {
					reached.push({
						id: null,
						unitId: current.unitId,
						evidence: [...current.path, edge],
						boundary: 'unresolved',
					});
					continue;
				}
				const next =
					direction === 'incoming'
						? edge.from
						: direction === 'both'
							? edge.from === current.id
								? edge.to
								: edge.from
							: edge.to;
				if (!next || current.ids.includes(next)) continue;
				const evidence = [...current.path, edge];
				if (next === target) {
					paths.push({
						unitId: current.unitId,
						nodeIds: [...current.ids, next],
						evidence,
						targetResolution: evidence.some((e) => e.targetResolution !== 'resolved')
							? 'candidate-set'
							: 'resolved',
						runtimeObserved: false,
					});
					if (paths.length >= maxPaths) {
						truncated = queue.length > 0 || edges.length > 1;
						return { paths, reached, truncated, visitedEdges };
					}
					continue;
				}
				const key = `${current.unitId}:${next}`;
				if (seen.has(key)) continue;
				if (seen.size >= maxNodes) {
					truncated = true;
					break;
				}
				seen.add(key);
				reached.push({
					id: next,
					unitId: current.unitId,
					evidence,
					depth: evidence.length,
				});
				queue.push({
					id: next,
					unitId: current.unitId,
					path: evidence,
					ids: [...current.ids, next],
				});
			}
		}
		return { paths, reached, truncated, visitedEdges };
	}
	explain_dependency(options) {
		const c = this.context(options);
		this.entity(c, options.targetId);
		const result = this.traverse(c, options.sourceId, options, 'outgoing', options.targetId);
		return this.envelope(c, result.paths, {
			truncated: result.truncated,
			boundaries: result.reached.filter((r) => r.boundary).slice(0, 20),
			visitedEdges: result.visitedEdges,
			interpretation:
				'Bounded static evidence paths; an empty result does not prove absence of dependency.',
		});
	}
	analyze_impact(options) {
		const c = this.context(options);
		const result = this.traverse(c, options.id, options, 'incoming');
		return this.page(
			c,
			'analyze_impact',
			options,
			result.reached.map((r) => ({
				...r,
				impactKind: r.evidence[0]?.semantics ?? 'unknown',
			})),
			{
				boundedTraversal: result.truncated,
				visitedEdges: result.visitedEdges,
				interpretation:
					'Possible impact through observed relations; runtime effects are not proven.',
			},
		);
	}
	get_feature_context(options) {
		const c = this.context(options);
		const result = this.traverse(c, options.id, options, 'both');
		return this.page(c, 'get_feature_context', options, result.reached, {
			boundedTraversal: result.truncated,
			visitedEdges: result.visitedEdges,
		});
	}
	find_unused_candidates(options = {}) {
		const c = this.context(options);
		const nodes = this.store
			.entities(c.manifest.id, c.unitIds)
			.filter((n) => (options.kinds ?? ['Method', 'Function']).includes(n.kind));
		const results = [];
		const deadline = performance.now() + 250;
		for (const node of nodes) {
			if (performance.now() > deadline) break;
			const incoming = this.filtered(
				{ ...c, unitIds: [node.compilationUnitId] },
				node.id,
				'incoming',
				options,
			).filter((e) => observedUsage.has(e.type) && !e.typeOnly);
			const reasons = [
				...(incoming.length ? ['observed-incoming-usage'] : []),
				...(node.external || !node.hasImplementation
					? ['external-or-declaration-only']
					: []),
			];
			const missing = c.manifest.coverage
				.filter(
					(f) =>
						f.compilationUnitId === node.compilationUnitId &&
						['A08', 'A17', 'A18', 'A25'].includes(f.familyId) &&
						f.status !== 'complete',
				)
				.map((f) => f.familyId);
			results.push({
				entity: node,
				status: reasons.length ? 'excluded' : 'blocked-by-coverage',
				exclusionReasons: reasons,
				incomingEvidence: incoming.slice(0, 20),
				incomingTruncated: incoming.length > 20,
				blockingFamilies: missing,
				publicPolicy: 'Public/external consumers are not fully analyzed.',
				testPolicy: 'Only selected compilation units are analyzed.',
				policyVersion: 'no-global-unused-verdict:1',
			});
		}
		return this.page(c, 'find_unused_candidates', options, results, {
			boundedTraversal: results.length < nodes.length,
		});
	}
}
function counts(edges) {
	return edges.reduce((out, e) => ((out[e.type] = (out[e.type] ?? 0) + 1), out), {});
}
