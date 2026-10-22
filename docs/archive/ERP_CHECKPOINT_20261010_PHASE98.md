# WoWSync ERP Phase 98: saved grouped-plan lifecycle

Date: 2026-10-10

## Outcome

The grouped multi-project planner now carries a saved plan through later observation review. One server-confirmed grouped transaction assigns a common batch ID and confirmation time. Each step freezes the exact need kind/key and the evidence state, freshness, observed quantity, and timestamp available at confirmation. Later imports are compared with the correct resource identity.

The shared core exposes batch state and per-step review through REST, AccountContext schema 42, MCP, and the existing Projects panel. A later changed quantity remains an observation comparison: work orders remain PLANNED and action causality stays UNKNOWN. A changed need identity produces a batch conflict. Legacy batches without frozen identity enter review without comparing quantities. Generic project PUT cannot rewrite or remove a batch baseline or task history; normal task status transitions remain available.

Player outcome: after confirming one plan across multiple projects, the player can find that saved batch later and see which exact requirement has newer, unchanged, stale, missing, or conflicting evidence, while retaining the original resource scope. This supports review and replanning without implying that a task caused any inventory change.

## Validation and review

`npm.cmd run validate:erp` passed:

- Core: 850 passed
- MCP: 3 passed
- Server: 268 passed, 2 Windows platform skips
- Web: 315 passed
- TypeScript: passed
- Production build: passed; existing Vite large-chunk advisory remains
- Synthetic browser acceptance: 22 passed

The end-to-end browser scenario checks common batch identity, per-need exact baselines, REST/AccountContext/MCP agreement, rejected baseline rewrite and task removal, later changed observations, and unchanged PLANNED status/cause UNKNOWN. Core regressions cover identity changes and legacy baselines without identity.

Independent review found two data-integrity issues and they were fixed: generic PUT could remove a batch task, and a need resource could be changed while its old quantity baseline remained attached. Follow-up review found both fixes sound and no remaining blockers.

All new workflow evidence is synthetic. No live game or production Dashboard validation was performed.

## Cumulative capability inventory

- **Implemented and usable:** version-scoped character/resource observations; project needs and evidence; reservations and commitment review; manual work orders; resource/profession/crafting evidence; procurement and storage/retrieval planning; cross-project queue and frozen multi-need planning; batch lifecycle review through Dashboard, REST, AccountContext, and MCP.
- **Implemented, synthetic-tested only:** Phase 98's persisted batch comparison and identity conflict handling, as well as most cross-domain workflow scenarios.
- **Partial:** craft planning based on player-entered needs and observed profession/recipe evidence; explicit quote and gold planning; evidence-gated storage retrieval; non-causal reconciliation.
- **Missing or unsupported:** automatic optimal fulfillment solver; general recipe/material inference; market availability/prices; broad ownership, storage access, or transfer-route proof; causal attribution of game actions.
- **Requires live validation:** representative real-account cross-domain resource fulfillment beyond the previously accepted Forever gear/mail events.

## Delivery

- Dashboard baseline: `8669175ad26ba4e0b19c5ef311c28732839157c7`
- Dashboard implementation: `d9b29ef` (`feature/forever-gear-observation`), pushed to origin
- Documentation and cumulative inventory are committed separately.

## Next substantial milestone

Build a player-led replan loop from saved batch review: identify stale, changed, and conflicting needs; preserve the old batch as history; let the player review and update affected work/reservations; recompute source, procurement, and prerequisite evidence across the multi-need package; then expose the same revised state through the UI, REST, AccountContext, and MCP. Preserve UNKNOWN ownership/access and cause. The ERP initiative remains active.
