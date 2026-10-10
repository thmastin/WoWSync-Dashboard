# WoWSync ERP Phase 74 — cross-project source intent and linked work

## Outcome

The cross-project buyer review now shows other active or paused requirements that explicitly name the same version, exact resource identity, and source character. Each row preserves its own requirement state, freshness, quantity, reservation assessment, explanation, and linked manual work-order status/readiness/progress. The player can open the exact project need from the buyer/source review.

This closes a visibility gap in the source lower-bound screen: a player can see other projects' explicit intent against that same source. These needs are not silently counted as reservations, are not deducted from observed quantity, and do not establish that the source is accessible. Only needs explicitly scoped to the exact source identity and resource key appear. Results remain version-scoped and limited to active/paused projects. Missing need assessment is returned as `UNKNOWN`.

REST and MCP expose the same shared core projection. AccountContext schema 35 adds returned-row counts for source reviews with other scoped project needs. The Dashboard presents these needs and linked work beside the source capacity result and offers direct navigation to each requirement.

## Cumulative ERP status

The player can now inspect buyer quote packages, separate project requirements, grouped observed source leads, source lower-bound comparison, other explicit same-source plans, each plan's linked manual work, and freshness/evidence with navigation in one workbench flow. Existing reservations, inventory, quotes, and game state are unchanged. No action executes.

Still partial or unsupported: no optimizer selects the winning project, unreserved plans do not reserve stock, observed character location does not establish ownership/access/transferability, market price and affordability remain unknown, crafting inputs remain player-declared, and resource changes do not prove action causation. This phase uses synthetic data only and is not live-validated.

## Validation and review

`npm.cmd run validate:erp` passed after the implementation: Core 833; MCP 3; Server 267 passed with 2 Windows platform skips; Web 315; TypeScript checks; production web build; and 14 synthetic browser acceptances. The browser scenario exercised the cross-project buyer/source UI, direct need navigation, linked manual work, REST, AccountContext, and MCP against one temporary SQLite database. The build emitted the existing large-chunk advisory.

Focused independent review found no blocking findings. It verified exact resource/source/version scoping, active/paused filtering, UNKNOWN fallback, linked work-order context, and that other project intent is not treated as reservation, supply, or completed action. No live account, game, production dashboard, or market validation occurred.

## Repositories and next action

Dashboard repository: `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`, branch `feature/forever-gear-observation`. Starting commit: `577b11d65b9b9165f5e81344f55db69988d46267`. Implementation and documentation commit: `fe791dd133948725aa7ec3b79086b9a1c0c653ba`, pushed to `origin/feature/forever-gear-observation`.

Canonical truth remains in `D:\dev\wow-stuff\truth\`. GearExport, SavedVariables, the production Dashboard, and game state were not modified.

**Next substantial implementation:** build a per-source fulfillment view that joins exact-scope needs and reservations with project readiness, quotes, and paired observations, then carries explicit craft inputs and evidence-qualified retrieval into the same manual decision path. Do not infer access, ownership, action cause, or a winning allocation. No player action is needed for that engineering work.
