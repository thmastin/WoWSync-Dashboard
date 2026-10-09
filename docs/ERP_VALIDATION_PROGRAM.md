# ERP Validation Program

This document tracks automated acceptance coverage for the implemented WoWSync ERP surface. The
fixtures are synthetic and explicitly labeled in their test files. They validate code behavior;
they are not evidence of live gameplay, ownership, bank access, transferability, prices, or actions.

## Current command and coverage

Run `npm run validate:erp` on Node 24 with a local Chromium browser. It runs workspace tests,
TypeScript checks, the production web build, and the browser acceptance test. The command is
provider-independent: it uses deterministic assertions and process exit codes and requires no LLM
provider, credentials, running game, or player input. CI and any local developer can run the same
command.

The current end-to-end acceptance journey focuses on the Retail stock-target slice. Other existing
ERP project, reservation, work-order, and Forever allocation contracts also run in the workspace
test suites, but do not yet have one unified browser journey. Coverage includes:

- Synthetic import observations and a personal inventory projection that excludes guild-only stock.
- Demand creation, editing, deactivation, stable intent identity, and durable SQLite reopen.
- REST allocation review and MCP allocation review parity, including item-level MCP projection.
- No-demand and deactivated-demand cases without fabricated surplus/deficit fields.
- An additive pre-ERP SQLite schema upgrade that preserves snapshots and account facts and creates
  no invented demand.
- Browser interactions to create, edit, and deactivate demand, view its history, and confirm that
  the Retail commodity does not appear on Forever gear review.
- Existing Forever allocation validation, including the newer live-transfer regression contract.

## Acceptance scope still pending product support

The current browser journey does not yet cover project/work-order authoring, reservation lifecycle,
or task reconciliation. Those product capabilities do exist and have separate core, REST, MCP, and
web tests; they should be added to a later unified acceptance journey. Crafting execution, purchase
execution, and causal attribution of observed changes are not implemented, and must not be represented
as passing coverage. The current migration test is specific to additive creation of the `demands`
table and index and is not a generalized migration framework test.

Other useful expansion areas include cross-pipeline AccountContext/read-model parity, malformed
export security cases, repeated-import/idempotence properties across all data families, fuller
identity/version collision matrices, API validation edge cases, MCP error parity, and browser
coverage beyond allocation review. Assertions for version-specific gameplay rules must be based on
the implementation, export contract, or verified version-specific evidence.

## Integration guidance

Windows owns final product integration. Cherry-pick or merge the isolated validation branch into
the latest ERP product branch after refreshing both branches. Review overlap in root `package.json`
and `package-lock.json`, `docs/TESTING_AND_VALIDATION.md`, and any shared allocation test fixtures.
Run `npm ci` and `npm run validate:erp` on the combined tree before product integration. Keep test
fixtures synthetic and disposable; do not import them into production databases.
