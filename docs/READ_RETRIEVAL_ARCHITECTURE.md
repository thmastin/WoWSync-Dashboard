# Provider-Neutral Read and Research Retrieval

Status: Phase 6 complete and live-validated (2026-09-28). The provider-neutral
core is consumed by a dedicated stdio MCP adapter, connected to ChatGPT through
OpenAI Secure MCP Tunnel. This does not change the existing Ask My Account
provider path or make the Dashboard HTTP server public. See
[`MCP_DEVELOPMENT.md`](MCP_DEVELOPMENT.md) for operations and acceptance
evidence.

## Purpose

`DashboardReadModel` is a narrowly scoped, deterministic read surface over the
`SnapshotReadStore` interface. It is intentionally not an HTTP wrapper, SQL query
surface, filesystem browser, or provider adapter. The current external
consumer is `packages/mcp`; Dashboard UI and Ask My Account could adopt this
provider-neutral core later. The core imports no LLM-provider-specific code.

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

## Local MCP adapter and private ChatGPT connection

`packages/mcp` is a thin MCP-protocol edge adapter; `packages/core`
does not depend on it. The MCP process instantiates only
`SqliteSnapshotReadStore`, `DashboardReadModel`, and the fixed
`ResearchRegistry` manifest. It never instantiates `SqliteSnapshotStore`.
Its transport is local STDIO, so the MCP process opens no listener or public
endpoint. Its eleven registered tools are closed-world, bounded, and marked
read-only; it exposes no mutation, raw SQL, filesystem, shell, raw-export, or
generic Dashboard-API proxy tool.

MCP serialization preserves the core's version isolation, character ambiguity,
and provenance contract. The personal ChatGPT MCP App and Secure MCP Tunnel
have now passed live discovery and invocation acceptance. The process still
has no public listener; `tunnel-client` maintains the outbound private tunnel.
See `MCP_DEVELOPMENT.md` for local startup, operations, and acceptance details.

SQLite in WAL mode may create empty `-wal` / `-shm` coordination sidecars for a
read-only connection; SQLite may leave those coordination files after close.
This is not a schema or journal-mode change: the primary database remains
unchanged and the read path executes no persistent-write PRAGMA. Do not
substitute SQLite's `immutable=1` URI flag for this live reader; that mode is
only safe when the database and its WAL state cannot change, which is not true
while the Dashboard may import new data.

## Research registry

`ResearchRegistry` indexes explicitly registered Markdown documents only. Each
registration has a stable document ID, document class, canonical-relative path,
version/patch scope where known, deterministic SHA-256 content hash, parsed
heading sections, and extractable source URLs. It does not fetch URLs, execute
Markdown, or permit caller-supplied file paths.

The current registration manifest points to the four existing Dashboard `docs/`
Midnight documents because they are the only extant copies. `D:\dev\wow-stuff\truth`
remains the intended long-term canonical truth repository, but migration is
deferred until its research layout exists and all Dashboard references can be
updated deliberately. A future derived/presentation copy can record the
registry document ID plus content hash for stale-copy detection.

Sections are derived deterministically from Markdown headings, retaining their
hierarchy in stable section IDs. Search is bounded deterministic keyword search
over registered titles, headings, and body text with supported version/patch/
season/document-class filters. Section retrieval returns one registered
section, its available citations, and explicit truncation metadata at the
20,000-character bound. It does not fetch external URLs. Content hashes allow
later checks of declared derived copies; the current React Research UI is not
automatically semantically compared to Markdown.

Document classes prevent versioned researched game documentation from being
silently treated as equal evidence to operational truth. Search defaults are a
consumer decision; callers should use `VERSIONED_RESEARCH` for game-mechanic
questions and explicitly opt into `OPERATIONAL_TRUTH` when appropriate.

## Audit logging (not implemented)

The MCP adapter does not write an audit log into the WoWSync database. If a
future operational requirement adds local audit logging, prefer a rolling ~30
days of compact events:
timestamp, operation/tool name, version and non-secret scope identifiers,
success/error, and optional duration. It must exclude credentials, API keys,
complete research bodies, and raw exports unless narrowly enabled for debugging.
It should be local-only and must not imply a public listener or tunnel.
