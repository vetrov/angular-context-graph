import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAdapter } from './adapter.mjs';
import { addTypeScriptDependencies } from './typescript.mjs';
import { addAngularCore } from './angular-core.mjs';
import { createInputTracker } from './inputs.mjs';

export const EXTRACTION_COVERAGE =
	'Static template sites in analyzed TypeScript programs. Excludes route rendering, bootstrap, and dynamic component creation. Conditional/deferred sites do not prove runtime execution.';

export async function loadProject(project, options = {}) {
	const configPath = path.resolve(project);
	// Resolve FROM the target config, never from the extractor's dependencies.
	const require = createRequire(path.join(path.dirname(configPath), '__semantic_loader__.cjs'));
	const compilerRequire = createRequire(require.resolve('@angular/compiler-cli'));
	for (const name of ['typescript', '@angular/compiler']) {
		if (
			fs.realpathSync(require.resolve(name)) !==
			fs.realpathSync(compilerRequire.resolve(name))
		) {
			throw new Error(
				`Target and compiler-cli resolve different ${name} installations; repair the project's peer dependencies.`,
			);
		}
	}
	const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
	const [ngc, ng, tsModule] = await Promise.all([
		load('@angular/compiler-cli'),
		load('@angular/compiler'),
		load('typescript'),
	]);
	const ts = tsModule.default ?? tsModule;
	const versions = {
		compilerCli: ngc.VERSION.full,
		compiler: ng.VERSION.full,
		core: require('@angular/core/package.json').version,
		typescript: ts.version,
	};
	if (versions.compiler !== versions.compilerCli || versions.core !== versions.compiler) {
		throw new Error(`Angular versions must match: ${JSON.stringify(versions)}`);
	}
	if (![20, 21, 22].includes(Number(versions.compiler.split('.')[0]))) {
		throw new Error(`No experimental adapter for Angular ${versions.compiler}`);
	}
	const tracker = options.indexInputs ? createInputTracker() : null;
	const originalFileSystem = ngc.getFileSystem();
	let config;
	try {
		// Angular config globbing consults the global filesystem, not just its host argument.
		if (tracker) ngc.setFileSystem(tracker.wrap(originalFileSystem));
		config = ngc.readConfiguration(configPath);
	} finally {
		if (tracker) ngc.setFileSystem(originalFileSystem);
	}
	const compilerOptions = {
		...config.options,
		noEmit: true,
		strictTemplates: true,
		_enableTemplateTypeChecker: true,
	};
	if (['local', 'experimental-local'].includes(compilerOptions.compilationMode))
		throw new Error(
			'Local compilation mode is unsupported; use a global/partial project config',
		);
	const format = (diagnostics) =>
		ts.formatDiagnostics(diagnostics, {
			getCurrentDirectory: () => path.dirname(configPath),
			getCanonicalFileName: (f) => f,
			getNewLine: () => '\n',
		});
	if (config.errors.length) throw new Error(format(config.errors));
	// NgtscProgram performs its own installed TypeScript compatibility check.
	const host = ngc.createCompilerHost({ options: compilerOptions });
	const program = new ngc.NgtscProgram(
		config.rootNames,
		compilerOptions,
		tracker?.wrap(host) ?? host,
	);
	const adapter = createAdapter(program, ts, ng);
	const diagnostics = [
		...program.getTsOptionDiagnostics(),
		...program.getNgOptionDiagnostics(),
		...program.getTsSyntacticDiagnostics(),
		...program.getNgStructuralDiagnostics(),
		...program.getTsSemanticDiagnostics(),
		...program.getNgSemanticDiagnostics(),
	];
	const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
	if (errors.length)
		throw new Error(
			`Project compilation failed; no complete index emitted.\n${format(errors)}`,
		);
	if (tracker) {
		for (const name of [
			'typescript',
			'@angular/compiler',
			'@angular/compiler-cli',
			'@angular/core',
		])
			tracker.record('file', require.resolve(`${name}/package.json`));
		for (let dir = path.dirname(configPath); ; dir = path.dirname(dir)) {
			for (const name of [
				'package.json',
				'package-lock.json',
				'pnpm-lock.yaml',
				'yarn.lock',
				'angular.json',
			]) {
				const file = path.join(dir, name);
				tracker.record('exists', file);
				if (fs.existsSync(file)) tracker.record('file', file);
			}
			if (dir === path.dirname(dir)) break;
		}
	}
	return {
		configPath,
		versions,
		ts,
		ng,
		program,
		adapter,
		tracker,
		diagnostics: diagnostics.map((d) => ({
			code: d.code,
			message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
		})),
	};
}

