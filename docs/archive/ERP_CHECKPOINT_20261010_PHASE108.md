# WoWSync ERP Phase 108 — attention queue to exact review surfaces

Date: 2026-10-10  
Repository: `D:\dev\wow-addons\WoWSync-Dashboard-Forever-Gear`  
Branch: `feature/forever-gear-observation`

## Player outcome

From Portfolio next actions, a player can open the exact conflicting reservation group or exact source/resource access review row identified by the shared Core projection. The target preserves version, source scope/identity, resource kind, and resource key. The focus action does not change the Dashboard hash route. If the matching row is not present in the bounded returned review, the queue explains the limitation and sends the player back to the exact need for refresh; it does not point at a similarly named resource.

The queue continues to link evidence and history to exact needs, saved history to exact review generations, and unfinished work to exact work orders. These links navigate for review only. No task, reservation, source, or game state is written by opening a target.

## Implementation

- Added shared source-review and reservation-scope anchor builders.
- Added exact source/access action links resolved by version/resource/source identity.
- Added exact reservation-review links resolved by source/resource identity and an active conflict state.
- Focused targets without mutating the hash-based app route.
- Expanded the existing competing-reservation synthetic scenario with a separate source/access need and checked target existence, actual focus, route stability, REST/MCP next-action parity, AccountContext counts, and Forever isolation.
- Increased navigation timeout only for the browser acceptance that had intermittently timed out on local page load; action timeouts remain 5 seconds.
- Updated the cumulative capability inventory with the actual UI/REST/AccountContext/MCP coverage and clarified that all 32 MCP tools are read-only.

## Validation and review

`npm.cmd run validate:erp` passed on the exact final code and browser fixtures:

- Core: 856 passed.
- MCP: 3 passed.
- Server: 269 passed, 2 Windows platform skips.
- Web: 315 passed.
- Browser: 22 passed.
- TypeScript and production build passed.
- Existing Vite advisory: main bundle exceeds 500 kB.

The browser-only run also passed 22/22 after the navigation-timeout stabilization. One earlier full attempt hit a 5-second local `page.goto` timeout in an unrelated observation-review acceptance; it passed after setting that test's navigation timeout to 15 seconds.

Independent review found no blocking or high-priority findings. Reviewer-confirmed behavior includes exact matching, conservative missing-window fallback, hash-route preservation, UI focus checks, REST/MCP parity, and version isolation.

## Evidence and limits

This phase is synthetic browser validation only. It does not represent live WoW or production Dashboard validation. The ERP retains OBSERVED, DERIVED, LAST_SEEN, and UNKNOWN distinctions; exact navigation does not upgrade evidence, establish access/ownership/routes, infer action cause, or execute a task.

See `ERP_CAPABILITY_INVENTORY.md` for the cumulative audited state, including MCP read/write coverage and live-evidence scope. The active ERP initiative is not complete.
