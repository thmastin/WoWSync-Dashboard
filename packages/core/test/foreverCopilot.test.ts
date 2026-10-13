import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { answerForeverCopilot, understandObjective, type CopilotAnswer } from "../src/foreverCopilot.ts";
import { foreverItem, foreverQuest, foreverSpell, parseItemTooltip, parseQuestPage, parseSpellTooltip } from "../src/foreverKnowledge.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

// Real fixtures: the exact import payloads (WOWSYNC text + structured sidecars) the SavedVariables
// bridge sent for these Forever 1.60.1/70338 characters on 2026-10-11/12.
const FIXTURE_DIR = new URL("./fixtures/forever/", import.meta.url);
const payload = (name: string) => JSON.parse(readFileSync(new URL(`copilot-${name}.import.json`, FIXTURE_DIR), "utf8")) as { text: string; [key: string]: unknown };
const NOW = 1_791_840_000;
const SCENARIO_A = "I'm playing Rordin. Look at my character, account, and the game. What are the most valuable things I could do to improve this character, including things I haven't considered?";
const SCENARIO_B = "Look at my Forever stable and tell me how I can make gold using the characters, professions, and resources I actually have.";

function importPayload(store: SqliteSnapshotStore, name: string) {
  const { text, ...extras } = payload(name);
  store.importSnapshot(text, extras);
}

function realStable(extra?: (store: SqliteSnapshotStore) => void) {
  const store = new SqliteSnapshotStore(":memory:");
  for (const name of ["rordin", "hallo-pvp2", "fizzwick"]) importPayload(store, name);
  extra?.(store);
  return { store, read: new DashboardReadModel(store, () => NOW) };
}