function location(span) {
	return {
		file: path.resolve(span.start.file.url),
		start: span.start.offset,
		end: span.end.offset,
		line: span.start.line + 1,
		column: span.start.col + 1,
	};
}

function declarationLocation(node) {
	const sf = node.getSourceFile();
	const start = node.name?.getStart() ?? node.getStart();
	const lc = sf.getLineAndCharacterOfPosition(start);
	return {
		file: path.resolve(sf.fileName),
		start,
		end: node.name?.getEnd() ?? node.getEnd(),
		line: lc.line + 1,
		column: lc.character + 1,
	};
}

const ignored = new Set([
	'sourceSpan',
	'keySpan',
	'valueSpan',
	'nameSpan',
	'startSourceSpan',
	'endSourceSpan',
	'handlerSpan',
	'i18n',
]);
// Walk compiler-provided AST nodes, including expression nodes and control-flow containers.
function walk(value, visit, origin = null, seen = new WeakSet()) {
	if (!value || typeof value !== 'object' || seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit, origin, seen);
		return;
	}
	const source = value.sourceSpan?.start?.file ? value.sourceSpan : origin;
	if (typeof value.visit === 'function') visit(value, source);
	for (const [key, child] of Object.entries(value)) {
		if (!ignored.has(key)) walk(child, visit, source, seen);
	}
}

