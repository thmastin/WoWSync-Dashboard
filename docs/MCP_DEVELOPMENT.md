# WoWSync MCP: development, operations, and acceptance

Status: Phase 6 complete; Secure MCP Tunnel and the personal ChatGPT MCP App
were live-validated on 2026-09-28. No public Dashboard/MCP endpoint, MCP OAuth,
or Dashboard UI integration exists or is intended for this path. The separate
Ask My Account feature is unchanged.

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

| Tool | Purpose |
|---|---|
| `list_versions` | List isolated version buckets known to WoWSync. |
| `list_characters` | List compact character summaries for one required version. |
| `get_character_summary` | Resolve one character and return its deterministic summary. |
| `get_character_equipment` | Return latest-known slot equipment with provenance. |
| `get_character_professions` | Return captured profession observations and their provenance. |
| `get_character_currencies` | Return captured currency data, bounded to 100 records. |
| `get_profession_coverage` | Return per-version account profession coverage as derived data. |
| `get_renown` | Return captured Renown state; currently `UNKNOWN` because WoWSync does not capture it. |
| `list_research_documents` | List registered research metadata, not document bodies. |
| `search_research` | Search registered research with a default 5 / hard 8 result limit. |
| `get_research_section` | Retrieve one registered heading section, capped at 20,000 characters with explicit truncation. |

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
JSON-RPC frame, and uses only a temporary fixture database. See the Phase 6
acceptance record below for the separate live ChatGPT validation.

## Secure MCP Tunnel runbook

