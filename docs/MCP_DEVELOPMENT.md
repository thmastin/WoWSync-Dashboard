# Local read-only MCP development

Status: Phase 5 local development only. This repository does **not** yet have a
ChatGPT MCP App, Secure MCP Tunnel, public endpoint, OAuth configuration, or
Dashboard UI integration.

`@wowsync-dashboard/mcp` is a thin STDIO adapter over the provider-neutral
core. Its process path is deliberately:

```text
SqliteSnapshotReadStore (SQLite readOnly: true)
  -> DashboardReadModel
  -> ResearchRegistry (registered Markdown paths only)
  -> STDIO MCP tools
```

It never creates `SqliteSnapshotStore`, so it cannot initialize, import into,
or mutate the WoWSync database. It exposes no SQL, filesystem, shell, HTTP
proxy, raw export, mutation, account-dump, or shared-storage tool.

## Start locally

From the Dashboard repository root:

```powershell
npm.cmd run start --workspace @wowsync-dashboard/mcp
```

The process communicates exclusively through standard input/output; it does
not listen on any TCP or HTTP port. Keep stdout reserved for the MCP protocol.
Safe startup diagnostics go to stderr only.

The default database is `data/wowsync.sqlite` beneath this repository. An
operator may set `WOWSYNC_MCP_DB_PATH` before starting the process to select a
different existing database for development. This is process configuration,
not an MCP tool input; MCP callers can never provide a database path.

The default registered research root is `docs/`. `WOWSYNC_MCP_RESEARCH_ROOT`
is available only for controlled local development/test configuration. The
tool surface remains constrained to the fixed Phase 2 registration manifest,
not paths supplied by an MCP caller.

The read-only SQLite path refuses missing or incompatible databases and never
creates schemas, runs migrations/backfills, or changes journal mode. A live
WAL database can create empty `-wal` / `-shm` coordination sidecars when a
read-only process opens it; that is SQLite coordination, not a primary-database
or persistent account-state write. Do not use `immutable=1` while Dashboard
imports may update the database.

## Registered tools

- `list_versions`
- `list_characters`
- `get_character_summary`
- `get_character_equipment`
- `get_character_professions`
- `get_character_currencies`
- `get_profession_coverage`
- `get_renown`
- `list_research_documents`
- `search_research`
- `get_research_section`

All tools are marked read-only and closed-world. Every account-state query
requires an explicit canonical version; none defaults to Retail. Character
lookups return `AMBIGUOUS` instead of selecting a same-name realm. Results
preserve `OBSERVED`, `DERIVED`, `LAST_SEEN`, and `UNKNOWN`. Renown is currently
an intentional `UNKNOWN`, because WoWSync has not captured it.

Results are bounded: characters default to 50 and cap at 100, currencies cap
at 100, research search defaults to 5 and caps at 8, and a single research
section caps at 20,000 characters with explicit truncation metadata.

## Validate locally

```powershell
npm.cmd run test --workspace @wowsync-dashboard/mcp
```

The protocol test creates a temporary fixture database, spawns the STDIO MCP
process via the official MCP client transport, discovers tools, and invokes
them over MCP JSON-RPC. It does not open the production database or configure
any ChatGPT connection.
