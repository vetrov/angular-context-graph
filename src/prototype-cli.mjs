import { parseArgs } from 'node:util';
import { extract, findComponentUsages, discoverConfigs, EXTRACTION_COVERAGE } from './extract.mjs';

try {
	const { values } = parseArgs({
		options: {
			project: { type: 'string', multiple: true },
			workspace: { type: 'string' },
			component: { type: 'string' },
			typescript: { type: 'boolean' },
			'template-expressions': { type: 'boolean' },
			'angular-core': { type: 'boolean' },
			help: { type: 'boolean' },
		},
	});
	if (values.help) {
		console.log(
			'node src/cli.mjs (--project path/to/tsconfig.json | --workspace path) [--component FooComponent] [--typescript] [--template-expressions] [--angular-core]\nRepeat --project for additional compilation units. Without --component, emits the full normalized extraction. --typescript adds static TypeScript dependencies. --template-expressions also links template calls/references to original TS declarations. --angular-core adds the bounded DI/provider/bootstrap/route/host/query/framework research pass. Unresolved and unrepresented sites are reported separately.',
		);
	} else {
		if (!values.project?.length && !values.workspace)
			throw new Error('Pass --project or --workspace; --help shows usage.');
		if (values['angular-core']) {
			values.typescript = true;
			values['template-expressions'] = true;
		}
		const configs = values.project ?? (await discoverConfigs(values.workspace));
		const graphs = [];
		for (const config of configs)
			graphs.push(
				await extract(config, {
					typescript: values.typescript,
					templateExpressions: values['template-expressions'],
					angularCore: values['angular-core'],
				}),
			);
		const graph = {
			schemaVersion: 1,
			coverage: EXTRACTION_COVERAGE,
			projects: graphs.map((g) => ({
				project: g.project,
				versions: g.versions,
				elapsedMs: g.elapsedMs,
			})),
			complete: graphs.every((g) => g.complete),
			issues: graphs.flatMap((g) => g.issues),
			diagnostics: graphs.flatMap((g) => g.diagnostics),
			...(values.typescript || values['template-expressions']
				? { typescript: graphs.map((g) => ({ project: g.project, ...g.typescript })) }
				: {}),
			...(values['template-expressions']
				? {
						templateExpressions: graphs.map((g) => ({
							project: g.project,
							...g.templateExpressions,
						})),
					}
				: {}),
			...(values['angular-core']
				? { angularCore: graphs.map((g) => ({ project: g.project, ...g.angularCore })) }
				: {}),
			nodes: [...new Map(graphs.flatMap((g) => g.nodes).map((n) => [n.id, n])).values()],
			edges: [
				...new Map(
					graphs.flatMap((g) => g.edges).map((e) => [JSON.stringify(e), e]),
				).values(),
			],
		};
		console.log(
			JSON.stringify(
				values.component ? findComponentUsages(graph, values.component) : graph,
				null,
				2,
			),
		);
		if (!graph.complete) process.exitCode = 2;
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