Secure MCP Tunnel is the private transport used by this integration. The
dedicated MCP process stays local and communicates with `tunnel-client` over
stdio; `tunnel-client` initiates outbound HTTPS to OpenAI. No inbound public
listener or Dashboard HTTP exposure is required. The Dashboard's normal
loopback server is not the MCP target. OpenAI's current description and setup
are in the [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

Tunnel management is at
[Platform → Organization → Tunnels](https://platform.openai.com/settings/organization/tunnels).
The local profile name is `wowsync`; its YAML is user-specific under
`%APPDATA%\tunnel-client\wowsync.yaml` and must not be copied into this repo.
The profile launches Node directly:

```text
node.exe D:/dev/wow-addons/WoWSync-Dashboard/packages/mcp/src/index.ts
```

The MCP executable must remain direct Node execution. Do **not** replace it
with `npm.cmd run start --workspace @wowsync-dashboard/mcp`, `npm run`, `npx`,
PowerShell, or another wrapper. npm lifecycle banners previously polluted
stdout ahead of JSON-RPC frames; tunnel discovery correctly failed to parse
that stream. The subsequent Node `EPIPE` was a consequence of the tunnel
closing the failed child pipe, not the original fault. MCP stdout is protocol
only; diagnostics go to stderr.

### Start and stop

1. Open PowerShell in the Dashboard repository root.
2. Ensure `CONTROL_PLANE_API_KEY` is securely available to this process using
   the local secret-handling method you chose. The variable's value must never
   be placed in this repository, command history, logs, chat, or documentation.
   Use a least-privilege runtime key whose principal has the required Tunnels
   **Read + Use** access; do not use an organization admin key. Tunnel runtime
   authentication is separate from the ChatGPT MCP App's authentication
   selection.
3. After local configuration changes or when troubleshooting, run:

   ```powershell
   .\tools\tunnel-client\tunnel-client.exe doctor --profile wowsync --explain
   ```

4. Start and leave the foreground process running while ChatGPT needs WoWSync:

   ```powershell
   .\tools\tunnel-client\tunnel-client.exe run --profile wowsync
   ```

5. Stop with **Ctrl+C** in that window. WoWSync tool calls will fail until
   the tunnel client is started again.

`tunnel-client` also has local operator/health surfaces. Leave their default
loopback binding in place; do not enable remote UI access for this integration.

The installed v0.0.15 CLI exposes `run` as its long-lived poller. It also has
`runtimes connect/status/stop` commands for native local runtime supervision;
its own help describes `connect` as the long-lived runtime path managed by
Codex. That mode was not configured or tested here. It is not documented by
the CLI help as a Windows service, scheduled task, or OS startup integration.
OpenAI's current deployment guide mentions VM/systemd and container patterns,
but does not establish a supported Windows service recipe. Keep the manually
started foreground process as today's recommendation; no persistent startup
is configured. If Codex-managed supervision is considered later, review its
credential/profile storage and lifecycle separately. This does not authorize
installing the optional Codex tunnel plugin.

### ChatGPT connection

The validated personal app is named **WoWSync**. In ChatGPT's current
Plugins/app connection flow, choose the tunnel connection and the `wowsync`
tunnel. The MCP App uses **No authentication**: the local tunnel client's
control-plane key authenticates the tunnel and is not an MCP OAuth credential.
The tunnel must be running during app discovery and every tool call. Product
labels can change; OpenAI's current [plugin connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
describes developer-mode apps and the Tunnel connection option. The MCP server
is available in a tested normal ChatGPT conversation. This acceptance record
does not separately claim Project-specific invocation unless that is tested
again in a Project chat.

### Troubleshooting

- Run `tunnel-client doctor --profile wowsync --explain` and check that the
  named profile can resolve its runtime credential, tunnel identity, Node
  executable, and stdio MCP target. Never copy credential output into a ticket
  or chat.
- Confirm `tunnel-client run --profile wowsync` is still running and healthy;
  calls stop when it exits.
- Confirm the profile starts the direct Node MCP entrypoint above, not npm.
- If the child fails at startup, check the configured `WOWSYNC_MCP_DB_PATH`
  points to the intended existing database and `WOWSYNC_MCP_RESEARCH_ROOT`
  points to the registered research corpus. MCP fails closed when its database
  schema is missing or incompatible; it does not create or migrate tables.
- If discovery reports a response/protocol failure, check for any non-JSON
  output on MCP stdout. Keep diagnostics on stderr and run the MCP package's
  protocol tests using a temporary fixture database.
- Do not expose the Dashboard publicly, open firewall ports, or add a public
  proxy as a workaround. OpenAI's [tunnel troubleshooting guidance](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#troubleshooting)
  also recommends checking client health and rerunning `doctor`.

### Schema and data preservation lessons

The strict read-only reader correctly refused the live database when the old
schema lacked `snapshot_currency_sections` and `snapshot_currencies`. The
one-time repair used the existing normal writable `SqliteSnapshotStore`
initialization path after a timestamped backup; character and snapshot counts
were 20 and 137 respectively before and after, and data fingerprints were
preserved. The backup is retained locally under `data/backups/` and excluded
from git. This is an operational rule, not a
reason to make MCP permissive: schema upgrades belong to the ordinary writable
application/migration path, never MCP startup. MCP must not initialize, migrate,
backfill, or otherwise repair the live database.

The separate Phase 6 stdio failure had two causes: npm's lifecycle output
violated stdout framing, and the former legacy-only transport setup did not
support current modern discovery. The fix uses the SDK `serveStdio` factory,
advertises its supported protocol versions, and retains the legacy path. A
regression test exercises modern `server/discover` with protocol `2026-07-28`,
then `tools/list` and JSON-only stdout, alongside legacy initialization. Do not simplify the entrypoint back
to npm or legacy-only transport wiring.

## Phase 6 live ChatGPT acceptance (2026-09-28)

The personal **WoWSync** MCP App was created/installed through the OpenAI
Secure MCP Tunnel connection and invoked in a real normal ChatGPT conversation.
The tunnel passed `doctor --profile wowsync --explain`; no public Dashboard or
MCP endpoint was created. Results below are a durable summary, not a transcript:

| Acceptance check | Result |
|---|---|
| `list_versions` | Returned four isolated buckets: Retail (12 characters), Classic Era (3), TBC Anniversary (3), Forever (2). |
| Retail Virek/Cairne summary | `FOUND`, level 90 Hunter, `OBSERVED`, recent, snapshot 136; bank remained `LAST_SEEN`, bags `OBSERVED`. |
| Retail Virek/Cairne equipment | `FOUND`, complete slot-level equipment, `OBSERVED`, snapshot 136. |
| Retail Janne/Cairne professions | Midnight Herbalism 43/100 and Mining 54/100, `OBSERVED`, complete, snapshot 108. |
| Retail profession coverage | Returned `DERIVED` from the 12 Retail characters; Jewelcrafting and Leatherworking had `coverageStatus: none`. Profession existence does not itself imply Midnight-tier coverage. |
| Retail Virek Renown | `UNKNOWN`, with reason `WoWSync does not currently capture Renown.` No inferred rank or zero. |
| Research search for Ritual Sites | Returned three registered matches from `midnight-12-1-renown`, snapshot 2026-09-28. |
| Research section retrieval | Retrieved registered section `other-current-tracks` from `midnight-12-1-renown` with its research metadata. |
| Cross-version isolation | TBC Anniversary / Virek / Cairne returned `NOT_FOUND`, without Retail fallback. |

Together with the local protocol tests, this validates modern MCP discovery,
the installed tool surface, real tool invocation, version isolation,
and preservation of `OBSERVED`, `LAST_SEEN`, `DERIVED`, and `UNKNOWN`.
Project-specific invocation is not asserted by this record; it was not part
of the acceptance results summarized above.
