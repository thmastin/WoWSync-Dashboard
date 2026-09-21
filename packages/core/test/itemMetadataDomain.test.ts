// The pure item-metadata domain: facet resolution, strict item-id extraction, order-independent provenance merging, and
// the Dashboard-owned expansion labels - evidence-backed, scoped to a game version, and explicit about what is unknown.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPANSION_LABELS,
  buildItemMetadataView,
  buildItemMetadataViews,
  describeExpansion,
  itemIdFromItemRef,
  knownFacets,
  mergeEvidence,
  unknownItemMetadata,
  type FacetState,
  type ItemFacetEvidence,
  type ItemFacetName,
} from "../src/itemMetadata.ts";
import type { WowVersion } from "../src/types.ts";

const known = (value: number): FacetState<number> => ({ state: "KNOWN", value, sources: ["game-client"] });
const ev = (baseItemId: number, facet: ItemFacetName, value: number, gameVersion: WowVersion = "retail", clientBuilds = ["69875"]): ItemFacetEvidence => ({
  gameVersion,
  baseItemId,
  facet,
  source: "game-client",
  value,
  firstSeenAt: 1,
  lastSeenAt: 1,
  clientBuilds,
});

// The five values captured directly from the live Retail (Midnight) client by GearExport a94288e.
const LIVE_RETAIL_SAMPLES: Array<[string, number, number, string]> = [
  ["Mote of Harmony", 89112, 4, "Mists of Pandaria"],
  ["Progenitor Essentia", 187707, 8, "Shadowlands"],
  ["Elemental Mote", 202071, 9, "Dragonflight"],
  ["Bismuth", 210931, 10, "The War Within"],
  ["Mote of Light", 236949, 11, "Midnight"],
];

test("every live Retail sample resolves to its verified expansion label", () => {
  for (const [name, , raw, label] of LIVE_RETAIL_SAMPLES) {
    const info = describeExpansion("retail", known(raw));
    assert.deepEqual(info, { state: "KNOWN", rawValue: raw, label, text: label }, name);
  }
});

test("only the live-verified Retail values are mapped: the table is not extrapolated from a sequence", () => {
  assert.deepEqual(Object.keys(EXPANSION_LABELS.retail!).map(Number).sort((a, b) => a - b), [4, 8, 9, 10, 11]);
  for (const [, , raw] of LIVE_RETAIL_SAMPLES) assert.ok(EXPANSION_LABELS.retail![raw].evidence.length > 20, "every entry documents its evidence");
  // Neighbours of verified values (which a sequence would 'imply') are NOT labelled.
  for (const raw of [1, 2, 3, 5, 6, 7, 12, 13]) {
    assert.deepEqual(describeExpansion("retail", known(raw)), { state: "UNMAPPED", rawValue: raw, text: `Expansion unknown (client value ${raw})` }, `client value ${raw}`);
  }
});

test("0 and 254 are never labelled Classic (or anything): they render as an unknown client value, like any unsupported number", () => {
  for (const raw of [0, 254]) {
    for (const version of ["retail", "classic-era", "tbc-anniversary", "forever"] as const) {
      const info = describeExpansion(version, known(raw));
      assert.equal(info.state, "UNMAPPED");
      assert.equal(info.text, `Expansion unknown (client value ${raw})`);
      assert.doesNotMatch(info.text, /classic|vanilla|burning|wrath/i);
    }
  }
});

test("Retail evidence is product-scoped: Classic Era, TBC Anniversary and Forever have no expansion labels at all", () => {
  for (const version of ["classic-era", "tbc-anniversary", "forever"] as const) {
    assert.equal(EXPANSION_LABELS[version], undefined, `${version} has no table`);
    for (const [, , raw] of LIVE_RETAIL_SAMPLES) {
      assert.equal(describeExpansion(version, known(raw)).state, "UNMAPPED", `${version} value ${raw}`);
    }
  }
});

test("an unreported expansion is UNKNOWN, and a conflicting one is not labelled", () => {
  assert.deepEqual(describeExpansion("retail", { state: "UNKNOWN" }), { state: "UNKNOWN", text: "Expansion unknown" });
  const conflict = describeExpansion("retail", { state: "CONFLICT", values: [{ value: 9, sources: ["game-client"], clientBuilds: [] }, { value: 11, sources: ["game-client"], clientBuilds: [] }] });
  assert.deepEqual(conflict, { state: "CONFLICT", rawValues: [9, 11], text: "Expansion unknown (conflicting client values 9, 11)" });
  assert.doesNotMatch(conflict.text, /Dragonflight|Midnight/);
});

test("an item nothing is known about has every facet UNKNOWN (not 0, false or empty)", () => {
  const v = unknownItemMetadata("retail", 12345);
  for (const facet of [v.classId, v.subclassId, v.bindType, v.expansionId, v.craftingReagent]) assert.deepEqual(facet, { state: "UNKNOWN" });
  assert.equal(v.expansion.state, "UNKNOWN");
});

