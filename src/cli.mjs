#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GraphStore } from './store.mjs';
import { indexWorkspace } from './indexer.mjs';
import { QueryService } from './queries.mjs';
import { QUERY_TOOLS, query } from './api.mjs';

const help = `angular-context-graph index [--workspace path] [--project tsconfig ...] [--full]
angular-context-graph status [--workspace path] [--db path]
angular-context-graph query <tool> [--args '{"id":"..."}'] [--workspace path] [--db path]
angular-context-graph mcp [--workspace path] [--db path]
angular-context-graph export [--snapshot id] [--workspace path] [--db path]
angular-context-graph import --input snapshot.json [--workspace path] [--db path]
angular-context-graph extract --project tsconfig [prototype extraction flags]

Queries: ${Object.keys(QUERY_TOOLS).join(', ')}
Default database: <workspace>/.angular-context-graph/index.sqlite
JSON goes to stdout; diagnostics and index progress go to stderr.
Exit codes: 0 success, 1 error, 2 partial/stale index. Query results report their own freshness.
Legacy --project/--component/--typescript/--template-expressions/--angular-core invocations still work.`;

async function main() {
	const args = process.argv.slice(2);
	if (!args.length || args[0] === '--help' || args[0] === 'help') {
		console.log(help);
		return;
	}
	if (args[0] === 'extract' || args[0].startsWith('--')) {
		if (args[0] === 'extract') process.argv.splice(2, 1);
		await import('./prototype-cli.mjs');
		return;
	}
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			workspace: { type: 'string' },
			project: { type: 'string', multiple: true },
			db: { type: 'string' },
			args: { type: 'string' },
			full: { type: 'boolean' },
			snapshot: { type: 'string' },
			input: { type: 'string' },
			help: { type: 'boolean' },
		},
	});
	if (values.help) {
		console.log(help);
		return;
	}
	const command = positionals[0];
	if (!['index', 'status', 'query', 'mcp', 'export', 'import'].includes(command))
		throw new Error(`Unknown command ${command}; --help shows usage`);
	if (positionals.length > (command === 'query' ? 2 : 1))
		throw new Error('Unexpected positional arguments');
	const workspace = fs.realpathSync(values.workspace ?? process.cwd());
	const store = new GraphStore(
		values.db ?? path.join(workspace, '.angular-context-graph/index.sqlite'),
	);
	const service = new QueryService(store, workspace);
	const output = (value) => console.log(JSON.stringify(value, null, 2));
	let keepOpen = false;
	try {
		if (command === 'index') {
			const manifest = await indexWorkspace(store, {
				workspace,
				projects: values.project ?? [],
				full: values.full,
				onProgress: (progress) => console.error(`${progress.status}: ${progress.unit}`),
			});
			const response = service.get_index_status();
			response.results[0].metrics = manifest.metrics;
			output(response);
			process.exitCode = 2;
		} else if (command === 'status')
			output(
				query(service, 'get_index_status', {
					...(values.snapshot ? { snapshotId: values.snapshot } : {}),
				}),
			);
		else if (command === 'query') {
			const params = values.args ? JSON.parse(values.args) : {};
			output(
				query(service, positionals[1], {
					...params,
					...(values.snapshot ? { snapshotId: values.snapshot } : {}),
				}),
			);
		} else if (command === 'export')
			output(
				store.exportSnapshot(
					service.context(values.snapshot ? { snapshotId: values.snapshot } : {}).manifest
						.id,
				),
			);
		else if (command === 'import') {
			if (!values.input) throw new Error('import requires --input');
			store.importSnapshot(JSON.parse(fs.readFileSync(values.input, 'utf8')));
			output(service.get_index_status());
		} else if (command === 'mcp') {
			const { serveMcp } = await import('./mcp.mjs');
			const server = await serveMcp(store, workspace);
			keepOpen = true;
			let closed = false;
			const close = async () => {
				if (closed) return;
				closed = true;
				await server.close();
				store.close();
			};
			process.once('SIGINT', () => close().then(() => process.exit(0)));
			process.once('SIGTERM', () => close().then(() => process.exit(0)));
			process.stdin.once('end', close);
		}
	} finally {
		if (!keepOpen) store.close();
	}
}
main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
