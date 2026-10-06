# Four core Angular research proofs

The four proposed research areas have now been implemented as bounded proof passes in the existing prototype: DI requests/provider registrations; bootstrap/routes; contextual provider selection; and framework-only usage with host behavior, queries and projection. These are demonstrated subsets, rather than exhaustive support for all Angular constructs.

Use `--angular-core` with the prototype CLI, or `extract(project, {angularCore: true})`. It implies ordinary TS indexing and template-expression indexing. Results add `angularCore` with per-family counts, issues, resolution results and limitations. The existing top-level `complete` flag continues to describe static template extraction only.

## Evidence

The complete fixture suite has **50 tests: the previous 32 plus 18 core research tests**. All pass on Angular 20.3.33 / TS 5.9.3, Angular 21.2.25 / TS 5.9.3 and Angular 22.2.1 / TS 6.0.3. The new cases use actual Angular core/router/platform/forms packages at the matching pinned versions.

The demo passes **24 checks across source and compiled-library modes**, including the independent binding audit and preservation of all existing static Angular edges. The demo repository remains unchanged; compiled UI experiments use the existing isolated workspace copy.

- [Real-project summary](./core-research-summary.json)
- [Connected evidence paths](./core-research-examples.json)
- [Verification script](./verify-core-research.mjs)
- [Angular 20 test run](./core-research-tests20.txt), [Angular 21](./core-research-tests21.txt), [Angular 22](./core-research-tests22.txt)
- [Fixture acceptance tests](../angular-semantic-spike/test/core-relations.test.mjs)
- [Source graph](./core-research-source.json), [compiled-consumer graph](./core-research-compiled.json)

## Demonstrated subsets

| Area                    | Proven cases                                                                                                                                                                                                                                                                                                                                                                                                      | Explicit remaining limits                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DI requests / providers | Resolved API identity; constructor runtime class tokens and explicit Inject tokens; inherited constructors; inject fields; forwardRef; same-label InjectionToken identity; class/existing/factory/value strategies; static arrays/spreads; factory deps; root class and token factories; multi registration/order.                                                                                                | Arbitrary provider helpers, complex factory deps/modifiers, inherited field initialization/context propagation, non-root providedIn, library implementation providers and async/injector-get APIs need additional proof. An inject call in an ordinary method has a resolved requested token but no assumed valid injection context. |
| Bootstrap / routes      | bootstrapApplication with imported config; provideRouter; literal import-then-export lazy components, route arrays and NgModules; direct RouterModule.forChild arrays; nested routes; reused route definitions with distinct mounts; direct functional guards/resolvers; static redirect/order facts.                                                                                                             | Module bootstrap, transitive module/provider imports, default/async loader forms, guard factories, mapped/generated route entries, dynamic configuration and navigation matching remain incomplete. Loaders and application functions are never executed by extraction.                                                              |
| Contextual DI           | Root/route/local/view scopes; repeated component placements; projected content versus view children; same-element directive visibility; self/skipSelf/optional; alias lookup evidence; multi order; factory dependencies.                                                                                                                                                                                         | Host modifier, deeper alias/factory cycles, recursive placement widening, implicit framework providers, standalone imported-module environments, opaque library/provider scopes and arbitrary runtime placement remain incomplete. Missing-in-model is not a runtime missing-provider conclusion.                                    |
| Framework-only usage    | Component/directive lifecycle hooks, inherited hooks, service destruction hooks, pipe transform, registered initializer/guard/resolver/factory callbacks, registered CVA/validator methods; host metadata member/call references and decorator bindings/listeners; decorator/signal view/content queries; string locator/read token facts; boundary/descendant tests; ordered selector/wildcard projection slots. | Nested host composition/expression forms, escaped host source maps, complex query/provider/read-value matching, re-projection and selector override equivalence, callback/data flow and global reachability require additional proof. No unused-method verdict is emitted.                                                           |

