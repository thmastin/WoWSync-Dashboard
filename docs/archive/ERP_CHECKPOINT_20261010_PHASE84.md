# WoWSync ERP checkpoint — Phase 84

**Date:** 2026-10-10  
**Worktree:** `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`  
**Branch:** `feature/forever-gear-observation`  
**Starting HEAD:** `19851136aeea1ce4910e930bf8bbf70fae6ef9d3`

## Player outcome

From a source-scoped need with no linked work, the player can now click **Add [need] to grouped planning**. The Dashboard selects the exact project/need in the existing cross-project planner and scrolls to it. The player still chooses task type and instructions, assignee, work source, any bounded reservation, and prerequisites. The handoff does not save or mutate anything. The frozen preview and transaction-time stale/conflict checks remain the only path to saving a plan.

The active/version-scoped project and unworked-need requirements are rechecked by the composer. If the need is no longer available or the 20-need bound is full, the player sees an error and no selection or write occurs.

## Implementation

- Added a need-level handoff from the fulfillment pathway panel to the existing grouped work-order planner.
- Added exact `{projectId, needId}` preselection, scroll-to-row, and need re-resolution in the planner.
- Kept the default task as INVESTIGATE; selected source leads, reservations, and dependencies require player choices inside the existing composer.
- Extended the existing synthetic multi-project browser acceptance to begin at the pathway panel and verify exact need preselection before reviewing three manual tasks, stale rejection, capacity rejection, and save.

## Validation and review

The Core (838), MCP (3), Server (267 plus 2 platform skips), Web (315), TypeScript, and production build stages of `npm.cmd run validate:erp` passed. The first browser stage had one transient page-navigation timeout in an unrelated scenario, so that invocation exited unsuccessfully. The timed-out scenario passed on isolated rerun, and the complete 15-test browser suite passed on rerun. After a final wording-only correction, typecheck and the focused end-to-end planning browser scenario passed again.

Independent review found no blocking issue. It confirmed prefill uses exact project/need identity, the selected row remains unsaved, unsafe source/reservation choices are not inferred, and the existing frozen/atomic review remains in effect. A misleading “workbench is refreshing” error sentence was changed to neutral reload-current-evidence guidance.

All new behavior is synthetic browser-tested. It is not live account or game validation.

## Cumulative status and next action

- **Implemented and usable:** direct per-need entry into the grouped player-authored planning flow.
- **Synthetic-tested only:** exact selection, multi-project frozen review, unsaved preview, stale rejection, reservation-capacity rejection, and player-confirmed creation.
- **Partial:** the user selects the supported option and configures a manual task; the software does not optimize routes.
- **Missing:** evidence alternatives from multiple needs are not yet compared and frozen together as an explicit reviewed plan decision.
- **Requires live validation:** real-game access, transfer, crafting, and market outcomes remain outside this synthetic checkpoint.

Next: extend the grouped plan review to explicitly show which evidence-qualified pathway motivated each selected need and to preserve that pathway snapshot alongside the player-authored task, while continuing to reject stale source/evidence and unsafe implied routes.
