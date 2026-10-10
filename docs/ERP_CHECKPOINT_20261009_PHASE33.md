# WoWSync ERP Phase 33 — explicit craft-output observation target

**Date:** 2026-10-09  
**Repository:** isolated Dashboard development worktree  
**Branch:** `feature/forever-gear-observation`  
**Starting commit:** `b84efd382d25e85e5e4c9428358b64103f5d9363`

## Product change

A CRAFT work order with a player-declared output may explicitly select the character whose inventory should be checked. The selected observation character is separate from the assigned crafter and the intended recipient. This supports a plan where those characters differ without guessing where the output should be found.

The core validates the selected character through the existing version-scoped identity guard and reads only that character's inventory. The output assessment keeps `observedOnIdentityKey` distinct from `intendedRecipientIdentityKey`. The legacy `recipientIdentityKey` remains a compatibility field for prior consumers. If the player did not choose an output observation character and the crafter and recipient differ, the result stays UNKNOWN. Current quantity or a later change never proves crafting, transfer, or task completion.

## Validation and review

- `npm.cmd run validate:erp` passed: Core 822; MCP 3; Server 259 passed and 2 platform skips; Web 301; TypeScript; production build; 5 synthetic browser acceptances.
- Focused core, REST route, and MCP protocol suites passed; REST and MCP expose the shared assessment.
- Synthetic browser acceptance created a CRAFT plan with different crafter and intended recipient, selected the crafter as the inventory check target, and verified all three roles in UI/API data.
- Regression tests cover assigned character A, observer B, absent destination, recipient compatibility, explicit destination, and cross-version identity rejection.
- Independent review found and resolved the risk of labeling the observation character as recipient; final focused review found no remaining actionable findings.
- Existing >500 kB build advisory remains. No production or live-game validation was performed.

## Evidence and limits

The selected character is an explicit player plan field, not inferred account ownership or a transfer route. The feature compares the latest supported inventory observation and preserves its freshness and coverage; it does not infer recipe output correctness, crafting causation, or movement.

**Commit and push:** pending at report creation.
