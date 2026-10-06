# Angular Context Graph

An MVP Angular-aware indexer, CLI, and local MCP server built on the proven compiler extraction prototype. It stores immutable SQLite snapshots and answers questions with original source evidence, per-unit coverage, and explicit unknowns. The graph follows the [relationship matrix](docs/angular-relationship-research.md) and [core proof boundaries](docs/core-angular-proof.md).

Use Node **22.23+** (or a newer version compatible with the Angular workspace). SQLite uses Node's built-in `node:sqlite`; Node 22 may print an experimental warning to stderr. Angular and TypeScript are resolved from the workspace being analyzed. The extractor has fixture evidence for Angular **20.3.33 / TS 5.9.3**, **21.2.25 / TS 5.9.3**, and **22.2.1 / TS 6.0.3**.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run format:check
```

Prettier uses tabs with display width 4 and a 100-column line width. `npm run format` applies the configuration.

## Index and query

```sh
# Explicit configs work for Angular, Nx, libraries, and custom layouts.
node src/cli.mjs index --workspace /path/to/workspace --project tsconfig.app.json

# Discover angular.json build targets and configuration variants.
node src/cli.mjs index --workspace /path/to/workspace

# Inspect a saved index without recompiling.
node src/cli.mjs status --workspace /path/to/workspace
node src/cli.mjs query find_entities --workspace /path/to/workspace \
    --args '{"text":"SupplierEditPage","kinds":["Component"]}'

# Use an ID from search; names and selectors can be ambiguous.
node src/cli.mjs query get_relationships --workspace /path/to/workspace \
    --args '{"id":"declaration:...","direction":"incoming","types":["TEMPLATE_USES"]}'
```

The default database is `<workspace>/.angular-context-graph/index.sqlite`. `--db /path/to/index.sqlite` overrides it. Repeat `--project` to select multiple compilation units; explicit configs are relative to `--workspace`. An index operation replaces the workspace's selected unit set. Unchanged units reuse saved extraction; `--full` forces compiler analysis. Queries never rebuild automatically.

JSON is written to stdout and progress/errors to stderr. Index exit code **2** means a successfully published partial index; the current MVP always retains incomplete family coverage. Exit code **1** means failure, and **0** means a successful query, status, export/import, or complete legacy extraction. Query responses carry freshness independently of exit status.

| Query                    | Useful answer                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `find_entities`          | IDs, declaration facets, contracts, route/context entities, and contributing units. Use `kinds` to search `InjectionRequest`, `InjectorContext`, `RouteMount`, or `AnalysisIssue` records. |
| `get_entity`             | Declaration data and incoming/outgoing counts.                                                                                                                                             |
| `get_relationships`      | Primitive observations, source occurrences, uncertainty, and evidence IDs.                                                                                                                 |
| `explain_dependency`     | Bounded directed evidence paths across template, TS, DI, provider, and framework relations.                                                                                                |
| `resolve_provider`       | Request plus explicit injector context: lookup trace, selected/candidate registrations, and implementation/alias/factory evidence.                                                         |
| `explain_injection`      | Class/service provider scopes, explicit dependencies, nested class-provider dependencies and value tokens, plus shared-registration evidence with its component.                           |
| `get_feature_context`    | Bounded application/route/component neighborhood.                                                                                                                                          |
| `analyze_impact`         | Direct users and reverse evidence paths, distinguishing possible runtime effects.                                                                                                          |
| `find_unused_candidates` | Usage exclusions and candidates blocked by incomplete coverage; no global unused verdict.                                                                                                  |
| `get_source_evidence`    | A captured original source span, at most 1,000 UTF-16 characters, keyed by observation or occurrence ID.                                                                                   |
| `get_index_status`       | Snapshot, freshness, unit metrics, missing units, and last job/failure.                                                                                                                    |

Responses default to `detail: "compact"`: source locations, evidence IDs, resolution/semantics, and per-unit coverage summaries remain; repeated compiler metadata and source snippets are omitted. Request `detail: "full"` for raw DTOs and the full coverage matrix. `get_source_evidence` always returns its captured snippet. Graph schema v2 is unchanged; response and cursor format is query v2.

Shared query options include `snapshotId`, `unitIds` or `unit` (an exact unit name from status), `contextId`, `types`, and `familyIds` where applicable. Most queries retain all indexed units by default. `explain_injection` selects a unique default build when available and explicitly reports omitted variants; multiple units without a default require selection. Variants are never silently merged. Lists accept `limit` (1–200, default 20) and an opaque `cursor` bound to the snapshot, filters, and query version. Traversals accept `maxDepth` (1–16), `maxNodes` (1–500), `maxEdges` (1–5,000), and `maxPaths` (1–20), with a 250 ms traversal budget. Truncation and traversal bounds are explicit. An empty bounded search does not prove absence.

Search uses SQL filtering and pagination, ranks exact names first, and supports `match: "exact"`, `roles: ["Service"]`, and `kinds: ["Service"]` as an alias for the service role on a Class. Declaration members match their owner's name only with `includeMembers: true`; explicit occurrence/context searches still match their owners.

Freshness checks deduplicate shared inputs across variants. A long-lived MCP server reuses an input checkpoint for at most one second; `checkedAt`, `checkMode`, `ageMs`, and `maxAgeMs` disclose this. Pass `freshness: "verify"` to force a current check; status always verifies. Snapshot changes invalidate cached manifests/checkpoints, and last-job failures are checked on every call.

For a DI question, start with one focused query:

```sh
node src/cli.mjs query explain_injection --workspace /path/to/workplace-hub \
    --args '{"name":"RequestListService","component":"Requests"}'
