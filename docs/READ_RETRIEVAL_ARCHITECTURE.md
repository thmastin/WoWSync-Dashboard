# Provider-Neutral Read and Research Retrieval

Status: Phase 2 foundation (no network adapter, MCP server, or LLM integration).

## Purpose

`DashboardReadModel` is a narrowly scoped, deterministic read surface over the
existing `SnapshotStore`. It is intentionally not an HTTP wrapper, SQL query
surface, filesystem browser, or provider adapter. Its consumers may eventually
include Dashboard UI, Ask My Account, and separately authorized external
adapters, but it imports no provider-specific code.

Every stateful character/account operation requires an explicit recognized
WoW version. Character lookup is constrained to that version and returns an
ambiguity result when name plus optional realm cannot identify exactly one
character. It never defaults to Retail or searches other versions.

## Provenance contract

Read results carry provenance explicitly:

- `OBSERVED`: directly captured by a WoWSync snapshot.
- `DERIVED`: deterministically calculated from immutable observations (for
  example AccountFacts, profession coverage, or shared-storage projection).
- `LAST_SEEN`: an older captured section preserved as history, not a live view.
- `UNKNOWN`: uncaptured, inaccessible, unsupported, or otherwise not known.

`UNKNOWN` is never represented as ordinary zero, an empty list, or `false`.
An actual observed zero remains an ordinary observed value. Shared storage
continues to distinguish character-owned bank, Warband/account-owned bank, and
guild-owned bank; inaccessible guild tabs remain inaccessible rather than
empty. Snapshot history deliberately returns compact metadata, not raw exports.

Renown is deliberately `UNKNOWN` until WoWSync captures it. This is separate
from research retrieval about how Renown works.

## Read-only storage boundary

The normal Dashboard/import path uses `SnapshotStore`, which extends the
smaller `SnapshotReadStore` with explicit mutation operations. External
deterministic consumers must accept only `SnapshotReadStore` and must open the
database through `SqliteSnapshotReadStore`, never `SqliteSnapshotStore`.

`SqliteSnapshotReadStore` opens an existing database with Node SQLite's
`readOnly: true` connection option. It refuses missing files, validates every
table needed by the current schema, and fails clearly for invalid or
incompatible files. It never creates a database, runs schema creation or
migration SQL, changes `journal_mode`, or runs the shared-storage backfill.
The ordinary Dashboard/import store remains responsible for all initialization
and writes.

SQLite in WAL mode may create transient `-wal` / `-shm` coordination sidecars
while a read-only connection is open. This is SQLite's read coordination, not a
schema or journal-mode change: the primary database remains unchanged and the
read path executes no persistent-write PRAGMA. Do not substitute SQLite's
`immutable=1` URI flag for this live reader; that mode is only safe when the
database and its WAL state cannot change, which is not true while the Dashboard
may import new data.

## Research registry

`ResearchRegistry` indexes explicitly registered Markdown documents only. Each
registration has a stable document ID, document class, canonical-relative path,
version/patch scope where known, deterministic SHA-256 content hash, parsed
heading sections, and extractable source URLs. It does not fetch URLs, execute
Markdown, or permit caller-supplied file paths.

The current transition manifest points to the four existing Dashboard `docs/`
Midnight documents because they are the only extant copies. `D:\dev\wow-stuff\truth`
remains the intended long-term canonical truth repository, but migration is
deferred until its research layout exists and all Dashboard references can be
updated deliberately. A future derived/presentation copy can record the
registry document ID plus content hash for stale-copy detection.

Document classes prevent versioned researched game documentation from being
silently treated as equal evidence to operational truth. Search defaults are a
consumer decision; callers should use `VERSIONED_RESEARCH` for game-mechanic
questions and explicitly opt into `OPERATIONAL_TRUTH` when appropriate.

## Future adapter audit recommendation

No audit logger exists in this phase because no external adapter exists. A
future local-only adapter should retain a rolling ~30 days of compact events:
timestamp, operation/tool name, version and non-secret scope identifiers,
success/error, and optional duration. It must exclude credentials, API keys,
complete research bodies, and raw exports unless narrowly enabled for debugging.
It should be local-only and must not imply a public listener or tunnel.
