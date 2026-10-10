# WoWSync ERP Checkpoint — 2026-10-09 — Phase 29

## Outcome

Improved the existing version-scoped Resource commitments surface for exception review. Review-risk scopes now sort first; controls filter to “Needs review” or “Has reservations,” and search across resource, source, and contributing project names. A live count announces how many scopes are shown and how many require review.

Review risk includes unknown source, stale or unknown freshness, over-reservation, unknown reservation state, overlapping item identities, and unresolved evidence sections. The explicit reservation filter includes only rows with a recorded exact or overlapping reservation quantity. An UNKNOWN reservation state is never described as unreserved.

## Integration and safety

This reuses the existing REST resource commitment summary and Dashboard workbench; no second ledger, endpoint, storage model, or database change was introduced. Displayed rows remain version-isolated. The workbench continues to keep plan demand and reservations distinct from observed supply, and overlapping identities are not totaled together. Search and filtering only change presentation; they do not write or infer player intent.

## Validation and review

`npm.cmd run validate:erp` passed: Core 821; MCP 3; Server 259 passed plus 2 platform skips; Web 294; TypeScript; production web build; and 5 synthetic browser acceptances. Browser acceptance exercises the review-risk filter, exact/overlapping reservation filter, search, and no-match state against temporary fixture data.

Focused independent review found no actionable findings. It verified UNKNOWN remains distinct from UNRESERVED, the reserved filter is based on recorded quantities, the controls are accessible and announce counts, and review rows sort first. The production build still reports the existing advisory for a minified main chunk above 500 kB.

This was automated local validation only; no live game or production Dashboard was used.

## Next work

Continue the active ERP mission with an operational lifecycle improvement connecting persistent project/work-order state to later imports. Preserve explicit player completion, evidence-backed changes, ambiguous changes, contradictions, and stale evidence as distinct states. Then continue integrated storage and crafting/procurement planning; no game session or production change is required for that engineering work.
