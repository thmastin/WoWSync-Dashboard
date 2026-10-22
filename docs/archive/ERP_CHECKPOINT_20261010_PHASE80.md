# WoWSync ERP Phase 80 — Alternate-Source Reservation Fulfillment

**Date:** 2026-10-10  
**Repository:** `thmastin/WoWSync-Dashboard`, isolated worktree `WoWSync-Dashboard-Forever-Gear`  
**Branch:** `feature/forever-gear-observation`  
**Starting commit:** `6c9212137755d9e7dd7368b2f4c59e2cab243fe9`

## Player outcome

The portfolio composer now lets a player select a recent, exact-variant observed item source for a PROVISION work order and, when appropriate, request that the planning reservation apply to that same source. The requirement's original source intent remains separate from the selected provisioning source. A reservation is still only saved planning intent; the feature does not move items or establish character access, ownership, membership, transferability, or a valid route.

The source-scoped commitment appears against the reservation source. If current source evidence later disappears, the active commitment remains visible with current supply, freshness, and reservation assessment UNKNOWN. This prevents a saved commitment from vanishing merely because the latest scan no longer contains its candidate row.

## Implementation

- Added optional `reservationSourceIdentityKey` to the existing portfolio work-order request contract.
- REST accepts it only with an explicit reservation quantity and only when it matches the selected provisioning source.
- The atomic SQLite operation rechecks project revisions, the source lead, exact variant, recent complete quantified observations, and exact/base-scope competing reservations before writing any part of a batch.
- Core project validation requires the alternate-source reservation to have an explicitly linked exact-item PROVISION order; completed/released work remains valid historical linkage.
- Commitment projection attributes held quantity to the actual reservation source, while preserving the requirement's distinct source grouping and existing overlap semantics.
- The player review payload and UI retain the selected reservation source and explain that it is intent only.
- Added a multi-project synthetic browser path with competing capacity, alternate-source line, evidence disappearance, explicit release, player completion note, and REST/AccountContext/MCP parity.

## Validation

`npm.cmd run validate:erp` passed:

- Core: 835 passed
- MCP: 3 passed
- Server: 267 passed, 2 Windows platform skips
- Web: 315 passed
- TypeScript checks passed
- Production build passed (existing large-chunk advisory)
- Browser acceptance: 14 passed

The new browser scenario used a disposable synthetic SQLite database. It is not live-game or production validation.

## Independent review

A focused separate review identified three defects: reservation amounts could be attributed to the requirement's named source; linked plan validation rejected edits after the linked order became terminal; and active alternate-source reservations disappeared from the projection when their candidate observation disappeared. All three were fixed, regression-covered, and re-reviewed. The final review reported no additional blocking findings. A wording mismatch discovered during follow-up was also corrected.

## Cumulative status and next work

The cumulative capability inventory now records Phase 80. Resource fulfillment is usable for planning across projects, observed source leads, reservations, player-authored manual work, evidence review, REST, AccountContext, MCP, and the workbench. Crafting inputs, market facts, general ownership/access/transfer routes, and causal attribution remain partial or UNKNOWN as documented. Automated scenarios are synthetic; no live game session or production deployment was performed.

**Next substantial milestone:** connect alternate-source reservations to a single source-review and work-order lifecycle, including post-observation reconciliation and explicit player release/adjustment, then validate stale, partial, missing, and competing-source scenarios across the same interfaces. The broader ERP initiative remains active.
