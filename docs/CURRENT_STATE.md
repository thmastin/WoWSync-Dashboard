# Current WoWSync state

**Describes commit `5b3b0558447872c51974106e7f18144ab82b6263` on `feature/dashboard-integration`
(ops: track full wowsync-dev systemd topology).** Application behavior has not changed since that
commit as of this documentation milestone (documentation-only commits may follow it on
`docs/phase2-durable-documentation` without invalidating this stamp — check `git log
docs/phase2-durable-documentation` if you need the exact set of commits that produced this file).
If this SHA is not an ancestor of the branch you're reading this on, treat this document as
possibly stale and re-verify against source.

For the fixed onboarding entry point, start at [`START_HERE.md`](START_HERE.md).

## What's shipped

- **Core Dashboard**: import (manual paste, `import:saved` CLI, `watch:saved`/capture receiver —
  three transports converging on one `SqliteSnapshotStore.importSnapshot()` call), version
  isolation (`classic-era`/`tbc-anniversary`/`retail`/`forever`, with unrecognized clients
  quarantined rather than guessed), the diff engine, `AccountFacts`/`AccountContext`, shared
  storage (Warband/Guild Bank reconciled from an immutable observation journal), item metadata,
  and Ask My Account (experimental). See [`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md) for the full
  implementation reference.
- **Azeroth ERP Vertical Slice 1**: durable `STOCK_TARGET` demands (`packages/core/src/demand.ts`,
  the `demands` table), deterministic allocation reasoning (`packages/core/src/allocation.ts`),
  and the `get_item_allocation` MCP tool. Retail-only, one commodity per demand, account-scoped.
  See [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) for the full semantics
  contract and the live-validation record.
- **MCP**: read-only STDIO server over `DashboardReadModel`. Current tool count: run
  `grep -c "server.registerTool(" packages/mcp/src/server.ts` yourself rather than trusting a
  number here — it changes as tools are added. As of this baseline it was **25**, including
  `get_item_allocation` as the newest addition. See
  [`MCP_DEVELOPMENT.md`](MCP_DEVELOPMENT.md) for the registered-tool table.
- **Live ChatGPT MCP validation**: the Azeroth ERP Slice 1 live validation (Void-Tempered Leather,
  base item ID 238511) succeeded end-to-end through the real Omarchy DEV Secure MCP Tunnel path.
  Full record, numbers, and framing: see
  [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md#live-validation-record-azeroth-erp-slice-1)
  (not duplicated here). The temporary validation demand used for that record has since been
  deactivated through the normal API (status flipped to `INACTIVE`, never deleted) and does not
  describe current demand state.
- **Omarchy DEV systemd topology**: now reconstructable from the repository
  (`ops/systemd/wowsync-dev.target`, `wowsync-dev-dashboard.service` + drop-in,
  `wowsync-dev-mcp-tunnel.service`, `wowsync-dev-herdr.service`, plus
  `tools/omarchy/install-wowsync-dev.sh` and the `wowsync-dev` operator CLI). See
  [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) for the full topology, what's tracked vs.
  host-only, and safe validation commands.
- Omarchy DEV is operational under Unix identity `wowsync-dev`: writable DEV checkout, DEV
  Dashboard on loopback port 4174, DEV-only Herdr control plane, and the accepted read-only MCP
  connection. The current tunnel ID is **not** written here or anywhere else in this repository —
  see `OPERATIONS_RUNBOOK.md`, "Do not hard-code the live tunnel ID," for how to check it live.
  Windows sign-in continues to run the capture supervisor, SavedVariables watcher, and SSH
  forwarding; its old MCP tunnel ownership was retired after Omarchy acceptance. See
  [`WINDOWS_CAPTURE_SETUP.md`](WINDOWS_CAPTURE_SETUP.md).
- Omarchy LIVE has not been cut over. Its Dashboard is inactive; there is no authoritative LIVE
  database, importer/receiver, MCP/tunnel, or production credential set there. The authoritative
  WoWSync database and normal capture path remain on Windows.

## Current limitations

- **No demand-management UI.** Demand CRUD HTTP routes exist (`packages/server/src/demandRoutes.ts`)
  but have no caller anywhere in this codebase — no UI, no MCP mutation tool. The only way to
  manage a demand today is a direct HTTP call.
- **No MCP mutation capability, anywhere.** Every MCP tool, including `get_item_allocation`, is
  structurally read-only (SQLite opened `readOnly: true`; the `SnapshotReadStore` interface has no
  write methods). MCP never authors demand.
- Azeroth ERP Slice 1 is Retail-only, one commodity per demand, account-scoped (no character
  scope), and covers `STOCK_TARGET` only. See
  [`NON_GOALS_AND_FUTURE_ARCHITECTURE.md`](NON_GOALS_AND_FUTURE_ARCHITECTURE.md) for everything
  explicitly deferred beyond it.
- Warband account scope is `installation-local`, not a true Battle.net account ID — two Battle.net
  accounts imported into one installation are currently indistinguishable.
- No demand-management UI, no Dashboard-UI consumer of `DashboardReadModel` (that read model
  serves MCP only — see [`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md)), and no public
  Dashboard/MCP endpoint of any kind.

## Development gates

The primary agent may inspect and change this DEV repository, run normal development commands and
validation, and commit/push validated work to `feature/dashboard-integration`. It must not merge
to `main`. Tate remains the gate for authoritative database migration, production credentials,
Windows LIVE destination switch, destructive LIVE work, addon deployment/live-game validation
(including `/reload`), and merge to `main`.

## Trust model (unchanged)

Preserve version isolation and data semantics: `OBSERVED`, `UNKNOWN`, `LAST_SEEN`, `DERIVED`;
UNKNOWN is never zero, inaccessible data is never empty, and LAST_SEEN is never current. Keep
Character Bank owned by character, Warband by account, and Guild Bank by guild. The full invariant
set, including the Azeroth ERP additions, is in
[`ARCHITECTURE_INVARIANTS.md`](ARCHITECTURE_INVARIANTS.md).

Hardcore/SSF version handling is **not implemented** — it was previously (incorrectly) stated here
as current behavior. It is a deferred design intent only; see
[`ROADMAP.md`](ROADMAP.md#deferred--future) for the correctly-framed version.
