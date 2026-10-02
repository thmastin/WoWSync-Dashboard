# WoWSync MCP: development, operations, and acceptance

Status: Phase 6 complete; Secure MCP Tunnel and the personal ChatGPT MCP App
were live-validated on 2026-09-28. No public Dashboard/MCP endpoint, MCP OAuth,
or Dashboard UI integration exists or is intended for this path. The separate
Ask My Account feature is unchanged.

The current **DEV** tunnel runtime is on Omarchy. The root-managed
`wowsync-dev-mcp-tunnel.service` runs the official tunnel-client v0.0.15 as
`wowsync-dev`, launches the local stdio MCP child from this checkout, and reads
`/var/lib/wowsync-dev/db/wowsync.sqlite`. Its runtime key is supplied through a
systemd credential sourced from `/etc/wowsync/dev/tunnel-api-key`; the secret
is not stored in this repository or in the unit. The accepted Omarchy tunnel ID
is `tunnel_6abd1086c3c08191ac4f9c1a64cc6787`. Do not use the old Windows tunnel
ID for this runtime.

The old Windows DEV MCP runtime was retired after Omarchy acceptance. The
Windows capture supervisor no longer starts or monitors tunnel-client; it
continues to own SavedVariables watching, DEV capture transfer, required SSH
forwarding, and scheduled startup. Rollback material is intentionally retained
at `%APPDATA%\tunnel-client\wowsync.yaml`, including the old tunnel ID
`tunnel_6abac56510a08191a9bf6c8075a8de3f` and its existing credential
material. The old MCP must not be described or treated as active.

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
| `get_character_state` | Return bounded current character state with section-level provenance. |
| `get_character_history` | Return a compact, newest-first paged snapshot timeline for one character. |
| `get_character_changes` | Compare the previous/latest snapshots or two explicit snapshots for one character. |
| `get_character_spells` | Return bounded known-spellbook evidence from the current or selected snapshot. |
| `get_character_trainer` | Return bounded trainer-visit services and the exact captured status at visit. |
| `get_account_overview` | Return bounded version-scoped account/economy facts, currencies and storage coverage. |
| `get_account_currencies` | Return detailed bounded currency evidence with ownership scope and per-character coverage. |
| `get_account_changes` | Page the existing AccountFacts recent meaningful-change summaries. |
| `get_character_equipment` | Return latest-known slot equipment with provenance. |
| `get_character_professions` | Return captured profession observations and their provenance. |
| `get_character_currencies` | Return captured currency data, bounded to 100 records. |
| `get_profession_coverage` | Return per-version account profession coverage as derived data. |
| `get_renown` | Return captured Renown state; currently `UNKNOWN` because WoWSync does not capture it. |
| `list_research_documents` | List registered research metadata with a bounded section outline, not document bodies. |
| `get_research_document` | Retrieve one registered document, capped at 40,000 characters. |
| `search_research` | Search registered research with a default 5 / hard 8 result limit. |
| `get_research_section` | Retrieve one registered heading section, capped at 20,000 characters with explicit truncation. |
| `search_items` | Search item metadata from the selected version's captured data. |
| `get_character_storage` | Retrieve bounded character-owned storage for one character. |
| `get_shared_storage` | Retrieve bounded account/Warband shared storage. |
| `get_item_metadata` | Retrieve deterministic metadata for specified item IDs. |
| `get_item_allocation` | Azeroth ERP Vertical Slice 1: resolve one commodity's active STOCK_TARGET demand against account-owned evidence into a deterministic allocation decision. See `docs/AZEROTH_ERP_ARCHITECTURE.md`. |

This brings the implementation to 25 registered tools. All tools are marked read-only and closed-world. Every account-state query
requires an explicit canonical version; none defaults to Retail. Character
lookups return `AMBIGUOUS` instead of selecting a same-name realm. Results
preserve `OBSERVED`, `DERIVED`, `LAST_SEEN`, and `UNKNOWN`. Renown is currently
an intentional `UNKNOWN`, because WoWSync has not captured it.

Results are bounded: characters default to 50 and cap at 100; currency and
account-change pages default to 20 and cap at 100; per-currency character rows
default to 25 and cap at 100; spell pages default to 50 and cap at 100; trainer
service pages default to 50 and cap at 100, with at most 50 categories; research
search defaults to 5 and caps at 8; research outlines return at most 100 rows
per document; a section caps at 20,000 characters and a document at 40,000
characters, both with explicit truncation metadata.

The account overview caps per-character detail at 25, realms and recorded guild
owners at 20, profession coverage at 25, currency summaries at 20 per account or
realm, and recent change/level-up highlights at 10. The compact
character state caps professions at 10 and currencies at 20. Missing gold totals
remain omitted when no character gold is known; a captured zero remains an explicit
zero. Warband and guild observations are reported separately from character wealth.

`get_character_state` reports character bank state from the latest character snapshot;
`LAST_SEEN` includes an explicit historical warning and is never represented as live.
The account overview reports shared storage coverage and freshness without assigning
market values to stored assets.

