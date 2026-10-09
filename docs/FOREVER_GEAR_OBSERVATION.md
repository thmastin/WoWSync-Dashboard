# Forever gear allocation evidence path

Forever 1.60.1 build 70291 / interface 16001 has a version-scoped evidence path through the existing Dashboard core. Its current live-validated inputs are the matching WoWSyncDB identity/GUID, equipment, carried bags, and exact-item GetItemInfoInstant/IsEquippableItem samples. Equipment, bags, item evidence, bank coverage, timestamps, and freshness remain separate. Structured WoWSyncDB records are accepted only when the client profile, character identity, GUID history, and export timestamp agree.

## Observation and item facts

`get_forever_gear_observation` and `GET /api/characters/:identityKey/forever-gear-observation` expose exact observed equipment and carried itemStrings. A carried row is located with the exporting character (character ownership scope), with its exact bag/container slot and stack count when observed. The WoW bag `isBound` facet is exposed separately as observed true/false or UNKNOWN. That facet alone never proves transferability. Missing bank capture stays UNKNOWN, not empty. Character and account identity are distinct: the existing character identity key has no WoW account ID.

Candidate classification is derived only from exact itemString-matched Forever item APIs. A `POTENTIAL_EQUIPMENT` label does not establish character eligibility, build suitability, or upgrade value. Never use Retail rules. The current Hallo live capture validated one Mining Pick candidate (item 2901) and its Forever type/equip-location facts. It did not validate any eligibility, effective stats, upgrade, or transfer conclusion.

The GearExport development candidate adds raw `C_Item.GetItemInfo` return tuples and bounded `C_Item.GetItemStats` tables for exact observed variants. Dashboard carries these results through candidate evidence but marks semantic interpretation UNKNOWN. This new data is NOT YET LIVE-VALIDATED on build 70291; no requirement, stat, or binding meaning is inferred from it. A reviewed package deployment and same-refresh capture are required before mapping these fields into deterministic rules.

## Cross-character assessment

`get_forever_gear_allocation` and `GET /api/characters/:identityKey/forever-gear-allocation` are a read-only decision-support view over the Forever Dashboard import context. AccountContext embeds the same core result under each Forever character in AccountContext schema 6. The selected recipient includes its latest observed class, level, equipment, and freshness. Potential item sources preserve their source character, carried/bank completeness and timestamps, exact item variants, carried locations, and binding facets. Carried location is not promoted into an ownership claim; ownership and transferability remain UNKNOWN.

The result keeps eligibility, suitability, upgrade status, transferability, and allocation priority independent. If Forever-specific evidence is missing, each stays UNKNOWN and the decision is `NO_RECOMMENDATION`, with concrete missing-evidence reasons. Characters in one Dashboard import context are not asserted to share a Battle.net account. Presence in another character's inventory is not access or transferability. Unobserved bank rows are not enumerated, treated as empty, or ranked. No opaque score or transfer action is generated.

## Identity and version safety

The source character GUID is checked across imported snapshots. Missing or conflicting GUID history withholds source observations. The model is hard-gated to Forever 1.60.1 build 70291 / interface 16001; other versions do not enter this evaluator. Retail gear-allocation logic is not called.

## Live-validation boundary

Automated fixtures validate candidate-source resolution, freshness, binding/location provenance, UNKNOWN handling, AccountContext/REST consistency, and MCP contracts. They do not prove the new 70291 GetItemInfo/GetItemStats API shapes or tooltip agreement. That requires one deployment checkpoint and live capture. Eligibility, active build suitability, upgrade comparison, transfer routes, and allocation ranking require their own version-accurate evidence and remain unsupported until validated.
