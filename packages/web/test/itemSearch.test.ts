import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ITEM_SEARCH_RESULT_CAP,
  filterItemRows,
  flattenInventoryRows,
  searchItemRows,
} from "../src/itemSearch.ts";
import type { CharacterFacts, InventoryFacts } from "../src/types.ts";

function char(partial: Partial<CharacterFacts> & Pick<CharacterFacts, "identityKey" | "name" | "realm">): CharacterFacts {
  return {
    snapshotCount: 1,
    freshness: "recent",
    bankStatus: "OBSERVED",
    professionsObservationStatus: "OBSERVED",
    bagsStatus: "OBSERVED",
    ...partial,
  };
}

const inventory: InventoryFacts = {
  items: [
    {
      itemKey: "10940",
      name: "Strange Dust",
      totalKnownQty: 12,
      locations: [
        { identityKey: "a|r", name: "Alice", storage: "bags", qty: 5 },
        { identityKey: "b|r", name: "Bob", storage: "bank", qty: 7 },
      ],
    },
    {
      itemKey: "1",
      name: "Copper Ore",
      totalKnownQty: 20,
      locations: [{ identityKey: "a|r", name: "Alice", storage: "bags", qty: 20 }],
    },
  ],
  unknownBank: [{ identityKey: "c|r", name: "Carol" }],
  unknownBags: [],
  hasUnknownStorage: true,
};

const characters: CharacterFacts[] = [
  char({ identityKey: "a|r", name: "Alice", realm: "Silvermoon", lastObservedAt: 1_700_000_000, bagsStatus: "OBSERVED" }),
  char({
    identityKey: "b|r",
    name: "Bob",
    realm: "Area 52",
    lastObservedAt: 1_700_100_000,
    bankObservedAt: 1_700_050_000,
    bankStatus: "LAST_SEEN",
  }),
];

describe("itemSearch", () => {
  it("flattens locations with realm and storage-specific age", () => {
    const rows = flattenInventoryRows(inventory, characters);
    assert.equal(rows.length, 3);
    const dustBank = rows.find((r) => r.itemName === "Strange Dust" && r.storage === "bank");
    assert.ok(dustBank);
    assert.equal(dustBank.realm, "Area 52");
    assert.equal(dustBank.observedAt, 1_700_050_000);
    assert.equal(dustBank.storageState, "LAST_SEEN");
  });

  it("filters by name substring case-insensitively", () => {
    const rows = filterItemRows(flattenInventoryRows(inventory, characters), "strange");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.itemName === "Strange Dust"));
  });

  it("empty query yields no rows (type-to-search)", () => {
    const result = searchItemRows(inventory, characters, "   ");
    assert.equal(result.totalMatches, 0);
    assert.deepEqual(result.rows, []);
  });

  it("caps results and reports hidden count", () => {
    const big: InventoryFacts = {
      items: Array.from({ length: ITEM_SEARCH_RESULT_CAP + 5 }, (_, i) => ({
        itemKey: String(i),
        name: `Widget ${i}`,
        totalKnownQty: 1,
        locations: [{ identityKey: "a|r", name: "Alice", storage: "bags" as const, qty: 1 }],
      })),
      unknownBank: [],
      unknownBags: [],
      hasUnknownStorage: false,
    };
    const result = searchItemRows(big, characters, "widget");
    assert.equal(result.totalMatches, ITEM_SEARCH_RESULT_CAP + 5);
    assert.equal(result.rows.length, ITEM_SEARCH_RESULT_CAP);
    assert.equal(result.truncated, true);
    assert.equal(result.hiddenCount, 5);
  });

  it("does not invent rows for unknown-bank characters", () => {
    const rows = flattenInventoryRows(inventory, characters);
    assert.ok(!rows.some((r) => r.identityKey === "c|r"));
  });
});
