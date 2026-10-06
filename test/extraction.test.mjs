import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { extract, findComponentUsages, discoverConfigs } from '../src/extract.mjs';

const project =
	process.env.SEMANTIC_PROJECT ??
	fileURLToPath(new URL('../fixtures/tsconfig.json', import.meta.url));
const graph = await extract(project);
const result = findComponentUsages(graph, 'FooComponent');
const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const main = result.usages.find((u) => u.parent.name === 'InlineParent' && u.bindings.length > 2);
const snippet = (loc) => fs.readFileSync(loc.file, 'utf8').slice(loc.start, loc.end);
const binding = (name) => main.bindings.find((b) => b.publicName === name);

test('loads the target Angular and TypeScript versions, with no compilation errors', () => {
	assert.equal(graph.complete, true);
	assert.deepEqual(graph.issues, []);
	assert.equal(graph.versions.compiler, graph.versions.core);
	assert.equal(graph.versions.compilerCli, graph.versions.core);
	const targetRequire = createRequire(path.resolve(project));
	assert.equal(graph.versions.core, targetRequire('@angular/core/package.json').version);
	assert.equal(graph.versions.typescript, targetRequire('typescript/package.json').version);
});

test('finds the nine actual Foo template sites without desugared duplicates', () => {
	assert.match(
		result.coverage,
		/Excludes route rendering, bootstrap, and dynamic component creation/,
	);
	assert.equal(result.usages.length, 9);
	assert.deepEqual(
		result.usages.reduce((a, u) => ((a[u.parent.name] = (a[u.parent.name] ?? 0) + 1), a), {}),
		{
			InlineParent: 6,
			ExternalParent: 1,
			ModuleParent: 1,
			EscapedParent: 1,
		},
	);
});

test('distinguishes identical selectors in different scopes and excludes schema-only elements', () => {
	assert.equal(findComponentUsages(graph, 'OtherFooComponent').usages.length, 1);
	assert.equal(
		findComponentUsages(graph, 'OtherFooComponent').usages[0].parent.name,
		'OtherParent',
	);
	assert.ok(!graph.edges.some((e) => byId.get(e.from)?.name === 'UnknownParent'));
});

test('maps aliased decorator inputs and outputs to class members', () => {
	assert.equal(binding('publicValue').target.name, 'value');
	assert.equal(binding('publicChanged').target.name, 'changed');
	assert.equal(snippet(binding('publicValue').target.location), 'value');
});

test('resolves signal input/output aliases even when getSymbolOfNode(input) is null', () => {
	assert.equal(binding('signalAlias').target.name, 'signalValue');
	assert.equal(binding('signalAlias').target.isSignal, true);
	assert.equal(binding('signalChanged').target.name, 'signalEvent');
});

test('preserves the inherited declaration and the concrete component contract', () => {
	assert.equal(binding('legacy').target.declaringClass, 'BaseContract');
	assert.equal(byId.get(binding('legacy').target.owner).name, 'FooComponent');
	assert.equal(binding('legacyChanged').target.declaringClass, 'BaseContract');
});

test('records both halves of model two-way binding against the same class member', () => {
	assert.equal(binding('count').twoWay, true);
	assert.equal(binding('countChange').twoWay, true);
	assert.equal(binding('count').target.name, 'count');
	assert.equal(binding('countChange').target.name, 'count');
	assert.equal(snippet(binding('count').location), '[(count)]="count"');
});

test('applies host directive exposure aliases without assigning them to the component', () => {
	const host = graph.edges.filter(
		(e) => e.site === main.site && byId.get(e.to)?.owner?.endsWith('#HostBehavior'),
	);
	assert.deepEqual(
		host.map((e) => [e.publicName, byId.get(e.to).name]),
		[
			['exposed', 'hostValue'],
			['exposedChanged', 'hostEvent'],
		],
	);
	assert.ok(!main.bindings.some((e) => e.publicName === 'exposed'));
});

test('keeps every consumer when a component and directive share input/output aliases', () => {
	const shared = graph.edges.filter(
		(e) => e.site === main.site && ['publicValue', 'publicChanged'].includes(e.publicName),
	);
	assert.deepEqual(shared.map((e) => byId.get(e.to).name).sort(), [
		'accentChanged',
		'accentValue',
		'changed',
		'value',
	]);
});

