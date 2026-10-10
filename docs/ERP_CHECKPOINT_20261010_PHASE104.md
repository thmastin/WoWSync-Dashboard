# WoWSync ERP Phase 104 - source-scoped resource history

Date: 2026-10-10
Dashboard repository: `WoWSync-Dashboard`
Branch: `feature/forever-gear-observation`
Dashboard implementation commit: `e52ac45`

## Product outcome

Saved-plan evidence intervals now bind both the resource and its source. When the source character or shared owner changes after a plan review, the history reports an identity conflict instead of comparing unrelated quantities. Older baselines with no saved source scope remain explicitly UNKNOWN and cannot produce an interval. The player can inspect the reviewed/current source scope from the Projects history surface.

The saved interval supports Retail character-scoped currency and Retail shared-storage owner journals in addition to the existing character item, gold, and profession history. Currency values are read from the exact captured source snapshot. An absent currency ID is not zero; an account-wide row is not treated as character-owned stock. Shared-storage history is owner-scoped and preserves partial quantities, incomplete guild scans, and conflicting content recorded at the same effective time.

The shared Core view continues through REST, AccountContext, MCP, and the Dashboard. Neither roster co-location nor history establishes ownership, access, transfer, a completed task, or action cause.

## Capability inventory

- **Implemented and usable:** exact source-scoped saved-plan history for character and Retail shared owner scopes; currency and shared inventory intervals; source-change conflict display.
- **Automated-tested:** Core, REST, AccountContext, MCP, and the UI workflow with deterministic synthetic fixtures.
- **Requires live validation:** whether these planning-history workflows fit real player reconciliation behavior; no live session was performed.
- **Still UNKNOWN/unsupported:** shared-storage accessibility beyond observed coverage, ownership/transfer, causal attribution, automatic completion, and non-Retail currency/shared-storage intervals.

## Validation and review

`npm.cmd run validate:erp` passed: Core 853, MCP 3, Server 269 passed with 2 Windows platform skips, Web 315, TypeScript checks, production build, and 22 synthetic browser acceptances. The two new focused core files passed 80/80. Browser coverage asserts the saved character scope is visible and exercises the existing multi-project history/reconciliation flow. `git diff --check` passed. Vite emitted its existing advisory for a 739.5 kB minified JavaScript chunk.

Independent review by a separate reviewer found no blocking or high-priority issues. Review covered frozen source identity, legacy UNKNOWN behavior, character/owner/version isolation, exact currency snapshots, no-zero semantics, shared-storage conflict/completeness behavior, and UI wording.

No production Dashboard, SavedVariables, GearExport, game installation, or live game data was changed.

## Delivery and continuation

Dashboard implementation is pushed as `e52ac45ba258559e950ab71cf94cff0344885445` to `origin/feature/forever-gear-observation`.

Next substantial capability: feed quantity variation found between a saved review and later imports into portfolio next-action triage, including a change that later returns to baseline. The player should be prompted to reconcile/replan while the system continues to label cause and task completion UNKNOWN.
