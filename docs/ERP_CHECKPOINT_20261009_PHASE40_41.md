# WoWSync ERP checkpoint — Phases 40–41

**Date:** 2026-10-09  
**Dashboard branch:** `feature/forever-gear-observation`  
**Dashboard commits:** `43a45ee54d25e7adf480f71900512049db9a1c3d` (Phase 40), `bd53d58477e53641eaee44b1c87bbdffd462eaec` (Phase 41), pushed

## Delivered

Shared-storage retrieval reviews now display the resolved human-readable owner label when the workbench has an exact matching owner record, while preserving the original owner scope and key. When no owner name is available, the UI keeps the existing raw-key fallback.

The core retrieval projection now also compares a selected recipient's own bags independently from shared-owner contents. It reports only a quantity comparison for two complete OBSERVED bag sections. `ITEM_REF` compares the exact itemString; `ITEM_ID` explicitly groups variants. Equal or reversed section timestamps, incomplete or missing snapshots, stale/future evidence, and incompatible recipient identity leave the recipient result UNKNOWN. This comparison does not establish shared-storage access, ownership, retrieval, transfer, or causation. It does not complete the manual work order.

The REST project detail and MCP `get_erp_projects` expose the same nested recipient bag observation. AccountContext adds counts for owner retrieval states and recipient bag observation states. The work-order UI labels recipient bags separately from the shared owner and explains the non-causal limitation.

## Verification and review

`npm.cmd run validate:erp` passed on the combined implementation:

- Core: 822 passed
- MCP: 3 passed
- Server: 259 passed, 2 platform skips
- Web: 301 passed
- TypeScript checks passed
- Production web build passed (existing advisory for a JavaScript chunk over 500 kB)
- Synthetic browser acceptance: 5 passed

The focused strict-chronology fixture passed. Independent review found that snapshot order alone did not guarantee strictly increasing section timestamps; the code now returns UNKNOWN when section timestamps are equal or out of order. Review of the correction and the REST/MCP/AccountContext/UI contract found no remaining actionable findings.

All behavioral checks for paired recipient/shared-storage changes are synthetic. No player action or live game validation was performed. No GearExport, SavedVariables, installed addon, production Dashboard, or BankCleanup changes were made.

## Continuation and next work

The active native Codex Goal remains the supported thread-scoped continuation mechanism. It is event-driven, not a fresh-process scheduler or guarantee of unbounded unattended execution. The checkpoint is recoverable from the pushed Dashboard commits and canonical truth; no scheduler, service, or security bypass was introduced.

Continue the ERP mission with shared-owner reservation conflicts across competing projects: verify the lower-bound arithmetic, ambiguity behavior across base IDs and variants, stale/partial supply handling, and make conflict summaries actionable through the existing core, REST, AccountContext, MCP, and workbench surfaces. Keep ownership, access, and movement UNKNOWN unless observed independently.

## Report

The matching user-facing report is `WoWSync-ERP-Checkpoint-20261009-Phase40-41.md` in the Windows Downloads folder.
