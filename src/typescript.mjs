import path from 'node:path';

export const TYPESCRIPT_COVERAGE =
	'TypeScript source imports/re-exports, symbol references, heritage, and statically resolved call/new targets in the analyzed program. Calls describe compile-time targets, not runtime dispatch or callback execution. Excludes generated Angular type-check files; does not resolve Angular DI providers.';

// Uses the SAME project program as Angular extraction, with public TypeScript APIs.
export function addTypeScriptDependencies(
	program,
	ts,
	graphNodes,
	graphEdges,
	compilationUnit,
	templateReferences = [],
	onRegistry = null,
) {
	const checker = program.getTypeChecker();
	const unresolvedCalls = [];
	const unresolvedModules = [];
	const unrepresentedTemplateReferences = [];
	const sources = program
		.getSourceFiles()
		.filter(
			(sf) =>
				!sf.isDeclarationFile &&
				!sf.fileName.includes('/node_modules/') &&
				!sf.fileName.endsWith('.ngtypecheck.ts'),
		);
	const fileId = (sf) => `${path.resolve(sf.fileName)}::File`;
	const loc = (n) => {
		const sf = n.getSourceFile();
		const start = n.getStart(sf);
		const lc = sf.getLineAndCharacterOfPosition(start);
		return {
			file: path.resolve(sf.fileName),
			start,
			end: n.getEnd(),
			line: lc.line + 1,
			column: lc.character + 1,
		};
	};
	const edge = (type, from, to, location, more = {}) => {
		const e = {
			type,
			from,
			to,
			location,
			compilationUnit,
			confidence: 'static',
			provenance: 'typescript-checker',
			...more,
		};
		graphEdges.set(JSON.stringify(e), e);
	};
	function registerFile(sf) {
		const id = fileId(sf);
		if (!graphNodes.has(id))
			graphNodes.set(id, {
				id,
				kind: 'File',
				name: path.basename(sf.fileName),
				location: loc(sf),
				external: sf.isDeclarationFile,
			});
		return id;
	}
	const declarationKind = (n) =>
		ts.isClassDeclaration(n)
			? 'Class'
			: ts.isInterfaceDeclaration(n)
				? 'Interface'
				: ts.isTypeAliasDeclaration(n)
					? 'TypeAlias'
					: ts.isEnumDeclaration(n)
						? 'Enum'
						: ts.isFunctionDeclaration(n)
							? 'Function'
							: ts.isMethodDeclaration(n) || ts.isMethodSignature(n)
								? 'Method'
								: ts.isConstructorDeclaration(n)
									? 'Constructor'
									: ts.isGetAccessorDeclaration(n) ||
										  ts.isSetAccessorDeclaration(n)
										? 'Accessor'
										: ts.isPropertyDeclaration(n) || ts.isPropertySignature(n)
											? 'Property'
											: ts.isVariableDeclaration(n) || ts.isBindingElement(n)
												? 'Variable'
												: ts.isParameter(n)
													? 'Parameter'
													: ts.isArrowFunction(n) ||
														  ts.isFunctionExpression(n)
														? 'Function'
														: null;
	const declarations = new Map();
	function register(n) {
		if (!n || !declarationKind(n)) return null;
		if (declarations.has(n)) return declarations.get(n);
		const sf = n.getSourceFile();
		const kind = declarationKind(n);
		const location = loc(n.name ?? n);
		let parent = n.parent;
		while (parent && !ts.isSourceFile(parent) && !declarationKind(parent))
			parent = parent.parent;
		const owner = parent && !ts.isSourceFile(parent) ? register(parent) : registerFile(sf);
		const name =
			n.name?.getText(sf) ??
			(kind === 'Constructor' ? 'constructor' : `<anonymous@${n.getStart(sf)}>`);
		// Angular class nodes already use this identity; reuse them without changing kind.
		const id =
			kind === 'Class'
				? `${path.resolve(sf.fileName)}#${name}`
				: `${path.resolve(sf.fileName)}#${kind}:${name}@${location.start}`;
		declarations.set(n, id);
		const existing = graphNodes.get(id);
		if (kind === 'Class' && existing && existing.location.start !== location.start)
			throw new Error(`Declaration identity collision: ${id}`);
		const hasImplementation = !!n.body || (kind === 'Class' && !sf.isDeclarationFile);
		if (existing) Object.assign(existing, { typescriptKind: kind, hasImplementation });
		else
			graphNodes.set(id, {
				id,
				kind,
				name,
				location,
				owner,
				external: sf.isDeclarationFile,
				typescriptKind: kind,
				hasImplementation,
			});
		edge('CONTAINS', owner, id, location);
		return id;
	}
	function unalias(symbol) {
		const seen = new Set();
		while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
			seen.add(symbol);
			const next = checker.getAliasedSymbol(symbol);
			if (next === symbol) break;
			symbol = next;
		}
		return symbol;
	}
	function symbolDeclaration(symbol) {
		symbol = unalias(symbol);
		return (
			symbol?.declarations?.find((d) => declarationKind(d) && d.body) ??
			(symbol?.valueDeclaration && declarationKind(symbol.valueDeclaration)
				? symbol.valueDeclaration
				: null) ??
			symbol?.declarations?.find((d) => declarationKind(d)) ??
			symbol?.declarations?.find(ts.isSourceFile)
		);
	}
	function symbolTarget(symbol) {
		const d = symbolDeclaration(symbol);
		return d && (ts.isSourceFile(d) ? registerFile(d) : register(d));
	}
	// Register local declarations first, preserving Angular class identity.
	for (const sf of sources) {
		registerFile(sf);
		const visit = (n) => {
			register(n);
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	for (const reference of templateReferences) {
		const target = register(reference.declaration);
		const { file, start, end } = reference.span;
		const prefix = file.content.slice(0, start).split('\n');
		const location = {
			file: path.resolve(file.url),
			start,
			end,
			line: prefix.length,
			column: prefix.at(-1).length + 1,
		};
		if (!target) {
			unrepresentedTemplateReferences.push({
				type: reference.type,
				from: reference.owner,
				location,
				declarationKind: ts.SyntaxKind[reference.declaration.kind],
				reason: 'Resolved declaration kind is not represented by this prototype',
			});
			continue;
		}
		const e = {
			type: reference.type,
			from: reference.owner,
			to: target,
			location,
			compilationUnit,
			confidence: 'exact',
			provenance: 'angular-template-checker',
			name: reference.name,
		};
		graphEdges.set(JSON.stringify(e), e);
	}
	const bySpan = new Map();
	for (const [declaration, id] of declarations) {
		const l = loc(declaration.name ?? declaration);
		bySpan.set(JSON.stringify([l.file, l.start, l.end]), id);
	}
	// Bind the public Angular contract to its actual TS member, including base members.
	for (const n of [...graphNodes.values()].filter((n) => ['Input', 'Output'].includes(n.kind))) {
		const l = n.location;
		let id = bySpan.get(JSON.stringify([l.file, l.start, l.end]));
		if (!id) {
			const sf = program.getSourceFile(l.file);
			const search = (d) => {
				if (declarationKind(d)) {
					const dl = loc(d.name ?? d);
					if (dl.start === l.start && dl.end === l.end) id = register(d);
				}
				if (!id) ts.forEachChild(d, search);
			};
			if (sf) search(sf);
		}
		if (id) {
			n.typescriptDeclaration = id;
			edge('DECLARED_BY', n.id, id, l);
		} else throw new Error(`No TypeScript declaration for Angular contract ${n.id}`);
	}
	function importModule(n, sf) {
		if (!n.moduleSpecifier || !ts.isStringLiteralLike(n.moduleSpecifier)) return;
		const module = n.moduleSpecifier.text;
		const target = unalias(checker.getSymbolAtLocation(n.moduleSpecifier))?.declarations?.find(
			ts.isSourceFile,
		);
		if (!target) {
			unresolvedModules.push({ module, location: loc(n.moduleSpecifier) });
			return;
		}
		edge(
			ts.isExportDeclaration(n) ? 'REEXPORTS' : 'IMPORTS',
			fileId(sf),
			registerFile(target),
			loc(n.moduleSpecifier),
			{ module, typeOnly: n.isTypeOnly ?? n.importClause?.isTypeOnly ?? false },
		);
		const clause = ts.isExportDeclaration(n) ? n.exportClause : n.importClause;
		if (clause) {
			const visit = (b) => {
				if (
					ts.isImportSpecifier(b) ||
					ts.isExportSpecifier(b) ||
					ts.isNamespaceImport(b) ||
					(ts.isImportClause(b) && b.name)
				) {
					const id = symbolTarget(checker.getSymbolAtLocation(b.name));
					if (id)
						edge(
							ts.isExportDeclaration(n) ? 'REEXPORTS_SYMBOL' : 'IMPORTS_SYMBOL',
							fileId(sf),
							id,
							loc(b.name),
							{
								localName: b.name.text,
								typeOnly: n.isTypeOnly ?? n.importClause?.isTypeOnly ?? false,
								specifierTypeOnly: b.isTypeOnly ?? false,
							},
						);
				}
				ts.forEachChild(b, visit);
			};
			visit(clause);
		}
	}
	let resolvedCalls = 0;
	for (const sf of sources) {
		function visit(n, owner) {
			const own = declarations.get(n);
			if (own) owner = own;
			if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
				importModule(n, sf);
				return;
			}
			if ((ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.heritageClauses) {
				for (const h of n.heritageClauses)
					for (const t of h.types) {
						const target = symbolTarget(checker.getSymbolAtLocation(t.expression));
						if (target)
							edge(
								h.token === ts.SyntaxKind.ImplementsKeyword
									? 'IMPLEMENTS'
									: 'EXTENDS',
								own,
								target,
								loc(t.expression),
							);
					}
			}
			const dynamicImport =
				ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword;
			if (dynamicImport) {
				const specifier = n.arguments[0];
				const target =
					specifier && ts.isStringLiteralLike(specifier)
						? unalias(checker.getSymbolAtLocation(specifier))?.declarations?.find(
								ts.isSourceFile,
							)
						: null;
				if (target)
					edge('IMPORTS', fileId(sf), registerFile(target), loc(specifier), {
						module: specifier.text,
						dynamic: true,
						typeOnly: false,
					});
				else
					unresolvedModules.push({
						module: specifier?.getText(sf) ?? '',
						location: loc(specifier ?? n),
						reason: 'Dynamic import is not a resolved literal module',
					});
			}
			if (!dynamicImport && (ts.isCallExpression(n) || ts.isNewExpression(n))) {
				const signature = checker.getResolvedSignature(n);
				const declaration = signature?.declaration;
				let target;
				if (ts.isNewExpression(n)) {
					target = symbolTarget(checker.getSymbolAtLocation(n.expression));
					if (target && graphNodes.get(target).typescriptKind !== 'Class') target = null;
				} else if (
					declaration &&
					[
						ts.isFunctionDeclaration,
						ts.isMethodDeclaration,
						ts.isMethodSignature,
						ts.isFunctionExpression,
						ts.isArrowFunction,
						ts.isGetAccessorDeclaration,
						ts.isSetAccessorDeclaration,
					].some((f) => f(declaration))
				) {
					// Overloads resolve to their implementation where present; retain chosen signature.
					target =
						ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)
							? register(declaration)
							: (symbolTarget(
									checker.getSymbolAtLocation(declaration.name ?? n.expression),
								) ?? register(declaration));
				}
				if (target) {
					const targetNode = graphNodes.get(target);
					edge(
						ts.isNewExpression(n) ? 'CONSTRUCTS' : 'CALLS',
						owner,
						target,
						loc(n.expression),
						{
							signatureLocation: declaration ? loc(declaration) : null,
							dispatch: targetNode.hasImplementation
								? 'source-implementation'
								: 'declaration-only',
							optional: !!n.questionDotToken || !!n.expression.questionDotToken,
						},
					);
					resolvedCalls++;
				} else
					unresolvedCalls.push({
						from: owner,
						location: loc(n.expression),
						expression: n.expression.getText(sf),
						reason: signature
							? 'Callable signature has no supported concrete function/method/class declaration'
							: 'No resolved signature',
					});
			}
			if (ts.isIdentifier(n)) {
				const parent = n.parent;
				const declarationName =
					parent.name === n &&
					!ts.isPropertyAccessExpression(parent) &&
					!ts.isQualifiedName(parent) &&
					!ts.isShorthandPropertyAssignment(parent);
				if (!declarationName) {
					const symbol = ts.isShorthandPropertyAssignment(parent)
						? checker.getShorthandAssignmentValueSymbol(parent)
						: checker.getSymbolAtLocation(n);
					const target = symbolTarget(symbol);
					if (target && target !== owner)
						edge('REFERENCES', owner, target, loc(n), { typeOnly: inTypePosition(n) });
				}
			}
			ts.forEachChild(n, (c) => visit(c, owner));
		}
		visit(sf, fileId(sf));
	}
	function inTypePosition(n) {
		for (let p = n.parent; p; p = p.parent) {
			if (ts.isTypeNode(p)) return true;
			if (ts.isExpression(p) || ts.isStatement(p) || declarationKind(p)) return false;
		}
		return false;
	}
	onRegistry?.({ register, registerFile, loc, symbolDeclaration, unalias, checker, sources });
	return {
		coverage: TYPESCRIPT_COVERAGE,
		allCallsResolved: unresolvedCalls.length === 0,
		allModulesResolved: unresolvedModules.length === 0,
		sourceFiles: sources.length,
		resolvedCalls,
		unresolvedCalls,
		unresolvedModules,
		...(templateReferences.length ? { unrepresentedTemplateReferences } : {}),
	};
}
