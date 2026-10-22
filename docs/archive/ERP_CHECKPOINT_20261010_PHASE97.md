# ERP Phase 97 — grouped package demand and reservation review

Date: 2026-10-10

## Player outcome

The portfolio queue can seed the existing grouped planner with exact project requirements. Before confirming a multi-need plan, the player can now see whether selected source leads cover combined observed demand and whether requested reservations exceed the available evidence-backed lower bound. This makes source selection and reservation conflicts reviewable before work orders are saved.

## Implementation

- Added shared deterministic package review logic in `packages/core` for grouping demand and reservation requests only by exact version, resource identity, and source scope.
- Demand aggregation requires recent, complete, timestamped OBSERVED need evidence. Source evidence, freshness, and oldest observation time are shown separately. A shortfall is a planning comparison, not proof that the source is accessible.
- Reservation review blocks confirmation for known overcommit, conflicting evidence, or UNKNOWN capacity. UNKNOWN source identities are kept separate.
- A disappeared selected alternate source remains that exact source; it cannot fall back to the requirement's default source. Missing selected PROVISION evidence is rejected.
- The composer freezes the package comparison with the reviewed tasks. Existing transaction-time project revision and evidence checks remain authoritative.
- REST, AccountContext, and MCP continue to expose the saved plan through the existing shared model; this phase adds no parallel planning system.

## Validation and review

Component gates passed on the final tree: Core 849, MCP 3, Server 268 passed with 2 Windows platform skips, Web 315, TypeScript, production build, and 22 synthetic browser acceptances. The full `validate:erp` run preceded moving six helper tests from Web to Core; the affected Core, TypeScript, build, and browser gates were rerun after the move. The browser scenarios verify overcommit blocking, source-demand shortfall review, no write before explicit confirmation, stale transaction rejection, and REST/AccountContext/MCP parity. Fixtures use disposable SQLite and synthetic evidence.

One focused independent review found that a missing selected alternate source could otherwise be checked against the requirement's default source. That was fixed and covered by regression tests. Follow-up review found no blockers.

## Limits and next milestone

This is automated-tested with synthetic fixtures, not live-game or production validation. The comparison does not establish ownership, account membership, source access, transfer routes, purchase, craftability, movement, or action completion. Those remain UNKNOWN without evidence.

Next substantial milestone: connect package-level source demand and reservation decisions to the saved portfolio lifecycle, then exercise later partial, conflicting, and restored imports followed by a player-led replan across Dashboard, REST, AccountContext, and MCP. Preserve player control and non-causal reconciliation.

Dashboard implementation commit: `fd144f0ae2a74daf7b1f5adb23c7259f20dc9810` (`feature/forever-gear-observation`).
