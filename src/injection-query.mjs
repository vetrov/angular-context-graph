import path from 'node:path';
import { entityRef as fullEntityRef, location as fullLocation } from './query-format.mjs';

const classKinds = ['Class', 'Component', 'Directive'];
const providerEdges = ['USES_CLASS', 'USES_FACTORY', 'USES_VALUE', 'ALIASES_TOKEN'];

export function explainInjection(service, options) {
	if (Boolean(options.name) === Boolean(options.entityId))
		throw new Error('Pass exactly one of name or entityId.');
	const c = service.context({ ...options, selectDefaultUnit: true });
	const location = (value) => {
		const loc = fullLocation(value);
		if (!loc || options.detail === 'full') return loc;
		const relative = path.relative(c.manifest.workspace, loc.file);
		return {
			...loc,
			file:
				relative && !relative.startsWith('..') && !path.isAbsolute(relative)
					? relative
					: loc.file,
		};
	};
	const entityRef = (value) =>
		value ? { ...fullEntityRef(value), location: location(value.location) } : null;
	if (!options.unitIds && !options.unit && c.unitIds.length > 1)
		return service.envelope(c, [
			{
				status: 'unit-selection-required',
				units: c.unitSelection.selected,
				reason: 'Several compilation units are indexed and there is no unique default build. Pass unit or unitIds.',
			},
		]);
	const matches = options.entityId
		? service.entity(c, options.entityId)
		: service.store.searchEntities(
				c.manifest.id,
				c.unitIds,
				{ text: options.name, match: 'exact', kinds: classKinds },
				0,
				3,
			);
	if (new Set(matches.map((n) => n.id)).size > 1)
		return service.envelope(c, [
			{
				status: 'ambiguous-entity',
				candidates: matches.map(entityRef),
				reason: 'Use entityId to select an unambiguous declaration.',
			},
		]);
	if (!matches.length)
		throw new Error(
			`No indexed class named ${options.name}; find_entities can search roles and locations.`,
		);
	if (matches.some((n) => !classKinds.includes(n.kind)))
		throw new Error('explain_injection requires a class, component or directive declaration.');
	const classId = matches[0].id;
	const results = [];
	const maxContexts = options.maxContexts ?? 4;
	const maxDependencies = options.maxDependencies ?? 40;
	const maxDepth = options.maxDepth ?? 2;
	let truncated = false;
	for (const unitId of c.unitIds) {
		const nodeCache = new Map();
		const edgeCache = new Map();
		const requestCache = new Map();
		const node = (id) => {
			if (!id) return null;
			if (!nodeCache.has(id))
				nodeCache.set(id, service.store.entity(c.manifest.id, id, [unitId])[0] ?? null);
			return nodeCache.get(id);
		};
		const edges = (id, direction = 'outgoing') => {
			const key = `${direction}:${id}`;
			if (!edgeCache.has(key))
				edgeCache.set(
					key,
					service.store.relationships(c.manifest.id, id, direction, [unitId]),
				);
			return edgeCache.get(key);
		};
		const requests = (owner) => {
			if (!requestCache.has(owner))
				requestCache.set(
					owner,
					service.store
						.relatedEntities(
							c.manifest.id,
							[unitId],
							'InjectionRequest',
							'classOwner',
							[owner],
						)
						.sort(
							(a, b) =>
								a.location.file.localeCompare(b.location.file) ||
								a.location.start - b.location.start,
						),
				);
			return requestCache.get(owner);
		};
		const subject = node(classId);
		if (!subject) continue;
		const registrations = edges(classId, 'incoming')
			.filter((e) => e.type === 'USES_CLASS')
			.map((e) => node(e.from))
			.filter(Boolean);
		const scopes = registrations.map((p) => p.owner);
		let contexts = [
			...service.store.relatedEntities(
				c.manifest.id,
				[unitId],
				'InjectorContext',
				'classIds',
				[classId],
			),
			...service.store.relatedEntities(
				c.manifest.id,
				[unitId],
				'InjectorContext',
				'definitions',
				scopes,
			),
		];
		contexts = [...new Map(contexts.map((ctx) => [ctx.id, ctx])).values()];
		if (options.contextId) {
			const ctx = node(options.contextId);
			if (!ctx || ctx.kind !== 'InjectorContext')
				throw new Error('contextId must identify an InjectorContext in the selected unit.');
			contexts = contexts.filter((candidate) => candidate.id === ctx.id);
		}
		if (options.component)
			contexts = contexts.filter((ctx) => node(ctx.component)?.name === options.component);
		if (!contexts.length) contexts = [null];
		for (const ctx of contexts) {
			if (results.length >= maxContexts) {
				truncated = true;
				break;
			}
			const evidence = new Map();
			let dependencyCount = 0;
			const record = (observations) => {
				for (const e of observations)
					evidence.set(
						e.id,
						options.detail === 'full'
							? e
							: {
									id: e.id,
									type: e.type,
									location: location(e.location),
									targetResolution: e.targetResolution,
									semantics: e.semantics,
									provenance: e.provenance,
									...(e.reason ? { reason: e.reason } : {}),
								},
					);
				return observations.map((e) => e.id);
			};
			const provider = (registration) => {
				const def = node(registration.owner);
				const observations = [
					...edges(registration.id).filter((e) =>
						['PROVIDES_TOKEN', ...providerEdges].includes(e.type),
					),
					...edges(registration.id, 'incoming').filter((e) => e.type === 'REGISTERS'),
				];
				return {
					id: registration.id,
					strategy: registration.strategy,
					multi: registration.multi,
					token: entityRef(node(registration.token)),
					implementation: entityRef(node(registration.target)),
					...(registration.strategy === 'useValue' ? { value: registration.value } : {}),
					location: location(registration.location),
					scope: def
						? {
								id: def.id,
								kind: def.scopeKind,
								visibility: def.visibility,
								owner: entityRef(node(def.owner)),
								location: location(def.location),
							}
						: null,
					evidenceIds: record(observations),
				};
			};
			const resolve = (q, contextId) =>
				contextId ? service.store.resolution(c.manifest.id, unitId, q.id, contextId) : null;
			const dependency = (q, contextId, depth, ancestry) => {
				if (++dependencyCount > maxDependencies) {
					truncated = true;
					return null;
				}
				const resolution = resolve(q, contextId);
				const resolutionEvidence = resolution
					? [
							...edges(q.id).filter(
								(e) => e.type === 'RESOLVES_IN' && e.to === resolution.id,
							),
							...edges(resolution.id).filter((e) =>
								['SELECTS_PROVIDER', 'CANDIDATE_PROVIDER'].includes(e.type),
							),
						]
					: [];
				const dependencyEvidence = edges(q.id).filter((e) => e.type === 'REQUESTS_TOKEN');
				const providers = (resolution?.providers ?? []).map(node).filter(Boolean);
				const result = {
					requestId: q.id,
					member: node(q.owner)?.name ?? null,
					token: entityRef(node(q.token)),
					form: q.form,
					modifiers: q.modifiers,
					contextEligibility: q.contextEligibility,
					location: location(q.location),
					status: resolution?.status ?? 'unresolved',
					reason:
						resolution?.reason ??
						(resolution
							? null
							: 'No resolution was modeled for this request in the selected construction context.'),
					providerContextId: resolution?.foundContext ?? null,
					providers: providers.map(provider),
					evidenceIds: record([...dependencyEvidence, ...resolutionEvidence]),
				};
				if (options.detail === 'full') result.trace = resolution?.trace ?? [];
				if (
					resolution?.status === 'selected' &&
					!resolution.multi &&
					providers.length === 1 &&
					ctx
				) {
					const peers = (ctx.classIds ?? [])
						.filter((id) => id !== q.classOwner)
						.flatMap(requests)
						.filter((other) => other.token && other.token === q.token);
					result.sharedWith = peers.flatMap((other) => {
						const selected = resolve(other, ctx.id);
						if (
							selected?.status !== 'selected' ||
							selected.multi ||
							selected.providers.length !== 1 ||
							selected.providers[0] !== providers[0].id ||
							selected.foundContext !== resolution.foundContext
						)
							return [];
						const ids = record([
							...edges(other.id).filter(
								(e) => e.type === 'RESOLVES_IN' && e.to === selected.id,
							),
							...edges(selected.id).filter((e) => e.type === 'SELECTS_PROVIDER'),
						]);
						return [
							{
								consumer: entityRef(node(other.classOwner)),
								member: node(other.owner)?.name ?? null,
								requestId: other.id,
								location: location(other.location),
								registrationId: providers[0].id,
								providerContextId: selected.foundContext,
								staticResult: 'same-registration-in-same-modeled-injector',
								evidenceIds: ids,
								runtimeObserved: false,
							},
						];
					});
				}
				if (resolution?.status === 'selected') {
					result.providerDependencies = providers
						.filter((p) => p.strategy === 'useClass' && p.target)
						.flatMap((p) => {
							const childRequests = requests(p.target);
							if (!childRequests.length) return [];
							const key = `${p.target}:${resolution.foundContext}`;
							if (ancestry.includes(key) || depth >= maxDepth) {
								truncated = true;
								return [
									{
										implementation: entityRef(node(p.target)),
										boundary: ancestry.includes(key)
											? 'provider-cycle'
											: 'max-depth',
										dependencies: [],
									},
								];
							}
							return [
								{
									implementation: entityRef(node(p.target)),
									contextId: resolution.foundContext,
									dependencies: childRequests
										.map((child) =>
											dependency(child, resolution.foundContext, depth + 1, [
												...ancestry,
												key,
											]),
										)
										.filter(Boolean),
								},
							];
						});
				}
				return result;
			};
			const providerScopes = registrations.map(provider);
			const dependencies = requests(classId)
				.map((q) => dependency(q, ctx?.id, 0, [`${classId}:${ctx?.id}`]))
				.filter(Boolean);
			results.push({
				unitId,
				sourceRoot: c.manifest.workspace,
				entity: entityRef(subject),
				status: ctx ? 'modeled-context' : 'no-modeled-context',
				context: ctx
					? {
							...entityRef(ctx),
							kind: ctx.contextKind,
							component: entityRef(node(ctx.component)),
							relation: ctx.relation,
						}
					: null,
				providerScopes,
				dependencies,
				...(options.detail === 'full'
					? { evidence: [...evidence.values()] }
					: {
							evidenceAccess:
								'get_source_evidence accepts every evidenceId; detail=full includes all observations and lookup traces.',
						}),
				interpretation: {
					sourceFacts:
						'Declarations and original source locations captured in the indexed snapshot.',
					staticResults:
						'Selections and shared registrations apply only to this modeled construction context.',
					dependencyInventory:
						'Indexed explicit injection requests; implicit framework dependencies and unsupported constructs may be absent.',
					runtimeObserved: false,
					assumptions: [
						'Instance sharing assumes normal Angular construction without runtime/test overrides or manual instantiation.',
						'A matching registration is static evidence; runtime object identity was not observed.',
					],
				},
				...(!ctx
					? {
							reason: 'No matching construction context was modeled. Provider scopes and requests are source facts; no winner is inferred.',
						}
					: {}),
			});
		}
	}
	return service.envelope(c, results, {
		truncated,
		bounds: { maxContexts, maxDependencies, maxDepth },
		runtimeObserved: false,
	});
}
