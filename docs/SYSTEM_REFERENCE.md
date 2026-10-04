# System Reference

This is the implementation reference: what exists today, where it lives, and how the pieces fit
together. For *why* a rule exists or what must never be violated, see
[`ARCHITECTURE_INVARIANTS.md`](ARCHITECTURE_INVARIANTS.md). For Azeroth ERP semantics in depth,
see [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md). For the deep historical narrative
behind these decisions, see [`ARCHITECTURE.md`](ARCHITECTURE.md), which this document summarizes
and reorganizes around "what exists now" rather than "how we got here."

## The single most important clarification in this document

**WoWSync Dashboard has two separate read-projection pipelines. `DashboardReadModel`, despite its
name, powers only the MCP server — it does not power the Dashboard UI.** A reader who assumes
otherwise will misdiagnose bugs and misdesign features. See "The two read-projection pipelines"
below before touching either path.

## Workspace / package topology

Four npm workspaces in a strict star dependency graph:

- **`packages/core`** — depends on nothing else in this repository. Parsing, version routing,
  identity, the diff engine, `AccountFacts`/`AccountContext`, shared storage, item metadata,
  demand/allocation, the SQLite store (read-write and read-only), and `DashboardReadModel` all
  live here. No I/O beyond the storage abstraction it owns.
- **`packages/server`** — depends only on `core`. A thin Express layer: REST endpoints that call
  into `SnapshotStore`, static hosting for the built web UI, the Ask My Account route. No business
  logic of its own.
- **`packages/web`** — depends only on `core`'s types (never imports `packages/core` itself, since
  that package pulls in `node:sqlite`, which has no reason to enter a browser bundle). React/Vite
  SPA that talks to `packages/server` only over `/api/*`.
- **`packages/mcp`** — depends only on `core`. A thin STDIO MCP-protocol adapter.

The three leaves (`server`, `web`, `mcp`) each depend only on `core`; `core` depends on none of
them. No leaf depends on another leaf.

## SQLite schema strategy: additive-only, no migration framework

There is no migration framework in this repository. Schema evolves by adding new tables/columns;
nothing is renamed or dropped in place. The writable store (`SqliteSnapshotStore`) owns all schema
creation. The read-only store (`SqliteSnapshotReadStore`) never creates, migrates, or repairs
schema — it validates that the tables it needs exist and fails closed otherwise.

## Import: three transports, one write call

```
GearExport addon (external repo)
        |  WoWSync v1 text export
        v
  ┌─────────────┬──────────────────┬────────────────────────┐
  │ manual paste │ import:saved CLI │ watch:saved / capture   │
  │ (web UI)     │ (one-shot)       │ receiver (foreground)   │
  └─────────────┴──────────────────┴────────────────────────┘
        |                |                      |
        └────────────────┴──────────────────────┘
                          v
          SqliteSnapshotStore.importSnapshot()
                          v
                       SQLite
```

All three transports converge on the exact same `importSnapshot()` call — there is no second
parsing/write path. `import:saved` reads GearExport's persisted `latestExport.text` from the WoW
SavedVariables file as data (never executing it, never writing to WoW) and sends the exact text
through the same code path as a manual paste. `watch:saved` is the same bridge run by a foreground
watch loop. The capture receiver (Omarchy DEV) is the durable-transport equivalent for the
Windows-capture flow (see [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md)).

## `SqliteSnapshotStore` / `SqliteSnapshotReadStore`

- `SqliteSnapshotStore` (`packages/core/src/sqliteStore.ts`) is the normal writable store: schema
  creation, import, shared-storage backfill, deletion, everything the Dashboard/import path needs.
- `SqliteSnapshotReadStore` opens an *existing* database with `readOnly: true`. It validates every
  table the current schema needs and refuses missing or incompatible databases. It never creates a
  database, runs schema/migration SQL, changes `journal_mode`, or runs the shared-storage backfill.
  This is the only store MCP is ever given.
