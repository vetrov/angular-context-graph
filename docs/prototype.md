# Angular semantic extraction spike

The compiler feasibility spike requested in the brief is implemented here. Given a component name, it returns compiler-resolved template sites, original source locations, and input/output contracts. The investigation is in [the feasibility report](../feasibility-report.md).

Validated on Angular **20.3.33, 21.2.25, and 22.2.1**. These are tested patch versions, not a guarantee for every release of those majors. The implementation uses private compiler APIs behind a small adapter.

## Run

Use Node 22.23.2 or another version compatible with the Angular version being analyzed. From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
```

Inspect your own installed workspace:

```sh
node src/cli.mjs --project /absolute/path/app/tsconfig.app.json --component FooComponent
node src/cli.mjs --workspace /absolute/path/angular-workspace --component FooComponent
node src/cli.mjs --project /absolute/path/app/tsconfig.app.json --typescript
node src/cli.mjs --project /absolute/path/app/tsconfig.app.json --template-expressions
node src/cli.mjs --project /absolute/path/app/tsconfig.app.json --angular-core
```

`--workspace` reads build tsconfigs from `angular.json`, including configuration variants. For Nx, custom builders, or configs absent from that file, supply the compilation units explicitly:

```sh
node src/cli.mjs --project /path/app/tsconfig.app.json --project /path/lib/tsconfig.lib.json
```

Omit `--component` to emit the full normalized extraction. Output is JSON on stdout; errors go to stderr. Exit codes: `0` complete extraction, `1` configuration/compiler/adapter error, `2` explicitly incomplete source mapping. An ambiguous class name requires the full `id` from the JSON output.

The tool resolves Angular and TypeScript **from the target config directory**. Prototype dev dependencies are for its fixtures. It verifies matching Angular package versions and that compiler-cli resolves the same compiler/TypeScript installations. Missing dependencies must be installed in the target workspace; the CLI does not install them or build/emit application artifacts.

## What is extracted

- Compiler-visible local components, directives, and pipes; used library declarations can also become targets.
- `TEMPLATE_USES`, `USES_DIRECTIVE`, `USES_PIPE`, `BINDS_INPUT`, `LISTENS_OUTPUT`.
- Decorator and signal aliases, inherited members, exposed host directive contracts, literal attributes, model two-way bindings, multiple contracts sharing a binding name.
- Standalone/NgModule scopes, external and literal inline templates, structural directives, `@if`, `@for`, `@switch`, and `@defer` traversal.

Every edge records its compilation unit, original file, zero-based UTF-16 start/end offsets (end exclusive), one-based line/column, confidence, and provenance. A `site` joins a usage to bindings on that particular AST node. Two-way binding is represented by input/output edges with `twoWay: true`; it does not emit a separate `BINDS_TWO_WAY` edge.

The queried component's bindings are returned on its usage. Host directive bindings belong to the directive and are available in the full graph. Inherited contracts retain the concrete receiver and the actual member declaration in the base class. Conditional/deferred sites are statically resolvable usages; their presence does not prove execution at runtime.

## Validation

An optional [TypeScript dependency pass](../workplace-hub-validation/typescript-verification.md) adds module imports/re-exports, symbol references, heritage, and supported static calls/constructions using the same compiler program. Angular classes share identity with TS code, and Input/Output contracts link to their TS member declarations through `DECLARED_BY`. Enable it with `--typescript` when requesting the full graph. Its own coverage and unresolved-call/module lists are emitted separately; Angular's `complete` flag retains its static-template meaning. The newer `--template-expressions` flag implies that pass and adds `TEMPLATE_CALLS` / `TEMPLATE_REFERENCES` through the Angular template checker. Unsupported declarations are reported explicitly. The newer `--angular-core` flag implies both passes and adds bounded DI/provider/bootstrap/route/host/query/projection/framework proofs. Its own per-family metadata, issues and contextual resolutions are separate from the legacy template completeness flag.

The [research matrix and indexer handoff](../angular-relationship-research.md) covers 26 relationship families across Angular entities. It specifies proposed graph records/edges, extraction APIs, uncertainty and scope rules, acceptance cases, incremental indexing and an MCP query surface. Latest evidence: **50 fixture tests pass on each pinned Angular 20/21/22 pair**, including 18 new core proof tests. **24 new real-project checks** validate source/compiled consumers. The [core research report](../workplace-hub-validation/core-angular-proof.md) specifies the tested DI, route, context and framework subsets; the earlier 10 expression checks remain saved. This does not establish all Angular relationship families or a global unused-method verdict.

At the TypeScript milestone, the suite had 26 tests (16 Angular + 10 TypeScript), all passing on the three pinned Angular/TypeScript pairs. The later template-expression suite adds six tests, bringing that milestone to 32. The later core research suite adds 18 tests, bringing the current total to 50. The real-demo TypeScript milestone also passed 16 checks in source and compiled-library modes, preserving every Angular edge.

The original 16 Angular tests include negative scope and DOM cases, exact source slices, and incomplete/error handling. [demo-result.json](./demo-result.json) is a saved query result. The three `validation-angular*.txt` files capture the initial matrix runs. A subsequent [Workplace Hub validation](../workplace-hub-validation/README.md) passed 37 source-based checks on a real demo workspace, accounting for all 29 static component template sites. An independent declaration/scope oracle also audited all 304 input/output bindings, and 12 additional checks validated a freshly compiled UI package, all 668 application-owned relationships, compiled model/output contracts, and an exposed host-directive alias on Angular 22.2.1.

To reproduce all three versions in isolated temporary workspaces:

```sh
npm run test:matrix
```

This command downloads the pinned Angular/TypeScript versions, runs the same suite for each, and removes its temporary workspaces. The main fixture installation is unchanged.

## Limits

This is a feasibility prototype rather than a production indexer. It fully analyzes each program and keeps results in memory. There is no watcher, incremental graph, persistence, MCP, or runtime usage tracking. DI/routes and host/query/framework relations are available only through the bounded optional research pass; its gaps and candidate resolutions remain explicit. The real-demo validation is limited to static source relationships; no agent benchmark or large production scalability evaluation was performed.

Compilation errors stop extraction. `strictTemplates` is enabled for analysis, so an application with relaxed template checking may fail this spike's validation. Fine-grained strictness overrides in the original config are retained. Indirect inline templates, such as concatenated constants, are marked incomplete and skipped because their spans cannot safely be claimed as exact TS locations.

The test fixtures exercise ordinary supported constructs rather than every parser feature. Selectorless components, nested host-directive composition, custom resource transforms, package-manager edge cases, template factories, dynamic component creation, and very large workspaces need further tests. Missing build configs cannot be inferred from source files alone. Results from overlapping compilation units retain their unit identity and can show the same physical site more than once.

`adapter.mjs` isolates private semantic calls. `extract.mjs` handles project loading, AST traversal, and normalization. `angular-core.mjs` contains the bounded API-rule/static-evaluation/context research pass. `cli.mjs` is the small query interface. The stable JSON contains no Angular AST nodes or compiler objects. IDs are useful for this spike but are not stable across file moves or renames.
