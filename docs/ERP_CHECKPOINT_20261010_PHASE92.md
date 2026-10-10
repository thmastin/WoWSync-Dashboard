# WoWSync ERP checkpoint — Phase 92

**Date:** 2026-10-10 (ET)  
**Repository:** `thmastin/WoWSync-Dashboard`  
**Worktree:** `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`  
**Branch:** `feature/forever-gear-observation`  
**Starting commit:** `0a0ae875d93039606620be1f78bea8383350030c`

## Player outcome

Project fulfillment now accounts for source-scoped reservation intent before calling observed stock available for a requirement or dependency. Raw observed quantity remains visible, but a need whose sufficient coverage depends on active reservations is labeled `RESERVATION_REVIEW`; a dependent step stays blocked until the selected source has enough recent observed lower-bound quantity after other same-source commitments plus that need's own reservation intent. Reservations attached to another source are not charged against the selected source.

The workbench's resource commitment contributors now link directly to the exact project requirement and reservation controls. A player can follow a conflict, review or release the relevant reservation, and see the prerequisite projection recalculate. The new browser acceptance carries this through the actual UI, REST, AccountContext, and MCP surface. It demonstrates planning state only; it does not move resources or claim work completion.

## Implementation

- Core fulfillment pathways now distinguish observed coverage from reservation-adjusted coverage and preserve UNKNOWN reservation state.
- Portfolio prerequisite gates include reservation-adjusted lower bounds and source-specific explanation. Alternate-source intent is excluded from both arithmetic and blocker wording.
- The workbench labels reservation conflict on prerequisite gates and displays the relevant reservation state and reason.
- Commitment contributors navigate to the exact need for review.
- Regression coverage exercises competing reservations at two sources, blocked prerequisite readiness, player release, later sufficient observation, and an open alternate-source provisioning task.
- No database schema or SavedVariables changes.

## Validation

`npm.cmd run validate:erp` passed on the final code:

- Core: 838 passed
- MCP: 3 passed
- Server: 267 passed, 2 Windows platform skips
- Web: 315 passed
- TypeScript checks: passed
- Production web build: passed; existing advisory remains for the 708.76 kB minified JavaScript chunk
- Synthetic browser acceptance: 18 passed

Independent review of the final diff confirmed that alternate-source reservations are excluded from the selected source's coverage and explanation. No blocking or material findings remain. These results are synthetic acceptance, not live-game or production validation.

## Cumulative capability status

- **Implemented and usable:** version-scoped observations; project requirements; observed resource review; explicit reservations; manual work orders; source and storage pathway screening; cross-project dependencies; portfolio next-review links; shared Dashboard/REST/AccountContext/MCP projections.
- **Implemented, synthetic-tested only:** competing reservation gates, source-specific conflict review, and recovery of a dependent step after explicit replanning and sufficient new observation.
- **Partial:** crafting, procurement, storage retrieval, and project reconciliation rely on player-authored requirements and plans; recipe knowledge, craftability, market availability, access, transfer routes, and causal attribution are not inferred.
- **Requires live validation:** real account resource fulfillment and additional version-specific storage/crafting/economy cases.
- **Missing:** general automatic optimization or execution of resource movements; unattended game actions remain out of scope.

## Next substantial milestone

Build an atomic, player-reviewed fulfillment replanning session that resolves competing project reservations against exact source/resource scopes while preserving downstream dependencies. Show affected requirements and work orders before save; validate current evidence and project revisions together; then update only explicit player-authored reservation and task intent. Continue through the shared core, workbench, REST, AccountContext, and MCP. The ERP mission remains active.
