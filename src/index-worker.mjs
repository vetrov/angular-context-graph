import { extract } from './extract.mjs';

process.once('message', async ({ project }) => {
	try {
		const graph = await extract(project, { angularCore: true, indexInputs: true });
		process.send({ graph, memoryBytes: process.memoryUsage().rss }, () => process.disconnect());
	} catch (error) {
		process.send({ error: error.stack ?? error.message }, () => process.disconnect());
	}
});
