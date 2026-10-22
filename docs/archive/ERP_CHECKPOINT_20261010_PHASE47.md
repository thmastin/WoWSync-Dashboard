# WoWSync ERP Phase 47 — reservation review in AccountContext

Date: 2026-10-10

## Outcome

AccountContext schema 23 now includes compact per-project reservation review state counts, sourced from the same core read projection used by REST and MCP. Stale-source reservation intent and historical observed quantity remain visible, while stale evidence is classified `SUPPLY_UNKNOWN` and produces no available observed lower bound. The UI continues to prevent a new reservation from being created from stale supply.

The regression imports a five-day-old item observation, creates an explicit reservation, and checks that the REST response, project listing, and AccountContext summary agree. It verifies the observed quantity and reservation intent remain represented without treating stale stock as currently available.

## Validation and review

- `npm.cmd run validate:erp`: passed.
- Core: 823 passed.
- MCP: 3 passed.
- Server: 260 passed, 2 platform skips.
- Web: 302 passed.
- TypeScript checks and production web build: passed.
- Synthetic browser acceptance: 7 passed.
- Focused independent review: no blockers.
- Live game, production Dashboard, and real account validation: not performed.

## Repository state

Dashboard branch: `feature/forever-gear-observation`.

This checkpoint is recorded in this document and `CURRENT_STATE.md`; see the commit history for the validated implementation SHA.

## Next action

Continue integrated ERP work on observation-backed reconciliation and cross-domain resource planning. No player action is required for this code checkpoint.
