# WoWSync ERP checkpoint — Phases 76–77 (2026-10-10)

## Outcome

The Projects & Work Orders source review now leads into grouped, persisted player plans and then shows where those plans select the same observed location. This closes a useful review loop across several project requirements while keeping evidence, needs, reservations, and plans distinct.

## Player workflow

From a repeated exact-source need review, the player can create same-version INVESTIGATE work orders for matching needs. When the alternative is a recent, positively observed, unreserved exact `ITEM_REF`, the player can instead record it as the selected source on linked manual PROVISION reviews. The transaction is bounded and rechecks project revisions, need/evidence snapshots, current source screen, freshness, reservation state, and exact observed row before saving. Original need source intent remains unchanged. Ineligible needs are reported rather than silently included.

When reviewing an alternative source, the player can now see existing open PROVISION plans that select that source, including project, need, task, status, intended recipient, and available paired-observation reconciliation state. Links navigate back to the exact manual task. This is explicit plan usage only; it is not a reservation, evidence of stock beyond the separately displayed observation, proof of ownership or access, a transfer route, movement, or completed work. The list is capped and discloses truncation.

The shared core drives the Dashboard, REST, MCP, and AccountContext. AccountContext schema version is 37. MCP remains read-only; the player creates and changes plans through Dashboard/REST.

## Validation and review

`npm.cmd run validate:erp` passed:

- Core: 835 passed
- MCP: 3 passed
- Server: 267 passed, 2 Windows-only platform skips
- Web: 315 passed
- TypeScript: passed
- Production web build: passed
- Synthetic browser acceptance: 14 passed

The synthetic browser journey creates linked plans from a repeated need/source review and verifies source-plan visibility and the same projection through UI, REST, AccountContext, and MCP. Fixtures validate the software workflow only; no live game, real account, or production Dashboard validation occurred. The build reports the existing advisory that the main JavaScript chunk exceeds 500 kB.

Focused independent review of source scoping, active project/status filters, projection bounds, schema parity, and caveat wording found no blockers. Earlier review findings on transaction-time candidate validation were resolved in Phase 76 and covered by direct-store regressions.

## Cumulative ERP capability status

- **Implemented and usable:** version-scoped projects/needs, observed evidence reviews, bounded cross-project work planning, dependencies, reservations where exact current evidence supports them, procurement ceilings/quotes, source-scoped fulfillment, and manual work-order lifecycle.
- **Synthetic-tested only:** this grouped source-to-plan-to-source-usage journey and the broader ERP workflows exercised by `validate:erp`.
- **Partial:** recipe inputs require player declaration; procurement remains quote/budget intent without market facts; storage retrieval remains subject to evidence and unknown access; reconciliation remains non-causal.
- **Missing/unsupported:** a global optimizer/route scheduler, verified general craft eligibility, market price/supply, automatic causal attribution, and unattended game actions.
- **Requires live validation:** broader multi-character allocation and any game-specific behavior beyond the documented real Forever observations/events.

## Commits and next work

Phase 76 grouped source-lead planning is at Dashboard commit `1fd86c53b6cb7aa936c2171c9c2b2da2306f9710`. Phase 77 and this report are recorded in the subsequent Dashboard checkpoint commit. Canonical truth is updated separately. Both development repositories remain on their authorized branches; no production deployment or game action occurred.

Next substantial work is a multi-need portfolio session that combines eligible source investigation/provisioning, retrieval, declared craft inputs, and procurement with per-need evidence blockers and dependencies in one atomic save, then presents subsequent reconciliation without attributing cause. The ERP initiative remains active.