test("a known 0 / false is KNOWN, not UNKNOWN", () => {
  const v = buildItemMetadataView("retail", 202071, [ev(202071, "bindType", 0), ev(202071, "isCraftingReagent", 0), ev(202071, "subclassID", 0)]);
  assert.deepEqual(v.bindType, known(0));
  assert.deepEqual(v.subclassId, known(0));
  assert.deepEqual(v.craftingReagent, { state: "KNOWN", value: false, sources: ["game-client"] });
});

test("a corrupt stored reagent value fails loudly rather than being read as a boolean", () => {
  assert.throws(() => buildItemMetadataView("retail", 1, [ev(1, "isCraftingReagent", 2)]), /Corrupt item metadata/);
});

test("two different KNOWN values are a CONFLICT (ascending, with builds); the same value from two builds is KNOWN once", () => {
  const conflict = buildItemMetadataView("retail", 60224, [ev(60224, "expansionID", 3, "retail", ["70000"]), ev(60224, "expansionID", 0, "retail", ["69875"])]);
  assert.deepEqual(conflict.expansionId, {
    state: "CONFLICT",
    values: [
      { value: 0, sources: ["game-client"], clientBuilds: ["69875"] },
      { value: 3, sources: ["game-client"], clientBuilds: ["70000"] },
    ],
  });
  assert.equal(conflict.expansion.state, "CONFLICT");
  const agree = buildItemMetadataView("retail", 5, [ev(5, "classID", 7, "retail", ["1"]), ev(5, "classID", 7, "retail", ["2"])]);
  assert.deepEqual(agree.classId, known(7));
});

test("views are per game version and per item: evidence for another version is never used, and items are ordered", () => {
  const evidence = [ev(9, "classID", 1), ev(3, "classID", 2), ev(3, "classID", 5, "classic-era")];
  assert.deepEqual(buildItemMetadataViews("retail", evidence).map((v) => v.baseItemId), [3, 9]);
  assert.deepEqual(buildItemMetadataViews("retail", evidence)[0].classId, known(2));
  assert.deepEqual(buildItemMetadataViews("classic-era", evidence).map((v) => v.classId), [known(5)]);
  assert.deepEqual(buildItemMetadataViews("forever", evidence), []);
});

test("knownFacets flattens only KNOWN facets, in item then contract order, with reagent as 1 / 0", () => {
  assert.deepEqual(
    knownFacets([
      { baseItemId: 20, classId: 7, isCraftingReagent: false },
      { baseItemId: 10, bindType: 0, expansionId: 11, isCraftingReagent: true },
      { baseItemId: 30 },
    ]),
    [
      { baseItemId: 10, facet: "bindType", value: 0 },
      { baseItemId: 10, facet: "expansionID", value: 11 },
      { baseItemId: 10, facet: "isCraftingReagent", value: 1 },
      { baseItemId: 20, facet: "classID", value: 7 },
      { baseItemId: 20, facet: "isCraftingReagent", value: 0 },
    ],
  );
});

test("mergeEvidence is idempotent, commutative and keeps only distinct sorted builds", () => {
  const a = mergeEvidence(undefined, 100, "69875");
  assert.deepEqual(a, { firstSeenAt: 100, lastSeenAt: 100, clientBuilds: ["69875"] });
  assert.deepEqual(mergeEvidence(a, 100, "69875"), a, "replay changes nothing");
  const viaLaterFirst = mergeEvidence(mergeEvidence(undefined, 300, "70000"), 100, "69875");
  const viaEarlierFirst = mergeEvidence(mergeEvidence(undefined, 100, "69875"), 300, "70000");
  assert.deepEqual(viaLaterFirst, viaEarlierFirst);
  assert.deepEqual(viaLaterFirst, { firstSeenAt: 100, lastSeenAt: 300, clientBuilds: ["69875", "70000"] });
  assert.deepEqual(mergeEvidence(a, 200, undefined), { firstSeenAt: 100, lastSeenAt: 200, clientBuilds: ["69875"] }, "an export naming no build adds none");
});

test("itemIdFromItemRef reads a real base id only, ignoring the embedded level and variant fields", () => {
  assert.equal(itemIdFromItemRef("item:236949::::::::85:253:::::::::"), 236949);
  assert.equal(itemIdFromItemRef("item:236949::::::::86:253:::::::::"), 236949);
  assert.equal(itemIdFromItemRef("item:6948"), 6948);
  for (const bad of [undefined, "", "?", "EMPTY", "item:", "item:abc", "item:0", "item:-5", "battlepet:123", "  item:5", "Mote of Light", "item:9007199254740993"]) {
    assert.equal(itemIdFromItemRef(bad), undefined, String(bad));
  }
});
