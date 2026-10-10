# WoWSync ERP Checkpoint — Phase 30: cross-project work-order review

Dashboard branch `feature/forever-gear-observation`, worktree `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`.

## Delivered

Added a work-order review queue to the existing version-scoped Projects & Work Orders workbench. It combines the already-computed readiness and progress entries across active projects, prioritizes unresolved evidence before ready work and then uses the player's explicit project priority, supports attention/all-active filtering and text search, and navigates to the owning project. Navigation transfers keyboard focus to the destination project heading. It is a derived view only: no statuses, evidence, reservations, or project data are changed.

The default queue excludes paused projects and completed/cancelled orders. Missing readiness remains UNKNOWN and is surfaced for review. Observation changes, linked shortfalls, conflicts, mixed evidence, and stale/insufficient progress remain attention items. The queue explicitly states that it neither verifies actions nor changes status. Inputs are fetched from the selected version's existing project view; no new REST/MCP/database contract was added.

## Validation

- `npm.cmd run validate:erp`: Core 821 passed; MCP 3 passed; Server 259 passed with 2 platform skips; Web 296 passed; TypeScript passed; production build passed; 5 synthetic browser acceptance tests passed.
- New deterministic tests verify attention-first ordering, project-priority tie ordering, exclusion of paused and terminal work, manual-supply attention state, and missing readiness staying absent/UNKNOWN.
- Existing synthetic browser project flow now exercises cross-project queue rendering, search empty state, navigation, and keyboard focus transfer.
- Focused independent review found one medium accessibility issue (navigation initially left focus behind); fixed by focusing the project heading and added browser assertion. Reviewer rechecked the fix and found no further actionable findings.
- Production bundle-size advisory (>500 kB chunk) remains. No live-game, production-dashboard, or production-browser validation occurred.

## Next

Continue the ERP mission. A candidate next gap is connecting cross-project work-order evidence into a concise portfolio reconciliation view without duplicating persisted state or implying causation. No player action is currently required.
