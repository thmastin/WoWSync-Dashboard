# WoWSync ERP Checkpoint — Phase 31: portfolio reconciliation gaps

Dashboard branch `feature/forever-gear-observation`, worktree `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`.

## Delivered

Expanded the existing Projects & Work Orders portfolio review. The work-order queue now includes nonterminal tasks in projects the player has marked complete, making the project/work-order state mismatch visible without implying that either record is wrong. The row explicitly states that the project is player-marked complete and the work order is not terminal.

Added a cross-project list of resource needs that are not covered by recent observed evidence and have no nonterminal manual work order linked. It shows evidence state, freshness, observed amount where known, historical possible quantity separately, source, and a path back to the existing project. A project marked complete with an uncovered need is labelled as a mismatch in current evidence, not proof of failure. Needs already linked to planned/in-progress/paused work are not duplicated; recently covered needs and cancelled projects are omitted. No resource state or task state is mutated.

## Validation

- `npm.cmd run validate:erp`: Core 821 passed; MCP 3 passed; Server 259 passed with 2 platform skips; Web 298 passed; TypeScript passed; production web build passed; 5 synthetic browser acceptance tests passed.
- Deterministic web tests cover recent coverage vs stale coverage, orphaned needs, suppression by nonterminal linked work, completed projects with unmet needs, and cancelled projects.
- Synthetic browser acceptance checks an UNKNOWN uncovered need appears, then disappears from the orphan list when a source-verification work order is created; queue search and focus navigation also remain checked.
- Independent review found no actionable findings. Reviewer examined completed-vs-open tasks, need suppression, freshness wording, version scope, and accessible navigation.
- Existing production bundle-size advisory (>500 kB chunk) remains. No live-game, production-dashboard, or production-browser validation occurred.

## Next

Continue the ERP: strengthen reservation adjustment/release workflows and connect explicit crafting/provisioning needs to project execution and later evidence reconciliation. No player action is currently required.
