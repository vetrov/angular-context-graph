import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { QueryService } from './queries.mjs';
import { indexWorkspace } from './indexer.mjs';
import { QUERY_TOOLS, INDEX_INPUT, RESPONSE_SCHEMA, query } from './api.mjs';

export function createMcpServer(store, workspace) {
	const server = new McpServer({ name: 'angular-context-graph', version: '0.1.0' });
	const service = new QueryService(store, workspace);
	const result = (value) => ({
		content: [
			{
				type: 'text',
				text: `${value.results.length} result(s); snapshot ${value.snapshotId ?? 'none'}; ${value.freshness.status}${value.truncated ? '; truncated (see bounds/cursor)' : ''}. Results are in structuredContent.`,
			},
		],
		structuredContent: value,
	});
	const error = (exception) => ({
		isError: true,
		content: [{ type: 'text', text: exception.message }],
	});
	for (const [name, tool] of Object.entries(QUERY_TOOLS))
		server.registerTool(
			name,
			{
				description: tool.description,
				inputSchema: tool.input,
				outputSchema: RESPONSE_SCHEMA,
				annotations: {
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			async (args) => {
				try {
					return result(query(service, name, args));
				} catch (exception) {
					return error(exception);
				}
			},
		);
	server.registerTool(
		'index_workspace',
		{
			description:
				'Explicitly index the server workspace using its installed Angular/TS packages. Publish an atomic snapshot, reusing unchanged units. Never install dependencies or emit builds.',
			inputSchema: INDEX_INPUT,
			outputSchema: RESPONSE_SCHEMA,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (args, extra) => {
			try {
				const manifest = await indexWorkspace(store, {
					workspace,
					...INDEX_INPUT.parse(args),
					signal: extra.signal,
				});
				const response = service.get_index_status();
				response.results[0].metrics = manifest.metrics;
				return result(RESPONSE_SCHEMA.parse(response));
			} catch (exception) {
				return error(exception);
			}
		},
	);
	return server;
}
export async function serveMcp(store, workspace) {
	const server = createMcpServer(store, workspace);
	await server.connect(new StdioServerTransport());
	return server;
}
