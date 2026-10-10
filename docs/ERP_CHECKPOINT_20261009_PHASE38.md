# WoWSync ERP Phase 38 — observed source to manual provisioning review

Date: 2026-10-09

## Outcome

From an item need with an explicit intended recipient, the resource-source screen can now create a manual PROVISION review after the player selects a possible source. The action is available only when the need explicitly names that source, the source item evidence is recent and OBSERVED with positive matching quantity, the candidate has no active reservations, source and destination are distinct, and both identities match the project's version. Active duplicate reviews are suppressed for the exact need/source/recipient tuple.

The work order is PLANNED and stores the selected source and recipient plus exact observed itemString/location evidence. Its instructions require the player to verify current item location, ownership, account membership, access, binding, and a valid route before any decision to move an item. It performs no transfer and makes no claim that roster co-location or realm is a valid route. Later observation changes remain non-causal.

The existing source-investigation action remains available for candidates that do not meet the stricter provision-review preconditions. The feature reuses the current work-order model and provisioning reconciliation projection; no second allocation system or API was introduced.

## Validation

`npm.cmd run validate:erp` passed on 2026-10-09:

- Core: 822 passed
- MCP: 3 passed
- Server: 259 passed, 2 platform skips
- Web: 301 passed
- TypeScript checks passed
- Production web build passed
- Synthetic browser acceptances: 5 passed

The browser acceptance uses synthetic characters on different realms. It verifies explicit source and recipient identity, PLANNED-only state, uncertainty wording, and that an active reservation removes the provision-review action. This does not establish actual account membership or game transfer rules. The existing bundle-size advisory (>500 kB) remains.

## Independent review

Focused independent review found no actionable findings. It confirmed same-version identity gates, recent positive observed source evidence, reservation suppression, exact tuple duplicate handling, explicit unknown ownership/access/route semantics, and no movement.

## Repository and limits

Dashboard branch: `feature/forever-gear-observation`. No GearExport, SavedVariables, production Dashboard, or game installation changes. No live or production validation.

## Next

Continue linking provisioning plans to downstream readiness and manual retrieval/transfer work without treating candidate location as access or a valid route; improve the integrated view of storage locations, reservations, and unresolved destination requirements.
