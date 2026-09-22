import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNeedsAttention, classifyAgeBand, groupNeedsAttentionByAgeBand, LOW_BAG_FREE_SLOTS, type AttentionCharacter } from "../src/needsAttention.ts";

const NOW = 1_700_000_000;
const day = 86400;

function char(over: Partial<AttentionCharacter> & Pick<AttentionCharacter, "identityKey" | "name">): AttentionCharacter {
  return {
    realm: "Cairne",
    freshness: "recent",
    bankStatus: "OBSERVED",
    lastObservedAt: NOW - 3600,
    ...over,
  };
}

test("recent, complete characters are omitted", () => {
  const rows = buildNeedsAttention(
    [char({ identityKey: "a", name: "Virek", bankStatus: "OBSERVED", bagsStatus: "OBSERVED", bagsFreeSlots: 20, bagsTotalSlots: 80, professionsObservationStatus: "OBSERVED" })],
    NOW,
  );
  assert.deepEqual(rows, []);
});

test("stale sync is listed oldest-first with a lastObservedAt reason", () => {
  const rows = buildNeedsAttention(
    [
      char({ identityKey: "new", name: "Newer", freshness: "stale", lastObservedAt: NOW - 4 * day }),
      char({ identityKey: "old", name: "Older", freshness: "stale", lastObservedAt: NOW - 12 * day }),
      char({ identityKey: "ok", name: "Fresh", freshness: "recent", lastObservedAt: NOW - 3600 }),
    ],
    NOW,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Older");
  assert.equal(rows[0].reasons[0].text, "synced 12d ago");
  assert.equal(rows[0].reasons[0].field, "lastObservedAt");
  assert.equal(rows[1].name, "Newer");
});

test("never-synced sorts before stale and cites lastObservedAt", () => {
  const rows = buildNeedsAttention(
    [
      char({ identityKey: "stale", name: "Stale", freshness: "stale", lastObservedAt: NOW - 5 * day }),
      char({ identityKey: "ghost", name: "Ghost", freshness: "unknown", lastObservedAt: undefined }),
    ],
    NOW,
  );
  assert.equal(rows[0].name, "Ghost");
  assert.deepEqual(rows[0].reasons[0], { text: "synced never", field: "lastObservedAt" });
});

test("unknown bank and professions are fact reasons without advice", () => {
  const rows = buildNeedsAttention(
    [
      char({
        identityKey: "a",
        name: "Torahn",
        freshness: "recent",
        bankStatus: "UNKNOWN",
        professionsObservationStatus: "UNKNOWN",
      }),
    ],
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].reasons.map((r) => r.text),
    ["bank never observed", "professions never observed"],
  );
  assert.ok(rows[0].reasons.every((r) => !/should|log in|need to/i.test(r.text)));
});

test("stale bank observation is listed when bank was seen before", () => {
  const rows = buildNeedsAttention(
    [char({ identityKey: "a", name: "Virek", bankStatus: "OBSERVED", bankObservedAt: NOW - 9 * day })],
    NOW,
  );
  assert.equal(rows[0].reasons[0].text, "bank last seen 9d ago");
  assert.equal(rows[0].reasons[0].field, "bank.observedAt");
});

test("low free bag slots are listed with counts", () => {
  const rows = buildNeedsAttention(
    [
      char({
        identityKey: "a",
        name: "Virek",
        bagsStatus: "OBSERVED",
        bagsFreeSlots: 2,
        bagsTotalSlots: 38,
      }),
    ],
    NOW,
  );
  assert.equal(rows[0].reasons[0].text, "free bag slots: 2 of 38");
  assert.equal(rows[0].reasons[0].field, "bags.freeSlots");
  assert.ok(2 <= LOW_BAG_FREE_SLOTS);
});

test("unknown bags do not invent free-slot reasons", () => {
  const rows = buildNeedsAttention(
    [char({ identityKey: "a", name: "Virek", bagsStatus: "UNKNOWN", bagsFreeSlots: 0, bagsTotalSlots: 16 })],
    NOW,
  );
  assert.deepEqual(rows, []);
});
test("classifyAgeBand uses fixed 3d / 14d / never boundaries", () => {
  assert.equal(classifyAgeBand(undefined, NOW), "never");
  assert.equal(classifyAgeBand(NOW - 2 * day, NOW), "recent");
  assert.equal(classifyAgeBand(NOW - 3 * day, NOW), "recent");
  assert.equal(classifyAgeBand(NOW - 3 * day - 1, NOW), "aging");
  assert.equal(classifyAgeBand(NOW - 10 * day, NOW), "aging");
  assert.equal(classifyAgeBand(NOW - 14 * day, NOW), "aging");
  assert.equal(classifyAgeBand(NOW - 14 * day - 1, NOW), "old");
});

test("groupNeedsAttentionByAgeBand orders never â†’ old â†’ aging â†’ recent and skips empty", () => {
  const rows = buildNeedsAttention(
    [
      char({ identityKey: "r", name: "RecentBag", freshness: "recent", lastObservedAt: NOW - day, bankStatus: "UNKNOWN" }),
      char({ identityKey: "a", name: "Aging", freshness: "stale", lastObservedAt: NOW - 10 * day }),
      char({ identityKey: "o", name: "Old", freshness: "stale", lastObservedAt: NOW - 20 * day }),
      char({ identityKey: "n", name: "Never", freshness: "unknown", lastObservedAt: undefined }),
    ],
    NOW,
  );
  const groups = groupNeedsAttentionByAgeBand(rows);
  assert.deepEqual(
    groups.map((g) => g.band),
    ["never", "old", "aging", "recent"],
  );
  assert.equal(groups[0].rows[0].name, "Never");
  assert.equal(groups[1].rows[0].name, "Old");
  assert.equal(groups[2].rows[0].name, "Aging");
  assert.equal(groups[3].rows[0].name, "RecentBag");
  assert.ok(rows.every((r) => r.ageBand !== undefined));
});
