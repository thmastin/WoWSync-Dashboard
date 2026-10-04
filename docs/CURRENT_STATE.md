# Current WoWSync state

**Describes commit `5b3b0558447872c51974106e7f18144ab82b6263` on `main`
(ops: track full wowsync-dev systemd topology).** Application behavior has not changed since that
commit as of this documentation milestone (documentation-only commits may follow it on
`docs/phase2-durable-documentation` without invalidating this stamp — check `git log
docs/phase2-durable-documentation` if you need the exact set of commits that produced this file).
If this SHA is not an ancestor of the branch you're reading this on, treat this document as
possibly stale and re-verify against source (use `git ls-remote origin main` rather than a
possibly-stale local `origin/main` tracking ref if you need to re-check what's actually on the
remote).

**Azeroth ERP Slice 2 addendum.** Application behavior *did* change after that stamp: `main` was
fast-forwarded on 2026-10-03 to `77f9c95bdeb5d804bc8bdce68f3e25ad1e9083ee`
(`fix: distinguish ERP unknown-quantity causes and LAST_SEEN floors`), which adds the Account
Allocation Review described below. Application behavior on `main` has not changed since that commit;
documentation-only commits may follow it.

**Azeroth ERP Slice 3 addendum.** Slice 3 was shipped and blindly live-validated through the deployed
DEV MCP runtime at source `81f66eeb8a035acf3c633f6fa9d8693cc4f9a009`; that source is now on `main`.
See the Slice 3 contract and live-validation record in
[`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md#live-validation-record-azeroth-erp-slice-3).
The temporary validation demands were deactivated afterward. No active Retail demand remains from
validation.

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
- **Azeroth ERP Vertical Slice 2 — Account Allocation Review**: `DashboardReadModel.getAllocationReview`
  (`packages/core/src/allocationReview.ts`) and the read-only `get_allocation_review` MCP tool. One
  account-wide, independently paged view of every active demand's allocation result (identical to
  `get_item_allocation`) and of account-owned holdings with no active demand (`unallocated` — evidence
  only, never surplus, no disposition). Retail-only, explicit version, no new durable state. The shared
  evidence projection (`projectAccountOwnedEvidenceMap` / `evidenceForItem`) now serves both slices,
  and a present item row with an unreported quantity is no longer summed as 0: in observed storage it
  is unresolved item-quantity evidence (reason `ITEM_QUANTITY_UNKNOWN_PRESENT`, distinct from unknown
  storage) that gates sale disposition; in LAST_SEEN storage it changes no number or disposition and is
  reported by `potentialUnknownQuantityRowCount` and the LAST_SEEN reasons. See [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) §23.
  **Shipped and live-validated 2026-10-03** through the full chain to ChatGPT (record:
  [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md#live-validation-record-azeroth-erp-slice-2)).
  Its temporary validation demand was deactivated afterward; no ACTIVE validation demand remains, and
  the record does not describe current demand state.
- **Azeroth ERP Vertical Slice 3 — Held-item identity and binding** (**shipped and live-validated** at
  `81f66eeb8a035acf3c633f6fa9d8693cc4f9a009`): base-item allocation arithmetic is performed only when the confirmed rows' normalized
  item strings prove aggregation valid (otherwise the new `BASE_ITEM_AGGREGATION_UNPROVEN` result, with no
  allocation numbers), and confirmed bound or binding-unknown rows withhold `SEND_HELLOMAGS` from a
  confirmed surplus. No new MCP tool and no persistence change. See
  [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) §24 and its Slice 3 live-validation record.
  Binding-only live isolation remains covered by automated tests; the real binding validation composed
  binding with unresolved character-bank evidence.
- **MCP**: read-only STDIO server over `DashboardReadModel`. Current tool count: run
  `grep -c "server.registerTool(" packages/mcp/src/server.ts` yourself rather than trusting a
  number here — it changes as tools are added. With Slice 2 it is **26**, including
  `get_allocation_review` as the newest addition (25 at the Slice 1 baseline). See
  [`MCP_DEVELOPMENT.md`](MCP_DEVELOPMENT.md) for the registered-tool table.
- **Live ChatGPT MCP validation**: Slices 1–3 passed live ChatGPT MCP validation. Slice 3 used a blind
  external conversation and passed allocation-review parity; the real-data record and separate
  OBSERVED/LAST_SEEN prevalence are in [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md#live-validation-record-azeroth-erp-slice-3).
  The Azeroth ERP Slice 1 live validation (Void-Tempered Leather,
  base item ID 238511) succeeded end-to-end through the real Omarchy DEV Secure MCP Tunnel path.
  Full record, numbers, and framing: see
  [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md#live-validation-record-azeroth-erp-slice-1)
  (not duplicated here). The temporary validation demand used for that record has since been
  deactivated through the normal API (status flipped to `INACTIVE`, never deleted) and does not
  describe current demand state.
- **Omarchy DEV systemd topology**: the **service definitions** are now tracked and
  reconstructable from the repository (`ops/systemd/wowsync-dev.target`,
  `wowsync-dev-dashboard.service` + drop-in, `wowsync-dev-mcp-tunnel.service`,
  `wowsync-dev-herdr.service`, plus `tools/omarchy/install-wowsync-dev.sh` and the `wowsync-dev`
  operator CLI). The install script reconstructs those definitions and brings up the dashboard
  path; it deliberately does not enable/start the mcp-tunnel or herdr services — that remains a
  separate manual operator step. See [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) for the
  full topology, exactly what's installed vs. enabled vs. started vs. still manual/host-only, and
  safe validation commands.
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

- **No MCP mutation capability, anywhere.** Every MCP tool, including `get_item_allocation` and
  `get_allocation_review`, is structurally read-only (SQLite opened `readOnly: true`; the `SnapshotReadStore` interface has no
  write methods). MCP never authors demand.
- **Allocation Tab implemented but not live-validated.** The Dashboard now has a Retail-only Allocation
  Tab (`#/retail/allocation`) for demand authoring and allocation review. It is implemented and test-validated
  but has not yet undergone independent live testing on real account data. The read-model query
  (`getAllocationReview`) is used by the Dashboard UI (a new second consumer besides MCP), and the
  demand CRUD routes are now callable by the Allocation Tab UI. See [`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md)
  ("The two read-projection pipelines", Pipeline C) for the narrow scope.
- Azeroth ERP Slice 1 is Retail-only, one commodity per demand, account-scoped (no character
  scope), and covers `STOCK_TARGET` only. Slice 2's review is Retail-only and does
  not value or rank unallocated inventory, and treats Hellomags as an ordinary character. The
  Allocation Tab UI is the first Dashboard consumer of the Slice 2 review. See
  [`NON_GOALS_AND_FUTURE_ARCHITECTURE.md`](NON_GOALS_AND_FUTURE_ARCHITECTURE.md) for everything
  explicitly deferred beyond it.
- Warband account scope is `installation-local`, not a true Battle.net account ID — two Battle.net
  accounts imported into one installation are currently indistinguishable.

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