- Both implement `SnapshotReadStore`-shaped read methods; only the writable store additionally
  implements mutation operations. `SnapshotReadStore` has no write methods defined in its
  TypeScript interface at all — this is why MCP cannot mutate even if it tried.

## `AccountFacts` -> `AccountContext` -> `LlmContext`

- **`AccountFacts`** (`packages/core/src/accountFacts.ts`) — deterministic, version-scoped account
  facts (gold/playtime/progression/professions/inventory/freshness/recent changes), built from the
  store and diff engine. Pure: no I/O, no clock reads (`now` is always a parameter).
- **`AccountContext`** (`packages/core/src/accountContext.ts`) — every version's `AccountFacts`
  embedded wholesale, plus per-character snapshot history/transitions/trainer summaries. This is
  the canonical "Export Dashboard Context" document — `GET /api/account-context` and the web UI's
  Copy/Download buttons share this one serialization.
- **`LlmContext`** — the system-prompt-plus-`AccountContext` payload Ask My Account sends to the
  LLM provider.

## The two read-projection pipelines

This is the clarification most worth internalizing before changing either path.

```
Pipeline A (Dashboard UI + Ask My Account):
  SQLite -> AccountFacts -> AccountContext -> LlmContext -> Dashboard UI + Ask My Account
  (server routes: GET /api/versions/:version/account-facts, GET /api/account-context)

Pipeline B (MCP / ChatGPT):
  SQLite -> DashboardReadModel -> MCP tools -> ChatGPT
```

**Exception: Allocation Review (Azeroth ERP Slice 2 Dashboard UI) uses Pipeline C:**

```
Pipeline C (Dashboard Allocation UI only):
  SQLite -> DashboardReadModel.getAllocationReview -> Dashboard Allocation Tab
  (server route: GET /api/versions/:version/allocation-review)
```

Pipeline C is a **narrow, read-only second consumer of DashboardReadModel**, used only for the
Dashboard's Allocation Tab. It does not affect the main Dashboard UI (Pipeline A), which continues
to use `AccountFacts`/`AccountContext` exclusively. The exception exists because Allocation Review
is account-scoped demand + evidence aggregation — a distinct operation from the per-character facts
in Pipeline A.

- **Pipeline A** is what renders every page of the Dashboard web UI except the Allocation Tab, and
  what Ask My Account uses. `POST /api/ask` fetches its own `GET /api/account-context` over a real
  HTTP self-call (not a second in-process code path) and projects fresh every time — there is no
  caching layer.
- **Pipeline B** is what every MCP tool reads from. `DashboardReadModel` (`packages/core/src/readModel.ts`)
  is consumed by exactly three things: its own module, `packages/mcp/src/server.ts`, and (narrowly)
  `packages/server/src/demandRoutes.ts` for the allocation-review route only.
- **Pipeline C** (Allocation Review) uses `DashboardReadModel.getAllocationReview()` to produce
  the `AccountAllocationReview` document. The allocation review is Retail-only, account-scoped, and
  derives demand + allocation state plus unallocated inventory (no surplus, no disposition, evidence
  only). It is not part of the general Dashboard UI projection and does not imply the entire
  Dashboard has switched pipelines.
- **`packages/web/src` imports `DashboardReadModel` types only for Allocation Review** (`getAllocationReview`
  result types). It never imports the read model itself; the actual query is issued by the server
  at `GET /api/versions/:version/allocation-review`.
