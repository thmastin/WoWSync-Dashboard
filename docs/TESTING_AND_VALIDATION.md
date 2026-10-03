# Testing and Validation

This is the testing/live-validating reference: how to run normal automated checks, how the two
read-projection pipelines are guarded against drift, how MCP is smoke-tested, how real-data live
acceptance events are recorded, and how to tell a test fixture apart from live evidence.

## Automated tests and build

```bash
npm test               # runs each workspace's test suite (npm run test --workspaces --if-present)
npm run build:web      # production build of packages/web
```

`tsc --noEmit` (see root `tsconfig.base.json`) type-checks `packages/core` and `packages/server`,
which otherwise run their `.ts` files directly under Node 24 with no compile step.

The full test suite is loopback-network-dependent in places (server tests bind random loopback
ports). On the Omarchy DEV host specifically, the host firewall denies host-local loopback ports
used by tests; run the suite from a private network namespace there (see
[`OMARCHY_DEV_LIVE_ISOLATION.md`](OMARCHY_DEV_LIVE_ISOLATION.md), "Network boundary") rather than
opening a host port range. This is a DEV-host-specific firewall interaction, not a property of the
test suite itself — it does not apply to a normal developer machine.

## Read-model parity testing

`packages/core/test/readModelParity.test.ts` exists specifically to guard Pipeline A
(`AccountFacts`/`AccountContext`/`LlmContext`, serving the Dashboard UI and Ask My Account) and
Pipeline B (`DashboardReadModel`, serving MCP) against semantic drift — see
[`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md), "The two read-projection pipelines." Run it whenever
either pipeline's projection logic changes, even if the change looks confined to one pipeline:
the two are expected to agree on overlapping questions (e.g. "what spells does this character
know"), and this suite is the thing that would catch a silent divergence.

## MCP smoke validation

```bash
npm run test --workspace @wowsync-dashboard/mcp
```

The protocol tests cover both legacy SDK-client initialization and raw modern stdio discovery
(`server/discover` followed by `tools/list`), launching the entrypoint directly with Node and
checking every stdout line as a JSON-RPC frame against a temporary fixture database — never a real
one. MCP stdout must carry only newline-delimited JSON-RPC frames; any banner/log/warning text on
stdout breaks protocol discovery (diagnostics belong on stderr). This is the local smoke test;
it does not reach the live tunnel or ChatGPT (see "Real-data live acceptance testing" below for
that).

## Distinguishing test fixtures from live evidence

- **Fixtures** live in `packages/*/test/` (and helpers like `fixtureBuilder.ts`), run against
  `:memory:` or temporary SQLite databases, and are deterministic and disposable. Nothing in a
  fixture run touches `data/wowsync.sqlite` or any `/var/lib/wowsync-{dev,live}` database.
- **Live evidence** means a real character export, imported into a real database (the repo's
  `data/wowsync.sqlite` for local development, or `/var/lib/wowsync-dev/db/wowsync.sqlite` on the
  Omarchy DEV host), observed through the normal Dashboard/MCP read paths.
- A document recording live evidence (an acceptance record) must say so explicitly and include
  enough detail (character names, item IDs, exact observed quantities, dates) that a future reader
  can tell it apart from a fixture-based example. Conversely, never dress up a fixture scenario in
  acceptance-record language — label it as a test, with its file and scenario name.

## How to record a future acceptance event

The Azeroth ERP Slice 1 live-validation record in
[`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md#live-validation-record-azeroth-erp-slice-1)
is the template for the next one. When you need to record a new real-data live acceptance event:

1. State the exact commodity/version/item under test (name and base item ID — not just a
   description).
2. State the exact observed evidence per source (per-character, Warband, any unresolved scopes)
   with real numbers, not illustrative ones.
3. State the exact demand record used (type, required quantity) and that it was created through
   the normal API, not injected directly into the database.
4. State the exact result returned by the live path under test (resolution branch, every numeric
   field, disposition, unresolved-evidence flags) — copy the real values, don't paraphrase them.
5. State how the temporary/test demand was cleaned up afterward (deactivated via the normal API —
   a status flip to `INACTIVE` — never deleted, and never left `ACTIVE` as if it were current
   state).
6. Frame the whole record as **historical** — a one-time event that proved a specific chain of
   components end-to-end — not as a description of current demand state. Put it in a clearly
   labeled "live validation record" or "acceptance record" section, distinct from the surrounding
   semantics sections, exactly as the Slice 1 record does.
7. Never retroactively edit an old acceptance record's numbers to look current. If circumstances
   changed, add a new dated record instead.

## MCP deployment / Refresh-tools / new-conversation procedure

**This procedure is an externally observed fact about ChatGPT's own client behavior, as observed
on 2026-10-02. It is not enforced, automated, or guaranteed by any code in this repository.**
Record it here because it materially affects how you validate a newly added or changed MCP tool,
but do not treat it as something this repository's tests cover.

1. Deploy/update the MCP source on the DEV host.
2. Restart the relevant MCP/tunnel runtime (`systemctl restart wowsync-dev-mcp-tunnel.service` or
   `wowsync-dev restart`) — this is a deliberate **operator action**, not something this milestone
   automates further.
3. In ChatGPT: Plugins -> WoWSync DEV -> Manage app -> Refresh tools.
4. Start a **new** ChatGPT conversation to validate a newly added/changed tool.

Observed on 2026-10-02: an already-open ChatGPT conversation retained its original 24-tool surface
even after clicking Refresh tools; a brand-new conversation immediately saw the 25th tool
(`get_item_allocation`) and successfully executed the live Slice 1 validation recorded in
`AZEROTH_ERP_ARCHITECTURE.md`. Treat this purely as an observed quirk of ChatGPT's own tool-caching
behavior — when validating a newly registered tool, always start a fresh conversation rather than
trusting an existing one's tool list, and do not assume a future ChatGPT client version behaves the
same way.
