# WoWSync ERP Phase 34 — editable manual work-order plans

Date: 2026-10-09

## Outcome

The Projects & Work Orders workbench now lets a player edit a nonterminal manual work-order plan in place. The saved row retains its stable ID and current status while plan fields (title, instructions, assignment, planned source/destination, resource links, dependencies, declared craft output, output-observation character, and procurement terms) can be revised. Existing player-entered purchase quotes are retained only when the linked item target remains the same; changing target removes the old quote so it cannot be misrepresented as evidence for another item. The editor treats procurement target/budget links as derived from the current selectors: changing a selector removes the old automatic link, re-adds the current selection, and preserves unrelated manually linked needs.

Edits change recorded intent only. They do not execute game actions, assert that a task occurred, or change observations. Existing project mutation validation remains authoritative.

## Validation

`npm.cmd run validate:erp` passed after the review fix:

- Core: 822 passed
- MCP: 3 passed
- Server: 259 passed, 2 platform skips
- Web: 301 passed
- TypeScript: passed
- Production web build: passed (existing >500 kB bundle advisory)
- Synthetic browser acceptances: 5 passed

The browser scenario edits a CRAFT plan and verifies stable ID/status, linked need, dependency, observed-output character and intended destination. It edits a PURCHASE target and verifies the former auto-linked item need is removed, current target and budget remain linked, and the old player quote is cleared. These are synthetic acceptance cases, not live or production validation.

## Independent review

Focused review found that the first implementation retained a purchase quote even when its item target changed. The edit path now retains the quote only if the target need ID is unchanged, and browser coverage protects the behavior. Follow-up regression found and prevented the previous auto-linked target need from remaining selected after an edit; the editor now separates automatic procurement links from manually linked inputs. The reviewer rechecked link replacement, budget preservation, and retention of unrelated manual links; no remaining actionable findings.

## Repository

Dashboard branch: `feature/forever-gear-observation`.

Starting commit: `daa25a5f0dccfed2931f523331a4fc753a4d560f`.

Follow-up implementation and documentation commit/push are recorded in the repository history after this checkpoint's initial implementation commit.

No GearExport, game, SavedVariables, production Dashboard, or BankCleanup changes. Native Codex continuation still has no verified scheduler or fresh-process auto-launch; this phase does not change that platform limitation.

## Next engineering action

Continue with the integrated ERP lifecycle: link manual craft/provisioning work to declared material requirements and reservations, then reconcile subsequent observations without attributing causation. ERP development remains active; this is an internal checkpoint, not mission completion.
