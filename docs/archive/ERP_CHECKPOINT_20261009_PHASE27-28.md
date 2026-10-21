# WoWSync ERP Checkpoint — 2026-10-09 — Phases 27–28

## Outcome

Procurement plans now link an optional explicit same-buyer `GOLD_COPPER` resource need in addition to the item target and player-entered spending ceiling. The budget need must be linked to the PURCHASE work order, sourced from and intended for the assigned buyer, and uses the existing resource ledger and reservation model. A ceiling remains only an upper-bound plan field.

The workbench shows the linked budget requirement, its observed quantity and freshness, and explicit reservations independently. A player-entered quote can now be compared separately against (1) the spending ceiling, (2) the linked planned budget amount, and (3) a strictly later recent observed-gold snapshot after tracked reservations. The planned-budget comparison evaluates saved intent only. Affordability, market availability, valid purchase route, and spendable funds remain UNKNOWN.

REST, AccountContext schema 22, MCP, and the Dashboard all use the shared core procurement assessment. Existing projects without budget needs remain valid and report `NO_EXPLICIT_PLANNED_BUDGET` for quote comparison.

## Safety and evidence

- The UI never auto-creates a reservation from a linked budget need.
- The item ceiling, planned gold need, observed gross gold, reservations, and player-reported quote remain separate values and provenance.
- A quote is not a verified price or availability observation. Its explicit covered quantity remains visible.
- No work order, purchase, game action, storage transfer, or character ownership is inferred.

## Validation and review

`npm.cmd run validate:erp` passed after the implementation: Core 821; MCP 3; Server 259 passed plus 2 platform skips; Web 294; all package TypeScript checks; production web build; and 5 synthetic browser acceptances. The build has the existing advisory that its main JavaScript chunk exceeds 500 kB.

Focused independent review found no actionable findings. Review confirmed the planned comparison does not imply affordability and remains separate from observed gold and ceiling comparisons. Tests cover the core comparison, REST readback, AccountContext summary, MCP, and the full browser workflow including creation/linking of a planned budget and quote review.

This is automated development validation only. No live game, production Dashboard, or purchase action was performed.

## Commits

- Phase 27 explicit procurement budget link: `89077ae` (`89077ae…`), pushed to `origin/feature/forever-gear-observation`.
- Phase 28 quote-to-planned-budget comparison is in the following feature commit.

## Remaining limits and next work

Current gold evidence is a dated snapshot, not spendable balance. Active reservations represent explicit plan commitments, not a complete obligation ledger. A planned budget and a recorded quote do not verify availability or a vendor/Auction House route. Existing project reconciliation deliberately does not attribute observed changes to actions.

Next engineering target: connect the existing account-wide resource commitment projection to an actionable, version-scoped project review surface so players can inspect competing reservations, observed supply, and unresolved source scope together. Continue into evidence-backed procurement and storage planning without asserting access or cause. The ERP mission remains active; no player action is required.