```

Use `entityId` instead of `name` when names are ambiguous. `component` or `contextId` selects a modeled **construction** context. Results retain unresolved/candidate dependencies, selected value providers, source locations relative to `sourceRoot`, and evidence IDs. Sharing means the same registration in the same modeled injector; runtime object identity is not observed. Nested class-provider dependencies default to depth 2, with bounds of depth 0–4, 1–8 contexts, and 1–100 dependencies (defaults 4 and 40). Cycles and limits are explicit. Alias/factory flows remain available through `resolve_provider` and primitive evidence queries.

Dependency paths omit structural `CONTAINS` ownership unless you request it in `types`. Narrowing edge families keeps paths focused; result payloads have a 64,000-character budget with explicit truncation and continuation where possible.

For the included core example:

```sh
node src/cli.mjs index --project fixtures/core-relations/tsconfig.json
node src/cli.mjs query find_entities --args '{"text":"Leaf","kinds":["Component"]}'
node src/cli.mjs query find_entities --args '{"kinds":["InjectionRequest","InjectorContext"],"limit":200}'
```

Inspect the request's `classOwner`/`owner` and context's `component`, `parent`, and `relation`. Then query `resolve_provider` with `{"requestId":"occurrence:...","contextId":"context:..."}`. Leaf's view placement under ScopeBox selects ViewWorker; its projected-content placement selects LocalWorker. The acceptance suite verifies this distinction and the handler → injected field → request → contextual resolution → registration → implementation path.

## MCP

```sh
node src/cli.mjs mcp --workspace /path/to/workspace
```

Configure any stdio MCP client with an absolute executable path if Node is unavailable in the client's environment:

```json
{
	"mcpServers": {
		"angular-context-graph": {
			"command": "node",
			"args": [
				"/absolute/path/angular-context-graph/src/cli.mjs",
				"mcp",
				"--workspace",
				"/absolute/path/angular-workspace"
			]
		}
	}
}
```

The server exposes the eleven queries above plus explicit `index_workspace` with `projects` and `full`. It indexes only its configured workspace. Read tools are annotated as read-only; indexing is a separate mutation. Input and output schemas are declared and validated, and successful tools return their complete result in `structuredContent`. The default `--text-mode json` also supplies compact JSON in text for client compatibility. Clients that consume structured results can opt into `--text-mode receipt` to eliminate the duplicate JSON and receive a short text receipt instead. A `detail: "full"` query also returns serialized JSON in text. This explicit compatibility option follows the [MCP structured-content guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content). Stdout contains MCP frames only. Restart the MCP connection after updating the server so clients discover the new tool. The transport uses the official MCP TypeScript SDK v1 maintenance line (2025-11-25 protocol support); no client configuration is changed automatically.

## Persistence and uncertainty

Snapshots are staged and published in one SQLite transaction. Foreign keys prevent dangling endpoints. Indexing has one writer, while queries remain on an immutable snapshot. Compiler or normalization failure leaves the previous snapshot available with stale state and failure diagnostics. A dead writer's lock is recoverable on the next indexing run. Every selected unit is analyzed in a separate compiler process, using one shared Angular/TS program within that process.

Source/resource reads, config glob directory membership, failed resolution probes, real paths, package metadata, and ancestor configs/lockfiles participate in invalidation. Source/template edits, additions, deletions, renames, config changes, and lockfile changes are tested against full rebuilds. Unit-level recomputation is deliberate; there is no watcher or fine-grained pass cache in this MVP.

The query update fixes TypeScript reads that bypassed `host.readFile`: original compiler source text is now validated and fingerprinted through `getSourceFile`, including declaration files. Earlier snapshots remain readable but report an outdated extractor until explicitly reindexed. Query/transport-only code changes no longer invalidate extraction fingerprints.

Schema v2 keeps declaration, occurrence, context, and evidence layers separate. A central registry assigns workspace-qualified IDs and saves the legacy migration map. Angular/TS declarations share identities; placements and observations remain unit-specific. IDs are stable for unchanged snapshots. Move/rename/offset migration and merged-symbol improvements remain future work. Colliding prototype class identities fail explicitly.

Original prototype endpoints are retained in the `prototype-compatibility` observation view, with separate occurrence IDs and template ownership records. Every observation includes the unit/snapshot, extractor and exact package versions, family, original source span, target resolution, semantics, provenance, and evidence IDs. `confidence: exact/static` remains a legacy field. It is never treated as a runtime probability. Candidate provider selections, unresolved calls, unrepresented declarations, opaque helpers, and missing-in-model results remain queryable records.

Coverage has all 26 matrix families per unit. Proven subsets are `partial`; absent extractors are `unsupported`. The legacy template `complete` value is saved separately. Framework callbacks are possible runtime entry points, queries are candidate matches, and route declarations do not prove navigation or activation.

Export/import is deterministic and schema checked:

```sh
node src/cli.mjs export > snapshot.json
node src/cli.mjs import --input snapshot.json --db /path/to/other.sqlite
```

Bundles retain the original workspace/source paths. They are intended for same-workspace recovery and evidence transport, not relocatable project migration. Saved spans can be read even after source edits.

## Scope and validation

The original extraction passes and their 50 proof tests remain. Additional acceptance tests cover persistence/restart, export/import, source validation, incremental/full parity, failure recovery, overlapping units, provider contexts, evidence paths, bounded queries, cursors, CLI behavior, and real stdio MCP handshake/tool calls. Run the pinned extraction matrix with `npm run test:matrix`; it installs dependencies in disposable workspaces.

Build variants have distinct identities. File replacements and custom resource-transform builders are reported as unsupported rather than analyzed with guessed settings; supply an effective tsconfig explicitly. The index covers the tsconfig program closure using the existing strictTemplates analysis policy, not emitted build output. Nx/custom project discovery, exact build resource pipelines, global reachability, dynamic rendering, forms/reactive/HTTP flow, public/test policies, and large-workspace scalability remain extensions.

The [MVP implementation decisions](docs/mvp.md) explain the architecture and lessons from [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) and [trace-mcp](https://github.com/nikolai-vysotskyi/trace-mcp). [Prototype notes](docs/prototype.md) preserve the earlier extraction usage and validation history. Legacy invocations such as `node src/cli.mjs --project fixtures/tsconfig.json --component FooComponent` still work; `extract` is also an explicit command.

To reproduce the source-mode Workplace Hub query proof after indexing it, run `node scripts/verify-demo.mjs --workspace /path/to/workplace-hub --db /path/to/index.sqlite`. It checks template-handler evidence, contextual facade selection, the connected DI path, and preservation of the 402 known unrepresented template occurrences.

`node scripts/benchmark-queries.mjs --workspace /path/to/workplace-hub --db /path/to/index.sqlite` measures compact queries and verifies the RequestListService DI answer without compiling or writing the database. Close active SQLite connections first so the database has no WAL. [Query validation](docs/query-validation.json) records local measurements; these are JSON sizes and query timings, not model-token or agent-latency claims.
