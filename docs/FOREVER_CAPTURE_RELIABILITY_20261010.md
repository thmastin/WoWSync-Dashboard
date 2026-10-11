# Forever capture reliability and presentation checkpoint — 2026-10-10

## Scope

This implementation extends the existing Forever observation/read-model pipeline for the explicit Forever 1.60.1 build profiles 70291 and 70338, interface 16001. It does not alter Retail, TBC Anniversary, Classic Era, Hardcore, the production Dashboard, the live database, SavedVariables, or the in-game installation. The API declarations were compared with the version-matched Gethe UI-source Forever branch for build 70338; matching declarations between 70291 and 70338 are compatibility evidence, not proof of post-change live behavior.

## Player-visible changes

- Race flows from WOWSYNC v1 text into the character model, REST/AccountContext and roster/detail UI when present. Missing legacy race remains absent.
- Known Forever equipment IDs render as Head, Neck, Shoulder, Shirt, Chest, Waist, Legs, Feet, Wrist, Hands, Finger 1/2, Trinket 1/2, Back, Main Hand, Off Hand, Ranged, and Tabard. Numeric slot IDs remain authoritative in storage and API models. Labels are presentation only and version-isolated.
- The equipment page states physically empty slots separately from missing upgrades. Shirt and Tabard are labeled optional/cosmetic; applicability for other empty slots remains UNKNOWN. No empty slot is counted as an equipment deficiency.
- Structured equipment, bags, and character-bank item names have OBSERVED/UNKNOWN name resolution and source labeling. An unresolved item renders as “Item name unresolved (item ID N)” instead of an item-level placeholder being mistaken for a real name. Exact item references/variants are retained where captured.
- Build 70338 structured evidence can be imported and viewed. Item API returns remain raw/UNKNOWN for eligibility and candidate semantics until the build-specific contract is live-validated; the 70291 contract gate remains distinct.
- Bank container items preserve itemString, item ID, quantity, name when observed, and observed-versus-unknown bank state. Trainer raw evidence is retained even if no item facts exist. No trainer tuple is interpreted as learnability.

## Coverage and provenance

| Field or section | End-to-end path after this change | Status and boundary |
|---|---|---|
| Character first/surname, realm, class, level | Existing parser/store/REST/AccountContext/UI | Surname remains display metadata, not identity. Legacy surname/race absence remains absent. |
| Race | Forever v1 `Race:` parse -> facts/context -> roster/detail | Captured by add-on for supported profiles; Dashboard preservation implemented. New build-specific capture awaits live verification. |
| Faction, money, XP/current max XP | WOWSYNC character section -> parser/store/read models | Collector fixes are in GearExport; Dashboard’s shared parser already preserves supported v1 fields. No fields default to 0. |
| Total/level `/played` | Async `TIME_PLAYED_MSG` -> character section -> v1 | Correctly timestamped only when response exists for current GUID. Live behavior after this change unverified. |
| Zone/subzone | Location section -> parser/snapshot history | GearExport location collector restored to the version-scoped set; Dashboard path existed. No value means UNKNOWN. |
| Equipment slot/name | Numeric slot and optional slot label -> Forever canonical presentation map -> UI and observation views | All 19 labels tested; other versions retain their existing labels. No equipability inferred. |
| Item ID/link/name | Text item reference + structured observation -> item identity/name provenance -> UI/REST/AccountContext/MCP | Preserves ID and exact variant when present. Name is UNKNOWN without client evidence. ID-only name lookups have no fabricated variant. |
| Item-level/stats/durability/enchantments | Existing raw collector/structured observation | Raw fields can be partial. No stat or empty-slot conclusion becomes an upgrade or recommendation. |
| Durability/enchantments | No complete authoritative Forever fields added | Not captured as current facts; UNKNOWN. |
| Bags/free slots | Existing v1 inventory + Forever structured sections | Section completeness/freshness retained; names may be UNKNOWN on client cache miss. |
| Bank | Open-visit bank section + structured container rows -> observation view | Known scanned rows and known empty scan stay distinct from closed/unobserved bank. No SavedVariables “empty bank” is synthesized. |
| Professions and skills | Added GetProfessions/GetProfessionInfo observations plus existing parser | Learned profession name/rank/max may be captured; observed absence only applies to a complete section. Live 70338 verification pending. |
| Spellbook/profession abilities | Added indices from GetProfessions to C_SpellBook traversal | Visible IDs/names retained where returned; ranks, trainer learnability, and complete recipe catalog remain unsupported/UNKNOWN. |
| Known recipes/smelting | No verified recipe enumeration or conversion collector enabled | UNKNOWN. Spellbook observations do not establish learned recipe coverage, ore-to-bar ratio, skill requirement, or craftability. |
| Hearthstone/home location | No verified source field in the active collector | Not collected; UNKNOWN, with no inference from item ownership or a prior inn visit. |
| Trainer services/requirements | Raw evidence section preserved through importer/read model display | Service tuple semantics intentionally not interpreted; profession trainer frame capture must be live-verified. |
| REST, AccountContext, MCP | Existing shared character and Forever observation projections | Same core observation is reused. Existing parity suites pass; no parallel identity model or DB migration was added. |

## Item IDs 4237, 4239, 4362

The collector had the item ID/current item level but requested `GetItemInfo` only when an item link was already available. The unresolved display came from an absent source name and the UI’s fallback, not name loss in SQLite. GearExport now tries the exact link or known base ID; it requests asynchronous cache loading once for missing names and recollects on item-data events. Dashboard preserves the raw ID/link and name provenance and displays an explicit unresolved label when there is no observed name. The existing real exports do not establish that all three names will hydrate on build 70338; a post-deployment capture is required to verify that.

## Empty-slot contract

Physical emptiness is an observation. It does not imply character need, item eligibility, or an upgrade opportunity. Shirt/Tabard are presented optional/cosmetic. Applicability of other Forever equipment slots is UNKNOWN because this project has no validated class/level/item-specific slot-applicability evidence sufficient to count them as deficiencies. Two-hand conflicts remain an evaluation concern, not an empty-slot count.

## Validation

`npm.cmd run validate:erp` passed on this implementation tree: core 862, MCP 9, server 272 (2 platform-specific Windows skips), web 316, TypeScript, production build, and browser acceptance 23/23. Browser acceptance is synthetic. The GearExport Lua fixture suite passed 477 Forever assertions, 1,682 Retail assertions, 220 general assertions, package/release guards, 35 Lua-file syntax parses, 32 deployment fixtures, and the no-gameplay-action scan. The Forever package manifest was built and every one of its 32 file hashes matched. No game client capture was made after the collector changes; none of these automated results establish build 70338 runtime behavior.

## Review and next evidence

No independent subagent review was available for this pass; the implementer performed a focused self-review of profile gates, unknown/stale handling, exact item references, optional/inapplicable slots, bank access and item-name fallbacks. Review also caught and fixed fixture/type coverage issues before the final successful test run. Next, after separate authorization to deploy these exact commits, perform one consolidated capture on Forever 70338: base `/reload`, `/wowsync`, `/reload` on Rordin and Hallo; include one character-bank open/scan/close and a profession trainer window open/scan only if safe and convenient, with no purchases or learning. Check basic fields, IDs 4237/4239/4362, exact links, delayed names, profession/spell rows, bank section freshness and raw trainer tuples. Do not claim trainer learnability or recipe facts from raw tuples.
