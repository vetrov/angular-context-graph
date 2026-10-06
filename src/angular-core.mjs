import path from 'node:path';

// Research-only, bounded Angular API rules. Does not execute application code.
export function addAngularCore({ ts, ng, adapter, registry: r, nodes, edges, unit, limits = {} }) {
	const { checker, sources, register, loc, symbolDeclaration, unalias } = r;
	const issues = [];
	const classes = new Map(),
		requests = [],
		providers = [],
		routes = [],
		applications = [],
		contexts = [];
	const node = (kind, n, more = {}) => {
		const l = n?.file ? n : loc(n);
		const id = `${l.file}#${kind}@${l.start}${more.identity ? `:${more.identity}` : ''}`;
		if (!nodes.has(id)) nodes.set(id, { id, kind, location: l, ...more });
		return id;
	};
	const edge = (type, from, to, n, more = {}) => {
		if (!from || !to) return;
		const e = {
			type,
			from,
			to,
			location: n?.file ? n : loc(n),
			compilationUnit: unit,
			confidence: 'static',
			provenance: 'angular-api-rule',
			...more,
		};
		edges.set(JSON.stringify(e), e);
	};
	const issue = (family, n, reason, more = {}) => {
		const q = { family, location: n?.file ? n : loc(n), reason, ...more };
		issues.push(q);
		return q;
	};
	function symbol(n) {
		return unalias(checker.getSymbolAtLocation(n));
	}
	function declaration(n) {
		return symbolDeclaration(symbol(n));
	}
	// Canonical declaration belongs to the framework package, not just an identically named import.
	function api(n, packages = ['core']) {
		const s = symbol(n);
		if (!s) return null;
		for (const d of s.declarations ?? []) {
			const f = d.getSourceFile().fileName.replaceAll('\\', '/');
			for (const p of packages) if (f.includes(`/@angular/${p}/`)) return s.name;
		}
		return null;
	}
	const decorators = (n) => (ts.canHaveDecorators(n) ? (ts.getDecorators(n) ?? []) : []);
	const unwrap = (n) => {
		while (
			n &&
			(ts.isParenthesizedExpression(n) ||
				ts.isAsExpression(n) ||
				ts.isTypeAssertionExpression(n) ||
				ts.isNonNullExpression(n) ||
				ts.isSatisfiesExpression(n))
		)
			n = n.expression;
		return n;
	};
	const unknown = (n, reason) => ({ kind: 'unknown', node: n, reason });
	const is = (v) => v?.kind;
	// Values retain their AST origin; imported/spread constants do not lose source evidence.
	function value(n, seen = new Set()) {
		n = unwrap(n);
		if (!n) return undefined;
		if (seen.has(n)) return unknown(n, 'Cyclic static value');
		const next = new Set(seen).add(n);
		if (ts.isStringLiteralLike(n) || ts.isNumericLiteral(n))
			return ts.isNumericLiteral(n) ? Number(n.text) : n.text;
		if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
		if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
		if (n.kind === ts.SyntaxKind.NullKeyword) return null;
		if (ts.isArrayLiteralExpression(n)) {
			const items = [];
			for (const el of n.elements) {
				if (ts.isSpreadElement(el)) {
					const v = value(el.expression, next);
					items.push(
						...(Array.isArray(v) ? v : [unknown(el, 'Unresolved array spread')]),
					);
				} else items.push(value(el, next));
			}
			return items;
		}
		if (ts.isObjectLiteralExpression(n)) {
			const fields = new Map();
			for (const p of n.properties) {
				if (ts.isSpreadAssignment(p)) {
					const v = value(p.expression, next);
					if (is(v) === 'object') for (const [k, a] of v.fields) fields.set(k, a);
					else fields.set(`<unknown@${p.pos}>`, unknown(p, 'Unresolved object spread'));
				} else if (ts.isPropertyAssignment(p))
					fields.set(p.name.getText().replace(/^['"]|['"]$/g, ''), {
						value: value(p.initializer, next),
						node: p.initializer,
					});
				else if (ts.isShorthandPropertyAssignment(p)) {
					const d = symbolDeclaration(
						unalias(checker.getShorthandAssignmentValueSymbol(p)),
					);
					fields.set(p.name.text, {
						value:
							d && ts.isVariableDeclaration(d) && d.initializer
								? value(d.initializer, next)
								: { kind: 'ref', node: d ?? p.name },
						node: p.name,
					});
				} else fields.set(`<unknown@${p.pos}>`, unknown(p, 'Unsupported object member'));
			}
			return { kind: 'object', node: n, fields };
		}
		if (ts.isArrowFunction(n) || ts.isFunctionExpression(n))
			return { kind: 'function', node: n };
		if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
			const d = declaration(ts.isPropertyAccessExpression(n) ? n.name : n);
			if (d && ts.isVariableDeclaration(d) && d.initializer) {
				// Token constructors represent unique runtime values, not their generic initializer type.
				if (ts.isNewExpression(unwrap(d.initializer))) return { kind: 'ref', node: d };
				return value(d.initializer, next);
			}
			if (d) return { kind: ts.isFunctionDeclaration(d) ? 'function' : 'ref', node: d };
			return unknown(n, 'No declaration for static value');
		}
		if (ts.isCallExpression(n)) {
			const name = api(n.expression, ['core', 'router', 'platform-browser']);
			if (name === 'forwardRef') {
				const fn = value(n.arguments[0], next);
				const ret = returned(fn?.node);
				return ret ? value(ret, next) : unknown(n, 'Unresolved forwardRef');
			}
			return {
				kind: 'call',
				node: n,
				api: name,
				args: n.arguments.map((a) => value(a, next)),
			};
		}
		return unknown(n, 'Runtime or unsupported static expression');
	}
	function returned(fn) {
		if (!fn?.body) return null;
		if (!ts.isBlock(fn.body)) return unwrap(fn.body);
		const statements = fn.body.statements;
		return statements.length === 1 && ts.isReturnStatement(statements[0])
			? unwrap(statements[0].expression)
			: null;
	}
	const field = (v, k) =>
		is(v) === 'object'
			? [...v.fields.keys()].some((key) => key.startsWith('<unknown@'))
				? unknown(v.node, 'Opaque object spread/member')
				: v.fields.get(k)?.value
			: undefined;
	const fieldNode = (v, k) => v?.fields?.get(k)?.node ?? v?.node;
	function target(v) {
		return ['ref', 'function'].includes(is(v)) ? register(v.node) : null;
	}
	const tokenCache = new Map();
	function token(v, n) {
		const t = target(v);
		let key;
		if (t) key = `symbol:${t}`;
		else if (['string', 'number'].includes(typeof v)) key = `literal:${JSON.stringify(v)}`;
		else {
			issue('A11/A12', n, 'Token is not a resolved runtime value');
			return null;
		}
		if (!tokenCache.has(key)) {
			const id = `${unit}::Token:${key}`;
			nodes.set(id, {
				id,
				kind: 'Token',
				name: t ? nodes.get(t)?.name : String(v),
				declaration: t ?? null,
				value: t ? undefined : v,
				frameworkAPI: api(v?.node?.name ?? v?.node ?? n, ['core', 'forms']),
				location: loc(n),
			});
			tokenCache.set(key, id);
			if (t) edge('DECLARED_BY', id, t, n);
		}
		return tokenCache.get(key);
	}
	function classDecorators(c) {
		const found = [];
		for (const d of decorators(c)) {
			const call = unwrap(d.expression);
			if (ts.isCallExpression(call)) {
				const name = api(call.expression);
				if (
					[
						'Component',
						'Directive',
						'Pipe',
						'Injectable',
						'Service',
						'NgModule',
					].includes(name)
				)
					found.push({ name, call, meta: value(call.arguments[0]) });
			}
		}
		return found;
	}
	for (const sf of sources) {
		const visit = (n) => {
			if (ts.isClassDeclaration(n) && n.name) {
				const ds = classDecorators(n);
				if (ds.length) {
					const id = register(n);
					const info = { id, node: n, decorator: ds[0], meta: ds[0].meta };
					classes.set(id, info);
					nodes.get(id).angularRole = ds[0].name;
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	const defs = new Map();
	function scope(kind, n, owner, visibility = 'providers') {
		const id = node('ScopeDefinition', n, {
			identity: `${kind}:${visibility}`,
			scopeKind: kind,
			owner,
			visibility,
		});
		if (!defs.has(id))
			defs.set(id, { id, node: n, owner, kind, visibility, registrations: [], unknown: [] });
		edge('DECLARES_SCOPE', owner, id, n);
		return defs.get(id);
	}
	function entry(owner, v, n, role) {
		let t = target(v);
		if (is(v) === 'ref' && ts.isClassDeclaration(v.node)) {
			const methodName = role === 'resolver' ? 'resolve' : role;
			const sym = checker.getTypeAtLocation(v.node).getProperty(methodName);
			const d = sym ? symbolDeclaration(sym) : null;
			if (d) t = register(d);
		}
		if (!t) {
			issue('A18', n, `Unresolved framework callback: ${role}`);
			return;
		}
		edge('FRAMEWORK_INVOKES', owner, t, n, {
			role,
			targetResolution: 'resolved',
			activation: 'possible',
		});
	}
	const callbackScopes = [];
	function provider(v, def, n, order = def.registrations.length) {
		if (Array.isArray(v)) {
			for (const x of v) provider(x, def, x?.node ?? n);
			return;
		}
		if (is(v) === 'call') {
			if (v.api === 'makeEnvironmentProviders') {
				provider(v.args[0], def, v.node);
				return;
			}
			if (v.api === 'provideRouter') {
				routeArray(v.args[0], def.id, v.node);
				return;
			}
			if (
				[
					'provideAppInitializer',
					'provideEnvironmentInitializer',
					'providePlatformInitializer',
				].includes(v.api)
			) {
				entry(def.id, v.args[0], v.node, v.api);
				callbackScopes.push({ owner: target(v.args[0]), def });
				return;
			}
			// Helpers can add unseen providers. Retain this on the scope so DI cannot pretend complete lookup.
			const q = issue(
				'A12',
				v.node,
				`Opaque provider helper: ${v.api ?? v.node.expression.getText()}`,
				{ scope: def.id },
			);
			def.unknown.push(q);
			return;
		}
		let tok, strategy, to, flags, tv;
		if (is(v) === 'ref' && ts.isClassDeclaration(v.node)) {
			tv = v;
			tok = token(v, n);
			strategy = 'useClass';
			to = target(v);
		} else if (is(v) === 'object') {
			tv = field(v, 'provide');
			tok = token(tv, fieldNode(v, 'provide'));
			flags = field(v, 'multi');
			for (const s of ['useClass', 'useExisting', 'useFactory', 'useValue'])
				if (v.fields.has(s)) {
					strategy = s;
					break;
				}
			if (!strategy && is(tv) === 'ref' && ts.isClassDeclaration(tv.node))
				strategy = 'useClass';
			const dest = field(v, strategy) ?? (strategy === 'useClass' ? tv : undefined);
			to = strategy === 'useExisting' ? token(dest, fieldNode(v, strategy)) : target(dest);
		}
		if (flags !== undefined && typeof flags !== 'boolean') {
			def.unknown.push(issue('A12', n, 'Dynamic multi-provider flag', { scope: def.id }));
		}
		if (!tok || !strategy) {
			const q = issue('A12', n, 'Unresolved provider registration', { scope: def.id });
			def.unknown.push(q);
			return;
		}
		const id = node('ProviderRegistration', v?.node ?? n, {
			identity: `${def.id}:${order}`,
			owner: def.id,
			token: tok,
			strategy,
			multi: flags === true,
			ordinal: def.registrations.length,
			target: to ?? null,
		});
		const reg = {
			id,
			def,
			token: tok,
			strategy,
			to,
			multi: flags === true,
			node: v?.node ?? n,
			value: v,
		};
		providers.push(reg);
		def.registrations.push(reg);
		edge('REGISTERS', def.id, id, reg.node);
		edge('PROVIDES_TOKEN', id, tok, n);
		if (to)
			edge(
				{
					useClass: 'USES_CLASS',
					useExisting: 'ALIASES_TOKEN',
					useFactory: 'USES_FACTORY',
					useValue: 'USES_VALUE',
				}[strategy],
				id,
				to,
				n,
			);
		if (strategy === 'useFactory') {
			entry(id, field(v, 'useFactory'), fieldNode(v, 'useFactory'), 'provider-factory');
			callbackScopes.push({ owner: to, def });
			const deps = field(v, 'deps');
			if (Array.isArray(deps))
				for (const dep of deps) addRequest(id, null, dep, n, {}, 'factory-deps');
		}
		if (strategy === 'useValue')
			nodes.get(id).value =
				typeof field(v, 'useValue') === 'object'
					? '<structured-or-runtime-value>'
					: field(v, 'useValue');
	}
	const rootDefaults = [];
	for (const c of classes.values()) {
		for (const visibility of ['providers', 'viewProviders']) {
			const vals = field(c.meta, visibility);
			if (vals !== undefined) {
				const def = scope(
					c.decorator.name === 'NgModule' ? 'module' : 'element',
					c.node,
					c.id,
					visibility,
				);
				provider(vals, def, fieldNode(c.meta, visibility));
			}
		}
		if (['Injectable', 'Service'].includes(c.decorator.name)) {
			const p = c.decorator.name === 'Service' ? 'root' : field(c.meta, 'providedIn');
			if (p === 'root') {
				const def = scope('root-default', c.node, c.id);
				provider({ kind: 'ref', node: c.node }, def, c.node);
				rootDefaults.push(def);
			} else if (p != null)
				issue('A12', c.node, 'Non-root providedIn is not modeled', {
					providedIn: typeof p === 'string' ? p : '<expression>',
				});
		}
		const imports = field(c.meta, 'imports');
		if (Array.isArray(imports))
			for (const x of imports) {
				const t = target(x);
				if (t) edge('ANGULAR_IMPORTS', c.id, t, x.node);
			}
		for (const [key, type] of [
			['declarations', 'DECLARES'],
			['exports', 'ANGULAR_EXPORTS'],
		])
			for (const x of field(c.meta, key) ?? []) {
				const t = target(x);
				if (t) edge(type, c.id, t, x.node);
			}
	}
	for (const sf of sources) {
		const visit = (n) => {
			if (
				ts.isVariableDeclaration(n) &&
				n.initializer &&
				ts.isNewExpression(unwrap(n.initializer))
			) {
				const call = unwrap(n.initializer);
				if (api(call.expression) === 'InjectionToken') {
					const opts = value(call.arguments?.[1]);
					const factory = field(opts, 'factory');
					const providedIn = field(opts, 'providedIn');
					if (
						factory &&
						providedIn !== null &&
						(providedIn === undefined || providedIn === 'root')
					) {
						const def = scope('root-default', n, register(n));
						provider(
							{
								kind: 'object',
								node: n,
								fields: new Map([
									['provide', { value: { kind: 'ref', node: n }, node: n.name }],
									[
										'useFactory',
										{ value: factory, node: fieldNode(opts, 'factory') },
									],
								]),
							},
							def,
							n,
						);
						rootDefaults.push(def);
					} else if (factory && providedIn != null)
						issue('A12', n, 'Non-root token factory is not modeled');
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	function addRequest(owner, classOwner, v, n, flags = {}, form = 'inject') {
		const tok = token(v, n);
		const id = node('InjectionRequest', n, {
			identity: `${owner}:${requests.length}`,
			owner,
			classOwner,
			token: tok,
			form,
			modifiers: flags,
			contextEligibility: classOwner ? 'angular-class' : 'requires-caller-context',
		});
		const q = { id, owner, classOwner, token: tok, flags, node: n };
		requests.push(q);
		edge('HAS_INJECTION_REQUEST', owner, id, n);
		if (tok) edge('REQUESTS_TOKEN', id, tok, n);
		return q;
	}
	function ctor(c) {
		let cls = c.node;
		const seen = new Set();
		while (cls && !seen.has(cls)) {
			seen.add(cls);
			const con = cls.members?.find(ts.isConstructorDeclaration);
			if (con) {
				for (const p of con.parameters) {
					let v,
						flags = {};
					for (const d of decorators(p)) {
						const call = unwrap(d.expression);
						if (!ts.isCallExpression(call)) continue;
						const name = api(call.expression);
						if (name === 'Inject') v = value(call.arguments[0]);
						if (['Optional', 'Self', 'SkipSelf', 'Host'].includes(name))
							flags[
								{
									Optional: 'optional',
									Self: 'self',
									SkipSelf: 'skipSelf',
									Host: 'host',
								}[name]
							] = true;
						if (name === 'Attribute') {
							v = null;
							flags.attribute = true;
						}
					}
					if (flags.attribute) {
						issue(
							'A11',
							p,
							'Attribute injection is a host attribute read, excluded from token DI',
						);
						continue;
					}
					if (v === undefined && p.type) {
						const t = p.type.typeName ?? p.type;
						const d = declaration(ts.isQualifiedName(t) ? t.right : t);
						if (d && ts.isClassDeclaration(d)) v = { kind: 'ref', node: d };
					}
					addRequest(register(p), c.id, v, p, flags, 'constructor');
				}
				return;
			}
			const base = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
				?.types[0]?.expression;
			cls = base ? declaration(base) : null;
		}
	}
	for (const c of classes.values()) if (c.decorator.name !== 'NgModule') ctor(c);
	for (const sf of sources) {
		const visit = (n, owner, classOwner = null) => {
			const id = register(n);
			if (id) owner = id;
			if (ts.isClassDeclaration(n)) classOwner = classes.has(id) ? id : null;
			if (
				ts.isMethodDeclaration(n) ||
				ts.isGetAccessorDeclaration(n) ||
				ts.isSetAccessorDeclaration(n) ||
				ts.isArrowFunction(n) ||
				ts.isFunctionExpression(n) ||
				ts.isFunctionDeclaration(n)
			)
				classOwner = null;
			if (ts.isCallExpression(n) && api(n.expression) === 'inject') {
				const opts = value(n.arguments[1]);
				const flags = {};
				for (const k of ['optional', 'self', 'skipSelf', 'host'])
					if (field(opts, k) !== undefined)
						flags[k] =
							typeof field(opts, k) === 'boolean' ? field(opts, k) : '<dynamic>';
				addRequest(owner, classOwner, value(n.arguments[0]), n, flags);
			}
			ts.forEachChild(n, (c) => visit(c, owner, classOwner));
		};
		visit(sf, r.registerFile(sf));
	}
	// A lazy target is accepted only for a returned literal import(...).then(m => m.Export).
	function lazy(v, n) {
		const fn = v?.node,
			ret = returned(fn);
		if (!ret) return null;
		if (
			ts.isCallExpression(ret) &&
			ts.isPropertyAccessExpression(ret.expression) &&
			ret.expression.name.text === 'then'
		) {
			const imported = ret.expression.expression;
			const callback = ret.arguments[0];
			const selected = returned(callback);
			if (
				ts.isCallExpression(imported) &&
				imported.expression.kind === ts.SyntaxKind.ImportKeyword &&
				ts.isStringLiteralLike(imported.arguments[0]) &&
				selected &&
				ts.isPropertyAccessExpression(selected) &&
				callback.parameters?.[0]?.name?.getText() === selected.expression.getText()
			) {
				const d = declaration(selected.name);
				if (d) {
					const id = register(d);
					if (id)
						return {
							id,
							value: ts.isVariableDeclaration(d)
								? value(d.initializer)
								: { kind: 'ref', node: d },
							declaration: d,
						};
				}
			}
		}
		issue('A15', n, 'Unsupported lazy loader; no target inferred');
		return null;
	}
	const routeGroups = new Map();
	function routeArray(vals, owner, n, seen = new Set()) {
		if (!Array.isArray(vals)) {
			issue('A15', n, 'Routes are not a statically resolved array');
			return [];
		}
		const group = [];
		for (const [index, v] of vals.entries()) {
			if (is(v) !== 'object' || seen.has(v.node)) {
				issue('A15', v?.node ?? n, 'Dynamic/cyclic route entry');
				continue;
			}
			const id = node('RouteDefinition', v.node, {
				path: typeof field(v, 'path') === 'string' ? field(v, 'path') : null,
				outlet: typeof field(v, 'outlet') === 'string' ? field(v, 'outlet') : 'primary',
				ordinal: index,
				pathMatch: field(v, 'pathMatch') ?? null,
				redirectTo:
					typeof field(v, 'redirectTo') === 'string' ? field(v, 'redirectTo') : null,
			});
			const prior = routes.find((r) => r.id === id);
			if (prior) {
				group.push(prior);
				edge('HAS_ROUTE', owner, id, v.node, { ordinal: index });
				continue;
			}
			const rec = {
				id,
				node: v.node,
				value: v,
				owner,
				children: [],
				component: null,
				lazyModule: null,
			};
			routes.push(rec);
			group.push(rec);
			edge('HAS_ROUTE', owner, id, v.node, { ordinal: index });
			const comp = target(field(v, 'component'));
			if (comp) {
				rec.component = comp;
				edge('RENDERS', id, comp, fieldNode(v, 'component'));
			}
			for (const k of ['loadComponent', 'loadChildren'])
				if (field(v, k)) {
					const resolved = lazy(field(v, k), fieldNode(v, k));
					if (resolved) {
						edge('LAZY_LOADS', id, resolved.id, fieldNode(v, k), { loaderKind: k });
						if (k === 'loadComponent') rec.component = resolved.id;
						else if (Array.isArray(resolved.value))
							rec.children.push(
								...routeArray(
									resolved.value,
									id,
									fieldNode(v, k),
									new Set(seen).add(v.node),
								),
							);
						else rec.lazyModule = resolved.id;
					}
				}
			const ps = field(v, 'providers');
			if (ps !== undefined) {
				rec.def = scope('route', v.node, id);
				provider(ps, rec.def, fieldNode(v, 'providers'));
			}
			for (const k of ['canActivate', 'canActivateChild', 'canDeactivate', 'canMatch'])
				for (const x of field(v, k) ?? []) {
					const t = target(x);
					if (t) {
						edge('GUARDED_BY', id, t, x.node, { role: k });
						entry(id, x, x.node, k);
					} else
						issue(
							'A15',
							x?.node ?? fieldNode(v, k),
							'Guard factory/dynamic guard is unresolved',
							{ route: id, role: k },
						);
				}
			const resolvers = field(v, 'resolve');
			if (is(resolvers) === 'object')
				for (const [key, item] of resolvers.fields) {
					const t = target(item.value);
					if (t) {
						edge('RESOLVED_BY', id, t, item.node, { dataKey: key });
						entry(id, item.value, item.node, 'resolver');
					} else issue('A15', item.node ?? v.node, 'Dynamic resolver is unresolved');
				}
			if (field(v, 'children'))
				rec.children.push(
					...routeArray(
						field(v, 'children'),
						id,
						fieldNode(v, 'children'),
						new Set(seen).add(v.node),
					),
				);
		}
		routeGroups.set(owner, group);
		return group;
	}
	// Discover route arrays only at router registration sites, not by variable name/type alone.
	const moduleRoutes = new Map();
	for (const c of classes.values())
		if (c.decorator.name === 'NgModule') {
			for (const x of field(c.meta, 'imports') ?? [])
				if (is(x) === 'call' && ['forChild', 'forRoot'].includes(x.api)) {
					const group = routeArray(x.args[0], c.id, x.node);
					moduleRoutes.set(c.id, [...(moduleRoutes.get(c.id) ?? []), ...group]);
				}
		}
	for (const sf of sources) {
		const visit = (n) => {
			if (
				ts.isCallExpression(n) &&
				api(n.expression, ['platform-browser']) === 'bootstrapApplication'
			) {
				const root = target(value(n.arguments[0]));
				const id = node('Application', n, { root });
				const def = scope('environment', n, id);
				const config = value(n.arguments[1]);
				provider(field(config, 'providers') ?? [], def, n);
				const app = { id, node: n, root, def, routes: routeGroups.get(def.id) ?? [] };
				applications.push(app);
				if (root) edge('BOOTSTRAPS', id, root, n.arguments[0]);
				else issue('A14', n, 'Dynamic bootstrap root');
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
	const hooks = [
		'ngOnChanges',
		'ngOnInit',
		'ngDoCheck',
		'ngAfterContentInit',
		'ngAfterContentChecked',
		'ngAfterViewInit',
		'ngAfterViewChecked',
		'ngOnDestroy',
	];
	const queries = [],
		templates = new Map();
	function member(c, name) {
		const sym = checker.getTypeAtLocation(c.node).getProperty(name);
		return sym ? symbolDeclaration(sym) : null;
	}
	function hostExpression(c, n, mode, label) {
		if (!ts.isStringLiteralLike(n)) {
			issue('A08', n, 'Host expression is not a literal');
			return;
		}
		const raw = n.getSourceFile().text.slice(n.getStart() + 1, n.getEnd() - 1);
		if (raw !== n.text) {
			issue('A08', n, 'Escaped host expression has no verified original source map');
			return;
		}
		const file = new ng.ParseSourceFile(n.text, n.getSourceFile().fileName);
		const start = new ng.ParseLocation(file, 0, 0, 0);
		const span = new ng.ParseSourceSpan(
			start,
			new ng.ParseLocation(file, n.text.length, 0, n.text.length),
		);
		const parser = new ng.Parser(new ng.Lexer());
		const ast =
			mode === 'listener'
				? parser.parseAction(n.text, span, 0)
				: parser.parseBinding(n.text, span, 0);
		const id = node(mode === 'listener' ? 'HostListener' : 'HostBinding', n, {
			owner: c.id,
			name: label,
			expression: n.text,
		});
		edge('HAS_HOST_BEHAVIOR', c.id, id, n);
		function exprDeclaration(e) {
			if (e instanceof ng.ImplicitReceiver || e instanceof ng.ThisReceiver) return c.node;
			if (e instanceof ng.PropertyRead || e instanceof ng.SafePropertyRead) {
				const receiver = exprDeclaration(e.receiver);
				if (!receiver) return null;
				const type = ts.isClassDeclaration(receiver)
					? checker.getTypeAtLocation(receiver)
					: checker.getTypeOfSymbolAtLocation(
							checker.getSymbolAtLocation(receiver.name ?? receiver),
							receiver,
						);
				return symbolDeclaration(type?.getProperty(e.name));
			}
			return null;
		}
		const seen = new WeakSet();
		function visit(a) {
			if (!a || typeof a !== 'object' || seen.has(a)) return;
			seen.add(a);
			if (a instanceof ng.PropertyRead || a instanceof ng.SafePropertyRead) {
				const d = exprDeclaration(a);
				const t = d ? register(d) : null;
				const pos = a.nameSpan;
				const l = loc(n);
				l.start = n.getStart() + 1 + pos.start;
				l.end = n.getStart() + 1 + pos.end;
				const lc = n.getSourceFile().getLineAndCharacterOfPosition(l.start);
				l.line = lc.line + 1;
				l.column = lc.character + 1;
				if (t) edge('HOST_REFERENCES', id, t, l, { name: a.name, owner: c.id });
				else if (a.name !== '$event')
					issue('A08', n, `Unresolved host member: ${a.name}`, { owner: c.id });
			}
			if (a instanceof ng.Call || a instanceof ng.SafeCall) {
				const d = exprDeclaration(a.receiver);
				const t = d ? register(d) : null;
				if (t) edge('HOST_CALLS', id, t, n, { owner: c.id });
				else issue('A08', n, 'Indirect host call is unresolved', { owner: c.id });
			}
			for (const [k, v] of Object.entries(a))
				if (!['sourceSpan', 'nameSpan', 'span', 'errors'].includes(k)) {
					if (Array.isArray(v)) for (const x of v) visit(x);
					else visit(v);
				}
		}
		visit(ast.ast);
	}
	const queryNames = [
		'ViewChild',
		'ViewChildren',
		'ContentChild',
		'ContentChildren',
		'viewChild',
		'viewChildren',
		'contentChild',
		'contentChildren',
	];
	function query(c, m, name, call) {
		const v = value(call.arguments[0]);
		const opts = value(call.arguments[1]);
		const content = name.toLowerCase().startsWith('content'),
			many = name.toLowerCase().endsWith('children');
		const predicate = target(v) ?? (typeof v === 'string' ? v : null);
		const read = target(field(opts, 'read'));
		const id = node('Query', call, {
			owner: c.id,
			member: register(m),
			queryKind: content ? 'content' : 'view',
			many,
			descendants: content ? (field(opts, 'descendants') ?? !many) : true,
			static: field(opts, 'static') ?? false,
			required:
				ts.isPropertyAccessExpression(call.expression) &&
				call.expression.name.text === 'required',
			predicate,
			read: read ?? null,
		});
		const q = {
			id,
			c,
			member: m,
			predicate,
			read,
			content,
			many,
			descendants: nodes.get(id).descendants,
			node: call,
		};
		queries.push(q);
		edge('DECLARES_QUERY', c.id, id, call);
		if (target(v)) edge('LOCATES', id, target(v), call.arguments[0]);
		if (read) edge('READS_AS', id, read, call.arguments[1]);
		if (!predicate) issue('A09', call, 'Query predicate is not resolved');
	}
	for (const c of classes.values())
		if (
			['Component', 'Directive', 'Pipe', 'Injectable', 'Service'].includes(c.decorator.name)
		) {
			for (const name of ['Injectable', 'Service'].includes(c.decorator.name)
				? ['ngOnDestroy']
				: hooks) {
				const d = member(c, name);
				if (d) entry(c.id, { kind: 'function', node: d }, d, name);
			}
			if (c.decorator.name === 'Pipe') {
				const d = member(c, 'transform');
				if (d) entry(c.id, { kind: 'function', node: d }, d, 'pipe-transform');
			}
			const h = field(c.meta, 'host');
			if (is(h) === 'object')
				for (const [key, item] of h.fields) {
					if (key.startsWith('(') || key.startsWith('['))
						hostExpression(
							c,
							item.node,
							key.startsWith('(') ? 'listener' : 'binding',
							key,
						);
				}
			for (const m of c.node.members) {
				for (const dec of decorators(m)) {
					const call = unwrap(dec.expression);
					if (!ts.isCallExpression(call)) continue;
					const name = api(call.expression);
					if (queryNames.includes(name)) query(c, m, name, call);
					if (name === 'HostListener')
						entry(c.id, { kind: 'function', node: m }, dec, 'host-listener');
					if (name === 'HostBinding')
						edge('HOST_REFERENCES', c.id, register(m), dec, { role: 'host-binding' });
				}
				if (m.initializer && ts.isCallExpression(unwrap(m.initializer))) {
					const call = unwrap(m.initializer);
					let expression = call.expression;
					if (
						ts.isPropertyAccessExpression(expression) &&
						expression.name.text === 'required'
					)
						expression = expression.expression;
					const name = api(expression);
					if (queryNames.includes(name)) query(c, m, name, call);
				}
			}
			// CVA and validator roles require a provider registration, not an interface name alone.
			const regs = providers.filter(
				(p) =>
					(p.strategy === 'useExisting' && nodes.get(p.to)?.declaration === c.id) ||
					(p.strategy === 'useClass' && p.to === c.id),
			);
			for (const p of regs) {
				const tokName = nodes.get(p.token)?.frameworkAPI;
				const methods =
					tokName === 'NG_VALUE_ACCESSOR'
						? [
								'writeValue',
								'registerOnChange',
								'registerOnTouched',
								'setDisabledState',
							]
						: ['NG_VALIDATORS', 'NG_ASYNC_VALIDATORS'].includes(tokName)
							? ['validate', 'registerOnValidatorChange']
							: [];
				for (const name of methods) {
					const d = member(c, name);
					if (d) entry(p.id, { kind: 'function', node: d }, d, `${tokName}:${name}`);
				}
			}
		}
	const blockKeys = ['children', 'branches', 'cases', 'empty', 'placeholder', 'loading', 'error'];
	for (const c of classes.values())
		if (c.decorator.name === 'Component' && adapter.canMapTemplate(c.node)) {
			const ast = adapter.getTemplate(c.node);
			if (!ast) continue;
			const record = { c, sites: [], roots: [], slots: [] };
			templates.set(c.id, record);
			function traverse(list, parent = null, conditional = false) {
				if (!list) return;
				if (!Array.isArray(list)) list = [list];
				for (const a of list) {
					if (!a || typeof a !== 'object') continue;
					const host = a instanceof ng.TmplAstElement || a instanceof ng.TmplAstTemplate;
					if (host) {
						const span = a.startSourceSpan ?? a.sourceSpan;
						const l = {
							file: path.resolve(span.start.file.url),
							start: span.start.offset,
							end: span.end.offset,
							line: span.start.line + 1,
							column: span.start.col + 1,
						};
						const id = `${unit}::${c.id}@${l.file}:${l.start}:${a.constructor.name}`;
						const matched = adapter.matched(a, c.node);
						const classIds = matched.map((m) => register(m.declaration));
						nodes.set(id, {
							id,
							kind: 'ElementSite',
							owner: c.id,
							location: l,
							tag: a.name ?? a.tagName,
							classes: classIds,
							conditional: conditional || a instanceof ng.TmplAstTemplate,
						});
						const s = {
							id,
							ast: a,
							parent,
							children: [],
							classes: classIds,
							component: matched.find((m) => m.isComponent)
								? register(matched.find((m) => m.isComponent).declaration)
								: null,
							conditional: conditional || a instanceof ng.TmplAstTemplate,
						};
						record.sites.push(s);
						if (parent) parent.children.push(s);
						else record.roots.push(s);
						for (const cls of classIds)
							edge('INSTANTIATES_DECLARATION', id, cls, l, {
								activation: 'possible',
							});
						traverse(a.children, s, s.conditional);
						continue;
					}
					if (ng.TmplAstContent && a instanceof ng.TmplAstContent) {
						const span = a.sourceSpan;
						const l = {
							file: path.resolve(span.start.file.url),
							start: span.start.offset,
							end: span.end.offset,
							line: span.start.line + 1,
							column: span.start.col + 1,
						};
						const id = `${c.id}.ProjectionSlot@${l.start}`;
						nodes.set(id, {
							id,
							kind: 'ProjectionSlot',
							owner: c.id,
							selector: a.selector,
							ordinal: record.slots.length,
							location: l,
						});
						record.slots.push({ id, selector: a.selector, ast: a });
						edge('DECLARES_SLOT', c.id, id, l);
						continue;
					}
					for (const k of blockKeys) if (a[k]) traverse(a[k], parent, true);
				}
			}
			traverse(ast);
		}
	function project(site, slots) {
		const attr = site.ast.attributes?.find((a) => a.name === 'ngProjectAs');
		if (attr) {
			for (const sl of slots)
				if (sl.selector !== '*' && sl.selector === attr.value) return sl;
			// Exact ngProjectAs selector equivalence only; complex selector algebra remains explicit.
			issue(
				'A10',
				site.ast.sourceSpan?.start?.file ? nodes.get(site.id).location : site.ast,
				'Unproven ngProjectAs selector equivalence',
			);
			return null;
		}
		const css = new ng.CssSelector();
		css.setElement(site.ast.name ?? site.ast.tagName ?? 'ng-template');
		for (const a of [
			...(site.ast.attributes ?? []),
			...(site.ast.inputs ?? []),
			...(site.ast.templateAttrs ?? []),
		]) {
			css.addAttribute(a.name, typeof a.value === 'string' ? a.value : '');
			if (a.name === 'class' && typeof a.value === 'string')
				for (const c of a.value.split(/\s+/)) if (c) css.addClassName(c);
		}
		for (const sl of slots)
			if (sl.selector !== '*') {
				const matcher = new ng.SelectorMatcher();
				matcher.addSelectables(ng.CssSelector.parse(sl.selector));
				let match = false;
				matcher.match(css, () => (match = true));
				if (match) return sl;
			}
		return slots.find((s) => s.selector === '*') ?? null;
	}
	function context(kind, n, more) {
		if (contexts.length >= (limits.maxContexts ?? Infinity))
			throw new Error('Angular context expansion limit reached; no new snapshot published.');
		const id = node('InjectorContext', n, {
			identity: `${kind}:${contexts.length}`,
			contextKind: kind,
			...more,
		});
		const c = { id, kind, node: n, ...more };
		contexts.push(c);
		return c;
	}
	const placements = [],
		maxPlacements = 1500;
	const unmodeledModuleOwners = new Set();
	function place(
		classIds,
		parent,
		env,
		n,
		{ relation = 'view', site = null, content = [], stack = [], hostBoundary = null } = {},
	) {
		if (placements.length >= maxPlacements) {
			issue('A13', n, 'Placement budget exceeded');
			return null;
		}
		const component =
			classIds.find(
				(id) =>
					classes.get(id)?.decorator.name === 'Component' ||
					nodes.get(id)?.kind === 'Component',
			) ?? null;
		const p = context('element', n, {
			classIds,
			parent: parent?.id ?? null,
			environment: env.id,
			relation,
			site: site?.id ?? null,
			component,
			hostBoundary: hostBoundary ?? parent?.component ?? null,
			definitions: classIds.flatMap((id) =>
				[...defs.values()]
					.filter((d) => d.owner === id && d.kind === 'element')
					.map((d) => d.id),
			),
			conditional: site?.conditional ?? false,
		});
		for (const cls of classIds)
			if (!classes.has(cls)) {
				const definition = scope('external-element', nodes.get(cls).location, cls);
				if (!definition.unknown.length)
					definition.unknown.push(
						issue(
							'A13',
							nodes.get(cls).location,
							'External Angular providers/host composition are unmodeled',
							{ scope: definition.id },
						),
					);
				p.definitions.push(definition.id);
			}
		if (component && classes.has(component)) {
			const imports = field(classes.get(component).meta, 'imports');
			p.environmentUnknown =
				Array.isArray(imports) &&
				imports.some(
					(v) =>
						is(v) === 'ref' &&
						ts.isClassDeclaration(v.node) &&
						adapter.getNgModuleMetadata(v.node),
				);
			if (p.environmentUnknown && !unmodeledModuleOwners.has(component)) {
				unmodeledModuleOwners.add(component);
				issue(
					'A13',
					classes.get(component).node,
					'Standalone imported-module environment is unmodeled',
					{ owner: component },
				);
			}
		}
		placements.push(p);
		if (parent) edge('PARENT_INJECTOR', p.id, parent.id, n, { relation });
		else edge('PARENT_INJECTOR', p.id, env.id, n);
		for (const id of classIds)
			edge('PLACES_DECLARATION', p.id, id, n, { site: site?.id ?? null });
		if (component) {
			if (stack.includes(component)) {
				p.truncated = true;
				issue('A13', n, 'Recursive component placement widened', { context: p.id });
				return p;
			}
			const tr = templates.get(component);
			function child(s, par, rel, declHost) {
				const sp = place(s.classes, par, env, s.ast ? locForSite(s) : n, {
					relation: rel,
					site: s,
					content: s.component ? s.children : [],
					stack: [...stack, component],
					hostBoundary: declHost,
				});
				if (!s.component && sp) for (const x of s.children) child(x, sp, 'view', declHost);
			}
			if (tr) for (const s of tr.roots) child(s, p, 'view', component);
			for (const s of content) {
				const sp = place(s.classes, p, env, locForSite(s), {
					relation: 'content',
					site: s,
					content: s.component ? s.children : [],
					stack: [...stack, component],
					hostBoundary: parent?.component ?? null,
				});
				const slot = tr ? project(s, tr.slots) : null;
				if (slot && sp)
					edge('PROJECTS_TO', sp.id, slot.id, locForSite(s), {
						site: s.id,
						activation: 'possible',
					});
				if (!s.component && sp)
					for (const x of s.children) child(x, sp, 'content', parent?.component ?? null);
			}
		}
		return p;
	}
	function locForSite(s) {
		return nodes.get(s.id).location;
	}
	// loc accepts ASTs; context sites can already be original locations.
	function mount(group, env, parentMount = null, stack = []) {
		for (const [ordinal, route] of group.entries()) {
			if (stack.includes(route.id)) {
				issue('A15', route.node, 'Recursive route mount');
				continue;
			}
			const id = node('RouteMount', route.node, {
				identity: `${env.id}:${parentMount ?? ''}`,
				definition: route.id,
				parentMount,
				environment: env.id,
				ordinal,
			});
			edge('MOUNTS_ROUTE', env.id, id, route.node);
			edge('MOUNT_OF', id, route.id, route.node);
			let routeEnv = env;
			if (route.def) {
				routeEnv = context('route-environment', route.node, {
					parent: env.id,
					definitions: [route.def.id],
					application: env.application,
				});
				edge('PARENT_INJECTOR', routeEnv.id, env.id, route.node);
				edge('MOUNTS_SCOPE', id, routeEnv.id, route.node);
			}
			if (route.lazyModule) {
				const definition = [...defs.values()].filter(
					(d) => d.owner === route.lazyModule && d.kind === 'module',
				);
				routeEnv = context('module-environment', route.node, {
					parent: routeEnv.id,
					definitions: definition.map((d) => d.id),
					application: env.application,
				});
				edge('PARENT_INJECTOR', routeEnv.id, routeEnv.parent, route.node);
				edge('MOUNTS_SCOPE', id, routeEnv.id, route.node);
				mount(moduleRoutes.get(route.lazyModule) ?? [], routeEnv, id, [...stack, route.id]);
			}
			if (route.component) {
				const p = place([route.component], null, routeEnv, route.node);
				if (p) edge('ROUTE_PLACEMENT', id, p.id, route.node);
			}
			mount(route.children, routeEnv, id, [...stack, route.id]);
		}
	}
	for (const app of applications) {
		const env = context('root-environment', app.node, {
			application: app.id,
			parent: null,
			definitions: [...rootDefaults.map((d) => d.id), app.def.id],
		});
		edge('MOUNTS_SCOPE', app.id, env.id, app.node);
		if (app.root) place([app.root], null, env, app.node);
		mount(app.routes, env);
	}
	const ctxById = new Map(contexts.map((c) => [c.id, c]));
	// Exact results are restricted to fully modeled lookup regions. Unknown helpers inhibit certainty.
	function lookup(tok, ctx, flags = {}, classOwner = null, seen = new Set()) {
		if (!tok || !ctx)
			return {
				status: 'unresolved',
				providers: [],
				reason: 'No resolved token or context',
				trace: [],
			};
		if (flags.host)
			return {
				status: 'unresolved',
				providers: [],
				reason: 'Host-boundary lookup is not yet proven',
				trace: [],
			};
		if (Object.values(flags).some((v) => typeof v !== 'boolean'))
			return {
				status: 'unresolved',
				providers: [],
				reason: 'Dynamic resolution modifier',
				trace: [],
			};
		const trace = [];
		let uncertain = false;
		const candidates = [];
		let cur = ctx,
			includeView = classOwner === ctx.component;
		if (flags.skipSelf) {
			includeView = ctx.relation !== 'content';
			cur = ctxById.get(ctx.parent) ?? ctxById.get(ctx.environment);
		}
		while (cur) {
			if (seen.has(cur.id))
				return {
					status: 'unresolved',
					providers: candidates,
					reason: 'Context cycle',
					trace,
				};
			seen.add(cur.id);
			const ds = (cur.definitions ?? [])
				.map((id) => defs.get(id))
				.filter(
					(d) =>
						d &&
						!(
							cur.kind === 'element' &&
							d.visibility === 'viewProviders' &&
							!includeView
						),
				);
			trace.push({
				context: cur.id,
				definitions: ds.map((d) => d.id),
				viewProvidersVisible: includeView,
			});
			const unknowns = ds.flatMap((d) => d.unknown);
			if (unknowns.length) uncertain = true;
			const hits = ds.flatMap((d) => d.registrations).filter((p) => p.token === tok);
			if (hits.length) {
				const multi = hits.every((p) => p.multi),
					mixed = hits.some((p) => p.multi) && !multi;
				const competingOwners = new Set(hits.map((p) => p.def.owner));
				if (cur.kind === 'element' && competingOwners.size > 1) uncertain = true;
				candidates.push(...(multi ? hits : [hits.at(-1)]));
				return {
					status: uncertain || mixed ? 'candidate' : 'selected',
					providers: candidates,
					reason: mixed
						? 'Mixed multi/non-multi'
						: uncertain
							? 'Unknown registrations or competing declarations in lookup region'
							: null,
					trace,
					foundContext: cur.id,
					multi,
				};
			}
			if (cur.environmentUnknown) uncertain = true;
			if (flags.self) break;
			includeView = cur.relation !== 'content';
			cur =
				ctxById.get(cur.parent) ??
				(cur.kind === 'element' ? ctxById.get(cur.environment) : null);
		}
		return {
			status: uncertain
				? 'unresolved'
				: flags.optional
					? 'optional-miss-in-model'
					: 'missing-in-model',
			providers: [],
			reason: uncertain
				? 'Unknown registrations in lookup region'
				: 'No provider in modeled region; framework/external implicit providers may be absent',
			trace,
		};
	}
	const resolutions = [];
	function resolve(q, ctx, classOwner = q.classOwner) {
		const out = lookup(q.token, ctx, q.flags, classOwner);
		const id = node('InjectionResolution', q.node, {
			identity: ctx.id,
			request: q.id,
			context: ctx.id,
			status: out.status,
			reason: out.reason,
			trace: out.trace,
			multi: out.multi ?? false,
		});
		edge('RESOLVES_IN', q.id, id, q.node, { context: ctx.id });
		for (const p of out.providers)
			edge(
				out.status === 'selected' ? 'SELECTS_PROVIDER' : 'CANDIDATE_PROVIDER',
				id,
				p.id,
				q.node,
				{ context: ctx.id },
			);
		const result = {
			id,
			request: q.id,
			context: ctx.id,
			...out,
			providers: out.providers.map((p) => p.id),
		};
		if (resolutions.length >= (limits.maxResolutions ?? Infinity))
			throw new Error(
				'Angular resolution expansion limit reached; no new snapshot published.',
			);
		resolutions.push(result);
		// Alias requests are resolved in the provider's owning lookup context, not globally.
		for (const p of out.providers)
			if (p.strategy === 'useExisting') {
				const aliased = lookup(p.to, ctxById.get(out.foundContext), {}, null);
				for (const a of aliased.providers)
					edge(
						aliased.status === 'selected'
							? 'ALIAS_SELECTS_PROVIDER'
							: 'ALIAS_CANDIDATE_PROVIDER',
						p.id,
						a.id,
						q.node,
						{ context: out.foundContext },
					);
			}
	}
	for (const ctx of contexts) {
		const classIds = ctx.kind === 'element' ? ctx.classIds : [];
		for (const q of requests)
			if (q.classOwner && classIds.includes(q.classOwner)) resolve(q, ctx);
		for (const defId of ctx.definitions ?? [])
			for (const p of defs.get(defId)?.registrations ?? []) {
				if (p.strategy === 'useClass')
					for (const q of requests)
						if (q.classOwner === p.to) resolve(q, ctx, q.classOwner);
				if (p.strategy === 'useFactory')
					for (const q of requests)
						if (q.owner === p.to || q.owner === p.id) resolve(q, ctx, null);
			}
		for (const cb of callbackScopes)
			if (ctx.definitions?.includes(cb.def.id))
				for (const q of requests) if (q.owner === cb.owner) resolve(q, ctx, null);
	}
	// Queries match static sites within their own view or projected content, never child templates.
	for (const p of placements)
		for (const q of queries.filter((q) => p.classIds.includes(q.c.id))) {
			const tr = templates.get(q.c.id);
			let sites;
			if (!q.content) sites = tr?.sites ?? [];
			else
				sites = placements
					.filter((x) => x.parent === p.id && x.relation === 'content')
					.map((x) => ({
						id: x.site,
						classes: x.classIds,
						ast: templates.size
							? [...templates.values()]
									.flatMap((t) => t.sites)
									.find((s) => s.id === x.site)?.ast
							: null,
					}));
			if (q.content && q.descendants) {
				const roots = new Set(
					placements
						.filter((x) => x.parent === p.id && x.relation === 'content')
						.map((x) => x.id),
				);
				let added = true;
				while (added) {
					added = false;
					for (const x of placements)
						if (x.relation === 'content' && roots.has(x.parent) && !roots.has(x.id)) {
							roots.add(x.id);
							added = true;
						}
				}
				sites = placements
					.filter((x) => roots.has(x.id))
					.map((x) =>
						[...templates.values()]
							.flatMap((t) => t.sites)
							.find((s) => s.id === x.site),
					)
					.filter(Boolean);
			}
			for (const s of sites) {
				const matches =
					s.classes?.includes(q.predicate) ||
					(typeof q.predicate === 'string' &&
						s.ast?.references?.some((r) => r.name === q.predicate));
				if (matches)
					edge('QUERY_MAY_MATCH', q.id, s.id, q.node, {
						context: p.id,
						read: q.read,
						activation: 'possible',
					});
			}
		}
	const counts = {};
	for (const e of edges.values())
		if (e.provenance === 'angular-api-rule') counts[e.type] = (counts[e.type] ?? 0) + 1;
	const familyEdges = {
		A11: ['HAS_INJECTION_REQUEST', 'REQUESTS_TOKEN'],
		A12: [
			'REGISTERS',
			'PROVIDES_TOKEN',
			'USES_CLASS',
			'ALIASES_TOKEN',
			'USES_FACTORY',
			'USES_VALUE',
		],
		A13: ['RESOLVES_IN', 'SELECTS_PROVIDER', 'CANDIDATE_PROVIDER', 'ALIAS_SELECTS_PROVIDER'],
		A14: ['BOOTSTRAPS'],
		A15: ['HAS_ROUTE', 'LAZY_LOADS', 'GUARDED_BY', 'RESOLVED_BY', 'MOUNTS_ROUTE'],
		A08: ['HOST_REFERENCES', 'HOST_CALLS', 'HAS_HOST_BEHAVIOR'],
		A09: ['DECLARES_QUERY', 'LOCATES', 'READS_AS', 'QUERY_MAY_MATCH'],
		A10: ['DECLARES_SLOT', 'PROJECTS_TO'],
		A18: ['FRAMEWORK_INVOKES'],
	};
	const families = Object.fromEntries(
		Object.entries(familyEdges).map(([family, types]) => [
			family,
			{
				status: 'partial-tested-subset',
				observations: types.reduce((sum, t) => sum + (counts[t] ?? 0), 0),
				issues: issues.filter((i) => i.family.split('/').includes(family)).length,
			},
		]),
	);
	const resolutionCounts = Object.fromEntries(
		[...new Set(resolutions.map((r) => r.status))].map((status) => [
			status,
			resolutions.filter((r) => r.status === status).length,
		]),
	);
	return {
		families,
		resolutionCounts,
		coverage:
			'Bounded source DI/provider/bootstrap/router/host/query/projection/framework-entry proof. Static facts and modeled contextual candidates; excludes unrecognized helpers and runtime execution.',
		status: issues.length ? 'partial' : 'tested-subset',
		counts,
		issues,
		requests: requests.length,
		providerRegistrations: providers.length,
		routes: routes.length,
		applications: applications.length,
		contexts: contexts.length,
		resolutions,
		limitations: [
			'Only standalone bootstrapApplication roots are mounted; NgModule lazy routes use directly registered forChild arrays.',
			'Unknown provider helpers prevent exact provider selection in affected lookup regions.',
			'Host modifier, implicit framework providers, dynamic injection contexts, dynamic route factories and recursive/widened placements remain incomplete.',
			'External Angular placements carry unknown provider scopes; standalone imported-module environments and transitive lazy-module providers remain unproven.',
			'Queries are static candidate matches; provider predicates/read values and complex projection selector overrides need further proof.',
			'Lifecycle and registered callbacks are potential framework entry points; no unused-method verdict is emitted.',
		],
	};
}
