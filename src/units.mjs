import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { unitId } from './model.mjs';
import { hash } from './inputs.mjs';

export function discoverUnits(root, projects = []) {
	root = path.resolve(root);
	if (projects.length)
		return {
			units: [...new Set(projects.map((project) => path.resolve(root, project)))].map(
				(project) => {
					const spec = {
						project,
						name: path.relative(root, project),
						mode: 'explicit',
						settings: {},
					};
					return { ...spec, id: unitId(spec) };
				},
			),
			missingUnits: [],
			discoveryFile: null,
		};
	const file = path.join(root, 'angular.json');
	const require = createRequire(path.join(root, '__graph_discovery__.cjs'));
	const ts = require('typescript');
	let discoveryState;
	const { config, error } = ts.readConfigFile(file, (f) => {
		const text = fs.readFileSync(f, 'utf8');
		discoveryState = hash(text);
		return text;
	});
	if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
	const units = [];
	const missingUnits = [];
	for (const [name, project] of Object.entries(config.projects ?? {})) {
		const build = (project.architect ?? project.targets)?.build;
		if (!build) {
			missingUnits.push({
				name,
				status: 'not-requested',
				reason: 'No build target; supply --project for custom/Nx units.',
			});
			continue;
		}
		const variants = [
			['default', build.options ?? {}],
			...Object.entries(build.configurations ?? {}).map(([variant, options]) => [
				variant,
				{ ...build.options, ...options },
			]),
		];
		for (const [variant, settings] of variants) {
			const spec = {
				name: `${name}:build:${variant}`,
				project:
					typeof settings.tsConfig === 'string'
						? path.resolve(root, settings.tsConfig)
						: null,
				mode: 'angular-build',
				builder: build.builder,
				settings,
			};
			spec.id = unitId(spec);
			const reason = !spec.project
				? 'No tsConfig in this target.'
				: settings.fileReplacements?.length
					? 'Build file replacements are not supported; supply an effective tsconfig explicitly.'
					: ![
								'@angular/build:application',
								'@angular-devkit/build-angular:application',
								'@angular-devkit/build-angular:browser',
								'@angular-devkit/build-angular:browser-esbuild',
								'@angular-devkit/build-angular:server',
						  ].includes(build.builder)
						? 'Custom builder/resource transforms are not supported; supply an effective tsconfig explicitly.'
						: null;
			if (reason) missingUnits.push({ ...spec, status: 'unsupported', reason });
			else units.push(spec);
		}
	}
	return {
		units: units.sort((a, b) => a.id.localeCompare(b.id)),
		missingUnits,
		discoveryFile: file,
		discoveryState,
	};
}
