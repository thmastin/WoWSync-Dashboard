# WoWSync ERP checkpoint - Phase 93

**Date:** 2026-10-10 (ET)  
**Repository:** `thmastin/WoWSync-Dashboard`  
**Worktree:** `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`  
**Branch:** `feature/forever-gear-observation`  
**Starting commit:** `f449cf334f716c5f4970aed0bd248c5fd088f79e`

## Player outcome

The Projects & Work Orders workbench now offers a reviewed way to resolve over-reserved resource commitments. A player can reduce or release existing reservation intent in a frozen proposal spanning up to 10 same-version projects, inspect affected work and downstream dependencies, then save the batch atomically. The dashboard recalculates fulfillment and prerequisite evidence from the resulting plan. No resource moves and no task is completed by this operation.

## Implementation

- Added a project-scoped reservation replan command to the shared store and REST API. The transaction verifies every expected project revision and complete reservation identity set before writing any project.
- The transaction allows decreases or releases only; source, need, owner, reservation identity, and creation time remain immutable. Released history cannot be reactivated or rewritten. Each included project must carry an actual change. The full transaction rolls back if any project fails validation.
- Active, paused, and completed projects can be included. A completed project may release or reduce retained reservation intent without changing its completion state, note, or historical quantity on release. Cancelled projects remain excluded from the player workflow.
- Added a workbench review panel. It groups exact-source commitments, caps edited quantities at their current intent, freezes revisions and affected-work preview, and explains that this records planning intent only.
- The review finds directly linked work orders, transitive downstream prerequisites, and their linked needs. Changes are keyed by project and reservation IDs in the UI.
- REST, AccountContext, and MCP continue to expose the shared read projection; no parallel ledger or schema migration was added.

## Cumulative capability status

- **Implemented and usable:** version-scoped observations, project requirements, resource evidence, commitments, reservations, manual work orders, pathway screening, and cross-project dependency planning.
- **Implemented, synthetic-tested only:** a player-reviewed, revision-checked, atomic multi-project reservation reduction/release workflow with downstream-work preview and recomputed evidence across the UI/API projections.
- **Partial or UNKNOWN:** crafting eligibility, verified recipes/material requirements, market prices/stock, access to unobserved storage, general transfer routes, and action causality remain evidence-limited. Reservations remain intent, not proof of possession.
- **Requires live validation:** representative account fulfillment and version-specific storage, crafting, and economy scenarios. No live-game or production validation occurred in this checkpoint.

## Validation and review

`npm.cmd run validate:erp` passed on the final implementation:

- Core: 840 passed
- MCP: 3 passed
- Server: 268 passed, 2 Windows platform skips
- Web: 315 passed
- TypeScript checks and production web build passed
- Synthetic browser acceptance: 19 passed

The existing Vite advisory remains for the approximately 716 kB minified JavaScript bundle. Independent review found and resolved one edge case: completed projects can retain active reservations, so the replan transaction now safely supports reduction/release without reopening completed work. Review also confirmed no-op projects are rejected before writes and a failed batch is atomic. A final review of the project-plus-reservation UI edit key found no further issue. Synthetic tests are not live-game validation.

## Repository state

Dashboard final commit and push status: recorded after commit in the Downloads checkpoint report. This work is confined to the isolated Dashboard feature branch. No GearExport, SavedVariables, production Dashboard, or BankCleanup changes occurred.

## Next substantial milestone

Continue the integrated fulfillment workflow by improving how the player can reconcile source-scoped and overlapping resource commitments into one actionable next step, with evidence and exact resource identity kept distinct. Keep unsupported access, ownership, craftability, transfer, and completion claims UNKNOWN. The ERP mission remains active.
