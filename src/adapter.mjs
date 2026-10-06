// All reliance on Angular's private semantic APIs lives in this adapter.
export function createAdapter(program, ts, ng) {
	const compiler = program.compiler;
	const ttc = compiler.getTemplateTypeChecker();
	for (const method of [
		'getTemplate',
		'getDirectivesOfNode',
		'getSymbolOfNode',
		'getDirectiveMetadata',
		'getPipeMetadata',
		'generateAllTypeCheckBlocks',
	]) {
		if (typeof ttc[method] !== 'function')
			throw new Error(`Unsupported Angular API: ${method}`);
	}
	ttc.generateAllTypeCheckBlocks();

	function classFromSymbol(symbol) {
		// 22 uses positional symbols; 20/21 expose tsType directly.
		const type = symbol.tsType ?? ttc.getTypeOfSymbol?.(symbol);
		const typeSymbol = type?.getSymbol();
		return typeSymbol?.declarations?.find(ts.isClassDeclaration) ?? symbol.ref?.node ?? null;
	}

	function matched(node, component) {
		// TemplateSymbol.directives may also contain directives on desugared children.
		// BoundTarget metadata is the authoritative list for THIS particular node.
		const bound = ttc.getDirectivesOfNode(component, node) ?? [];
		if (!bound.length) return [];
		const symbols = ttc.getSymbolOfNode(node, component)?.directives ?? [];
		return bound.map((meta) => {
			const declaration = meta.ref.node;
			const symbol = symbols.find((s) => {
				const name = s.ref?.node?.name?.text ?? s.ref?.name;
				const file = s.ref?.node?.getSourceFile().fileName ?? s.ref?.filePath;
				return (
					name === declaration.name.text && file === declaration.getSourceFile().fileName
				);
			});
			if (!symbol)
				throw new Error(`Cannot resolve a template symbol for ${declaration.name.text}`);
			const metadata = ttc.getDirectiveMetadata(declaration);
			if (!metadata) throw new Error(`No directive metadata for ${declaration.name?.text}`);
			const host =
				symbol.isHostDirective === true ||
				(ng.MatchSource !== undefined &&
					symbol.matchSource === ng.MatchSource.HostDirective);
			return {
				declaration,
				isComponent: metadata.isComponent,
				selector: metadata.selector,
				standalone: metadata.isStandalone,
				host,
				contracts: (name, output) => contracts({ host, metadata, symbol }, name, output),
			};
		});
	}

	function contracts(match, publicName, output = false) {
		let name = publicName;
		if (match.host) {
			const exposed = output ? match.symbol.exposedOutputs : match.symbol.exposedInputs;
			name = Object.entries(exposed ?? {}).find(([, alias]) => alias === publicName)?.[0];
			if (!name) return [];
		}
		const mapping = output ? match.metadata.outputs : match.metadata.inputs;
		return mapping.getByBindingPropertyName(name) ?? [];
	}

	function member(match, mapping) {
		const checker = compiler.getCurrentProgram().getTypeChecker();
		const type = checker.getTypeAtLocation(match.declaration);
		const symbol = type.getProperty(mapping.classPropertyName);
		return symbol?.valueDeclaration ?? symbol?.declarations?.[0] ?? null;
	}

	function pipe(node, component) {
		const symbol = ttc.getSymbolOfNode(node, component);
		return symbol?.classSymbol ? classFromSymbol(symbol.classSymbol) : null;
	}

	function declarationInfo(declaration) {
		const directive = ttc.getDirectiveMetadata(declaration);
		if (directive)
			return {
				kind: directive.isComponent ? 'Component' : 'Directive',
				selector: directive.selector,
				standalone: directive.isStandalone,
			};
		const pipe = ttc.getPipeMetadata(declaration);
		return pipe ? { kind: 'Pipe', pipeName: pipe.name } : null;
	}
	function canMapTemplate(component) {
		const resource = compiler.getDirectiveResources(component)?.template;
		return !resource || resource.path != null || ts.isStringLiteralLike(resource.node);
	}
	function expressionDeclaration(expression, component) {
		const symbol = ttc.getSymbolOfNode(expression, component);
		if (!symbol) return null;
		let target = symbol.tsSymbol ?? ttc.getTsSymbolOfSymbol?.(symbol);
		if (target?.flags & ts.SymbolFlags.Alias)
			target = compiler.getCurrentProgram().getTypeChecker().getAliasedSymbol(target);
		const declaration =
			target?.declarations?.find((d) => d.body) ??
			target?.valueDeclaration ??
			target?.declarations?.[0];
		// Template locals live in generated TCBs, and are not component members.
		if (!declaration || declaration.getSourceFile().fileName.endsWith('.ngtypecheck.ts'))
			return null;
		return declaration;
	}
	return {
		matched,
		member,
		pipe,
		declarationInfo,
		canMapTemplate,
		templateResource: (component) => compiler.getDirectiveResources(component)?.template,
		expressionDeclaration,
		getNgModuleMetadata: (declaration) => ttc.getNgModuleMetadata?.(declaration) ?? null,
		getTemplate: (component) => ttc.getTemplate(component),
		contracts: (match, name, output) => match.contracts(name, output),
	};
}