`get_character_history` requires `version` and `name`, accepts optional `realm`,
`offset`, and `limit`, defaults to 20 entries, and caps each page at 100. Entries
are newest first and contain snapshot IDs, generated/observed/imported timestamps,
freshness, compact character facts, and section states. They never include parsed
snapshot data, inventories, or full equipment payloads.

`get_character_changes` requires `version` and `name`, accepts optional `realm`,
and accepts `fromSnapshotId` and `toSnapshotId` only as a pair. Without IDs it
compares previous to latest. Explicit IDs must both belong to the resolved
character in the requested version. Semantic change lists cap equipment at 20,
bag and character-bank item deltas at 25 each, professions at 20, and currencies
at 20. Each bounded list reports returned count, total count, and truncation.
The comparison state is `COMPARED`, `PARTIAL`, `UNKNOWN`, `LAST_SEEN`, or
`NOT_COMPARABLE`; a character with fewer than two snapshots reports
`INSUFFICIENT_HISTORY`. Numeric zero remains distinct from a missing value.
Additions/removals require complete observed evidence on both sides. UNKNOWN,
partial observations, missing captured fields, and LAST_SEEN sections do not
produce fabricated removals or deltas. A stale bank is explicitly historical;
when either bank observation is LAST_SEEN, bank item changes are withheld.
Currencies compare only matching IDs with known quantities and unchanged
ownership scope in two observed lists; deltas label ACCOUNT, CHARACTER, or
UNKNOWN scope. Unlisted currencies are not treated as zero or removed. Independent
Warband and guild journal observations are outside character snapshot diffs.

`get_character_spells` accepts `{version, name, realm?, snapshotId?, query?,
offset?, limit?}`. It returns captured spellbook rows only, with section state,
coverage text, snapshot provenance, freshness, and bounded paging. UNKNOWN
sections have no fabricated empty spell list. The capture is scoped to the
snapshot's recorded spellbook coverage; it is not a promise of every spell the
character could learn.

`get_character_trainer` accepts `{version, name, realm?, snapshotId?,
category?, status?, query?, offset?, limit?}`. Service `statusAtVisit` values
are returned as captured (known, available, unavailable, or unclassified),
alongside category observation time, state, and freshness. “Available” means
the trainer observation said available at that visit; it does not establish
that the character later trained it. LAST_SEEN trainer categories remain
historical. No trainer recipe catalogue or known profession-recipe list is
captured by the current schema.

`get_account_currencies` accepts `{version, realm?, currencyID?, query?,
offset?, limit?, characterOffset?, characterLimit?}`. Retail reads are
explicitly account-wide; realm-partitioned versions require a realm and return
only that realm's projection. Account-wide balances are represented once,
character currencies sum known per-character quantities only, and an absent or
conflicting ownership flag yields scope `UNKNOWN` with no aggregate. Every
currency row retains per-character state and quantity evidence, including
known zero, unknown, and not-listed distinctions.

`get_account_changes` accepts `{version, realm?, offset?, limit?}` and pages
the canonical `AccountFacts.recentChanges` ordering/derivation. Each result
includes realm and freshness. This is a high-level character transition
summary; use `get_character_changes` for section comparability and explicit
UNKNOWN/LAST_SEEN reasons.

`list_research_documents` now includes up to 100 heading-outline entries per
registered document, plus total/returned/truncation counts. `get_research_document`
accepts only a registered `documentId`; caller paths are not accepted. It
returns registered metadata, content hash, and at most 40,000 characters with
explicit truncation. Existing exact section retrieval remains capped at
20,000 characters.

## Fresh MCP parity audit (2026-09-30)

| Area | Status | Source / boundary |
|---|---|---|
| Account overview / economy | MCP PARITY | `AccountFacts`, structured currencies, shared-storage journal; shared owners never enter personal wealth. |
| Character identity/current state | MCP PARITY | `DashboardReadModel` over version-scoped `SnapshotReadStore`. |
| Equipment | MCP PARITY | Typed equipment sections and semantic history diff. |
| Bags | MCP PARITY | Typed inventory reads and semantic diff. |
| Character bank | MCP PARITY | Typed storage read; `LAST_SEEN` marked historical. |
| Shared Warband storage | MCP PARITY | Retail shared-storage journal; account ownership kept distinct. |
| Guild storage/accessibility | MCP PARITY | Journal coverage exposes inaccessible/unconfirmed tabs, not empty tabs. |
| Item metadata | MCP PARITY | Deterministic registered item metadata lookup. |
| Item search | MCP PARITY | Bounded search over typed version-scoped read projections. |
| Professions | MCP PARITY | Current bounded character profession state. |
| Profession coverage | MCP PARITY | Derived by `AccountFacts` / provider-neutral coverage. |
| Known profession recipes | NOT CAPTURED | No recipe catalogue/known-recipe capture in current schema. |
| Trainer observations | MCP PARITY | `spells`/`trainer` snapshot sections; exact visit statuses and freshness retained. |
| Known spells / spellbook | MCP PARITY | Captured spellbook section; capture coverage may be limited by client/spec. |
| Character currencies | MCP PARITY | Structured currency list, per-character state and quantities. |
| Account-wide/shared currencies | MCP PARITY | `buildAccountCurrencies`; scope requires captured ownership evidence. |
| Renown | NOT CAPTURED | `get_renown` reports UNKNOWN; research documents do not establish character Renown. |
| Other progression/account facts | PARTIAL MCP PARITY | Captured level/XP/location and derived account facts are available; unrecorded progression remains unknown. |
| Snapshot history | MCP PARITY | Bounded compact `SnapshotReadStore` timeline. |
| Semantic snapshot changes | MCP PARITY | Provider-neutral `diffSnapshots`; missing or historical evidence does not invent removals. |
| Research list/search/section | MCP PARITY | Fixed `ResearchRegistry`, registered-only. |
| Research metadata/outline/full registered doc | MCP PARITY | Registry metadata, bounded outline and 40,000-character registered document read. |
| Spell/trainer historical comparison | CAPTURED BUT NOT MCP-EXPOSED | Snapshot diff does not compare these sections: spellbook capture coverage can vary and trainer visits are point-in-time observations, not learned-state transitions. |
| External game data, auction prices, arbitrary paths/SQL, raw snapshots, mutations | INTENTIONALLY OUT OF MCP SCOPE | Not a provider-neutral captured read capability; no such MCP surface is exposed. |