The implementation lives in [angular-core.mjs](../angular-semantic-spike/src/angular-core.mjs). It uses the shared TS declaration registry plus bounded Angular API recognizers and a static evaluator that retains AST origins internally. It serializes plain graph records only. Private template/compiler calls remain behind [adapter.mjs](../angular-semantic-spike/src/adapter.mjs).

The evaluator follows imported literal constants, arrays/objects and spreads, identifies symbol/function references, and unwraps supported forwardRef/provider wrappers. It records unknowns for unsupported calls and dynamic expressions. It does not call application functions, provider helpers, route loaders or guard factories. Opaque object spreads/members prevent assumptions about the fields they may override.

## Connected real-project proof

The saved examples connect these source facts:

```text
bootstrapApplication(App, appConfig)
  → root environment / registered routes
  → suppliers route
  → lazy SuppliersModule
  → RouterModule.forChild ':id/edit' route
  → SupplierEditPage
  → template save handler
  → referenced constructor parameter 'facade'
  → injection request for SupplierFacade
  → resolution in that route/page placement
  → selected local useClass provider
  → SupplierFacade declaration

SupplierEditPage.save → SupplierFacade.save → SupplierClient.save
```

The same facade token, parameter identity, selected local provider and TS method chain survive consuming the compiled UI library. Route edges describe declared possible activation, and the provider result is conditional on the modeled placement. This is not a measurement of actual route execution or method dispatch.

Source mode also proves WidgetSurface's host expression references `surfaceLabel`, SupplierEditPage's ViewChild predicate and candidate SupplierEditor site, projected TableColumn sites for ComposedTable's content query/slots, and framework roots for MoneyInput/EmployeePicker CVA methods and validators. Compiled mode retains application queries and contracts but does not invent unavailable library query initializers/templates/provider bodies from `.d.ts` files.

## Independence and negative controls

Expected fixture relationships are authored independently of extractor output and asserted through source declarations/constructs. The fixture distinguishes same-label tokens, duplicate placements, template ownership, view/content visibility and direct/descendant query defaults. It verifies that an unrelated user-defined `inject` function is ignored, dynamic token/flags and lazy branches remain unknown, an unregistered similarly named CVA method gets no framework root, and an ordinary method's inject call receives no inferred component injection context.

A separate oracle uses the **actual Angular runtime EnvironmentInjector** without calling the extraction functions. Across all three versions it confirms root/child override behavior, skipSelf, self/optional misses, alias lookup, multi ordering and factory dependency behavior. Component/projection visibility is checked against the reviewed fixture expectations and Angular's documented rules; it is not yet independently instantiated in a DOM runtime test. Query/projection matching uses Angular compiler AST/selector utilities, so those parser dependencies are shared rather than a fully independent implementation.

The existing independent binding oracle remains unchanged and passes in both demo modes. It checks the old template-contract graph while the new core pass is enabled.

## Coverage and practical boundaries

Source mode extracts 159 DI requests, 36 provider registrations and 31 static route definitions. Compiled-consumer mode extracts 158 requests, 32 registrations and the same 31 routes. The saved summary records current resolution counts, framework/query observations and all issues; those counts are observations of this demo, not completeness rates.

Known provider selection and implementation identity are distinct facts. `SELECTS_PROVIDER` identifies a registration in a modeled context; an alias/factory can still need further analysis to identify its final value. Unknown helpers or external Angular declarations add uncertainty to the relevant lookup region. Unknown standalone module environments are tracked when an element lookup would need to fall back to its environment. `CANDIDATE_PROVIDER` never becomes an exact implementation claim automatically.

The graph uses ScopeDefinition, ProviderRegistration, Token, InjectionRequest, InjectorContext, InjectionResolution, RouteDefinition/RouteMount, ElementSite, Query, ProjectionSlot and host occurrence records. The normal production identity registry, snapshot store, incremental invalidation, general query service and MCP remain future implementation work. Prototype IDs and context expansion are unsuitable as a promised durable production contract.

All four areas can now move from unimplemented hypotheses to **partially proven, implemented research subsets** in the matrix. The next implementation session can reuse these passes and tests, normalize the graph schema and extend the explicit gaps rather than redoing their basic feasibility work.