test('includes literal input attributes but excludes DOM properties and events', () => {
	assert.equal(
		result.usages.flatMap((u) => u.bindings).filter((b) => b.syntax === 'text').length,
		2,
	);
	assert.ok(!graph.edges.some((e) => ['click', 'title'].includes(e.publicName)));
});

test('resolves both pipe occurrences to the pipe class and exact name spans', () => {
	const pipes = graph.edges.filter((e) => e.type === 'USES_PIPE');
	assert.equal(pipes.length, 2);
	for (const edge of pipes) {
		assert.equal(byId.get(edge.to).name, 'ShoutPipe');
		assert.equal(snippet(edge.location), 'shout');
	}
});

test('all usage/binding locations point into original TS/HTML, including escaped inline literals', () => {
	for (const edge of graph.edges) {
		assert.ok(!edge.location.file.endsWith('.ngtypecheck.ts'));
		assert.ok(edge.location.end > edge.location.start);
		const text = fs.readFileSync(edge.location.file, 'utf8');
		const lines = text.slice(0, edge.location.start).split('\n');
		assert.equal(edge.location.line, lines.length);
		assert.equal(edge.location.column, lines.at(-1).length + 1);
	}
	for (const usage of result.usages) assert.ok(snippet(usage.location).startsWith('<app-foo'));
	const ext = result.usages.find((u) => u.parent.name === 'ExternalParent');
	assert.ok(ext.location.file.endsWith('external.html'));
	assert.equal(snippet(ext.bindings[0].location), '[publicValue]="title"');
});

test('rejects missing or ambiguous component names', () => {
	assert.throws(() => findComponentUsages(graph, 'Missing'), /found 0/);
	const duplicate = {
		...graph,
		nodes: [...graph.nodes, { ...result.component, id: 'different#FooComponent' }],
	};
	assert.throws(() => findComponentUsages(duplicate, 'FooComponent'), /found 2/);
	assert.equal(findComponentUsages(duplicate, result.component.id).usages.length, 9);
});

async function temporaryProject(source, run) {
	const dir = fs.mkdtempSync(path.join(path.dirname(project), '.test-project-'));
	try {
		fs.writeFileSync(
			path.join(dir, 'tsconfig.json'),
			JSON.stringify({ extends: '../tsconfig.json', include: ['sample.ts'] }),
		);
		fs.writeFileSync(path.join(dir, 'sample.ts'), source);
		await run(path.join(dir, 'tsconfig.json'), dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('fails on unknown bindings rather than reporting a complete index', async () => {
	await temporaryProject(
		`import {Component} from '@angular/core';
    @Component({standalone:true,template:'<div [notARealProperty]="1" />'}) export class Broken {}`,
		async (config) => {
			await assert.rejects(() => extract(config), /Project compilation failed/);
		},
	);
});

test('marks indirect constant templates incomplete instead of claiming exact source locations', async () => {
	await temporaryProject(
		`import {Component} from '@angular/core'; const TEMPLATE = '<span>' + 'text</span>';
    @Component({standalone:true,template:TEMPLATE}) export class Indirect {}`,
		async (config) => {
			const g = await extract(config);
			assert.equal(g.complete, false);
			assert.match(g.issues[0].reason, /Indirect inline/);
		},
	);
});

test('discovers build tsconfigs from angular.json including configurations and targets syntax', async () => {
	await temporaryProject('', async (config, dir) => {
		fs.writeFileSync(
			path.join(dir, 'angular.json'),
			`{// JSONC is permitted\n"projects":{"app":{"targets":{"build":{
      "options":{"tsConfig":"tsconfig.json"},"configurations":{"test":{"tsConfig":"test.json"},"prod":{"tsConfig":"tsconfig.json"}}
    }}}}}`,
		);
		assert.deepEqual(await discoverConfigs(dir), [config, path.join(dir, 'test.json')]);
	});
});

console.log(
	JSON.stringify({
		versions: graph.versions,
		elapsedMs: graph.elapsedMs,
		usages: result.usages.length,
		edges: graph.edges.reduce(
			(counts, e) => ((counts[e.type] = (counts[e.type] ?? 0) + 1), counts),
			{},
		),
	}),
);
