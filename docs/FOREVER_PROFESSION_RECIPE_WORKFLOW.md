# Forever profession recipe workflow

Forever 1.60.1 recipe records are a version-scoped character-state sidecar attached to ordinary imported snapshots. They retain the snapshot, client build, observation time, per-profession/per-recipe OBSERVED or LAST_SEEN state, and explicitly partial candidate coverage. Invalid, cross-version, duplicate, incomplete, or unhydrated evidence is rejected or remains UNKNOWN; absence from Forever's candidate list never means unlearned. The database stores these records inside the existing snapshot JSON and does not need a schema migration.

## Retail parity and Forever boundaries

| Capability | Retail today | Forever today | Treatment |
|---|---|---|---|
| Learned recipe candidates and exact schematics | Existing structured recipe sidecar | Captured from the open character profession panel | Shared snapshot sidecar and bounded MCP read model; Forever adapter preserves 1.60.1 build/interface evidence |
| Reagents and alternatives | Existing recipe payload | Exact item/currency alternatives and per-slot quantities when returned | Preserve alternatives; do not sum OR choices |
| Trainer services | Existing trainer projection | Existing Forever raw trainer window observation | Kept separate from recipe identity; service lists are not treated as exhaustive |
| Carried materials | Character bags | Forever structured bags merged into the Forever carried-item read model | Only the selected character's observed bags count; stale/partial/unidentified rows prevent a confirmed shortfall |
| Bank/other characters | Existing version-specific storage views | Bank may be UNKNOWN; another character is a separate owner | Never assume bank access, transfer, or account membership |
| Crafted gear output | Retail item and equipment evidence | `GetItemInfoInstant` output identity/class/location when available | Item location can identify an equipment candidate; upgrade and character eligibility remain UNKNOWN without validated comparative evidence |
| Craft completion | Snapshot diffs and explicit project reconciliation | Inventory/equipment/skill changes remain observations | A quantity or skill change alone never identifies a craft; user approval remains required |

`get_character_profession_recipes` returns bounded exact captured rows. `review_forever_recipe_materials` joins one exact recipe with only the same character's current Forever carried inventory and equipment observation. Alternative reagents remain alternatives; currencies and incomplete bag quantities remain UNKNOWN. Equipment output is reported as a candidate, not a verified upgrade. Existing ERP `RECIPE` requirements can use an explicit current learned-state observation, but need coverage does not prove profession skill, reagent availability, or craftability. Project writes continue through the existing immutable proposal, exact revision, Dashboard approval, and commit workflow. No project is changed by these read tools.

## Validation status

Automated fixtures cover parser validation, saved-variable forwarding, Forever version isolation, learned states, output/reagent rows, ERP evidence, and MCP readback. Synthetic data does not establish live game API behavior. Live acceptance requires the real Windows Forever client and connected DEV MCP; no Rordin project change or craft is implied by deployment.
