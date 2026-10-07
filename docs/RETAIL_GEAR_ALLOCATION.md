# Retail gear allocation (first deterministic release)

This capability consumes only Retail `[GEAR CANDIDATES]` rows and canonical Retail equipment observations. It is a read-only derived model: no demand, transfer, physical item identity, disposition, or inventory mutation is created.

## Invoke it

From the Dashboard MCP surface, call `get_gear_candidate_evidence` with `version: "retail"`. Select an evidence row using its exporter `identity.identityKey`, `snapshot.snapshotId`, and one-based `rowOrdinal`, then call `analyze_retail_gear_candidate` with those three references. The response includes the candidate validity, per-character/spec checks, evidence-backed exclusions, retained equipment tuple/snapshot, comparison slots, item-level delta, ranking/tie/UNKNOWN outcome, and limitations. These references identify a row in a snapshot only; they are not persistent physical-item identities.

In the Dashboard's Ask My Account dialog, optionally select a Retail candidate before asking a question. The server resolves that snapshot row through the same deterministic read model and includes the structured result with the account context. The model may explain the result but cannot redo eligibility, retention, comparison, or ranking. The standalone MCP result remains available for direct structured consumers.

## Evidence and retention

An equipment row qualifies only when the stored canonical observation is Retail, its envelope completeness is `complete`, its `specEquipmentObservation` sidecar is present, link tuple fields exactly match the canonical observation tuple, readiness is `READY`, stability is `STABLE`, and numeric `activeSpecBefore.specID` equals numeric `activeSpecAfter.specID`. Equipment selection is per character/spec, ordered by `observedAt DESC, capture DESC, revision DESC` among qualifying rows. Age never expires a qualifying row. An observation for another spec or a newer nonqualifying row does not erase it. A spec with no qualifying row stays `UNKNOWN`.

Responses separate `currentSnapshotObservation` (an observation linked to the character's latest overall snapshot, if the append-only journal has that link), `latestStoredObservation` (most recent equipment tuple), and `retained` (latest qualifying row for the requested spec). A missing current-snapshot link is `UNKNOWN`, even when retained per-spec evidence exists. Each known row includes its originating snapshot ID and tuple; retained historical equipment is never described as observed in the current snapshot. Snapshot freshness is not a retention validity rule.

## Decision limits in this release

The ruleset `retail-midnight-12.1.5-conservative-v1` is explicitly Retail-scoped. It includes the current Retail class/spec/role identity table and conservative class-native armor-family plausibility checks. A native-family mismatch is not treated as proof that the game client prevents equipping lower armor families. Unknown classes/specs and non-OBSERVED class/level sections do not become eligible recipients. Dashboard identities are installation-local; the tool cannot prove that every character is on the same Battle.net account.

For ordinary single slots, rings, and trinkets, a known candidate item level is compared with the lowest known item level among the applicable interchangeable equipped slots. An explicitly observed empty slot is reported as a fill, never encoded as item level zero. Equal item level is a sidegrade by item level; lower item level is a downgrade by item level. Missing slot/item-level evidence yields `UNKNOWN`. Supported item-level upgrades rank by descending delta, then stable character/spec identity; ties are reported only at the highest delta. Empty-slot fills have no known magnitude: multiple fills are reported as ambiguous, and a result containing both fills and item-level upgrades is also ambiguous. This is an item-level comparison, not a stat simulation or a claim of full equipability: candidate evidence has no item stat lines or complete item-specific restrictions. It cannot prove primary-stat match, unique/equip compatibility, or transferability. Binding evidence is never used to claim transferability.

Weapon subclass proficiency, spec-specific weapon suitability, dual-wield, main/off-hand, two-hand, shield pairing, and whole-set weapon interactions remain `UNKNOWN`. The tool does not infer upgrade from a weapon's higher item level. Any unknown recipient/spec that could affect account-wide ranking makes the overall recommendation `UNKNOWN`; equal best supported deltas are reported as a tie. `NO_SUPPORTED_UPGRADE` is not a sell/surplus decision.

The current candidate contract also cannot prove every item restriction, transferability, or that a Dashboard-known character belongs to the user's intended account. Missing candidate evidence is not an empty inventory. `OBSERVED`, `UNKNOWN`, `LAST_SEEN`, and `DERIVED` remain distinct.

## Version boundary and next work

This module and ruleset are Retail-only. The next Forever parity work should add a separate rules/evidence implementation for Forever class eligibility, trained weapon type, weapon skill/readiness, training cost/location, spec suitability, and upgrade magnitude. It should reuse only actual shared transport or presentation needs, not Retail proficiency or item assumptions. Forever is not implemented here.

## Source basis

Class/spec identity and broad class gear descriptions are derived from Blizzard's current Retail class pages. Blizzard's Midnight release material confirms Devourer as an active third Demon Hunter specialization and identifies its glaive-wielding role; see [Blizzard Midnight pre-expansion update](https://worldofwarcraft.blizzard.com/en-us/news/24245217), [Warrior class page](https://worldofwarcraft.blizzard.com/en-us/game/classes/warrior), and [12.1.5 update notes](https://worldofwarcraft.blizzard.com/en-us/news/24304162). Those pages are explanatory sources, not a complete machine-readable CanEquip or item-stat schema; unsupported details therefore remain `UNKNOWN`.
