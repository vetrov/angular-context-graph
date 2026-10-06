import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from '../src/extract.mjs';
const base =
	process.env.SEMANTIC_PROJECT ??
	fileURLToPath(new URL('../fixtures/tsconfig.json', import.meta.url));
const project = path.join(path.dirname(base), 'angular-relations/tsconfig.json');
const plain = await extract(project, { typescript: true });
const graph = await extract(project, { templateExpressions: true });
const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
const component = graph.nodes.find(
	(n) => n.name === 'ConnectedComponent' && n.kind === 'Component',
);
const method = (owner, name) =>
	graph.nodes.find(
		(n) => n.kind === 'Method' && n.name === name && nodes.get(n.owner)?.name === owner,
	);
const incoming = (n) =>
	graph.edges.filter(
		(e) =>
			e.to === n.id &&
			['REFERENCES', 'CALLS', 'TEMPLATE_REFERENCES', 'TEMPLATE_CALLS'].includes(e.type),
	);
test('template calls and callback references link to actual component methods', () => {
	for (const name of ['save', 'format', 'callbackOnly'])
		assert.ok(
			incoming(method('ConnectedComponent', name)).some(
				(e) => e.provenance === 'angular-template-checker',
			),
		);
	assert.equal(
		incoming(method('ConnectedComponent', 'save')).filter((e) => e.type === 'TEMPLATE_CALLS')
			.length,
		1,
	);
	assert.equal(
		incoming(method('ConnectedComponent', 'callbackOnly')).filter(
			(e) => e.type === 'TEMPLATE_CALLS',
		).length,
		0,
	);
});
test('template receiver resolution distinguishes inherited, service, child-reference and row methods', () => {
	for (const [owner, name, count] of [
		['BaseComponent', 'inherited', 1],
		['ApiService', 'run', 1],
		['ActionChild', 'ping', 1],
		['Row', 'save', 2],
	]) {
		assert.equal(
			graph.edges.filter(
				(e) => e.type === 'TEMPLATE_CALLS' && e.to === method(owner, name).id,
			).length,
			count,
		);
	}
	const own = graph.edges.find(
		(e) => e.type === 'TEMPLATE_CALLS' && e.to === method('ConnectedComponent', 'save').id,
	);
	assert.match(
		fs.readFileSync(own.location.file, 'utf8').split('\n')[own.location.line - 1],
		/\(click\)="save\(\)"/,
	);
});
test('a template-only usage is rescued from the TS-only unused candidate set', () => {
	const id = method('ConnectedComponent', 'format').id;
	assert.equal(
		plain.edges.filter((e) => e.to === id && ['REFERENCES', 'CALLS'].includes(e.type)).length,
		0,
	);
	assert.ok(incoming(method('ConnectedComponent', 'format')).length > 0);
	assert.equal(incoming(method('ConnectedComponent', 'unused')).length, 0);
	// ngOnInit is also unreferenced: this illustrates why lifecycle roots need an explicit layer.
	assert.equal(incoming(method('ConnectedComponent', 'ngOnInit')).length, 0);
});
test('template call and regular call join into component-handler to service dependency', () => {
	const handler = method('ConnectedComponent', 'save'),
		service = method('ApiService', 'run');
	assert.ok(
		graph.edges.some(
			(e) => e.type === 'TEMPLATE_CALLS' && e.from === component.id && e.to === handler.id,
		),
	);
	assert.ok(
		graph.edges.some((e) => e.type === 'CALLS' && e.from === handler.id && e.to === service.id),
	);
});
test('template method edge source ranges are original names, not generated TCB positions', () => {
	const additions = graph.edges.filter((e) => e.provenance === 'angular-template-checker');
	assert.ok(additions.length > 0);
	for (const e of additions) {
		assert.ok(!e.location.file.includes('.ngtypecheck.'));
		assert.ok(!nodes.get(e.to).location.file.includes('.ngtypecheck.'));
		const text = fs.readFileSync(e.location.file, 'utf8');
		assert.equal(text.slice(e.location.start, e.location.end), e.name);
		const lines = text.slice(0, e.location.start).split('\n');
		assert.equal(e.location.line, lines.length);
		assert.equal(e.location.column, lines.at(-1).length + 1);
	}
});
test('expression enrichment preserves existing Angular usage/binding edges', () => {
	assert.deepEqual(
		graph.edges.filter((e) => e.provenance === 'angular-compiler'),
		plain.edges.filter((e) => e.provenance === 'angular-compiler'),
	);
	assert.ok(graph.complete);
	assert.deepEqual(graph.diagnostics, []);
});
