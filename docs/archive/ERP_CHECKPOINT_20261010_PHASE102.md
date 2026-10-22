# WoWSync ERP Phase 102 — Requirement-Level Resolution

Date: 2026-10-10  
Repository: `WoWSync-Dashboard-Forever-Gear`  
Branch: `feature/forever-gear-observation`

## Player outcome

From a requirement's saved history, the player can choose one specific saved generation and open the existing grouped planner with exactly that project/requirement selected. The draft shows that generation's frozen resource identity and evidence beside current identity/evidence, its predecessor and known follow-up branches, and current reservation intent. It does not silently select sibling requirements, write work, change reservations, or imply that a task caused an observation change. Existing planner review and explicit atomic confirmation remain required.

This extends the resource fulfillment lifecycle across requirement evidence, saved planning generations, branches, reservations, manual work, and current reevaluation. The existing shared core projection feeds REST and MCP; AccountContext keeps the existing bounded history summary. No new database, endpoint, schema migration, or parallel planner was introduced.

## Implementation

- The requirement history UI offers a draft action only when the selected generation contains the exact requirement, its linked work is terminal, later evidence is reviewable, and saved context/identity are not conflicted. Open work, no newer observation, and identity/context conflicts display an explicit blocker.
- Selecting a generation seeds only that exact requirement into the existing planner and associates the saved predecessor and exact reference. Existing transaction-time version, evidence, revision, reservation, source, prerequisite, and procurement validations remain authoritative.
- History entries now preserve the frozen resource kind/key per generation, in addition to the history-wide identity set. The draft can therefore show the selected generation's actual baseline rather than another generation's identity.
- Synthetic browser acceptance completes an original two-project batch, changed observation review, terminalization, exact one-need draft, no-write-before-confirm, confirmed single-need branch, branch history, and API projections. It checks open-work, no-new-observation, and changed-identity gates and retains action causality as UNKNOWN.

## Cumulative capability inventory

- **Implemented and usable:** player-authored requirements, evidence review, reservations, source/procurement/prerequisite review, manual work orders, saved multi-project batches, immutable lineage, and per-requirement saved-generation branching in the existing Projects workbench.
- **Implemented; synthetic-tested only:** the newly added per-generation draft and branch flow, including Core/REST/AccountContext/MCP/UI representation.
- **Partial:** fulfillment pathways and sourcing remain player-selected; observations do not prove that a work-order action caused a change.
- **Missing or unsupported:** general verified recipes/craftability, broad account/storage access and transfer routes, reliable market evidence, automated optimization, and causal attribution.
- **Requires live validation:** real resource movement, general transfer/access rules, recipe feasibility, or execution outcomes beyond specific already validated observations. No live test is needed for this synthetic UI/core milestone.

The cumulative status is in `docs/ERP_CAPABILITY_INVENTORY.md`; architecture and phase details are in `docs/ERP_PLANNING.md`.

## Validation and review

`npm.cmd run validate:erp` passed:

- Core: 851 passed
- MCP: 3 passed
- Server: 269 passed, 2 Windows platform skips (271 tests total)
- Web: 315 passed
- TypeScript checks and production build passed
- Synthetic browser acceptance: 22 passed

The existing Vite large-chunk advisory remains. Independent focused review found no remaining blockers. The reviewer identified an ambiguous historical identity label; the shared model now retains exact identity per saved generation, UI and Core regressions cover it, and follow-up review confirmed closure.

All new workflow proof is synthetic in disposable SQLite/headless-browser environments. This is not live-game or production validation.

## Delivery and next work

Dashboard Phase 102 changes are committed and pushed to `feature/forever-gear-observation`; exact commit is in the delivery record and Git history. Canonical truth is updated separately under `D:\dev\wow-stuff\truth\`.

Next substantial milestone: expose the intervening imported observation interval between each frozen requirement review and current state, including partial, stale, conflicting, and restored quantities. Link that timeline to task and reservation history without inferring action causality, then validate through Core, REST, AccountContext, MCP, and the player-facing browser workflow.
