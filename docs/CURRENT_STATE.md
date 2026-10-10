**Latest feature-branch checkpoint (2026-10-09):** Phase 30 adds an active work-order review queue across the selected version's projects. It reuses readiness and progress evidence, prioritizes unresolved review, supports search/filter, and returns keyboard focus to the owning project. Full `npm.cmd run validate:erp` passed (Core 821; MCP 3; Server 259 plus 2 skips; Web 296; typecheck/build; 5 synthetic browser cases). Independent review found and verified the keyboard-focus fix. No live or production validation. See `ERP_CHECKPOINT_20261009_PHASE30.md`.
# Current WoWSync state

**Active ERP feature-branch checkpoint (2026-10-09):** Dashboard Phase 25, assigned-gatherer progress review, is pushed at `59ba78ae65fbec7628367ddef738786ff68c281f` on `feature/forever-gear-observation`. A GATHER work order can compare an explicitly assigned same-version character's complete, recent bag evidence against the prior comparable bag observation. The comparison shows item deltas and timestamps but never claims gathering, a route, or task completion. Stale, partial, future-dated, unordered, and identity-mismatched evidence remains UNKNOWN. REST, MCP, AccountContext schema 20, and the workbench use the same core projection. `npm.cmd run validate:erp` passed before the final test-only browser addition; all four synthetic browser acceptances then passed directly. No game or production validation occurred. See `ERP_PLANNING.md` and the 2026-10-09 Phase 25 truth checkpoint.

**Latest feature-branch checkpoint (2026-10-09):** Phase 30 adds an active work-order review queue across the selected version's projects. It reuses readiness and progress evidence, prioritizes unresolved review, supports search/filter, and returns keyboard focus to the owning project. Full `npm.cmd run validate:erp` passed (Core 821; MCP 3; Server 259 plus 2 skips; Web 296; typecheck/build; 5 synthetic browser cases). Independent review found and verified the keyboard-focus fix. No live or production validation. See `ERP_CHECKPOINT_20261009_PHASE30.md`.

**Previous feature branch ERP planning checkpoint (2026-10-09; automated validation and focused review complete):**
`feature/forever-gear-observation` extends the shared core with version-scoped persistent projects,
resource needs, cross-project reservations, manual work orders, project summaries in AccountContext,
REST CRUD/status routes, read-only MCP `get_erp_projects`, and a Dashboard Projects & Work Orders
workspace. Item/base-item/gold/exact-name profession evidence is evaluated from explicitly selected
character observations; current same-character export pairs expose non-causal section-level deltas.
Retail character-scoped currency evidence and existing Retail Warband/Guild item observations can be
selected explicitly as separate resource sources. Partial scans may establish a positive lower bound,
but cannot establish exhaustive shortfall; shared locations do not establish player ownership, access,
or transfer route. Currency, guild, and Warband evidence preserve their own scope and freshness.
`npm.cmd run validate:forever` passed after the shared-owner extension: core 781/781, MCP 2/2,
server 247 total (245 pass, 2 skipped), and web 286/286; all four TypeScript checks and production web
build passed. The build retains the large-chunk advisory (~519 kB). Focused independent review found
no blockers; its partial-Warband positive-lower-bound coverage request is now covered by a regression
test. No browser, persistent DEV, game, or production validation has occurred. See
[`ERP_PLANNING.md`](ERP_PLANNING.md) and the 2026-10-09 checkpoint report linked from the project
truth index. Recipes/craft feasibility, non-Retail currency/shared-storage projections, automatic
goal reconciliation/history, procurement evidence, transfer access, and broader operational
work-order flows remain open; this slice does not complete the ERP program.

