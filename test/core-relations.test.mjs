import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { extract } from '../src/extract.mjs';
const base =
	process.env.SEMANTIC_PROJECT ??
	fileURLToPath(new URL('../fixtures/tsconfig.json', import.meta.url));
const project = path.join(path.dirname(base), 'core-relations/tsconfig.json');
const plain = await extract(project, { templateExpressions: true });
const graph = await extract(project, { angularCore: true });
const core = graph.angularCore,
	nodes = new Map(graph.nodes.map((n) => [n.id, n]));
const named = (name, kind) =>
	graph.nodes.find((n) => n.name === name && (!kind || n.kind === kind));
const method = (owner, name) =>
	graph.nodes.find(
		(n) => n.kind === 'Method' && n.name === name && nodes.get(n.owner)?.name === owner,
	);
const requests = (owner, name) =>
	graph.nodes.filter(
		(n) =>
			n.kind === 'InjectionRequest' &&
			nodes.get(n.classOwner)?.name === owner &&
			(!name || nodes.get(n.owner)?.name === name),
	);
const token = (name) => named(name, 'Token');
const contexts = graph.nodes.filter((n) => n.kind === 'InjectorContext');
const env = contexts.find((n) => n.contextKind === 'root-environment');
function rootEnvironment(ctx) {
	while (ctx && ctx.contextKind !== 'root-environment')
		ctx = nodes.get(ctx.environment ?? ctx.parent);
	return ctx;
}
const first = contexts.filter((c) => rootEnvironment(c)?.id === env.id);
const result = (q, ctx) => core.resolutions.find((x) => x.request === q.id && x.context === ctx.id);
const selectedName = (x) =>
	x.providers.map((id) => {
		const p = nodes.get(id);
		return nodes.get(p.target)?.name ?? p.strategy;
	});
const route = (path) => graph.nodes.find((n) => n.kind === 'RouteDefinition' && n.path === path);
const edge = (type, from, to) =>
	graph.edges.find((e) => e.type === type && (!from || e.from === from) && (!to || e.to === to));