const otherRealmMiner = (store: SqliteSnapshotStore) => store.importSnapshot(buildWowSyncExport({
  generatedAt: NOW - 600,
  character: { name: "Bramm", realm: "Classic Beta PvE", class: "SHAMAN", race: "Dwarf", faction: "Alliance", level: 11, moneyCopper: 319, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" },
  bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:2770::::::::11:1489:::::::::", name: "Copper Ore", qty: 500 }, { itemRef: "item:2318::::::::11:1489:::::::::", name: "Light Leather", qty: 7 }] }] },
  bank: { unknown: true },
  professions: { entries: [{ name: "Leatherworking", skill: 36, maxSkill: 75 }, { name: "Skinning", skill: 78, maxSkill: 150 }] },
}));

const allEvidence = (answer: CopilotAnswer) => answer.recommendations.flatMap((rec) => rec.evidence);

test("Scenario A (real Rordin data): equipping owned upgrades outranks crafting them, with provenance", () => {
  const { store, read } = realStable();
  try {
    const answer = answerForeverCopilot(read, { version: "forever", question: SCENARIO_A });
    assert.equal(answer.status, "ANSWERED");
    assert.equal(answer.subject?.name, "Rordin");
    assert.ok(answer.objective.objectives.includes("GEAR") && answer.objective.objectives.includes("DEVELOP_PROFESSIONS"), "improve is broader than gear");
    const [first] = answer.recommendations;
    assert.equal(first.category, "EQUIP_OWNED_ITEM");
    assert.equal(first.feasibility, "READY_NOW");
    assert.match(first.title, /Rough Copper Vest/);
    assert.ok(first.evidence.some((line) => line.kind === "OBSERVED" && /holds Rough Copper Vest x1 in bags/.test(line.statement)));
    assert.ok(first.evidence.some((line) => line.kind === "EXTERNAL" && line.source === "https://www.wowhead.com/forever/item=10421"));
    assert.ok(first.evidence.some((line) => line.kind === "DERIVED" && /\+77 Armor/.test(line.statement)));
    assert.ok(answer.recommendations.some((rec) => rec.id === "equip-2853"), "Copper Bracers in bags are found too");
    assert.ok(!answer.recommendations.some((rec) => rec.category === "CRAFT_UPGRADE" && /Copper (Bracers|Vest)/.test(rec.title)), "never recommends crafting an item already owned");
    assert.ok(answer.challenges.some((challenge) => /already carrying 2 better items/.test(challenge)), "challenges the premise");

    const turnIns = answer.recommendations.find((rec) => rec.id === "quest-turn-ins");
    assert.ok(turnIns, "ready quests are recommended");
    assert.match(turnIns!.why, /250 XP/);
    assert.equal(turnIns!.feasibility, "READY_NOW");

    // An active quest's objective items held (last-seen) by a same-realm character become a mail, not a farm.
    const ribs = answer.recommendations.find((rec) => rec.id === "quest-384");
    assert.ok(ribs, "Beer Basted Boar Ribs is promoted because the stable already holds the ribs");
    assert.equal(ribs!.feasibility, "NEEDS_TRANSFER");
    assert.match(ribs!.what, /Hallo already has Crag Boar Rib x7 \(last seen, not confirmed current\)/);
    assert.ok(ribs!.costs.some((line) => /Rhapsody Malt: 50c/.test(line)), "vendor cost comes from the Forever database");
    assert.ok(ribs!.nextActions.includes("Get Rhapsody Malt."));

    // Cross-character opportunities stay player-controlled and never claim to move anything.
    const cloak = answer.recommendations.find((rec) => rec.id === "transfer-4658");
    assert.equal(cloak?.feasibility, "NEEDS_TRANSFER");
    assert.ok(cloak!.nextActions.some((action) => /You run this; WoWSync never moves items/.test(action)));
    assert.match(answer.playerControl, /never plays, buys, sells, mails, or moves items/);
    // Hallo needs her own Mining Pick: it is not treated as a spare.
    const pick = [...answer.recommendations].find((rec) => rec.id === "tool-mining-pick");
    if (pick) assert.doesNotMatch(pick.what, /Send Hallo/);

    // Missing evidence is surfaced, not filled in.
    assert.ok(answer.limitations.some((line) => /Rordin's bank has never been observed/.test(line)));
    assert.ok(answer.limitations.some((line) => /trainer/i.test(line)));
    for (const line of allEvidence(answer)) {
      assert.ok(["OBSERVED", "DERIVED", "LAST_SEEN", "EXTERNAL", "UNKNOWN"].includes(line.kind));
      if (line.kind === "EXTERNAL") assert.match(line.source, /^https:\/\/(www\.wowhead\.com\/forever\/|us\.forums\.blizzard|blizzardwatch|kami-labs|lfcarry|getboost|classicwowforever|www\.mmoexp|www\.zockify|www\.iggm)/);
    }
    assert.ok(answer.markdown.includes("### 1. Equip the Rough Copper Vest"));
  } finally { store.close(); }
});

test("Scenario B (real stable): realm-scoped goldmaking with vendor floors, buckets, and no invented market prices", () => {
  const { store, read } = realStable(otherRealmMiner);
  try {
    const answer = answerForeverCopilot(read, { version: "forever", question: SCENARIO_B });
    assert.equal(answer.status, "ANSWERED");
    assert.equal(answer.subject, undefined);
    assert.ok(answer.objective.objectives.includes("MAKE_GOLD"));
    assert.deepEqual([...answer.scope.realms].sort(), ["Classic Beta PvE", "Classic Beta PvP 2"]);
    assert.ok(answer.challenges.some((line) => /October 21, 2026/.test(line) && /expected to be deleted/.test(line)), "challenges beta goldmaking with the wipe expectation");
    assert.ok(answer.challenges.some((line) => /Auction House value is UNKNOWN/.test(line)));
    for (const rec of answer.recommendations) assert.ok(rec.goldBucket, `${rec.id} has a gold bucket`);

    const smelt = answer.recommendations.find((rec) => rec.id === "convert-2657" && rec.realm === "Classic Beta PvP 2");
    assert.ok(smelt, "converting the stable's ore is found");
    assert.ok(smelt!.evidence.some((line) => line.kind === "LAST_SEEN" && /Copper Ore x48 in bank/.test(line.statement)), "last-seen bank stock stays last-seen");
    assert.ok(smelt!.evidence.some((line) => line.kind === "DERIVED" && /at vendor prices/.test(line.statement)));
    assert.ok(smelt!.unknowns.includes("Auction House prices."));

    // Realm isolation: the PvE character's 500 Copper Ore never feeds a PvP 2 recommendation.
    for (const rec of answer.recommendations.filter((entry) => entry.realm === "Classic Beta PvP 2")) {
      assert.ok(!rec.evidence.some((line) => /Bramm/.test(line.statement)), `${rec.id} does not use another realm's evidence`);
      assert.doesNotMatch(rec.what, /\b5\d\d Copper Ore/);
    }
    assert.ok(answer.recommendations.some((rec) => rec.id.startsWith("capture-recipes-forever::classic beta pve::bramm")), "a crafting skill without captured recipes becomes an evidence-gap action");
    // Holder first: Rordin's own vest upgrade is never routed to someone else.
    assert.ok(!answer.recommendations.some((rec) => /Give Rough Copper Vest/.test(rec.title)));
    // No market price is ever stated as a number.
    assert.doesNotMatch(answer.markdown, /auction (price|value)[^.]*\d+[gsc]\b/i);
  } finally { store.close(); }
});

test("version isolation: non-Forever versions are refused and Forever answers never read other versions", () => {
  const { store, read } = realStable((s) => s.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 100, character: { name: "Rordin", realm: "Classic Beta PvP 2", class: "WARRIOR", level: 60, clientFamily: "Classic", clientVersion: "1.15.7", clientBuild: "60000", interface: "11507" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:12640::::::::60:::::::::", name: "Lionheart Helm", qty: 1 }] }] } })));
  try {
    const refused = answerForeverCopilot(read, { version: "retail", question: SCENARIO_A });
    assert.equal(refused.status, "UNSUPPORTED_VERSION");
    assert.equal(refused.recommendations.length, 0);
    const answer = answerForeverCopilot(read, { version: "forever", question: SCENARIO_A });
    assert.equal(answer.subject?.level, 6, "the Forever Rordin, not the Classic Era level 60");
    assert.ok(!JSON.stringify(answer).includes("Lionheart Helm"));
  } finally { store.close(); }
});

test("ambiguous and unknown characters are reported instead of guessed", () => {
  const { store, read } = realStable((s) => s.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 50, character: { name: "Hallo", realm: "Classic Beta PvE", class: "DRUID", level: 1, faction: "Horde", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" } })));
  try {
    assert.equal(answerForeverCopilot(read, { version: "forever", question: "How can Hallo improve?" }).status, "CHARACTER_AMBIGUOUS");
    assert.equal(answerForeverCopilot(read, { version: "forever", question: "How can Hallo improve?", realm: "Classic Beta PvP 2" }).subject?.class, "HUNTER");
    assert.equal(answerForeverCopilot(read, { version: "forever", question: "x", character: { name: "Nobody" } }).status, "CHARACTER_NOT_FOUND");
  } finally { store.close(); }
});

test("preferences change ranking: self-sufficiency lifts profession work, immediate power lifts gear", () => {
  const { store, read } = realStable();
  try {
    const self = answerForeverCopilot(read, { version: "forever", question: SCENARIO_A, preferences: { emphasis: "SELF_SUFFICIENCY" }, limit: 20 });
    const power = answerForeverCopilot(read, { version: "forever", question: SCENARIO_A, preferences: { emphasis: "IMMEDIATE_POWER" }, limit: 20 });
    const score = (answer: CopilotAnswer, id: string) => answer.recommendations.find((rec) => rec.id === id)?.score.total ?? 0;
    assert.ok(score(self, "tool-blacksmith-hammer") > score(power, "tool-blacksmith-hammer"));
    assert.ok(score(power, "transfer-4658") > score(self, "transfer-4658"));
    const avoid = answerForeverCopilot(read, { version: "forever", question: SCENARIO_A, preferences: { avoidSpending: true }, limit: 20 });
    for (const rec of avoid.recommendations) assert.ok(rec.score.basis.length > 0);
    const explicit = answerForeverCopilot(read, { version: "forever", question: SCENARIO_A, objectives: ["MAKE_GOLD"] });
    assert.deepEqual(explicit.objective.objectives, ["MAKE_GOLD"]);
  } finally { store.close(); }
});

test("recorded goals come from existing ERP projects, never a second store", () => {
  const { store, read } = realStable();
  try {
    const answer = answerForeverCopilot(read, { version: "forever", question: SCENARIO_A, preferences: { goals: ["Be self-sufficient in copper gear"] } });
    assert.deepEqual(answer.playerGoals.map((goal) => goal.source), ["this request"]);
  } finally { store.close(); }
});

test("objective understanding is deterministic and explains itself", () => {
  const gold = understandObjective({ version: "forever", question: "how do I make gold with my professions" });
  assert.deepEqual(gold.objectives, ["MAKE_GOLD", "DEVELOP_PROFESSIONS"]);
  assert.match(gold.basis, /DERIVED/);
  const vague = understandObjective({ version: "forever", question: "hmm" });
  assert.ok(vague.objectives.includes("IMPROVE_CHARACTER") && vague.objectives.includes("GEAR"));
});

test("knowledge parsers read Forever tooltips and quest pages; the committed dataset is Forever-only", () => {
  const bracers = parseItemTooltip(2853, { name: "Copper Bracers", quality: 1, tooltip: "<table><tr><td><b class=\"q1\">Copper Bracers</b><span class=\"q\"><br>Item Level <!--ilvl-->7</span><!--bo--><table width=\"100%\"><tr><td>Wrist</td><th><!--scstart4:3--><span class=\"q1\">Mail</span><!--scend--></th></tr></table><!--rf--><span><!--amr-->35 Armor</span><br>Durability 20 / 20</td></tr></table><table><tr><td>Requires Level <!--rlvl-->2<br><div class=\"whtt-sellprice\">Sell Price: <span class=\"moneycopper\">17</span></div></td></tr></table>" }, "2026-10-13T00:00:00Z");
  assert.deepEqual([bracers?.itemLevel, bracers?.slot, bracers?.subtype, bracers?.armor, bracers?.requiredLevel, bracers?.sellPriceCopper], [7, "Wrist", "Mail", 35, 2, 17]);
  const recipe = parseSpellTooltip(2663, { name: "Copper Bracers", tooltip: "<table><tr><td>Tools:<br /><div class=\"indent q1\"><a href=\"/forever/items?filter=91;162;0\">Blacksmith Hammer</a></div>Reagents:<br /><div class=\"indent q1\"><a href=\"/forever/item=2840/copper-bar\">Copper Bar</a>&nbsp;(2)</div><br /><span class=\"q1\"><a href=\"/forever/item=2853/copper-bracers\">Copper Bracers</a></span> (2)</td></tr></table>" }, "2026-10-13T00:00:00Z");
  assert.deepEqual(recipe?.tools, ["Blacksmith Hammer"]);
  assert.deepEqual(recipe?.reagents, [{ itemId: 2840, name: "Copper Bar", quantity: 2 }]);
  assert.equal(recipe?.createsItemId, 2853);
  const quest = parseQuestPage(384, "<title>Beer Basted Boar Ribs - Quest - Forever</title><meta name=\"description\" content=\"Ragnar Thunderbrew in Kharanos wants 6 Crag Boar Ribs and a mug of Rhapsody Malt. A level 7 Quest. +100 reputation with Ironforge +100 reputation with Gnomeregan Exiles\"><h2 class=\"heading-size-3\">Rewards</h2>You will receive: <a href=\"/forever/item=2888/beer-basted-boar-ribs\">x</a><h2>Gains</h2><script>WH.Gatherer.addData(3, 16, {\"2894\":{\"name_enus\":\"Rhapsody Malt\",\"jsonequip\":{\"avgbuyout\":20,\"buyprice\":50,\"sellprice\":12}}});</script><script>Rewards({\"xp\":{\"levels\":{\"7\":630}},\"coin\":{\"levels\":{\"7\":175}}});</script>", "2026-10-13T00:00:00Z");
  assert.deepEqual([quest?.level, quest?.xpByLevel["7"], quest?.coinByLevel["7"], quest?.rewardItemIds], [7, 630, 175, [2888]]);
  assert.deepEqual(quest?.reputation, [{ faction: "Ironforge", amount: 100 }, { faction: "Gnomeregan Exiles", amount: 100 }]);
  assert.deepEqual(quest?.vendorBuyPrices, [{ itemId: 2894, name: "Rhapsody Malt", buyPriceCopper: 50 }], "vendor buy price is kept; auction avgbuyout is never ingested");
  assert.ok(!JSON.stringify(quest).includes("avgbuyout"));
  // Committed dataset: values the client also observed agree (Copper Bracers 35 Armor; Rough Copper Vest 108 Armor + 1 Stamina).
  assert.equal(foreverItem(2853)?.armor, 35);
  assert.deepEqual([foreverItem(10421)?.armor, foreverItem(10421)?.stats], [108, [{ stat: "Stamina", value: 1 }]]);
  assert.deepEqual(foreverSpell(2575)?.tools, ["Mining Pick"]);
  assert.equal(Object.values(foreverQuest(384)?.xpByLevel ?? {})[0], 630);
  for (const url of [foreverItem(2853)!.sourceUrl, foreverSpell(2663)!.sourceUrl, foreverQuest(384)!.sourceUrl]) assert.match(url, /^https:\/\/www\.wowhead\.com\/forever\//);
});
