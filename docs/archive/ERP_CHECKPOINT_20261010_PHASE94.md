# WoWSync ERP checkpoint - Phase 94

**Date:** 2026-10-10 (ET)  
**Repository:** `thmastin/WoWSync-Dashboard`  
**Worktree:** `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`  
**Branch:** `feature/forever-gear-observation`  
**Baseline:** Phase 93 at `58b1e9eac9b11b83a0699cb110621557f62341cd`

## Player outcome

The replan panel now gives the player a path to inspect explicit base-item/exact-variant reservation overlap even though the shared evaluator correctly reports combined availability as UNKNOWN. Before this change, the evaluator preserved that uncertainty but the UI offered no way to reduce or release the conflicting plan intents.

The player can now open a same-source overlap, see each exact ITEM_ID or ITEM_REF reservation as a separate row, choose lower quantities or release, review the frozen multi-project proposal and downstream work, and save through the Phase 93 atomic transaction. The interface describes overlap as UNKNOWN, not a confirmed shortage. It does not combine variants into free stock.

## Implementation

- The panel includes a line when the core provides explicit overlapping reservation rows and quantity while marking the aggregate state UNKNOWN. Unknown source scope remains excluded.
- Reservation selection includes only the line's exact resource rows and the overlap rows explicitly returned by the shared model. The proposal shows item identity, project, source, and revision for each changed row.
- Existing revision checks and decrease/release-only atomic persistence are reused without changing the data model or API contract.
- A synthetic browser acceptance builds two same-version projects with ITEM_ID `940211` and exact ITEM_REF `item:940211::::::::80` reservations against one observed variant. It checks that pre-save assessment remains UNKNOWN, opens and edits both rows, then verifies the shared projections recalculate after the player-authored replan.

## Evidence and limits

- **Synthetic-tested only:** the browser fixture validates the decision flow and UI/API parity; it is not observed Forever or Retail gameplay evidence.
- Exact item variants remain distinct. UNKNOWN overlap is not an assertion that the reservations refer to interchangeable physical items or a confirmed inventory shortage.
- After explicit release/reduction, the dependent need can be current-evidence-ready while CRAFT readiness remains `WAITING_FOR_EVIDENCE` when craft inputs/recipe evidence is UNKNOWN.
- No inventory, ownership, access, transfer, craftability, or action cause is invented. No game action is performed.

## Validation and review

`npm.cmd run validate:erp` passed: Core 840; MCP 3; Server 268 passed plus 2 Windows platform skips; Web 315; TypeScript and production build; 19 synthetic browser scenarios. Existing Vite >500 kB bundle advisory remains.

Independent review confirmed that only explicit same-source overlaps from the shared evaluator are surfaced, exact item identities remain separate in the frozen proposal, and unknown is not described as a confirmed shortage. Existing atomic monotonic reduction, version, and revision safeguards remain in force. No blocking findings.

## Cumulative capability and next milestone

Phase 93 added atomic multi-project replan for known reservation overages. Phase 94 makes the separate base/variant uncertainty case reviewable. Other player-usable resource fulfillment capabilities remain listed in `ERP_CAPABILITY_INVENTORY.md`; crafting rules, broad storage access, pricing, generalized transfer routes, and causal action reconciliation remain partial or UNKNOWN where evidence is absent.

Next, connect unresolved resource review findings to one portfolio next-action queue that groups actionable player reviews without collapsing resource identity, source, freshness, or uncertainty. Then validate the whole multi-need workflow through the shared UI, REST, AccountContext, and MCP projections. WoWSync ERP remains active.
