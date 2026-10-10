# WoWSync ERP Phase 105 — review intervening resource variation

Date: 2026-10-10  
Repository: `WoWSync-Dashboard`  
Branch: `feature/forever-gear-observation`

## Player outcome

Saved requirement history now detects section quantity variation after a saved planning review, including a change that later returns to the saved/current quantity. The Projects history directs the player to the exact requirement for reconciliation. The UI shows the section, quantities, and observation times and labels the item for review; it does not attribute a cause or mark work complete. REST, AccountContext schema 46, MCP, and the Dashboard share the same core assessment.

The review is conservative at section granularity. A section sample is included only when its own timestamp is after the saved review. Variation is computed across all retained interval points even when the UI shows only its bounded 20-point sample. Truncated history, conflicting quantities at one timestamp, or too few comparable observations cannot produce a no-variation conclusion. An unambiguous quantity change can still be reported as observed evidence.

## Validation and review

`npm.cmd run validate:erp` passed: Core 855, MCP 3, Server 269 passed with 2 Windows platform skips, Web 315, 22 synthetic browser acceptance tests, TypeScript, and production build. Regression coverage includes mixed section timestamps, an intermediate quantity variation outside the displayed sample, underlying truncated history, and conflicting same-timestamp quantities. `git diff --check` passed. The build retains its existing Vite large-chunk advisory.

Independent focused review found and resolved three conservative-evidence issues: per-section review-time filtering, variation evaluation before display slicing, and same-time conflicting quantities. Follow-up review found no blockers. Synthetic acceptance does not establish game-action causality or live-game fulfillment behavior.

## Cumulative capability status

- **Implemented and usable:** follow a saved project requirement through plan history; inspect exact source/resource scope and bounded per-section evidence after review; identify quantity changes even if values later return; navigate to the requirement for player reconciliation.
- **Automated-tested:** shared Core, REST, AccountContext, MCP and browser behavior on deterministic synthetic cases.
- **Requires live validation:** whether the workflow fits real player reconciliation behavior and real export cadence.
- **Still UNKNOWN:** why any resource quantity changed, whether a task caused it, whether a transfer/craft/purchase occurred, and completion of any game action.

No live game, production Dashboard, SavedVariables, GearExport, or game installation was changed.

## Next substantial milestone

Unify portfolio next actions around saved-history exceptions, current need shortfalls, reservation conflicts, and open manual work. Preserve exact requirement links and current evidence, avoid duplicate queue entries, and let the player prepare a single bounded review/replan session across connected needs without implying that a historical variation explains the current state.
