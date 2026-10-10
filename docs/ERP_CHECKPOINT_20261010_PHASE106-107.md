# WoWSync ERP Checkpoint — Phases 106–107

Date: 2026-10-10  
Dashboard branch: `feature/forever-gear-observation`

## Outcome

The portfolio next-action queue now includes saved requirement-history exceptions. When retained observations show quantity variation after a saved review—including a change that later returns to the baseline—the affected active/paused project requirement appears as an observation-reconciliation review with the exact timestamps and a direct link to its history. REST, AccountContext schema 47, MCP, and the Dashboard use the shared Core projection.

A player can open a changed generation directly from the portfolio queue into the existing frozen follow-up planner. The handoff carries the exact project, need, and saved batch. Opening it only prepares a draft; it does not write a work order, alter a work-order state, reserve a resource, or perform an in-game action. The existing revision, evidence, lineage, and atomic-save checks still apply when the player later confirms.

The queue and workbench now have aligned bounded history windows: up to 100 saved batches and 200 exact requirement histories. Truncation is explicit. The browser acceptance asserts all queued history links resolve, the direct draft selects the exact requirement, and no plan/status write occurs before confirmation.

## Changes

- Phase 106, commit `93e561badc581d7d84bbe4ec8d0f04b3e384bb0b`: join saved-history exceptions into portfolio triage without duplicate exact project/need rows; expose signals, explanation, timestamped evidence navigation, summary counts, and truncation through existing contracts.
- Phase 107, commit `b578b87a1b0d74eaf778e78dee8a94d5d443c9f7`: direct saved-generation follow-up draft from the queue; align saved-history detail bounds; cover over-50 histories and exact latest batch handoff.
- No database schema migration. AccountContext read schema is 47.

## Validation and review

`npm.cmd run validate:erp` passed on the final implementation: Core 856 passed; MCP 3 passed; Server 269 passed and 2 Windows platform skips; Web 315 passed; TypeScript passed; production build passed; browser acceptance 22/22 passed. The existing Vite large-chunk advisory remains.

Independent review found a bounded-history mismatch risk between the action queue and workbench detail. The implementation aligned the workbench to the shared 200-history limit and kept the same 100-batch cap; a 60-requirement regression confirms exact requirement/latest-generation resolution and truncation parity. Follow-up review found no blockers. The browser path confirms opening a follow-up draft performs no write.

All new history and draft scenarios are synthetic. No live game, production Dashboard, SavedVariables, GearExport, installed addon, or game action was involved.

## Cumulative capability inventory

- **Implemented and usable:** portfolio attention includes source-scoped saved-history quantity variation; a player can inspect timestamps and prepare an exact-generation follow-up draft from the same queue.
- **Automated-tested:** Core, REST, AccountContext, MCP, and synthetic browser parity; exact identity, queue deduplication, bounded truncation, and no pre-confirmation writes.
- **Partial:** evidence variation identifies a need for review; it does not identify the game action that caused it or establish task completion. The player still reviews and confirms any follow-up plan.
- **Missing / UNKNOWN:** causal attribution, automatic game actions, general ownership/access, and live fulfillment outcomes remain unsupported or unknown.
- **Requires live validation:** no additional game API evidence is required for this deterministic Dashboard workflow; real player usefulness and any real-world task outcome remain unvalidated.

## Repositories and delivery

Dashboard implementation commits `93e561badc581d7d84bbe4ec8d0f04b3e384bb0b` and `b578b87a1b0d74eaf778e78dee8a94d5d443c9f7` are pushed to `origin/feature/forever-gear-observation`. No GearExport changes were made.

The WoWSync ERP mission remains active. Next, continue the cross-project attention workflow by making current evidence, reservation, source/access, and open-work queue items lead into the right existing review action with the same exact identity and bounded evidence, then validate one mixed multi-need scenario across the UI, REST, AccountContext, and MCP.
