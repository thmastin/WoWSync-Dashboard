import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { answerForeverCopilot } from "../src/foreverCopilot.ts";
import { ForeverKnowledgeIndex, type ForeverKnowledgeBundle } from "../src/foreverKnowledgeBundle.ts";
import { ForeverPriceIndex, foreverMarketFor, foreverPriceTargets, rulesetOfRealm, type ForeverPriceBundle } from "../src/foreverPrices.ts";
import { validateForeverPriceBundle } from "../src/foreverPriceStore.ts";

// Real AHledger values for forever.pvp.alliance.us: price table as of 2026-10-13 12:50 UTC (Copper Ore latest 3s 99c,
// 7-day 1s 61c; Copper Bar latest 7s 90c, 7-day 1s 81c) and earlier tooltip rows for the rest.
const FIXTURE_DIR = new URL("./fixtures/forever/", import.meta.url);
const PRICES = JSON.parse(readFileSync(new URL("prices-fixture.json", FIXTURE_DIR), "utf8")) as ForeverPriceBundle;
const KNOWLEDGE = new ForeverKnowledgeIndex(JSON.parse(readFileSync(new URL("knowledge-fixture.json", FIXTURE_DIR), "utf8")) as ForeverKnowledgeBundle);
const NOW_MS = Date.parse("2026-10-13T12:00:00Z");
const GOLD = "Look at my Forever stable and tell me how I can make gold using my actual characters, professions, and resources.";

function stable(names: string[]) {
  const store = new SqliteSnapshotStore(":memory:");
  for (const name of names) { const { text, ...extras } = JSON.parse(readFileSync(new URL(`copilot-${name}.import.json`, FIXTURE_DIR), "utf8")); store.importSnapshot(text, extras); }
  return { store, read: new DashboardReadModel(store, () => NOW_MS / 1000) };
}

test("Markets come from realm ruleset and faction; unknown stays unknown", () => {
  assert.equal(rulesetOfRealm("Classic Beta PvP 2"), "pvp");
  assert.equal(rulesetOfRealm("Classic Beta PvE"), "normal");
  assert.equal(rulesetOfRealm("Mystery Realm"), undefined);
  assert.equal(foreverMarketFor("Classic Beta PvP 2", "Alliance"), "forever.pvp.alliance.us");
  assert.equal(foreverMarketFor("Classic Beta PvE", "Horde", "eu"), "forever.normal.horde.eu");
  assert.equal(foreverMarketFor("Classic Beta PvE", undefined), undefined, "unknown faction has no market");
  const targets = foreverPriceTargets([{ realm: "Classic Beta PvP 2", faction: "Alliance" }, { realm: "Mystery Realm", faction: "Horde" }], [2770], [{ reagents: [{ itemId: 2770 }], createsItemId: 2840 }]);
  assert.deepEqual(targets, { markets: ["forever.pvp.alliance.us"], items: [2770, 2840], unmapped: ["Mystery Realm (ruleset unknown)"] });
});

test("Prices are fresh for 72 hours and then stale; the bundle validator rejects odd markets and values", () => {
  const fresh = new ForeverPriceIndex(PRICES, () => NOW_MS);
  const copper = fresh.lookup("forever.pvp.alliance.us", 2770)!;
  assert.equal(copper.unit, 161, "margins use the 7-day median, not one volatile scan");
  assert.equal(copper.fresh, true);
  assert.equal(new ForeverPriceIndex(PRICES, () => NOW_MS + 80 * 3_600_000).lookup("forever.pvp.alliance.us", 2770)!.fresh, false);
  assert.equal(fresh.lookup("forever.normal.horde.us", 2770), undefined);
  assert.throws(() => validateForeverPriceBundle({ ...PRICES, markets: { "retail.normal.neutral.us": { prices: {} } } }), /Unexpected market/);
  assert.throws(() => validateForeverPriceBundle({ ...PRICES, markets: { "forever.pvp.alliance.us": { prices: { "1": { median: -5 } } } } }), /Invalid median/);
});

test("Stable gold uses AHledger medians as EXTERNAL evidence with attribution, keeps vendor floors, and says what is not deducted", () => {
  const { store, read } = stable(["rordin", "hallo-pvp2", "fizzwick"]);
  try {
    const prices = new ForeverPriceIndex(PRICES, () => NOW_MS);
    const answer = answerForeverCopilot(read, { version: "forever", question: GOLD, limit: 20 }, KNOWLEDGE, prices);
    const smelt = answer.recommendations.find((rec) => rec.id === "convert-2657")!;
    assert.ok(smelt, "copper smelting is still recommended");
    const market = smelt.evidence.filter((line) => line.kind === "EXTERNAL" && /forever\.pvp\.alliance\.us/.test(line.statement));
    assert.ok(market.some((line) => /Copper Ore.*7-day median 1s 61c.*latest scan median 3s 99c/.test(line.statement)), market.map((line) => line.statement).join(" | "));
    assert.ok(market.every((line) => /ahledger\.com/.test(line.source)), "every price credits AHledger");
    assert.ok(smelt.evidence.some((line) => line.kind === "DERIVED" && /At market values \(7-day median where known\)/.test(line.statement) && /not deducted/.test(line.statement)));
    assert.match(smelt.why, /On the Auction House the Copper Bar is worth .* more than the raw Copper Ore/);
    assert.ok(smelt.evidence.some((line) => /vendor/.test(line.statement)), "vendor floor kept");
    assert.ok(answer.challenges.some((text) => /AHledger \(https:\/\/ahledger\.com\) for forever\.pvp\.alliance\.us/.test(text)));
    assert.ok(!answer.challenges.some((text) => /Market prices are not available/.test(text)));
  } finally { store.close(); }
});

test("Without a price bundle the gold answer still says prices are UNKNOWN", () => {
  const { store, read } = stable(["rordin", "hallo-pvp2"]);
  try {
    const answer = answerForeverCopilot(read, { version: "forever", question: GOLD, limit: 20 }, KNOWLEDGE);
    assert.ok(answer.challenges.some((text) => /Market prices are not available/.test(text)));
    assert.ok(answer.recommendations.flatMap((rec) => rec.evidence).every((line) => !/ahledger/i.test(line.source)));
  } finally { store.close(); }
});
