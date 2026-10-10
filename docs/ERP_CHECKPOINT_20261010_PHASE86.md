# WoWSync ERP Checkpoint — Phase 86

**Date:** 2026-10-10  
**Branch:** `feature/forever-gear-observation`  
**Baseline:** `932bdb1d57c493a1ee244c5409c099f842964519` (Phase 85 pathway context)  
**Scope:** Turn a validated same-character bank retrieval pathway into a player-ready manual work-order draft.

## Player outcome

From a current, complete personal-bank location review, the player can add the exact need to the existing grouped planner. The draft now selects the existing manual `RETRIEVE` work type, fills the source character as an editable same-version assignee, and gives instructions to check that the exact item is still present and accessible before retrieving it manually and exporting again. The player still reviews the frozen plan and explicitly saves it.

If the player changes the task type, the explanation follows the actual type: it distinguishes the retained pathway as reviewed context from the chosen work order. Existing draft fields are not overwritten by pathway prefill.

## Safety and evidence

The pathway requires recent complete bag and personal-bank sections with an observed exact item match and an unmet carried-bag need. The generated order does not claim current access, successful retrieval, ownership beyond the source observation, an inter-character route, or completion. No inventory, reservation, or game state is changed. The task remains a player-authored `PLANNED` order.

## Validation

- Focused browser acceptance verifies the pathway button opens the exact need, proposes `RETRIEVE`, selects only the editable same-version source actor, preserves conservative instructions, and updates its explanation if the player changes the work type.
- The same scenario retains stale, partial/unknown-bank, item-variant, reservation, and source-scope negative cases, then exercises the existing explicit retrieval-review work order.
- `npm.cmd run validate:erp`: Core 838 passed; MCP 3 passed; Server 267 passed with 2 platform skips; Web 315 passed; TypeScript, production build, and all 15 synthetic browser acceptances passed.
- Independent review found no blocking issues. It identified a mismatch between saved pathway context and a subsequently changed task type; the UI now explains them separately, with browser regression coverage. Follow-up review confirmed resolution.

## Capability inventory

- **Implemented and usable:** Evidence-qualified pathway-to-manual-retrieval draft through the existing Projects & Work Orders workflow.
- **Synthetic-tested only:** Draft handoff, editable task choice, same-version assignee, and uncertainty language across the UI; persisted pathway visibility remains covered by Phase 85 contract tests.
- **Partial:** Storage access and retrieval outcome remain player-confirmed and require later observations. This feature does not reconcile action causation.
- **Missing:** Automatic route optimization and cross-character access/transfer conclusions without direct supporting evidence.
- **Requires live validation:** Real access/retrieval and subsequent paired bag/bank behavior. No live data was used in this phase.

## Next substantial milestone

Build a single end-to-end multi-need fulfillment journey combining observed source selection, player-declared craft/procurement, storage retrieval, reservations, dependencies, work-order progression, and subsequent observation reconciliation. Keep one explainable shared next-action view consistent across Dashboard, REST, AccountContext, and MCP. The ERP initiative remains active.