- Both pipelines A and B read the same underlying SQLite data and are expected to agree on overlapping
  questions (e.g. "what spells does this character know"). **`packages/core/test/readModelParity.test.ts`
  is not a cross-pipeline test, despite its name.** It imports and exercises only
  `DashboardReadModel` and `SqliteSnapshotStore` directly — it never imports `AccountFacts`,
  `AccountContext`, or `LlmContext` — so it cannot be comparing Pipeline A's output against
  Pipeline B's. What it actually proves: that `DashboardReadModel`'s own query methods
  (`getCharacterSpells`, `getCharacterTrainer`, `getAccountCurrencies`, `getAccountChanges`,
  `getAllocationReview`) correctly bound/page their results, stay scoped to the right version/snapshot,
  and preserve `OBSERVED`/`LAST_SEEN`/`UNKNOWN`/`DERIVED` provenance — an internal correctness test of
  Pipeline B/C alone. **No automated test currently compares Pipeline A's and Pipeline B/C's outputs
  against each other.** Treat that absence as a current gap, not a covered risk, when changing either
  pipeline's projection logic.

## Shared-storage journal: `sharedStorage.ts` + `sharedStorageApi.ts`

- **`sharedStorage.ts`** — the pure domain model. Its own header states this plainly: Warband and
  Guild storage are owned by an *owner* (the Warband, or one guild), never by the character whose
  export happened to carry them. State is an immutable journal of observations plus provenance;
  "current" state is never stored — it is derived on demand by `projectOwner`/`projectJournal`
  from the journal alone, so the result cannot depend on import order (tests permute it).
- **`sharedStorageApi.ts`** — the HTTP-facing shape. Its own header states this plainly too: pure
  serialization of the domain projection for the local API, with no reconciliation logic of its
  own. An UNKNOWN scalar is omitted (never `0`/`""`/`false`); whole branches that may be absent are
  explicit `null` so the top-level shape is stable even when empty.

These two files' names and header comments match their actual roles exactly — a prior
investigation flagged a possible mismatch and a follow-up git-history check disproved it. Document
each file's role as stated above; there is no naming-cleanup caveat to carry forward.

## Item metadata

A separate type/table with no foreign key to characters or snapshots — not an inventory
observation. Keyed by `(version, base item id)`. `expansionID` is a content tag only (see
`ARCHITECTURE_INVARIANTS.md`, METADATA). Conflicting values across captures produce an explicit
`CONFLICT` state exposing both values rather than silently picking the latest.

## Currencies, professions, equipment, storage

Captured per-character sections (`InventorySection` and siblings in
`packages/core/src/types.ts`), each with its own `OBSERVED`/`LAST_SEEN`/`UNKNOWN` section state.
Character Bank is character-owned; Warband and Guild Bank flow through the shared-storage journal
above. Profession coverage is `DERIVED` from captured characters, not itself an observation.

## `ResearchRegistry`

A fixed, deterministic registry of canonical Markdown documents (currently the Midnight research
docs under `docs/`), resolved only by registry ID — never by a caller-supplied path. Exposed via
four MCP tools: `list_research_documents`, `search_research`, `get_research_section`,
`get_research_document`. This is a channel entirely separate from Ask My Account/`LlmContext`:
"what the account has" and "what we know about the game" deliberately never mix.

## `DashboardReadModel`

A narrowly scoped, deterministic read surface over `SnapshotReadStore`. Not an HTTP wrapper, SQL
surface, filesystem browser, or provider adapter. Its consumers are `packages/mcp` (Pipeline B,
all MCP tools), and `packages/server` (Pipeline C, the Dashboard's Allocation Review tab via
`getAllocationReview()`). Every stateful operation requires an explicit recognized WoW version;
character lookup returns an explicit ambiguity result rather than guessing across realms.
Allocation review is Retail-only and account-scoped; all other query methods are version-agnostic.

## Server API surface

`packages/server/src/app.ts` exposes the import endpoints, `GET /api/versions/:version/account-facts`,
`GET /api/account-context`, `POST /api/ask` (Ask My Account), shared-storage read/delete routes, and
the demand and allocation-review routes (`demandRoutes.ts`). Demand CRUD routes (`POST`, `PATCH`,
`POST /deactivate`) are used by the Dashboard Allocation Tab. The read-only
`GET /api/versions/:version/allocation-review` route (called by the Dashboard UI) returns an
`AccountAllocationReview` document: every active demand's allocation result plus account-owned
inventory with no active demand (evidence only, never surplus).

