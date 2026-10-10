# WoWSync ERP checkpoint — Phase 81

**Date:** 2026-10-10  
**Worktree:** `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`  
**Branch:** `feature/forever-gear-observation`  
**Starting Dashboard HEAD:** `5c19a16c529571b004c0a0620a5154145682566f`  
**Canonical truth baseline:** `6c19d4c233611ba99b7ec99c5de74171a8f0b0cc`

## Product outcome

Reservation adjustment is now source-specific and conservative. A player can inspect which character/source backs an existing hold and adjust its quantity only within a current complete quantified lower bound. Incomplete, stale, missing, or unknown source evidence permits reducing/releasing a commitment but does not enable increases. This applies to the UI and the shared SQLite update boundary, so generic REST/MCP project edits cannot bypass the same safeguard.

Project edits cannot silently rebind an active or released reservation to another item, source, owner, or intended recipient in the same update. The player must release first, update the need separately, refresh its evidence, and then create a new reservation. This prevents a pre-edit source assessment from being reused to justify a different resource.

The Resource Commitments panel again exposes section-level evidence, timestamps, completeness, and the explicit UNKNOWN-is-not-empty warning.

## Cumulative ERP capability inventory

- **Implemented and usable:** version-scoped observations and requirements; freshness/completeness; shared resource commitment projections; reservations; manual work orders; project and source review; procurement ceilings/quotes; evidence-backed reconciliation; shared REST, AccountContext, MCP, and Dashboard read models.
- **Implemented, synthetic-tested only:** exact alternate-source reservation, bounded quantity adjustment, rejection of UI and generic update attempts against partial evidence, need-scope rebind protection, and restored source-section disclosure.
- **Partial:** crafting remains based on player-declared inputs; market pricing/availability is absent; storage access/ownership/transfer routes may be UNKNOWN; reconciliation reports changes without causal attribution.
- **Missing/unsupported:** global resource optimizer/scheduler, generalized verified recipe/craftability, market facts, and causal action attribution.
- **Requires live validation:** broader roster access and game-specific fulfillment beyond the documented events. Phase 81 changes are local planning behavior and require no player session.

## Implementation and validation

- The core store validates all new/increased/reactivated holds at the shared mutation boundary against recent complete quantified evidence and remaining exact-scope capacity.
- Need resource/type/source/owner/recipient edits cannot be combined with activating a hold. A released reservation remains historical until a separate fresh allocation is made.
- UI adjustment allowance uses the reservation's actual source assessment and complete-source criteria; when evidence is incomplete, maximum remains current quantity.
- Added core regressions for partial evidence and release/rebind/reactivate against an absent variant. The existing browser acceptance verifies source attribution and section details.

`npm.cmd run validate:erp` passed: core 837, MCP 3, server 267 (2 platform skips), web 315, TypeScript checks, production build, and 14 synthetic browser acceptance tests. Build retains the existing chunk-size advisory. No production Dashboard, game client, SavedVariables, GearExport, or BankCleanup was changed.

## Independent review

A separate focused reviewer found and helped close three bypass/regression paths: partial evidence could enable an increase through generic updates; an existing reservation could be rebound to a changed need; and released holds could be reactivated alongside changed need scope using pre-edit evidence. The section-level commitment evidence disclosure was also restored. Final review found no blocking issue.

## Delivery and next substantial milestone

Dashboard implementation and documentation are committed separately on the existing feature branch. Canonical truth has a corresponding Phase 81 entry and cumulative inventory update. This internal checkpoint does not complete the ERP mission.

**Next substantial engineering milestone:** build an integrated fulfillment decision path over multiple project needs that joins source availability, competing reservations, manual craft/retrieve/procure work, prerequisites, and observation-backed follow-up in one reviewable workflow. Test stale, partial, missing, conflicting, and restored evidence across the same core, REST, AccountContext, MCP, and browser path. Preserve player control and avoid attributing resource deltas to specific actions.
