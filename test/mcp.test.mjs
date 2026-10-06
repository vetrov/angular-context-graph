import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RESPONSE_SCHEMA, QUERY_TOOLS } from '../src/api.mjs';
import { GraphStore } from '../src/store.mjs';
import { QueryService } from '../src/queries.mjs';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
test('stdio MCP handshake, schema-valid query, error, explicit index and restart use the shared store', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'angular-mcp-tests-'));
	const db = path.join(root, 'index.sqlite');
	fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
	fs.cpSync(path.join(repo, 'fixtures'), path.join(root, 'fixtures'), {
		recursive: true,
		filter: (file) => !path.basename(file).startsWith('.test-project-'),
	});
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(repo, 'src/cli.mjs'), 'mcp', '--workspace', root, '--db', db],
		stderr: 'pipe',
	});
	const client = new Client({ name: 'acceptance-client', version: '1.0.0' });
	let errors = '';
	transport.stderr?.on('data', (data) => (errors += data));
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		assert.equal(tools.tools.length, Object.keys(QUERY_TOOLS).length + 1);
		assert.ok(tools.tools.every((t) => t.outputSchema));
		assert.equal(
			tools.tools.find((t) => t.name === 'find_entities').annotations.readOnlyHint,
			true,
		);
		assert.equal(
			tools.tools.find((t) => t.name === 'index_workspace').annotations.readOnlyHint,
			false,
		);
		const empty = await client.callTool({ name: 'get_index_status', arguments: {} });
		assert.equal(RESPONSE_SCHEMA.parse(empty.structuredContent).freshness.status, 'unindexed');
		const indexed = await client.callTool(
			{ name: 'index_workspace', arguments: { projects: ['fixtures/tsconfig.json'] } },
			undefined,
			{ timeout: 30000 },
		);
		assert.equal(indexed.isError, undefined, JSON.stringify(indexed.content));
		const snapshot = RESPONSE_SCHEMA.parse(indexed.structuredContent).snapshotId;
		assert.ok(snapshot);
		const found = await client.callTool({
			name: 'find_entities',
			arguments: { text: 'FooComponent', kinds: ['Component'] },
		});
		const response = RESPONSE_SCHEMA.parse(found.structuredContent);
		assert.ok(response.results.some((n) => n.name === 'FooComponent'));
		const store = new GraphStore(db);
		try {
			const expected = new QueryService(store, root).find_entities({
				text: 'FooComponent',
				kinds: ['Component'],
			});
			assert.deepEqual(response.results, expected.results);
		} finally {
			store.close();
		}
		const bad = await client.callTool({ name: 'get_entity', arguments: { id: 'missing' } });
		assert.equal(bad.isError, true);
		const invalid = await client.callTool({ name: 'find_entities', arguments: { limit: -1 } });
		assert.equal(invalid.isError, true);
		assert.ok(!errors.includes('Unhandled'));
		const restart = spawnSync(
			process.execPath,
			[path.join(repo, 'src/cli.mjs'), 'status', '--workspace', root, '--db', db],
			{ encoding: 'utf8' },
		);
		assert.equal(restart.status, 0);
		assert.equal(JSON.parse(restart.stdout).snapshotId, snapshot);
	} finally {
		await client.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test('CLI JSON queries, legacy extraction, partial exit code and invalid command diagnostics', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'angular-cli-tests-'));
	const db = path.join(root, 'index.sqlite');
	const run = (args) =>
		spawnSync(process.execPath, [path.join(repo, 'src/cli.mjs'), ...args], {
			cwd: repo,
			encoding: 'utf8',
		});
	try {
		const index = run(['index', '--project', 'fixtures/tsconfig.json', '--db', db]);
		assert.equal(index.status, 2);
		RESPONSE_SCHEMA.parse(JSON.parse(index.stdout));
		const query = run([
			'query',
			'find_entities',
			'--args',
			'{"text":"FooComponent","kinds":["Component"]}',
			'--db',
			db,
		]);
		assert.equal(query.status, 0);
		assert.ok(JSON.parse(query.stdout).results.some((n) => n.name === 'FooComponent'));
		const legacy = run(['--project', 'fixtures/tsconfig.json', '--component', 'FooComponent']);
		assert.equal(legacy.status, 0);
		assert.equal(JSON.parse(legacy.stdout).usages.length, 9);
		const invalid = run(['unknown']);
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /Unknown command/);
		assert.equal(invalid.stdout, '');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
