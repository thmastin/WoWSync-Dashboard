# WoWSync ERP Phase 39 — Shared Storage Retrieval Review

**Status:** Implemented and automated-tested; synthetic browser acceptance passed. This is not live-game validation.

## Product outcome

An active project requirement explicitly sourced from a Retail Warband or guild owner can now prefill a linked `RETRIEVE` work order for its same-version intended character when the latest shared-storage evidence is recent, observed, positive, and has a positive unreserved lower bound. The action is a manual review only. It does not establish player access, guild permission, Battle.net account ownership, a retrieval route, or task completion.

The work-order instructions report the observed quantity as a lower bound, identify the owner scope and timestamp, warn that inaccessible or unscanned contents may exist, and require the player to verify current access and game requirements. Guild assets remain guild-owned; Warband remains installation-local. An active duplicate review for the same need and recipient is suppressed.

## Changes

- `packages/web/src/components/ErpProjectsWorkbench.tsx`: gated shared-storage retrieval review prefill in the existing project need workflow.
- `packages/web/e2e/allocationBrowser.test.mjs`: extended the disposable-database browser acceptance for a guild-sourced need, linked review, ownership/access wording, and duplicate suppression.

No GearExport, database schema, REST, MCP, SavedVariables, production Dashboard, or live installation changes were needed. Existing core shared-owner evidence, reservation assessment, REST project contract, and manual work-order persistence are reused.

## Validation

`npm.cmd run validate:erp` passed: Core 822, MCP 3, Server 259 passed with 2 platform skips, Web 301, TypeScript checks, production web build, and 5 synthetic browser acceptances. The browser case uses synthetic Retail fixtures and does not prove real storage access or retrieval behavior.

Independent focused review confirmed the Retail owner/version guards, recent OBSERVED evidence requirement, positive unreserved lower-bound check, duplicate suppression, and conservative ownership/access wording. A review wording finding led to describing the amount as “at least” the count in observed contents and warning about inaccessible/unscanned storage. No blockers remain.

## Repository state and next work

Dashboard development branch: `feature/forever-gear-observation`, based on `8b9c0783cef4a49fbcd20eebd8aed1aa16472d22`. The implementation is pending commit/push at report creation. The active ERP mission continues; this checkpoint does not signal completion. Next, continue integrating shared-storage reservation conflicts and observation-backed retrieval reconciliation into the existing project/work-order workflow, then move to other connected operational gaps.
