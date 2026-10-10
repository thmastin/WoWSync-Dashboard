# WoWSync ERP checkpoint - Phase 75

Date: 2026-10-10

## Player outcome

The Projects & Work Orders page now contains a per-version source/resource review that joins explicitly selected source needs across active and paused projects. A player can compare exact resource variants, current evidence/freshness, reservations, linked manual-work readiness and recorded status, paired observations, craft capability/output evidence, procurement quote state, and other same-version observed character locations in one place. Each need links back to its project controls.

Other character locations remain evidence leads. Their items, sections, timestamps, freshness, quantities, and scan limitations are shown, but alternative rows are not summed with the selected source. The review never claims account membership, ownership, access, transferability, a valid route, or an action outcome. A roster with no other character scanned is distinguished from a completed scan with no match. A partial scan can show leads and still states that it is incomplete.

## Implementation

- Added the shared core projection `buildErpSourceFulfillmentReview`, scoped by version, one explicit character or shared-owner source, and exact resource kind/key.
- Included active and paused requirements; kept completed/cancelled plans and other versions out.
- Preserved per-need quantities, freshness, section completeness, reservation assessments, work-order evidence, and itemString variants. No quantities from alternative locations are aggregated.
- Added bounded alternative location leads from existing same-version source screens. Duplicated evidence rows retain their linked need references. Missing screens, zero-character scans, unresolved characters, and truncated candidate scans remain explicit review states.
- Added the review to the existing Portfolio Fulfillment panel and shared REST/MCP/AccountContext contracts. AccountContext schema is 36.
- Changed procurement panel labels to state that work-order status is recorded player intent, not game-observed completion.

## Evidence and capability inventory

- **Implemented and usable:** requirements, version-scoped observations, reservation review, manual work, work-order readiness and paired observation review, craft/procurement evidence already present in the core, cross-project dependency packages, source-scoped fulfillment view, alternative same-version location leads, UI/REST/AccountContext/MCP parity.
- **Synthetic-tested only in this checkpoint:** grouped source/resource presentation, incomplete and zero-roster scan handling, candidate leads with unresolved roster scans, and parity through the existing browser acceptance journey.
- **Partial:** craft inputs remain player-declared; retrieval and provisioning remain evidence-gated; quotes are player-entered; source evidence is not a route solver.
- **Missing/unsupported:** automatic route or craft/buy/gather optimizer, general causal action attribution, verified market supply/pricing/affordability, complete generalized craftability, ownership/access/transfer inference from co-location.
- **Requires live validation:** broader multi-character source/access behavior and version-specific operational use. Existing real observations are not expanded by this synthetic checkpoint.

## Validation and review

`npm.cmd run validate:erp` passed on the final code tree:

- Core: 834 passed.
- MCP: 3 passed.
- Server: 267 passed, 2 Windows platform skips.
- Web: 315 passed.
- TypeScript checks and production build passed. Vite reports the existing large JavaScript chunk advisory.
- Synthetic browser acceptance: 14 passed.

Independent review first identified that a zero-character scan was being described like a completed scan, then found that candidate rows could suppress an incomplete-scan warning. Both were fixed with separate `NO_OTHER_CHARACTERS_TO_SCAN` and `POTENTIAL_LOCATIONS_SCAN_INCOMPLETE` results, summary accounting, UI wording, and deterministic regressions. Follow-up review confirmed those findings resolved and found no remaining blocker. The browser suite is automated synthetic acceptance, not live browser/account validation.

## Repository and delivery state

- Dashboard worktree: `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`
- Branch: `feature/forever-gear-observation`
- Starting Dashboard commit: `8c42f8f4e449e1f789d44ccc6553aca810437821`
- Code commit: `6402394` (`feat(erp): add source-scoped fulfillment review`), pushed to `origin/feature/forever-gear-observation`.
- Documentation commit and push status: record the exact report commit after this file, the capability inventory, and current state are committed.
- GearExport, BankCleanup, production Dashboard, SavedVariables, and installed addons were not modified. No live validation or deployment occurred.

## Continuation

The ERP mission remains active. The next substantial milestone is to connect this per-source review directly to the existing cross-project manual action queue so a player can carry a reviewed location lead into an explicit, revision-checked work-order plan while seeing its reservations, dependencies, procurement limits, and unresolved access in the same journey. Then add one multi-need procurement/retrieval/craft-input synthetic browser acceptance across Dashboard, REST, AccountContext, and MCP.
