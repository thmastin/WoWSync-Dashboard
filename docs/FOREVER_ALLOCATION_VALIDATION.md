# Forever gear allocation validation

Run the full deterministic validation command from the repository root:

```sh
npm run validate:forever
```

It executes all existing Node test suites, typechecks the core, server, MCP, and web workspaces, then builds the web UI. A failing test or build returns a nonzero process status. The runner uses Node, npm, the repository's checked-in dependencies, and deterministic fixtures only. It makes no model API calls, requires no provider SDK or credentials, and does not require a running game client or manual input. Node's test runner reports the failing test name and assertion message; contract failures include a stable invariant code.

## What the suite validates

The tests exercise the existing Forever 70291 observation, allocation, and transport implementations. The shared `foreverAllocationContract` assertions run against core read-model results and the REST and MCP projections. Existing AccountContext parity assertions ensure it carries the same canonical allocation plan as REST. Existing web tests cover the Forever roster review presentation and exact-variant grouping.

Coverage includes version/build isolation, realm and character identity, source GUID conflicts, exact item variants, duplicate and conflicting observations, freshness and partial coverage, unknown bank and account membership, eligibility and proficiency uncertainty, raw stat comparison limits, hand-slot conflicts, transfer uncertainty, and cross-surface response contracts. A synthetic adversarial test deliberately marks a cross-character transfer allowed while membership is unknown; the invariant checker must reject it with `UNKNOWN_MEMBERSHIP_DOES_NOT_PROVE_TRANSFER`.

Fixture labels follow the repository's fixture policy. The Hallo file under `packages/core/test/fixtures/forever/` is a real observed build 69913 export and is used to verify that the build 70291 allocation evaluator refuses it. The deeper 70291 allocation scenarios are synthetic adversarial observations in `packages/core/test/readModel.test.ts`; they are not live captures. No Fizzwick or post-mail observation is included in this harness.

## What this does and does not establish

Automation now catches regressions in deterministic import/read-model behavior, evidence states, identity isolation, candidate screening, exact-variant preservation, and REST, AccountContext, MCP, and UI-facing contracts. It can replay future sanitized or synthetic transfer evidence without asking a player to repeat known scenarios.

New in-game evidence is still required for client behavior the fixtures have not established, including recipient-specific Forever API results, actual item transfer rules, and any live behavior that differs from the recorded 70291 contract. Passing these tests is not live gameplay validation, and an observed raw-stat advantage remains only a raw-stat comparison.

This command and every check are model-agnostic. Codex, Claude Code, CI, and human developers run the same npm command and consume ordinary test output and process exit codes.
