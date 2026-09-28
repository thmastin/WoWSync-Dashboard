# Local read-only MCP development

Status: local MCP development and Secure MCP Tunnel compatibility validation.
This repository does **not** yet have a configured ChatGPT MCP App, public
endpoint, OAuth configuration, or Dashboard UI integration.

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

## STDIO output and launch commands

The MCP stdio protocol uses standard output for newline-delimited JSON-RPC
frames only. Any banner, log message, warning, or other text on stdout can
break protocol discovery. Diagnostics belong on stderr.

For an interactive local start from the Dashboard repository root, launch the
entrypoint directly with Node:

```powershell
node .\packages\mcp\src\index.ts
```

For Secure MCP Tunnel, configure the MCP command as the Node executable and
the absolute entrypoint path as its argument. For Tate's current Windows
checkout, the command is:

```text
C:\Program Files\nodejs\node.exe D:\dev\wow-addons\WoWSync-Dashboard\packages\mcp\src\index.ts
```

Do not use `npm run`, `npm.cmd`, `npx`, PowerShell, or another wrapper as the
tunnel's stdio MCP command; launch Node directly so the wrapper cannot write
to protocol stdout. Set any process environment in the tunnel profile rather
than passing database or research paths as tool inputs.

The process communicates exclusively through standard input/output; it does
not listen on any TCP or HTTP port. The SDK's `serveStdio` entrypoint supports
both legacy initialization and modern `server/discover` negotiation, and each
factory-created server instance closes its associated read-only store when it
ends.

The default database is `data/wowsync.sqlite` beneath this repository. Set
`WOWSYNC_MCP_DB_PATH` before starting the process to select an existing
database when the default is not the intended one. This is process
configuration, not an MCP tool input; MCP callers can never provide a database
path.

The default registered research root is `docs/`. Set
`WOWSYNC_MCP_RESEARCH_ROOT` only when the registered documents live elsewhere.
The tool surface remains constrained to the fixed research registration
manifest, not paths supplied by an MCP caller.

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

The protocol tests cover both legacy SDK-client initialization and raw modern
stdio discovery (`server/discover` followed by `tools/list`). The modern test
launches the entrypoint directly with Node, checks every stdout line as a
JSON-RPC frame, and uses only a temporary fixture database. It does not open
the production database or configure any ChatGPT connection.