**Describes commit `5b3b0558447872c51974106e7f18144ab82b6263` on `main`
(ops: track full wowsync-dev systemd topology).** Application behavior has not changed since that
commit as of this documentation milestone (documentation-only commits may follow it on
`docs/phase2-durable-documentation` without invalidating this stamp â€” check `git log
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

**ERP Allocation Tab addendum.** The Dashboard Allocation tab milestone is **complete**: feature
source `51628e4514448bb9cfdb56c1214d27ee38fa92e3` (`feature/erp-allocation-tab`) passed review, was promoted to DEV as that exact SHA
(no schema change) and passed real DEV UI validation on 2026-10-04, and was then merged to `main`
together with this documentation closeout. See the record in
[`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md#live-validation-record-dashboard-allocation-tab).
The temporary validation target was removed afterward; zero ACTIVE Retail targets remained.

For the fixed onboarding entry point, start at [`START_HERE.md`](START_HERE.md).

**DEV application deployment.** DEV Dashboard/MCP run from immutable exact-SHA releases at
`/home/wowsync-dev/releases/current`; the one-time runtime topology migration is complete, and Herdr
stays on the developer checkout. Deploying is one deliberate command,
`wowsync-dev-deploy deploy <ref> <validated-sha>`, which builds, backs up, switches, validates, and
recovers automatically (see [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md#deploying-to-dev)). The
launcher and sudoers rule are installed, the one-time bootstrap is complete, and the tool passed its
first real-host deployment on 2026-10-05 (`51628e4` -> `7da561362ef740a014fe65276ecccb60536c3af6`;
record in [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md#history)). That tooling is on `main`.
The live inline tunnel-ID drift is unmodified and separate.

## What's shipped

- **Core Dashboard**: import (manual paste, `import:saved` CLI, `watch:saved`/capture receiver â€”
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
- **Azeroth ERP Vertical Slice 2 â€” Account Allocation Review**: `DashboardReadModel.getAllocationReview`
  (`packages/core/src/allocationReview.ts`) and the read-only `get_allocation_review` MCP tool. One
  account-wide, independently paged view of every active demand's allocation result (identical to
  `get_item_allocation`) and of account-owned holdings with no active demand (`unallocated` â€” evidence
  only, never surplus, no disposition). Retail-only, explicit version, no new durable state. The shared
  evidence projection (`projectAccountOwnedEvidenceMap` / `evidenceForItem`) now serves both slices,
  and a present item row with an unreported quantity is no longer summed as 0: in observed storage it
  is unresolved item-quantity evidence (reason `ITEM_QUANTITY_UNKNOWN_PRESENT`, distinct from unknown
  storage) that gates sale disposition; in LAST_SEEN storage it changes no number or disposition and is
  reported by `potentialUnknownQuantityRowCount` and the LAST_SEEN reasons. See [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) Â§23.
  **Shipped and live-validated 2026-10-03** through the full chain to ChatGPT (record:
  [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md#live-validation-record-azeroth-erp-slice-2)).
  Its temporary validation demand was deactivated afterward; no ACTIVE validation demand remains, and
  the record does not describe current demand state.
- **Azeroth ERP Vertical Slice 3 â€” Held-item identity and binding** (**shipped and live-validated** at
  `81f66eeb8a035acf3c633f6fa9d8693cc4f9a009`): base-item allocation arithmetic is performed only when the confirmed rows' normalized
  item strings prove aggregation valid (otherwise the new `BASE_ITEM_AGGREGATION_UNPROVEN` result, with no
  allocation numbers), and confirmed bound or binding-unknown rows withhold `SEND_HELLOMAGS` from a
  confirmed surplus. No new MCP tool and no persistence change. See
  [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) Â§24 and its Slice 3 live-validation record.
  Binding-only live isolation remains covered by automated tests; the real binding validation composed
  binding with unresolved character-bank evidence.
- **ERP Allocation Tab â€” Dashboard stock targets + allocation review** (**shipped and DEV-validated** at
  `51628e4514448bb9cfdb56c1214d27ee38fa92e3`): a Retail-only top-level tab at `#/retail/allocation` that authors `STOCK_TARGET` demands (set
  "Keep N" with an optional purpose, edit, remove = deactivate, add by item ID for items not held) and
  presents the Slice 1â€“3 allocation review: account-level unseen-storage status shown once, Your
  targets (every result variant, including `BASE_ITEM_AGGREGATION_UNPROVEN` as "Allocation: not
  computed" and `CONFLICTING_DEMAND` as needing review), Held with no target (explicitly not surplus;
  searchable by name or exact item ID; paged), and a collapsed read-only Removed targets history. It
  reads `GET /api/versions/:version/allocation-review`, the narrow Dashboard consumer of
  `DashboardReadModel.getAllocationReview` (see [`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md)); MCP
  sees the same persisted demands. The demand routes reject wrong-version and INACTIVE mutations
  before changing anything. Allocation semantics are unchanged. See
  [`AZEROTH_ERP_ARCHITECTURE.md`](AZEROTH_ERP_ARCHITECTURE.md) Â§25 and its DEV validation record.
- **MCP**: read-only STDIO server over `DashboardReadModel`. Current tool count: run
  `grep -c "server.registerTool(" packages/mcp/src/server.ts` yourself rather than trusting a
  number here â€” it changes as tools are added. With Slice 2 it is **26**, including
  `get_allocation_review` as the newest addition (25 at the Slice 1 baseline). See
  [`MCP_DEVELOPMENT.md`](MCP_DEVELOPMENT.md) for the registered-tool table.
- **Live ChatGPT MCP validation**: Slices 1â€“3 passed live ChatGPT MCP validation. Slice 3 used a blind
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
  path; it deliberately does not enable/start the mcp-tunnel or herdr services â€” that remains a
  separate manual operator step. See [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) for the
  full topology, exactly what's installed vs. enabled vs. started vs. still manual/host-only, and
  safe validation commands.
- Omarchy DEV is operational under Unix identity `wowsync-dev`: writable DEV checkout, DEV
  Dashboard on loopback port 4174, DEV-only Herdr control plane, and the accepted read-only MCP
  connection. The current tunnel ID is **not** written here or anywhere else in this repository â€”
  see `OPERATIONS_RUNBOOK.md`, "Do not hard-code the live tunnel ID," for how to check it live.
  Windows sign-in continues to run the capture supervisor, SavedVariables watcher, and SSH
  forwarding; its old MCP tunnel ownership was retired after Omarchy acceptance. See
  [`WINDOWS_CAPTURE_SETUP.md`](WINDOWS_CAPTURE_SETUP.md).
- Omarchy LIVE has not been cut over. Its Dashboard is inactive; there is no authoritative LIVE
  database, importer/receiver, MCP/tunnel, or production credential set there. The authoritative
  WoWSync database and normal capture path remain on Windows.

## Current limitations

- Demand management UI is the Retail Allocation tab only; there is no Classic/Forever demand UI.
- **No MCP mutation capability, anywhere.** Every MCP tool, including `get_item_allocation` and
  `get_allocation_review`, is structurally read-only (SQLite opened `readOnly: true`; the `SnapshotReadStore` interface has no
  write methods). MCP never authors demand.
- Azeroth ERP Slice 1 is Retail-only, one commodity per demand, account-scoped (no character
  scope), and covers `STOCK_TARGET` only. Slice 2's review is Retail-only (its Dashboard UI is the Allocation tab), does
  not value or rank unallocated inventory, and treats Hellomags as an ordinary character. See
  [`NON_GOALS_AND_FUTURE_ARCHITECTURE.md`](NON_GOALS_AND_FUTURE_ARCHITECTURE.md) for everything
  explicitly deferred beyond it.
- Warband account scope is `installation-local`, not a true Battle.net account ID â€” two Battle.net
  accounts imported into one installation are currently indistinguishable.
- `DashboardReadModel` serves MCP and the one Dashboard Allocation route (see [`SYSTEM_REFERENCE.md`](SYSTEM_REFERENCE.md)). There is no public
  Dashboard/MCP endpoint of any kind.

## Development gates

Agents work autonomously in isolated workspaces or worktrees on feature branches: they may inspect
and change the repository, run development commands and validation, and commit/push validated work
to their feature branch. Deploying to persistent DEV is deliberate: only when explicitly asked, with
`wowsync-dev-deploy deploy <ref> <validated-sha>`. Agents must not merge to `main`. Tate remains the gate for authoritative database migration, production credentials,
Windows LIVE destination switch, destructive LIVE work, addon deployment/live-game validation
(including `/reload`), and merge to `main`.

## Trust model (unchanged)

Preserve version isolation and data semantics: `OBSERVED`, `UNKNOWN`, `LAST_SEEN`, `DERIVED`;
UNKNOWN is never zero, inaccessible data is never empty, and LAST_SEEN is never current. Keep
Character Bank owned by character, Warband by account, and Guild Bank by guild. The full invariant
set, including the Azeroth ERP additions, is in
[`ARCHITECTURE_INVARIANTS.md`](ARCHITECTURE_INVARIANTS.md).

Hardcore/SSF version handling is **not implemented** â€” it was previously (incorrectly) stated here
as current behavior. It is a deferred design intent only; see
[`ROADMAP.md`](ROADMAP.md#deferred--future) for the correctly-framed version.
