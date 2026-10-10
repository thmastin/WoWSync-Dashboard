# WoWSync ERP Phase 49 — grouped multi-need fulfillment review

Date: 2026-10-10

## Product outcome

An active project can now turn two to four uncovered requirements into one linked, player-authored INVESTIGATE work order. This closes a workflow gap between the existing per-need resource assessments and the existing manual gather, purchase, craft, retrieval, and provisioning reviews: the player can review related gaps together and preserve them in the project without pretending the system has solved them.

The planner omits needs already covered by recent observed evidence or linked to a nonterminal work order. It captures plan time, each need's evidence state/freshness/timestamp, observed and possible historical quantities, reservation assessment, and reason. It may assign a same-version reviewer and link open same-project prerequisites. Core project validation and optimistic revision updates continue to guard persistence.

The task explicitly says its evidence summary does not refresh, and the player must open linked needs for full identity/current evidence. It creates no reservation, movement, purchase, craft, access claim, ownership claim, transfer route, or completion assertion. No schema, migration, API, MCP, provider, or addon change was needed. Existing REST persistence, AccountContext project projection, and read-only MCP project projection are reused.

## Player workflow

From an active project in Projects & Work Orders, choose **Build grouped review**, select at least two and at most four unresolved requirements, optionally choose a reviewer and prerequisites, and save one task. The project fulfillment snapshot then includes the open task, and each linked need remains visible to existing readiness and evidence views. After importing newer evidence, the player reviews those needs and chooses any appropriate existing manual workflow.

## Cumulative capability inventory

See [ERP_CAPABILITY_INVENTORY.md](ERP_CAPABILITY_INVENTORY.md) for implemented/usable, synthetic-tested, partial, missing, and live-validation-dependent capabilities. The larger ERP remains active. In particular, automatic cross-domain optimization, verified generalized craftability, market evidence, causal action attribution, and broad roster transfer/access proof are not complete.

## Tests and review

- `npm.cmd run validate:erp`: passed.
- Core: 823 passed.
- MCP: 3 passed.
- Server: 260 passed, 2 platform skips.
- Web: 307 passed.
- TypeScript checks and production build: passed. Vite reported the existing large-bundle advisory.
- Synthetic browser acceptance: 8 passed, including a complete multi-need workflow over disposable SQLite through UI persistence, REST readiness, AccountContext work-order/readiness/fulfillment parity, and non-action wording.
- Focused independent review: no blocking findings. Reviewer checked stale evidence copy, existing-task duplication, project version assignment, optional dependencies, and that the grouped action remains an investigation rather than a fulfillment claim. The review prompted a plan-time/evidence-time snapshot clarification; an out-of-range timestamp regression now keeps the timestamp UNKNOWN rather than throwing.
- No live game, production Dashboard, or real-account validation occurred.

## Repository

Dashboard branch: `feature/forever-gear-observation`.
Starting baseline: `b74d5794278ea01a4f3c7042d2f20329f298f7a0`.
Implementation files: `packages/web/src/components/erpFulfillmentReview.ts`, `packages/web/src/components/ErpProjectsWorkbench.tsx`, `packages/web/src/styles.css`, `packages/web/test/erpFulfillmentReview.test.ts`, `packages/web/e2e/allocationBrowser.test.mjs`.

## Next substantial milestone

Continue the resource fulfillment lifecycle by connecting project-level competing requirements to a coherent, explainable fulfillment queue that can distinguish feasible observed supply, manually declared crafting/procurement/retrieval options, and unresolved requirements across projects. Avoid claiming an optimizer until its inputs and deterministic precedence are evidence-supported. Exercise the entire next workflow through shared core, REST, AccountContext, MCP, and browser acceptance. No player action is required for this synthetic development checkpoint.
