# WoWSync ERP Phase 37 — craft material procurement review

Date: 2026-10-09

## Outcome

A material requirement created from a recipe-to-CRAFT review now names the selected same-version crafter as both explicit source and intended recipient. This matches the existing same-character purchase quick-start contract. When the complete, recent source observation shows a shortfall and active reservations remain within observed supply, the existing PURCHASE form can be prefilled for that exact material need and same character as buyer.

The player must still enter an upper spending ceiling and can record a quote only through the existing manual review. Observed gross gold, an explicit planned gold need, quote data, availability, routes, affordability, and actual purchase remain independent. The purchase stays PLANNED; no game action occurs. Reservation does not erase a resource shortfall. No recipe-derived reagents are generated.

The browser acceptance also now scopes the existing quote assertion to the specific purchase order. The additional craft-material purchase creates a second procurement review in the same project, and the old document-wide first-match assertion could otherwise inspect the wrong order. This was a fixture selector defect, not a product or procurement-state defect.

## Validation

`npm.cmd run validate:erp` passed on 2026-10-09:

- Core: 822 passed
- MCP: 3 passed
- Server: 259 passed, 2 platform skips
- Web: 301 passed
- TypeScript checks passed
- Production web build passed
- Synthetic browser acceptances: 5 passed

The expanded synthetic browser scenario links an exact-variant, player-entered material need to a manual craft order, observes a shortfall against a complete synthetic character inventory, reserves only within observed unreserved supply, and creates a same-crafter manual procurement order with an explicit spending ceiling. It verifies the purchase remains PLANNED and the shortfall remains visible. This does not validate game recipes, vendor/auction availability, prices, or purchase behavior.

## Independent review

Focused independent review found no actionable findings. It confirmed source and recipient scoping to the same crafter, the existing confirmed-shortfall and reservation guards, exact need targeting, the player-set ceiling, and absence of purchase execution.

## Repository and limits

Dashboard branch: `feature/forever-gear-observation`. No GearExport, SavedVariables, production Dashboard, or game installation changes. No live or production validation. The existing Vite >500 kB chunk advisory remains.

## Next

Continue operational planning beyond this slice: connect provisioned items to project destination readiness while keeping observed stock, player purchase intent, and subsequent inventory changes distinct; continue storage and economic allocation planning without inferring routes or causation.
