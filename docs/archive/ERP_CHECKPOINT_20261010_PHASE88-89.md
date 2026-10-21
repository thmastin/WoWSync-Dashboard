# WoWSync ERP checkpoint: Phases 88–89

Date: 2026-10-10  
Branch: `feature/forever-gear-observation`  
Evidence: isolated Dashboard worktree and synthetic disposable-SQLite browser fixtures. No live game or production system was used.

## Product outcome

The cross-project manual planner now lets the player attach an independently selected, evidence-qualified fulfillment pathway to each requirement in a grouped planning session. Previously, only the requirement that opened the planner carried pathway context; other selected requirements could receive manual work but could not retain their own reviewed pathway without leaving the group.

Pathway identity remains separate from task type, requirement source, selected work source, assignee, destination, reservation, and dependency. The frozen preview carries each selected pathway, and the server revalidates it against current same-version source-review evidence before the atomic batch save. Players can still choose a different manual step than the pathway suggestion; the pathway does not validate execution or access.

## Evidence and safety behavior

- An alternate-character lead is prefilled only when exactly one candidate is OBSERVED and recent, its identity is scoped to the active version, and the exact resource matches a recent OBSERVED source-screen candidate.
- Multiple, stale, missing, wrong-version, or unmatched candidates remain unselected. Instructions call out that no unique current lead is established and preserve UNKNOWN ownership, account membership, access, binding, transferability, and route.
- Personal-bank retrieval pathways suggest a manual RETRIEVE review. Other pathways remain separate from player task choice.
- Untouched suggestions update or reset consistently as pathways are selected, cleared, or the requirement is removed/re-added. Once a player edits any task field, pathway changes and clearing preserve those edits.
- A pathway selection or work order does not reserve, move, retrieve, purchase, craft, gather, or complete anything in game.

## Validation and review

`npm.cmd run validate:erp` passed:

- Core: 838 passed
- MCP: 3 passed
- Server: 267 passed, 2 platform skips
- Web: 315 passed
- TypeScript checks and production web build passed
- Synthetic browser acceptance: 16 passed

The browser acceptance covers two distinct selected pathways in one grouped multi-project batch, exact unique observed-source prefill, ambiguous leads staying blank, task/path separation, deselect/reselect, pathway clear/reselect, preserving edited instructions, stale evidence rejection, reservation capacity rejection, and REST/AccountContext/MCP parity. This is synthetic acceptance, not live-game or production validation. The production build still emits its existing advisory for a JavaScript chunk above 500 kB.

Focused independent review found and resolved two interaction concerns: ambiguous leads must not be described as a unique recent lead, and pathway changes must not silently overwrite player-edited task fields. Final review found no blockers.

## Capability inventory and limits

**Implemented and usable:** The player can build one grouped planning batch across projects, choose a different evidence pathway for each requirement, select task details and prerequisites, review frozen evidence, then save the manual plan atomically when current validation passes. REST, AccountContext, MCP, and the UI read the same persisted result.

**Synthetic-tested only:** The new per-requirement pathway interaction, its source-prefill safeguards, and grouped persistence. Existing real Hallo/Fizzwick observations remain evidence for only their specific captured events.

**Still partial or UNKNOWN:** Craft inputs remain player-declared; capability evidence does not prove craftability. Location leads do not prove account membership, ownership, access, binding, or transfer routes. Resource changes do not prove causation or work completion. Live game, market, and production behavior were not tested.

## Repositories and delivery

Dashboard source and browser acceptance changed in the isolated development worktree only. No GearExport, SavedVariables, production Dashboard, BankCleanup, or game installation changes were made. Dashboard commit and push status are recorded after commit in the canonical truth checkpoint.

## Next substantial milestone

Complete one synthetic multi-need fulfillment journey through the existing shared model and player-facing workbench, combining a player-declared craft and its material needs, procurement or storage-retrieval review, reservation/dependency checks, a later import, and evidence-qualified reconciliation. Assert the same next-step and uncertainty state in REST, AccountContext, MCP, and the UI. Keep action cause UNKNOWN unless directly declared or independently evidenced. The ERP mission remains active.