test('DI requests use symbol identity, explicit tokens, aliases and inherited constructor metadata', () => {
	const worker = requests('Leaf', 'worker')[0];
	assert.equal(worker.token, token('WORK').id);
	assert.notEqual(token('WORK').id, token('OTHER').id); // Identical InjectionToken labels are distinct.
	const inherited = requests('CtorLeaf', 'worker')[0];
	assert.equal(inherited.token, token('WORK').id);
	assert.equal(inherited.form, 'constructor');
	const optional = requests('CtorLeaf', 'maybe')[0];
	assert.deepEqual(optional.modifiers, { optional: true, self: true });
	assert.equal(
		graph.nodes.filter(
			(n) => n.kind === 'InjectionRequest' && nodes.get(n.owner)?.name === 'fakeRequest',
		).length,
		0,
	);
	const auto = requests('ConstructorService', 'auto')[0];
	assert.equal(auto.token, token('AutoService').id);
});
test('an inject call inside an ordinary method requires a caller injection context', () => {
	const q = graph.nodes.find(
		(n) => n.kind === 'InjectionRequest' && nodes.get(n.owner)?.name === 'late',
	);
	assert.equal(q.token, token('WORK').id);
	assert.equal(q.classOwner, null);
	assert.equal(q.contextEligibility, 'requires-caller-context');
	assert.equal(core.resolutions.filter((x) => x.request === q.id).length, 0);
});
test('provider registrations cover useClass/useExisting/useFactory/useValue, spreads, multi and token factories', () => {
	const regs = graph.nodes.filter((n) => n.kind === 'ProviderRegistration');
	for (const strategy of ['useClass', 'useExisting', 'useFactory', 'useValue'])
		assert.ok(regs.some((n) => n.strategy === strategy));
	const multi = regs.filter((n) => n.token === token('MANY').id);
	assert.equal(multi.length, 2);
	assert.ok(multi.every((n) => n.multi));
	assert.deepEqual(
		multi.map((n) => n.value),
		['first', 'second'],
	);
	const tokenFactory = regs.find((n) => n.token === token('TOKEN_FACTORY').id);
	assert.equal(tokenFactory.strategy, 'useFactory');
	assert.ok(edge('HAS_INJECTION_REQUEST', regs.find((n) => n.token === token('FACTORY').id).id));
});
test('bootstrap roots and lazy component/routes/module targets are linked without executing loaders', () => {
	assert.equal(core.applications, 2);
	assert.ok(edge('BOOTSTRAPS', null, named('Root', 'Component').id));
	for (const [p, target] of [
		['lazy', 'LazyPage'],
		['feature', 'LAZY_ROUTES'],
		['module', 'LazyModule'],
	])
		assert.ok(edge('LAZY_LOADS', route(p).id, named(target).id));
	assert.ok(route('module-child'));
	assert.ok(route('child'));
	const lazy = route('lazy');
	assert.ok(edge('GUARDED_BY', lazy.id));
	assert.ok(edge('RESOLVED_BY', lazy.id));
	assert.equal(nodes.get(edge('RESOLVED_BY', lazy.id).to).kind, 'Function');
	assert.equal(route('').redirectTo, 'lazy');
	assert.equal(route('').pathMatch, 'full');
});
test('dynamic loader branches are retained as unknown rather than guessed targets', () => {
	const opaque = route('opaque');
	assert.ok(opaque);
	assert.equal(edge('LAZY_LOADS', opaque.id), undefined);
	assert.ok(
		core.issues.some((x) => x.family === 'A15' && x.reason.includes('Unsupported lazy loader')),
	);
});
test('one route definition reused under two parents has distinct mounts and provider contexts', () => {
	const defs = graph.nodes.filter((n) => n.kind === 'RouteDefinition' && n.path === 'reused');
	assert.equal(defs.length, 1);
	const mounts = graph.nodes.filter(
		(n) => n.kind === 'RouteMount' && n.definition === defs[0].id,
	);
	assert.equal(mounts.length, 2);
	assert.notEqual(mounts[0].environment, mounts[1].environment);
	const q = requests('Leaf', 'worker')[0];
	assert.deepEqual(
		mounts.map((m) => {
			const p = nodes.get(edge('ROUTE_PLACEMENT', m.id).to);
			return selectedName(result(q, p))[0];
		}),
		['RouteWorker', 'RootWorker'],
	);
});
test('provider selection distinguishes root, route, view child, projected child and same-element directive', () => {
	const q = requests('Leaf', 'worker')[0];
	const leaf = first.filter((c) => c.classIds?.includes(named('Leaf', 'Component').id));
	const view = leaf.find(
		(c) =>
			nodes.get(c.parent)?.component === named('ScopeBox', 'Component').id &&
			c.relation === 'view',
	);
	const content = leaf.find(
		(c) =>
			nodes.get(c.parent)?.component === named('ScopeBox', 'Component').id &&
			c.relation === 'content',
	);
	assert.deepEqual(selectedName(result(q, view)), ['ViewWorker']);
	assert.deepEqual(selectedName(result(q, content)), ['LocalWorker']);
	const root = leaf.find((c) => nodes.get(c.parent)?.component === named('Root', 'Component').id);
	assert.deepEqual(selectedName(result(q, root)), ['RootWorker']);
	const box = first.find((c) => c.component === named('ScopeBox', 'Component').id);
	assert.deepEqual(selectedName(result(requests('ScopeBox', 'ownWorker')[0], box)), [
		'ViewWorker',
	]);
	assert.deepEqual(selectedName(result(requests('Mark', 'worker')[0], box)), ['LocalWorker']);
	const lazy = first.find(
		(c) =>
			c.component === named('LazyPage', 'Component').id &&
			nodes.get(c.environment)?.contextKind === 'route-environment',
	);
	assert.deepEqual(selectedName(result(requests('LazyPage', 'worker')[0], lazy)), [
		'RouteWorker',
	]);
});
test('alias lookup, factory deps and multi-provider ordering are retained as evidence', () => {
	const aliasReg = graph.nodes.find(
		(n) => n.kind === 'ProviderRegistration' && n.token === token('ALIAS').id,
	);
	assert.ok(edge('ALIAS_SELECTS_PROVIDER', aliasReg.id));
	const leaf = first.find((c) => c.component === named('Leaf', 'Component').id);
	const multi = result(requests('Leaf', 'many')[0], leaf);
	assert.equal(multi.status, 'selected');
	assert.ok(multi.multi);
	assert.deepEqual(
		multi.providers.map((id) => nodes.get(id).value),
		['first', 'second'],
	);
	const factory = graph.nodes.find(
		(n) => n.kind === 'ProviderRegistration' && n.token === token('FACTORY').id,
	);
	const req = graph.nodes.find((n) => n.kind === 'InjectionRequest' && n.owner === factory.id);
	assert.equal(req.token, token('WORK').id);
	assert.ok(core.resolutions.some((x) => x.request === req.id && x.status === 'selected'));
});
test('self/skipSelf/optional constraints work, while host and dynamic token/flags stay explicit unknowns', () => {
	const flagged = first.find((c) => c.classIds?.includes(named('RequestFlags', 'Directive').id));
	assert.deepEqual(selectedName(result(requests('RequestFlags', 'parent')[0], flagged)), [
		'RootWorker',
	]);
	assert.equal(
		result(requests('RequestFlags', 'optional')[0], flagged).status,
		'optional-miss-in-model',
	);
	assert.equal(result(requests('RequestFlags', 'host')[0], flagged).status, 'unresolved');
	assert.equal(requests('Leaf', 'unknown')[0].token, null);
	const leaf = first.find((c) => c.component === named('Leaf', 'Component').id);
	assert.equal(result(requests('Leaf', 'dynamicFlag')[0], leaf).status, 'unresolved');
	assert.ok(core.issues.some((x) => x.reason.includes('Token is not a resolved runtime value')));
});
test('opaque provider helpers cannot produce exact winners or false absence claims', () => {
	const other = contexts.filter(
		(c) => rootEnvironment(c)?.id !== env.id && c.component === named('Leaf', 'Component').id,
	);
	const q = requests('Leaf', 'auto')[0];
	assert.ok(other.some((c) => result(q, c)?.status === 'candidate'));
	assert.ok(core.issues.some((x) => x.reason.includes('Opaque provider helper')));
	const w = requests('Leaf', 'worker')[0];
	assert.ok(other.some((c) => result(w, c)?.status === 'unresolved'));
});
test('external directive provider scopes are unknown and block exact ancestor selection', () => {
	assert.ok(
		core.issues.some(
			(x) => x.family === 'A13' && x.reason.includes('External Angular providers'),
		),
	);
	const ngIf = graph.nodes.find((n) => n.name === 'NgIf' && n.kind === 'Directive');
	const ctx = first.find(
		(c) =>
			c.component === named('Leaf', 'Component').id &&
			nodes.get(c.parent)?.classIds?.includes(ngIf.id),
	);
	assert.equal(result(requests('Leaf', 'worker')[0], ctx).status, 'candidate');
});
test('host metadata and decorator behavior resolve to original properties/methods', () => {
	const box = named('ScopeBox', 'Component'),
		handle = method('ScopeBox', 'handle');
	assert.ok(edge('HOST_CALLS', null, handle.id));
	assert.ok(
		graph.edges.some(
			(e) =>
				e.type === 'HOST_REFERENCES' &&
				e.owner === box.id &&
				nodes.get(e.to)?.name === 'label',
		),
	);
	assert.ok(
		edge('FRAMEWORK_INVOKES', named('Mark', 'Directive').id, method('Mark', 'tapped').id),
	);
	for (const e of graph.edges.filter((e) => e.type === 'HOST_REFERENCES' && e.name))
		assert.equal(
			fs.readFileSync(e.location.file, 'utf8').slice(e.location.start, e.location.end),
			e.name,
		);
});
test('view/content decorator and signal queries respect view boundaries and descendant options', () => {
	const box = first.find((c) => c.component === named('ScopeBox', 'Component').id);
	const query = (name) =>
		graph.nodes.find((n) => n.kind === 'Query' && nodes.get(n.member)?.name === name);
	const matches = (name) =>
		graph.edges.filter(
			(e) =>
				e.type === 'QUERY_MAY_MATCH' && e.from === query(name).id && e.context === box.id,
		);
	assert.equal(matches('leaf').length, 1);
	assert.equal(matches('signalLeaf').length, 1);
	assert.equal(matches('viewMarks').length, 1); // Does not pierce InnerBoundary's template or inspect projected content.
	assert.equal(matches('marks').length, 2);
	assert.equal(matches('directMarks').length, 1);
	assert.equal(nodes.get(query('bare').read).name, 'ElementRef');
	assert.equal(matches('bare').length, 1);
});
test('projection connects caller sites to ordered selected/default slots per placement', () => {
	const box = named('ScopeBox', 'Component');
	const slots = graph.nodes.filter((n) => n.kind === 'ProjectionSlot' && n.owner === box.id);
	assert.deepEqual(
		slots.map((s) => s.selector),
		['[special]', '*'],
	);
	const p = first.find((c) => c.component === box.id);
	const projected = graph.edges.filter(
		(e) => e.type === 'PROJECTS_TO' && nodes.get(e.from).parent === p.id,
	);
	assert.equal(projected.length, 4);
	assert.equal(projected.filter((e) => nodes.get(e.to).selector === '[special]').length, 3);
	assert.equal(projected.filter((e) => nodes.get(e.to).selector === '*').length, 1);
});
test('framework-only lifecycle/inherited/CVA methods are rescued while unrelated methods remain unrooted', () => {
	for (const [owner, name] of [
		['Leaf', 'ngOnInit'],
		['HookBase', 'ngOnDestroy'],
		['AutoService', 'ngOnDestroy'],
		['CvaProof', 'writeValue'],
		['CvaProof', 'registerOnChange'],
	]) {
		const m = method(owner, name);
		assert.ok(edge('FRAMEWORK_INVOKES', null, m.id));
	}
	assert.equal(
		plain.edges.filter(
			(e) =>
				['CALLS', 'REFERENCES', 'TEMPLATE_CALLS'].includes(e.type) &&
				e.to === method('Leaf', 'ngOnInit').id,
		).length,
		0,
	);
	assert.equal(
		graph.edges.filter(
			(e) => e.type === 'FRAMEWORK_INVOKES' && e.to === method('PlainClass', 'writeValue').id,
		).length,
		0,
	);
	assert.equal(
		graph.edges.filter(
			(e) =>
				[
					'FRAMEWORK_INVOKES',
					'HOST_CALLS',
					'TEMPLATE_CALLS',
					'CALLS',
					'REFERENCES',
				].includes(e.type) && e.to === method('Leaf', 'unused').id,
		).length,
		0,
	);
});
test('optional core pass preserves all existing Angular relationships and validates endpoint/source evidence', () => {
	assert.deepEqual(
		graph.edges.filter((e) => e.provenance === 'angular-compiler'),
		plain.edges.filter((e) => e.provenance === 'angular-compiler'),
	);
	for (const e of graph.edges.filter((e) => e.provenance === 'angular-api-rule')) {
		assert.ok(nodes.has(e.from) && nodes.has(e.to), e.type);
		const l = e.location;
		assert.ok(!l.file.includes('.ngtypecheck.'));
		const s = fs.readFileSync(l.file, 'utf8');
		assert.ok(l.start >= 0 && l.end <= s.length && l.start < l.end, e.type);
	}
	assert.doesNotThrow(() => JSON.stringify(graph));
	assert.ok(graph.complete);
});
test('template handler joins to the injected field, token, contextual provider and implementation', () => {
	const leaf = named('Leaf', 'Component'),
		save = method('Leaf', 'save'),
		q = requests('Leaf', 'worker')[0];
	const ctx = first.find(
		(c) =>
			c.component === leaf.id &&
			nodes.get(c.parent)?.component === named('ScopeBox', 'Component').id &&
			c.relation === 'view',
	);
	const resolution = result(q, ctx);
	const reg = nodes.get(resolution.providers[0]);
	assert.ok(edge('TEMPLATE_CALLS', leaf.id, save.id));
	assert.ok(edge('REFERENCES', save.id, q.owner));
	assert.ok(edge('HAS_INJECTION_REQUEST', q.owner, q.id));
	assert.ok(edge('REQUESTS_TOKEN', q.id, q.token));
	assert.ok(edge('RESOLVES_IN', q.id, resolution.id));
	assert.ok(edge('SELECTS_PROVIDER', resolution.id, reg.id));
	assert.ok(edge('USES_CLASS', reg.id, named('ViewWorker').id));
});
test('independent Angular runtime injector oracle confirms alias/multi/factory and child-scope rules', async () => {
	const require = createRequire(project);
	await import(pathToFileURL(require.resolve('@angular/compiler')).href);
	const ng = await import(pathToFileURL(require.resolve('@angular/core')).href);
	const T = new ng.InjectionToken('token'),
		A = new ng.InjectionToken('alias'),
		M = new ng.InjectionToken('multi'),
		F = new ng.InjectionToken('factory'),
		Missing = new ng.InjectionToken('missing');
	const root = ng.createEnvironmentInjector(
		[
			{ provide: T, useValue: 'root' },
			{ provide: A, useExisting: T },
			{ provide: M, useValue: 1, multi: true },
			{ provide: M, useValue: 2, multi: true },
			{ provide: F, useFactory: (x) => `${x}-factory`, deps: [T] },
		],
		null,
	);
	const child = ng.createEnvironmentInjector([{ provide: T, useValue: 'route' }], root);
	try {
		assert.equal(root.get(A), 'root');
		assert.deepEqual(root.get(M), [1, 2]);
		assert.equal(root.get(F), 'root-factory');
		ng.runInInjectionContext(child, () => {
			assert.equal(ng.inject(T), 'route');
			assert.equal(ng.inject(T, { skipSelf: true }), 'root');
			assert.equal(ng.inject(Missing, { self: true, optional: true }), null);
		});
	} finally {
		child.destroy();
		root.destroy();
	}
});
