import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from '../src/extract.mjs';
const base =
	process.env.SEMANTIC_PROJECT ??
	fileURLToPath(new URL('../fixtures/tsconfig.json', import.meta.url));
const project = path.join(path.dirname(base), 'dependencies/tsconfig.json');
const plain = await extract(project);
const graph = await extract(project, { typescript: true });
const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
const get = (name, kind, file, owner) => {
	const matches = graph.nodes.filter(
		(n) =>
			n.name === name &&
			(n.typescriptKind ?? n.kind) === kind &&
			(!file || n.location.file.endsWith(file)) &&
			(!owner || nodes.get(n.owner)?.name === owner),
	);
	return matches.find((n) => n.hasImplementation) ?? matches[0];
};
const has = (type, from, to) =>
	graph.edges.some((e) => e.type === type && e.from === from.id && e.to === to.id);
const snippet = (l) => fs.readFileSync(l.file, 'utf8').slice(l.start, l.end);
test('TypeScript enrichment preserves every Angular edge and reuses component class identity', () => {
	assert.ok(graph.complete);
	assert.deepEqual(graph.diagnostics, []);
	const angular = graph.edges.filter((e) => e.provenance === 'angular-compiler');
	assert.deepEqual(angular, plain.edges);
	assert.equal(get('DependencyChild', 'Class').kind, 'Component');
	assert.equal(
		graph.nodes.filter(
			(n) => n.name === 'DependencyChild' && ['Class', 'Component'].includes(n.kind),
		).length,
		1,
	);
});
test('path aliases and barrel re-exports resolve imports to actual declarations', () => {
	const helper = get('normalize', 'Function', 'helpers.ts');
	assert.ok(
		graph.edges.some(
			(e) =>
				e.type === 'IMPORTS_SYMBOL' &&
				e.to === helper.id &&
				e.localName === 'normalizeAlias',
		),
	);
	assert.ok(
		graph.edges.some(
			(e) => e.type === 'REEXPORTS_SYMBOL' && e.to === helper.id && e.localName === 'clean',
		),
	);
	assert.ok(
		graph.edges.some(
			(e) =>
				e.type === 'IMPORTS' &&
				e.module === '@helpers' &&
				nodes.get(e.to).location.file.endsWith('/barrel.ts'),
		),
	);
	assert.ok(
		graph.edges.some(
			(e) =>
				e.type === 'IMPORTS_SYMBOL' &&
				e.to === get('Processor', 'Interface').id &&
				e.specifierTypeOnly,
		),
	);
});
test('overloaded aliased call resolves the implementation while retaining the selected signature', () => {
	const call = graph.edges.find(
		(e) => e.type === 'CALLS' && snippet(e.location) === 'normalizeAlias',
	);
	assert.equal(call.to, get('normalize', 'Function', 'helpers.ts').id);
	assert.equal(call.from, get('value', 'Property', 'consumer.ts', 'DependencyParent').id);
	assert.match(snippet(call.signatureLocation), /value:\s*string/);
	assert.equal(call.dispatch, 'source-implementation');
});
test('namespace calls distinguish same-name functions in different files', () => {
	const call = graph.edges.find(
		(e) => e.type === 'CALLS' && snippet(e.location) === 'other.normalize',
	);
	assert.equal(call.to, get('normalize', 'Function', 'other.ts').id);
	assert.notEqual(call.to, get('normalize', 'Function', 'helpers.ts').id);
});
test('method calls, inherited methods, construction, extends and implements resolve', () => {
	const service = get('Service', 'Class');
	const baseService = get('BaseService', 'Class');
	assert.ok(has('EXTENDS', service, baseService));
	assert.ok(has('IMPLEMENTS', service, get('Processor', 'Interface')));
	assert.ok(has('CALLS', get('save', 'Method'), get('run', 'Method', 'helpers.ts', 'Service')));
	assert.ok(
		has('CALLS', get('run', 'Method', 'helpers.ts', 'Service'), get('inherited', 'Method')),
	);
	assert.ok(has('CONSTRUCTS', get('service', 'Property'), service));
});
test('Angular contracts bridge to TS properties used inside ordinary method bodies', () => {
	const input = graph.nodes.find((n) => n.kind === 'Input' && n.name === 'value');
	const output = graph.nodes.find((n) => n.kind === 'Output' && n.name === 'saved');
	for (const contract of [input, output]) {
		const declaration = nodes.get(contract.typescriptDeclaration);
		assert.equal(declaration.kind, 'Property');
		assert.deepEqual(declaration.location, contract.location);
		assert.ok(has('DECLARED_BY', contract, declaration));
		assert.ok(has('REFERENCES', get('save', 'Method'), declaration));
	}
	const usage = graph.edges.find((e) => e.type === 'TEMPLATE_USES');
	assert.equal(usage.to, get('DependencyChild', 'Class').id);
	const bound = graph.edges.find((e) => e.type === 'BINDS_INPUT');
	assert.equal(bound.to, input.id);
});
test('interface calls are declaration-only and callable parameters remain unresolved', () => {
	const call = graph.edges.find(
		(e) => e.type === 'CALLS' && snippet(e.location) === 'processor.run',
	);
	assert.equal(call.to, get('run', 'Method', 'helpers.ts', 'Processor').id);
	assert.equal(nodes.get(call.to).owner, get('Processor', 'Interface').id);
	assert.equal(call.dispatch, 'declaration-only');
	assert.ok(graph.typescript.unresolvedCalls.some((c) => c.expression === 'callback'));
	assert.ok(!graph.edges.some((e) => e.type === 'CALLS' && snippet(e.location) === 'callback'));
	assert.ok(graph.typescript.unresolvedCalls.some((c) => c.expression === 'target.run'));
	assert.ok(!graph.edges.some((e) => e.type === 'CALLS' && snippet(e.location) === 'target.run'));
	assert.equal(graph.typescript.allCallsResolved, false);
});
test('local function aliases resolve through their actual signature declaration', () => {
	const call = graph.edges.find(
		(e) => e.type === 'CALLS' && snippet(e.location) === 'functionAlias',
	);
	assert.equal(call.to, get('normalize', 'Function', 'helpers.ts').id);
	const arrowCall = graph.edges.find(
		(e) => e.type === 'CALLS' && snippet(e.location) === 'arrow',
	);
	assert.equal(nodes.get(arrowCall.to).kind, 'Function');
	assert.equal(nodes.get(nodes.get(arrowCall.to).owner).name, 'arrow');
	assert.equal(arrowCall.dispatch, 'source-implementation');
});
test('literal dynamic imports resolve to a module dependency rather than a function call', () => {
	assert.ok(
		graph.edges.some(
			(e) =>
				e.type === 'IMPORTS' &&
				e.dynamic &&
				e.module === './other' &&
				nodes.get(e.to).location.file.endsWith('/other.ts'),
		),
	);
});
test('TS positions reference original files and no generated type-check files enter the graph', () => {
	assert.ok(!graph.nodes.some((n) => n.location.file.includes('.ngtypecheck.')));
	for (const e of graph.edges.filter((e) => e.provenance === 'typescript-checker')) {
		assert.ok(nodes.has(e.from) && nodes.has(e.to));
		const lines = fs
			.readFileSync(e.location.file, 'utf8')
			.slice(0, e.location.start)
			.split('\n');
		assert.equal(e.location.line, lines.length);
		assert.equal(e.location.column, lines.at(-1).length + 1);
	}
	assert.equal(graph.typescript.unresolvedModules.length, 0);
});
