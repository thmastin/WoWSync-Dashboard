# WoWSync ERP checkpoint — Phases 76–79

Date: 2026-10-10  
Repository: `thmastin/WoWSync-Dashboard`  
Branch: `feature/forever-gear-observation`  
Baseline before this pass: Phase 75 source-scoped portfolio fulfillment review

## Player workflow delivered

Projects & Work Orders can now take a player from repeated same-version exact-item needs, through a grouped manual plan, to a frozen review of the complete multi-project request before save.

- Phase 76 groups matching needs and can attach a conditional manual PROVISION source lead when current evidence identifies a recent, positive, exact-variant location. Each project write is bounded, revision/evidence checked, and atomic.
- Phase 77 shows existing open provisioning plans beside the observed location lead, so the player can see source/need/task links and any available paired-observation status.
- Phase 78 lets the cross-project batch select an exact observed source for a PROVISION step while mixing other task types, prerequisites, and separately scoped reservations.
- Phase 79 previews project revisions, task types, titles, instructions, requirement source, selected work source, assignee, destination, exact item rows, timestamps/freshness, reservation requests, purchase ceiling, and prerequisite gates. It freezes the submitted task drafts and evidence snapshots. The API rechecks them in one SQLite transaction and rejects the complete batch if evidence changed.

The player can plan several related procurement, gather, craft, investigate, retrieve, or provision steps across active projects in one session and inspect their full intent before committing. The batch does not execute game actions or prove resource movement.

## Evidence and safety limits

Only same-version recent OBSERVED exact-item rows qualify as provisioning location leads. Need source intent remains separate from the selected work-order source. A source lead does not prove account membership, ownership, access, binding, transferability, or a route. A separate reservation still applies to the need's explicitly named source. Procurement ceilings are player-entered intent, not prices or affordability. Project/work-order status and completion still require evidence; observations do not establish action causation.

The Phase 79 review is synthetic-tested and is not live-game or production validation. No live observation was added in this checkpoint.

## Validation and review

`npm.cmd run validate:erp` passed on the final code:

- Core: 835 passed
- MCP: 3 passed
- Server: 267 passed, 2 Windows-only platform skips
- Web: 315 passed
- TypeScript checks: passed
- Production web build: passed (existing large-chunk advisory remains)
- Synthetic headless browser acceptance: 14 passed

Focused independent review initially found three defects: the reviewed payload was not frozen, the review omitted manual instructions, and a purchase ceiling could linger after changing task type. All were fixed. Browser coverage now confirms the frozen request is rejected atomically after a new import, preview creates no database write, back-to-edit preserves drafts, instructions are visible, and a non-purchase task does not retain a purchase ceiling. The reviewer rechecked the fixes and found no blocking issue.

## Repository and validation status

Changes are limited to the authorized Dashboard worktree. No GearExport, production Dashboard, BankCleanup, SavedVariables, or installed addon files changed. The work is synthetic/browser validated only; no production or game deployment occurred. Commit and push SHAs are recorded in this report after delivery.

## Cumulative capability status

- **Implemented and usable:** version-scoped project requirements, evidence and freshness review, cross-project need grouping, manual work orders, dependencies, player-declared reservations, procurement ceilings, observed source leads, grouped atomic planning, frozen review, and REST/AccountContext/MCP/UI projections.
- **Implemented; synthetic-tested only:** Phases 76–79 and their mixed multi-project planning scenario.
- **Partial:** crafting inputs remain player declared; storage access/routes remain unknown; procurement prices and market supply are absent; reconciliation remains non-causal.
- **Missing:** source-scoped reservations against an alternate location, a general route optimizer, and automatic prioritization across fulfillment methods.
- **Requires live validation:** broader multi-character storage/access behavior and game-dependent outcomes. This checkpoint itself needs no player action.

## Next substantial milestone

Allow a selected exact-variant alternate PROVISION source to scope a planning reservation to that observed source. Keep the requirement's original source intent distinct; require recent complete quantified source evidence; check competing exact and overlapping resource commitments in the existing atomic write path; and expose the reservation source and UNKNOWN access/ownership/transferability/route consistently in the planner and subsequent reconciliation. Validate cross-project capacity conflicts and the complete mixed workflow through UI, REST, AccountContext, and MCP.
