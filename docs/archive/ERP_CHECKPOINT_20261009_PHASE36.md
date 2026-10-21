# WoWSync ERP Phase 36 — linked craft inputs and reservations

Date: 2026-10-09

## Outcome

The existing recipe-to-craft quick-start now prepares the adjacent resource-need form for explicit material entry. It defaults to an exact `ITEM_REF`, assigns the recipe's explicitly sourced same-version character as the material source and intended crafter, and leaves quantity/name/resource to the player. A craft review can keep the material-need form open while the player links that need into the manual CRAFT order. Existing reservation controls remain separate and only permit reservations supported by observed unreserved supply.

No recipe reagent list is synthesized. Recipe knowledge does not establish materials, skill, unlocks, craftability, output, or completion. Exact item variants remain explicit. The work-order readiness view reports observed material coverage and reservation state independently of recipe/crafter readiness. No game action is executed.

## Validation

`npm.cmd run validate:erp` passed:

- Core: 822 passed
- MCP: 3 passed
- Server: 259 passed, 2 platform skips
- Web: 301 passed
- TypeScript checks passed
- Production web build passed
- Synthetic browser acceptances: 5 passed

The focused browser scenario created a recipe need, opened its craft review, explicitly declared an exact-variant material need against the assigned crafter, linked it to the CRAFT work order, confirmed observed synthetic coverage, and reserved only the observed quantity. This is synthetic acceptance, not live game validation. The production build retains the existing >500 kB advisory.

## Independent review

Focused independent review of the exact diff found no actionable findings. It confirmed explicit material declaration, no inferred reagent list, retained version/source scope, and reservation limits based on observed unreserved supply.

## Repository and limits

Dashboard branch: `feature/forever-gear-observation`. No GearExport, SavedVariables, production Dashboard, or game installation changes. No live or production validation.

This improves the manual crafting workflow but does not determine recipe inputs or prove a craft can be performed. Player-declared materials can be linked and reserved only as planning intent; actual craft completion remains user-declared or evidence-qualified under existing reconciliation.

## Next

Continue integrated ERP work with procurement follow-through for explicitly declared craft inputs, then strengthen project/work-order reconciliation without attributing inventory changes to game actions.