This pass adds five tools, bringing the implementation to 24 registered tools;
the five-tool addition is pending external ChatGPT acceptance after the DEV MCP
reload. No addon/capture changes were made. Remaining capture-dependent gaps
are known recipes and Renown; spellbook coverage completeness is also bounded
by what the client captured.

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

### Windows rollback profile: start and stop

These commands describe the preserved Windows fallback, not the active DEV
runtime. Open PowerShell in the Windows Dashboard repository root.

1. Ensure `CONTROL_PLANE_API_KEY` is securely available to this process using
   the local secret-handling method you chose. The variable's value must never
   be placed in this repository, command history, logs, chat, or documentation.
   Use a least-privilege runtime key whose principal has Tunnels **Read + Use**;
   do not use an organization admin key.
2. After local configuration changes or when troubleshooting, run:

   ```powershell
   .\tools\tunnel-client\tunnel-client.exe doctor --profile wowsync --explain
   ```

3. For rollback troubleshooting only, start the preserved Windows profile in
   the foreground:

   ```powershell
   .\tools\tunnel-client\tunnel-client.exe run --profile wowsync
   ```

4. Stop a manually launched rollback process with **Ctrl+C**. The current
   Windows supervisor does not manage tunnel-client. Do not change its
   capture/transfer components when handling the retained rollback material.

`tunnel-client` also has local operator/health surfaces. Leave their default
loopback binding in place; do not enable remote UI access for this integration.

The v0.0.15 CLI exposes `run` and native `runtimes connect/status/stop`
commands. The Windows supervisor previously managed `run --profile wowsync`,
but commit `42a17ba` retired that ownership after Omarchy acceptance. Preserve
the profile, old tunnel ID, and credential material for rollback; they are not
active. Windows scheduled startup continues for capture and forwarding. This
does not install the optional Codex tunnel plugin or alter the MCP app.

### ChatGPT connections

The original personal app is named **WoWSync** and uses the Windows tunnel for
the historical Phase 6 acceptance below. The separate **WoWSync DEV** app
connection uses the Omarchy tunnel ID above and **No authentication**. The
tunnel runtime key authenticates tunnel-client to the control plane; it is not
an MCP OAuth credential. Product labels can change; OpenAI's current
[plugin connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
describes developer-mode apps and the Tunnel connection option.

### Troubleshooting

- On Omarchy, check `systemctl status wowsync-dev-mcp-tunnel.service` and its
  journal. Do not print credential contents or credential-bearing diagnostics.
- Confirm the unit starts the direct Node MCP entrypoint, supplies the DEV DB
  and research paths, and references the key through a systemd credential; it
  must not invoke npm or npx.
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

## Omarchy DEV external ChatGPT acceptance (2026-09-30)

The separate **WoWSync DEV** connection was accepted from a normal ChatGPT
conversation through the Omarchy Secure MCP Tunnel. At that historical
acceptance point, all 15 then-registered tools were visible;
`list_versions` and Retail Squashpot storage retrieval succeeded against the
Omarchy DEV database. Squashpot's bags were `OBSERVED` with 94 item stacks,
28 free of 126 slots, and no truncation. Deterministic item metadata was
returned. The observed inventory included 58 Void-Tempered Leather,
8 Void-Tempered Scales, and 1 Fine Void-Tempered Hide.

The active Omarchy runtime is tunnel-client v0.0.15 under
`wowsync-dev-mcp-tunnel.service`, running as `wowsync-dev` and owning its local
stdio MCP child. It reads the Omarchy DEV SQLite database. The Windows MCP
tunnel `tunnel_6abac56510a08191a9bf6c8075a8de3f` was retired after acceptance;
its profile and credential material remain only for rollback. The four newer
retrieval tools are `search_items`, `get_character_storage`,
`get_shared_storage`, and `get_item_metadata`.