export async function extract(project, options = {}) {
	if (options.angularCore) options = { ...options, typescript: true, templateExpressions: true };
	const started = performance.now();
	const { configPath, versions, ts, ng, program, adapter, diagnostics, tracker } =
		await loadProject(project, options);
	const nodes = new Map();
	const edges = new Map();
	const issues = [];
	const templateReferences = [];
	const unresolvedExpressions = [];
	const templates = [];
	function registerClass(declaration, kind, metadata = {}) {
		const loc = declarationLocation(declaration);
		const id = `${loc.file}#${declaration.name.text}`;
		if (nodes.has(id) && nodes.get(id).location.start !== loc.start)
			throw new Error(`Declaration identity collision: ${id}`);
		if (!nodes.has(id))
			nodes.set(id, { id, kind, name: declaration.name.text, location: loc, ...metadata });
		return id;
	}
	function edge(type, from, to, loc, more = {}) {
		const item = {
			type,
			from,
			to,
			location: loc,
			compilationUnit: configPath,
			confidence: 'exact',
			provenance: 'angular-compiler',
			...more,
		};
		edges.set(JSON.stringify([type, from, to, loc.file, loc.start, loc.end, more.site]), item);
	}
	// The program closure includes imported sources, not just tsconfig rootNames.
	const classes = [];
	for (const sf of program.getTsProgram().getSourceFiles()) {
		if (sf.isDeclarationFile || sf.fileName.endsWith('.ngtypecheck.ts')) continue;
		const collect = (n) => {
			if (ts.isClassDeclaration(n) && n.name) classes.push(n);
			ts.forEachChild(n, collect);
		};
		collect(sf);
	}
	for (const component of classes) {
		const info = adapter.declarationInfo(component);
		if (!info) continue;
		const owner = registerClass(component, info.kind, info);
		if (info.kind !== 'Component') continue;
		const template = adapter.getTemplate(component);
		if (!template) {
			issues.push({ component: owner, reason: 'No resolved template' });
			continue;
		}
		if (!adapter.canMapTemplate(component)) {
			issues.push({
				component: owner,
				reason: 'Indirect inline template cannot be mapped exactly; skipped',
			});
			continue;
		}
		if (tracker) {
			const resource = adapter.templateResource(component);
			if (resource?.path) {
				const file = path.resolve(resource.path);
				const text = fs.readFileSync(file, 'utf8');
				tracker.record('file', file);
				templates.push({
					owner,
					inline: false,
					location: { file, start: 0, end: text.length, line: 1, column: 1 },
				});
			} else if (resource?.node && ts.isStringLiteralLike(resource.node)) {
				const node = resource.node;
				const sf = node.getSourceFile();
				const start = node.getStart(sf) + 1;
				const lc = sf.getLineAndCharacterOfPosition(start);
				templates.push({
					owner,
					inline: true,
					location: {
						file: path.resolve(sf.fileName),
						start,
						end: node.getEnd() - 1,
						line: lc.line + 1,
						column: lc.character + 1,
					},
				});
			}
		}
		walk(template, (node, origin) => {
			if (
				options.templateExpressions &&
				origin &&
				(node instanceof ng.PropertyRead || node instanceof ng.SafePropertyRead)
			) {
				const span = node.nameSpan;
				const declaration = adapter.expressionDeclaration(node, component);
				if (declaration)
					templateReferences.push({
						type: 'TEMPLATE_REFERENCES',
						owner,
						declaration,
						span: { file: origin.start.file, start: span.start, end: span.end },
						name: node.name,
					});
				// Null can legitimately denote a template-local variable or $event.
			}
			if (
				options.templateExpressions &&
				origin &&
				(node instanceof ng.Call || node instanceof ng.SafeCall)
			) {
				const receiver = node.receiver;
				const direct =
					receiver instanceof ng.PropertyRead || receiver instanceof ng.SafePropertyRead;
				const declaration = direct
					? adapter.expressionDeclaration(receiver, component)
					: null;
				const span = receiver.nameSpan ?? receiver.sourceSpan;
				if (declaration)
					templateReferences.push({
						type: 'TEMPLATE_CALLS',
						owner,
						declaration,
						span: { file: origin.start.file, start: span.start, end: span.end },
						name: receiver.name ?? '<expression>',
					});
				else
					unresolvedExpressions.push({
						component: owner,
						expression: receiver.name ?? receiver.constructor.name,
						file: path.resolve(origin.start.file.url),
						start: span.start,
						end: span.end,
						reason: 'No concrete original-source declaration resolved',
					});
			}
			const isHost = [
				ng.TmplAstElement,
				ng.TmplAstTemplate,
				ng.TmplAstComponent,
				ng.TmplAstDirective,
			].some((type) => type && node instanceof type);
			if (isHost) {
				const loc = location(node.startSourceSpan ?? node.sourceSpan);
				const site = `${configPath}::${owner}@${loc.file}:${loc.start}:${node.constructor.name}`;
				const matches = adapter.matched(node, component);
				for (const match of matches) {
					const target = registerClass(
						match.declaration,
						match.isComponent ? 'Component' : 'Directive',
						{
							selector: match.selector,
							standalone: match.standalone,
						},
					);
					edge(
						match.isComponent ? 'TEMPLATE_USES' : 'USES_DIRECTIVE',
						owner,
						target,
						loc,
						{ site, hostDirective: match.host },
					);
					function bind(binding, output = false) {
						// Attribute/class/style/animation bindings do not target Angular inputs.
						if (
							!output &&
							binding instanceof ng.TmplAstBoundAttribute &&
							![ng.BindingType.Property, ng.BindingType.TwoWay].includes(binding.type)
						)
							return;
						if (output && binding.target) return; // (window:event), etc.
						for (const contract of adapter.contracts(match, binding.name, output)) {
							const member = adapter.member(match, contract);
							if (!member) {
								issues.push({
									component: owner,
									reason: `Unresolved member ${target}.${contract.classPropertyName}`,
								});
								continue;
							}
							const memberId = `${target}.${output ? 'output' : 'input'}:${contract.classPropertyName}`;
							nodes.set(memberId, {
								id: memberId,
								kind: output ? 'Output' : 'Input',
								name: contract.classPropertyName,
								owner: target,
								publicName: contract.bindingPropertyName,
								location: declarationLocation(member),
								declaringClass: member.parent?.name?.text ?? null,
								isSignal: contract.isSignal ?? false,
							});
							const type = output ? 'LISTENS_OUTPUT' : 'BINDS_INPUT';
							edge(type, owner, memberId, location(binding.sourceSpan), {
								site,
								publicName: binding.name,
								syntax: output
									? 'event'
									: binding instanceof ng.TmplAstTextAttribute
										? 'text'
										: 'property',
								twoWay: output
									? binding.type === ng.ParsedEventType.TwoWay
									: binding.type === ng.BindingType.TwoWay,
							});
						}
					}
					for (const binding of [
						...(node.inputs ?? []),
						...(node.attributes ?? []),
						...(node.templateAttrs ?? []),
					])
						bind(binding);
					for (const binding of node.outputs ?? []) bind(binding, true);
				}
			}
			if (node instanceof ng.BindingPipe) {
				const declaration = adapter.pipe(node, component);
				if (!declaration || !origin) {
					issues.push({ component: owner, reason: `Unresolved pipe ${node.name}` });
					return;
				}
				const target = registerClass(declaration, 'Pipe', { pipeName: node.name });
				const file = origin.start.file;
				const start = node.nameSpan.start;
				const end = node.nameSpan.end;
				const prefix = file.content.slice(0, start);
				const lines = prefix.split('\n');
				edge('USES_PIPE', owner, target, {
					file: path.resolve(file.url),
					start,
					end,
					line: lines.length,
					column: lines.at(-1).length + 1,
				});
			}
		});
	}
	let registry;
	const typescript =
		options.typescript || options.templateExpressions
			? addTypeScriptDependencies(
					program.getTsProgram(),
					ts,
					nodes,
					edges,
					configPath,
					templateReferences,
					(r) => (registry = r),
				)
			: undefined;
	const angularCore = options.angularCore
		? addAngularCore({
				ts,
				ng,
				adapter,
				registry,
				nodes,
				edges,
				unit: configPath,
				limits: options.indexInputs ? { maxContexts: 5000, maxResolutions: 20000 } : {},
			})
		: undefined;
	return {
		schemaVersion: 1,
		project: configPath,
		versions,
		complete: issues.length === 0,
		coverage: EXTRACTION_COVERAGE,
		diagnostics,
		issues,
		...(angularCore ? { angularCore } : {}),
		...(typescript ? { typescript } : {}),
		...(options.templateExpressions
			? {
					templateExpressions: {
						attemptedResolvedReferences: templateReferences.length,
						emittedEdges: [...edges.values()].filter(
							(e) => e.provenance === 'angular-template-checker',
						).length,
						unrepresentedDeclarations: typescript.unrepresentedTemplateReferences ?? [],
						unresolvedCalls: unresolvedExpressions,
					},
				}
			: {}),
		...(tracker ? { indexInputs: tracker.records(), templates } : {}),
		nodes: [...nodes.values()],
		edges: [...edges.values()],
		elapsedMs: Math.round(performance.now() - started),
	};
}

