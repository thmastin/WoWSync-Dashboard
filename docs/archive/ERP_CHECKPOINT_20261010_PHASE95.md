# WoWSync ERP Phase 95 — Portfolio next-action review queue

## Outcome

The Projects & Work Orders workbench now has one shared cross-project next-action review queue. It joins exact-source fulfillment review with unresolved project triage and provides navigable, evidence-qualified next reviews.

The deterministic core matches only fully qualified project/need references with exact versioned resource scope. Rows preserve per-need evidence status, freshness and timestamp, source identity/owner, observed comparisons, priority, and linked work references. Malformed or unscoped source records remain separate with an explicit identity issue. Prioritization places incomplete evidence first, then reservation conflicts, observed changes, and source-review actions. Input/truncation limits propagate through the projection.

REST, AccountContext schema 41, MCP, and the Dashboard use the same core queue. It is a review surface; it creates no tasks or reservations and infers no ownership, access, route, transfer, movement, or action causality.

## Player outcome

The player can scan one list of unresolved cross-project evidence reviews instead of correlating independent source and triage panels. Each row retains enough exact resource and source context to decide which project need to inspect next. The queue does not choose or execute fulfillment actions.

## Validation

`npm.cmd run validate:erp` passed on the final implementation:

- Core: 843 passed
- MCP: 3 passed
- Server: 268 passed, 2 Windows platform skips
- Web: 315 passed
- TypeScript typecheck passed
- Production build passed; the existing Vite large-chunk advisory remains
- Synthetic browser acceptance: 19 passed

The browser scenario exercises multi-need grouping, incomplete/unscoped references, input truncation, and REST/AccountContext/MCP parity. No real account, game, or production environment was used.

A separate focused review found and the implementation fixed four issues: hidden source/triage truncation beyond 200 entries, a source identity message that overstated what was missing, an internal 200-row triage scan that omitted later evidence, and discarded conflicting source-owner context. Follow-up review found no remaining blockers.

## Cumulative capability inventory

See `ERP_CAPABILITY_INVENTORY.md`. The ERP remains active. Resource fulfillment is substantially connected across requirements, evidence, reservations, pathways, manual work, reconciliation, and now a cross-project next-review queue. It is not an autonomous optimizer, and synthetic acceptance does not establish game behavior.

## Next substantial milestone

Use the queue as the entry point for one player-reviewed multi-need fulfillment session: select exact queue items, prepare source alternatives and craft/procurement/retrieval work, review competing reservations and prerequisites, then follow saved work through a later import and evidence-qualified reconciliation. Keep all task authoring and game actions player-controlled. Preserve UNKNOWN for unproven recipe, access, market, route, ownership, and causality. Exercise stale, partial, conflicting, and restored evidence through browser acceptance and shared REST/AccountContext/MCP.

## Repository state

Dashboard implementation is in the isolated `feature/forever-gear-observation` development worktree. No GearExport, SavedVariables, production Dashboard, or live game files were changed. Commit and push status is recorded in the final checkpoint report and canonical truth after delivery.