## Demand lifecycle

`packages/core/src/demand.ts` defines `ExplicitDemand` and its lifecycle: `status` is `ACTIVE` or
`INACTIVE`; a row is mutated in place (never a superseding chain in Slice 1); at most one `ACTIVE`
demand may exist per `(version, demand type, commodity)` key. `packages/server/src/demandRoutes.ts`
exposes create/list/update/deactivate over HTTP — minimal CRUD, no hard delete. **No UI and no MCP
tool calls these routes today**; `app.ts` is the only caller that registers them, and the only way
to manage a demand today is a direct HTTP call.

## Allocation implementation

`packages/core/src/allocation.ts`: `projectAccountOwnedEvidenceMap` projects the account-owned
evidence sources (each character's latest bags/bank, the shared-storage Warband projection) once per
call, tallied by base item id, with guild owners kept in a separate list; `evidenceForItem` is the
per-item lookup that yields `CONFIRMED`/`POTENTIAL`/`UNRESOLVED` evidence (`projectAccountOwnedEvidence`
is the Slice 1 entry point composing the two). `buildAllocationResult` combines that with an
`ExplicitDemand` into the discriminated `AllocationResult` union
(`NO_ACTIVE_DEMAND`/`CONFLICTING_DEMAND`/`BASE_ITEM_AGGREGATION_UNPROVEN`/`RESOLVED`) and applies
identity and disposition gates. Slice 3 reads held-item identity and binding facets from that same
projection; see [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) §24 and its live-validation
record.

`packages/core/src/allocationReview.ts` (Slice 2): `buildAllocationReview` partitions one projection
into `demanded` (each ACTIVE demand through `buildAllocationResult`) and `unallocated` (account-owned
holdings with no active demand — evidence only, no surplus or disposition).
`DashboardReadModel.getItemAllocation` and `DashboardReadModel.getAllocationReview` are the two read-model
entry points; both are Retail-only and explicit-version. See
[`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) for the full semantics and
[`ARCHITECTURE_INVARIANTS.md`](ARCHITECTURE_INVARIANTS.md) (ERP section) for the invariant list.

## MCP tool architecture

`packages/mcp/src/server.ts` registers tools via `server.registerTool(...)`; count them yourself
with `grep -c "server.registerTool(" packages/mcp/src/server.ts` rather than trusting a number in
prose, since this count changes as tools are added — it is documented once, in
[`CURRENT_STATE.md`](CURRENT_STATE.md), and cross-linked elsewhere rather than repeated. The
process path is:

```
SqliteSnapshotReadStore (SQLite readOnly: true)
  -> DashboardReadModel
  -> ResearchRegistry (registered Markdown paths only)
  -> STDIO MCP tools
```

It never creates `SqliteSnapshotStore`, so it structurally cannot initialize, import into, or
mutate the database (see `ARCHITECTURE_INVARIANTS.md`, MUTATION/SECURITY). The Azeroth ERP reads
are `get_item_allocation` (Slice 1: one base item's active `STOCK_TARGET` demand resolved against
account-owned evidence into the deterministic `AllocationResult`) and the newest tool,
`get_allocation_review` (Slice 2: the account-wide review of every active demand's `AllocationResult`
plus unallocated account-owned holdings, independently paged).

## Ask My Account / `LlmContext`, briefly

Ask My Account's data source is `AccountContext`/`LlmContext` (Pipeline A), never
`DashboardReadModel`. The system prompt has been revised in direct response to real past LLM
failures — cross-contaminated inventory fabrication across characters, and misreading copper as
gold — and is load-bearing context for anyone touching that prompt: changes to it should be
evaluated against those specific failure modes, not just against new ones.