export function findComponentUsages(graph, nameOrId) {
	const matches = graph.nodes.filter(
		(n) => n.kind === 'Component' && (n.id === nameOrId || n.name === nameOrId),
	);
	if (matches.length !== 1)
		throw new Error(
			`Expected one component for ${nameOrId}, found ${matches.length}; use its full id to disambiguate.`,
		);
	const component = matches[0];
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const usages = graph.edges
		.filter((e) => e.type === 'TEMPLATE_USES' && e.to === component.id)
		.map((e) => ({
			parent: byId.get(e.from),
			location: e.location,
			site: e.site,
			bindings: graph.edges
				.filter(
					(b) =>
						b.site === e.site &&
						byId.get(b.to)?.owner === component.id &&
						['BINDS_INPUT', 'LISTENS_OUTPUT'].includes(b.type),
				)
				.map((b) => ({ ...b, target: byId.get(b.to) })),
		}));
	return {
		complete: graph.complete,
		coverage: graph.coverage ?? EXTRACTION_COVERAGE,
		issues: graph.issues,
		component,
		usages,
	};
}

export async function discoverConfigs(workspace) {
	const root = path.resolve(workspace);
	const require = createRequire(path.join(root, '__semantic_workspace__.cjs'));
	const ts = require('typescript');
	const file = path.join(root, 'angular.json');
	const { config, error } = ts.readConfigFile(file, (f) => fs.readFileSync(f, 'utf8'));
	if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
	const configs = new Set();
	for (const project of Object.values(config.projects ?? {})) {
		const build = (project.architect ?? project.targets)?.build;
		for (const options of [build?.options, ...Object.values(build?.configurations ?? {})]) {
			if (typeof options?.tsConfig === 'string')
				configs.add(path.resolve(root, options.tsConfig));
		}
	}
	if (!configs.size)
		throw new Error(
			'No build tsConfig found in angular.json; pass --project explicitly (Nx/custom builders/ng-packagr).',
		);
	return [...configs];
}
