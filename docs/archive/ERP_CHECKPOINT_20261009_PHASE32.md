# WoWSync ERP Phase 32 — reservation adjustment

**Date:** 2026-10-09  
**Repository:** `WoWSync-Dashboard` isolated development worktree  
**Branch:** `feature/forever-gear-observation`  
**Starting commit:** `3e905f91b7fe2d6246ef792eeb9453efea93822b`

## Outcome

The existing Projects & Work Orders workbench now lets a player adjust the quantity of an active resource reservation without replacing its identity or resetting its creation time. A lower quantity remains possible when remaining supply is unavailable. An increase is capped at the current quantity plus the established unreserved observed lower bound; stale, ambiguous, absent, or otherwise insufficient supply evidence therefore cannot authorize an increase. The UI describes this as planning intent and rejects invalid, fractional, and unsafe quantities.

## Validation

- `npm.cmd run validate:erp` passed: Core 821; MCP 3; Server 259 passed and 2 platform skips; Web 301; TypeScript; production build; 5 synthetic browser acceptances.
- Focused web suite passed: 301 tests.
- The browser acceptance adjusted a reservation within observed limits and rejected an increase beyond them.
- Independent review identified tooltip wording that over-attributed missing lower-bound evidence to unknown supply. Wording was corrected to include unavailable or insufficiently established evidence. The independent reviewer was asked to confirm the correction.
- The production build retains the existing advisory for a JavaScript chunk above 500 kB.
- No live game, production Dashboard, or storage mutation was performed.

## Evidence limits and continuation

This phase changes reservation planning intent only; reservations are not physical possession. Supply bounds continue to depend on the core evidence/freshness projection. No live validation is needed for the deterministic edit guard. ERP work remains active; next work is to connect explicit crafting/provisioning needs and their manual work orders to clearer cross-domain review without claiming craft completion from resource deltas.

**Commit and push:** recorded after validation below.
