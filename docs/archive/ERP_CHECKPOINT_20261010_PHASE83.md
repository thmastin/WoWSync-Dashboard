# WoWSync ERP checkpoint — Phase 83

**Date:** 2026-10-10  
**Worktree:** `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`  
**Branch:** `feature/forever-gear-observation`  
**Starting Dashboard HEAD:** `0688fa41e4ecddbd28e5075089d9ddda4bc8536c`

## Player outcome

Projects & Work Orders now puts evidence-qualified review options beside each selected-source resource need. The player can see current source coverage or shortfall, review same-character personal-bank retrieval when both bag and bank scans are complete and recent, follow linked player-authored work, inspect same-version character location leads, choose a manual supply plan, or refresh unclear evidence. Each alternate lead shows its character and realm, OBSERVED or LAST_SEEN provenance, freshness, and observation timestamp.

The state is called `CURRENT_SOURCE_COVERAGE`, never “need met.” Sufficient stock at a selected character or shared owner does not establish delivery to a different recipient. A location does not establish account membership, ownership, access, binding, transferability, or a route. The view is a read-only review; players continue to author and control all tasks, reservations, and dependencies.

## Implementation

- Added bounded per-need pathway options to the shared deterministic source fulfillment projection.
- Exposed per-lead provenance/freshness/time through REST and MCP core results; AccountContext schema 38 summarizes state and option-kind counts.
- Rendered review options, source-scoped coverage wording, exact observed bank item variants, and historical/current alternative leads in the existing Dashboard workbench.
- Added regression fixtures for complete and partial banks, an exact item variant, linked work, current and LAST_SEEN alternate locations, cross-character destination, shared owner, and AccountContext/REST/MCP/UI consistency.
- Updated ERP planning and capability inventory documentation.

## Validation and independent review

`npm.cmd run validate:erp` passed:

- Core: 838 passed
- MCP: 3 passed
- Server: 267 passed, 2 platform skips
- Web: 315 passed
- TypeScript checks and production web build passed
- Synthetic browser acceptance: 15 passed

The build reports the existing advisory for a minified JavaScript chunk above 500 kB. No live account or production validation occurred.

Independent review found two blockers: alternate locations omitted their historical provenance/freshness, and selected-source coverage was labeled as need fulfillment even for a separate destination. The contract and UI now preserve each lead's provenance, freshness, and time, and use source-scoped state names/reasons. Tests cover LAST_SEEN, cross-character, and shared-owner scenarios. Follow-up review found no remaining blocker.

## Cumulative capability status

- **Implemented and usable:** source-scoped per-need review pathways across the existing Dashboard, REST, MCP, and AccountContext summary.
- **Synthetic-tested only:** retrieval eligibility from complete same-character bag/bank evidence, location lead provenance, partial evidence handling, and source-versus-destination wording.
- **Partial:** pathways are review guidance and link to existing planning controls; they do not create a route or select sources automatically.
- **Missing:** one cross-project decision session that freezes selected pathways and task inputs and atomically revalidates them before saving player-authored work.
- **Requires live validation:** actual storage accessibility, movement, craftability, market availability, and game-specific fulfillment. No new player session is required for this synthetic workflow change.

## Next engineering action

Build the cross-project player-authored decision session from these pathways. Freeze the selected needs, task text, source scope, reservations, prerequisites, and evidence snapshot for review; reject the complete write if revisions or evidence change; and keep all actions manual and all unsupported routes UNKNOWN.
