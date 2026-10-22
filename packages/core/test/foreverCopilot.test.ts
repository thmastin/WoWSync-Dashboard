import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { answerForeverCopilot, understandObjective, type CopilotAnswer } from "../src/foreverCopilot.ts";
import { ForeverKnowledgeIndex, type ForeverKnowledgeBundle } from "../src/foreverKnowledgeBundle.ts";
import { ForeverKnowledgeStore } from "../src/foreverKnowledgeStore.ts";
import { parseItemTooltip, parseSpellTooltip, foreverItem, useForeverKnowledge } from "../src/foreverKnowledge.ts";
import { extractForeverTrainerVisit } from "../src/foreverTrainer.ts";
import { luaArray, parseLuaLiteral, parseQuestieDataBlock } from "../src/luaLiteral.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

// Real fixtures: the exact import payloads (WOWSYNC text + structured sidecars) the SavedVariables bridge
// sent for these Forever 1.60.1/70338 characters. The knowledge fixture holds real Wowhead Forever
// tooltip facts for the items/recipes these tests touch and synthetic quest/NPC rows (IDs 99xxxx).
const FIXTURE_DIR = new URL("./fixtures/forever/", import.meta.url);
const payload = (name: string) => JSON.parse(readFileSync(new URL(`copilot-${name}.import.json`, FIXTURE_DIR), "utf8")) as { text: string; [key: string]: unknown };
const knowledgeJson = readFileSync(new URL("knowledge-fixture.json", FIXTURE_DIR), "utf8");
const KNOWLEDGE = new ForeverKnowledgeIndex(JSON.parse(knowledgeJson) as ForeverKnowledgeBundle);
const NOW = 1_791_870_000;
const SCENARIO_RORDIN = "I'm playing Rordin. Look at my character, accessible account resources, and the wider Forever game. What are the most valuable things I could do to improve this character, including upgrades, quests, crafting, training, and opportunities I haven't encountered?";
const SCENARIO_HALLO = "I'm playing Hallo the druid on the PvE realm. Look at my character, my accessible faction resources, and the wider Forever game. What are the best equipment upgrades, profession choices, quests, and class improvements I should pursue over the next five levels? Compare alternatives, including opportunities I haven't encountered yet.";
const SCENARIO_GOLD = "Look at my Forever stable and tell me how I can make gold using my actual characters, professions, and resources, plus profitable opportunities available in the wider Forever game that I haven't discovered yet.";

function stable(names: string[], extra?: (store: SqliteSnapshotStore) => void) {
  const store = new SqliteSnapshotStore(":memory:");
  for (const name of names) { const { text, ...extras } = payload(name); store.importSnapshot(text, extras); }
  extra?.(store);
  return { store, read: new DashboardReadModel(store, () => NOW) };
}
const ALL = ["rordin", "hallo-pvp2", "fizzwick", "hallo-pve", "natokni", "bramm", "nibwick"];
const evidenceOf = (answer: CopilotAnswer) => answer.recommendations.flatMap((rec) => rec.evidence);

test("Scenario Rordin: owned upgrades still lead, and external discovery adds training and trainer recipes", () => {
  const { store, read } = stable(["rordin", "hallo-pvp2", "fizzwick"]);
  try {
    const answer = answerForeverCopilot(read, { version: "forever", question: SCENARIO_RORDIN, limit: 20 }, KNOWLEDGE);
    assert.equal(answer.status, "ANSWERED");
    assert.equal(answer.subject?.name, "Rordin");
    assert.equal(answer.recommendations[0].id, "equip-10421", "free immediate upgrade is not obscured by discoveries");
    assert.ok(answer.limitations.some((line) => /No class trainer visit has been captured/.test(line)), "Rordin's only trainer capture is Blacksmithing");
    assert.ok(answer.recommendations.some((rec) => rec.id === "equip-2853"));
    assert.ok(answer.challenges.some((line) => /already carrying 2 better items/.test(line)));
    const trainer = answer.recommendations.concat().find((rec) => rec.id === "profession-trainer-blacksmithing");
    assert.ok(trainer, "Blacksmithing trainer recipes observed in the client are offered");
    assert.match(trainer!.what, /Copper Chain Pants at Blacksmithing 15 for 50c/);
    assert.ok(trainer!.evidence.some((line) => line.kind === "OBSERVED" && /trainer window/.test(line.statement)));
    assert.equal(answer.knowledge.available, true);
  } finally { store.close(); }
});

test("Scenario Hallo: Horde druid discovery respects faction, race zones, completed quests and class", () => {
  const { store, read } = stable(ALL);
  try {
    const answer = answerForeverCopilot(read, { version: "forever", question: SCENARIO_HALLO }, KNOWLEDGE);
    assert.equal(answer.status, "ANSWERED");
    assert.equal(answer.subject?.realm, "Classic Beta PvE", "'the druid on the PvE realm' disambiguates the two Hallos");
    assert.equal(answer.subject?.faction, "Horde");
    const text = JSON.stringify(answer);
    // Quest discovery.
    assert.match(text, /Synthetic Plains Errand/, "an unseen Horde quest in her zone is discovered");
    assert.doesNotMatch(text, /Synthetic Alliance Errand/, "Alliance-only quests are excluded");
    assert.doesNotMatch(text, /Synthetic Valley Chore/, "another race's starting zone is not suggested at level 6");
    assert.doesNotMatch(text, /"The Hunt Begins"/, "a quest in her completed history is never offered again");
    assert.doesNotMatch(text, /Turn in .*The Hunt Begins/, "carried LAST_SEEN quest rows are not treated as active");
    // Gear from a discovered quest reward, with the proficiency baseline labelled.
    const mainHand = answer.recommendations.find((rec) => rec.id === "discover-gear-main-hand");
    assert.ok(mainHand, "a quest-reward weapon upgrade is found");
    assert.match(mainHand!.what, /Synthetic Plains Errand/);
    assert.ok(mainHand!.evidence.some((line) => /Classic Era class rules, not verified for Forever/.test(line.statement)));
    assert.ok(mainHand!.prerequisites.some((line) => /weapon skill/.test(line)));
    // Class training from the observed Forever trainer window.
    const training = answer.recommendations.find((rec) => rec.id === "class-training");
    assert.ok(training);
    assert.doesNotMatch(training!.what, /Wrath Rank 2/, "a rank trained since (Wrath 2, trained 03:49) is not offered again");
    assert.match(training!.what, /Level 8: Entangling Roots Rank 1 \(2s 0c\), Healing Touch Rank 2 \(2s 0c\)/);
    assert.match(training!.what, /Level 10: .*Nature's Grasp Rank 1 \(3s 0c\)/);
    assert.match(training!.why, /You have 1s 52c; the next five levels of training cost 19s 0c, so you are short by 17s 48c/);
    // Class quest chain toward Bear Form.
    const classQuest = answer.recommendations.find((rec) => rec.category === "CLASS_QUEST");
    assert.ok(classQuest);
    assert.match(classQuest!.title, /Synthetic Druid Calling -> Synthetic Great Bear Spirit/);
    // Profession choice: Alliance professionals on her realm are never counted as suppliers.
    const professions = answer.recommendations.find((rec) => rec.id === "profession-choice");
    assert.ok(professions);
    assert.match(professions!.title, /Skinning \+ Leatherworking/);
    assert.match(professions!.what, /Bramm has Leatherworking but is Alliance \(you are Horde\), so it cannot supply you by mail/);
    assert.match(professions!.what, /Nibwick has Herbalism but is Alliance/);
    assert.ok(professions!.evidence.some((line) => /Bramm is Alliance on the same realm: ordinary mail to Hallo \(Horde\) is not possible/.test(line.statement)));
    // Five-level plan.
    assert.equal(answer.plan.length, 6);
    assert.equal(answer.plan[0].level, 6);
    assert.ok(answer.plan.find((step) => step.level === 10)!.milestones.some((line) => /Synthetic Druid Calling/.test(line)));
    assert.ok(answer.markdown.includes("**Level plan (6 to 11)**"));
    for (const line of evidenceOf(answer)) assert.ok(["OBSERVED", "DERIVED", "LAST_SEEN", "EXTERNAL", "UNKNOWN"].includes(line.kind));
  } finally { store.close(); }
});

test("Scenario stable gold: economies are realm + faction; inaccessible resources never become inputs", () => {
  const { store, read } = stable(ALL);
  try {
    const answer = answerForeverCopilot(read, { version: "forever", question: SCENARIO_GOLD }, KNOWLEDGE);
    assert.equal(answer.status, "ANSWERED");
    const economies = new Set(answer.recommendations.map((rec) => rec.realm));
    assert.ok(economies.has("Classic Beta PvE, Horde") && economies.has("Classic Beta PvE, Alliance"), "the PvE realm splits into two faction economies");
    for (const rec of answer.recommendations.filter((entry) => entry.realm === "Classic Beta PvE, Horde")) {
      assert.ok(!rec.evidence.some((line) => /\b(Bramm|Nibwick|Tirilanin)\b/.test(line.statement)), `${rec.id} uses no Alliance evidence`);
      assert.doesNotMatch(rec.nextActions.join(" "), /\b(Bramm|Nibwick)\b/);
    }
    for (const rec of answer.recommendations.filter((entry) => entry.realm === "Classic Beta PvE, Alliance")) assert.ok(!rec.evidence.some((line) => /Hallo \(Classic Beta PvE\)|Natokni/.test(line.statement)), `${rec.id} uses no Horde evidence`);
    assert.ok(answer.recommendations.every((rec) => rec.goldBucket));
    assert.ok(answer.challenges.some((line) => /Auction House value is UNKNOWN/.test(line)));
    assert.doesNotMatch(answer.markdown, /auction (price|value)[^.]*\d+[gsc]\b/i);
    assert.ok(answer.recommendations.concat().some((rec) => rec.category === "GATHERING_DISCOVERY") || answer.otherOpportunities.some((other) => /materials worth gathering/.test(other.title)), "gathering discovery uses Forever knowledge");
  } finally { store.close(); }
});

test("without a knowledge bundle the co-pilot answers from account evidence only and says so", () => {
  const { store, read } = stable(["rordin", "hallo-pvp2"]);
  try {
    const answer = answerForeverCopilot(read, { version: "forever", question: SCENARIO_RORDIN });
    assert.equal(answer.knowledge.available, false);
    assert.match(answer.knowledge.source, /No Forever knowledge bundle/);
    assert.ok(!answer.recommendations.some((rec) => rec.category.startsWith("DISCOVERED")));
    assert.ok(answer.recommendations.some((rec) => rec.id === "quest-turn-ins"), "account-only advice still works");
    assert.ok(answer.recommendations.every((rec) => rec.evidence.every((line) => line.kind !== "EXTERNAL" || !/wowhead|QuestieDB/.test(line.source))), "no external facts without a bundle");
  } finally { store.close(); }
});

test("version isolation and ambiguity", () => {
  const { store, read } = stable(["rordin", "hallo-pvp2", "hallo-pve"], (s) => s.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 100, character: { name: "Rordin", realm: "Classic Beta PvP 2", class: "WARRIOR", level: 60, clientFamily: "Classic", clientVersion: "1.15.7", clientBuild: "60000", interface: "11507" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:12640::::::::60:::::::::", name: "Lionheart Helm", qty: 1 }] }] } })));
  try {
    assert.equal(answerForeverCopilot(read, { version: "retail", question: SCENARIO_RORDIN }, KNOWLEDGE).status, "UNSUPPORTED_VERSION");
    const answer = answerForeverCopilot(read, { version: "forever", question: SCENARIO_RORDIN }, KNOWLEDGE);
    assert.equal(answer.subject?.level, 6);
    assert.ok(!JSON.stringify(answer).includes("Lionheart Helm"));
    assert.equal(answerForeverCopilot(read, { version: "forever", question: "How can Hallo improve?" }, KNOWLEDGE).status, "CHARACTER_AMBIGUOUS");
    assert.equal(answerForeverCopilot(read, { version: "forever", question: "How can Hallo the hunter improve?" }, KNOWLEDGE).subject?.realm, "Classic Beta PvP 2");
  } finally { store.close(); }
});

test("preferences move ranking and explicit objectives override", () => {
  const { store, read } = stable(["rordin", "hallo-pvp2", "fizzwick"]);
  try {
    const score = (answer: CopilotAnswer, id: string) => answer.recommendations.find((rec) => rec.id === id)?.score.total ?? 0;
    const self = answerForeverCopilot(read, { version: "forever", question: SCENARIO_RORDIN, preferences: { emphasis: "SELF_SUFFICIENCY" }, limit: 20 }, KNOWLEDGE);
    const power = answerForeverCopilot(read, { version: "forever", question: SCENARIO_RORDIN, preferences: { emphasis: "IMMEDIATE_POWER" }, limit: 20 }, KNOWLEDGE);
    assert.ok(score(self, "tool-blacksmith-hammer") > score(power, "tool-blacksmith-hammer"));
    assert.ok(score(power, "transfer-4658") > score(self, "transfer-4658"));
    assert.deepEqual(answerForeverCopilot(read, { version: "forever", question: SCENARIO_RORDIN, objectives: ["MAKE_GOLD"] }, KNOWLEDGE).objective.objectives, ["MAKE_GOLD"]);
    assert.ok(self.recommendations.every((rec) => rec.score.confidence > 0 && rec.score.basis.includes("evidence confidence")));
  } finally { store.close(); }
});

test("objective understanding", () => {
  assert.deepEqual(understandObjective({ version: "forever", question: "how do I make gold with my professions" }).objectives, ["MAKE_GOLD", "DEVELOP_PROFESSIONS"]);
  assert.ok(understandObjective({ version: "forever", question: "hmm" }).objectives.includes("GEAR"));
});

test("trainer evidence: Hallo's Forever class trainer capture parses with level, cost and status", () => {
  const { store } = stable(["hallo-pve"]);
  try {
    const snapshot = store.listSnapshots("forever::classic beta pve::hallo")[0]!;
    const visit = extractForeverTrainerVisit(snapshot.parsed, snapshot.id)!;
    assert.equal(visit.kind, "CLASS");
    assert.equal(visit.serviceCount, 177);
    const roots = visit.services.find((service) => service.name === "Entangling Roots" && service.rank === "Rank 1")!;
    assert.deepEqual([roots.level, roots.costCopper, roots.statusAtVisit], [8, 200, "unavailable"]);
    const bash = visit.services.find((service) => service.name === "Bash" && service.rank === "Rank 1")!;
    assert.deepEqual([bash.level, bash.costCopper, bash.requires], [14, 900, ["Bear Form (Shapeshift)"]]);
  } finally { store.close(); }
});

test("knowledge parsers, Lua literal reader, and the bundle store", () => {
  const bracers = parseItemTooltip(2853, { name: "Copper Bracers", quality: 1, tooltip: "<span class=\"q\"><br>Item Level <!--ilvl-->7</span><table width=\"100%\"><tr><td>Wrist</td><th><!--scstart4:3--><span class=\"q1\">Mail</span><!--scend--></th></tr></table><span><!--amr-->35 Armor</span><br>Requires Level <!--rlvl-->2<br><div class=\"whtt-sellprice\">Sell Price: <span class=\"moneycopper\">17</span></div>" }, "t");
  assert.deepEqual([bracers?.itemLevel, bracers?.slot, bracers?.subtype, bracers?.armor, bracers?.requiredLevel, bracers?.sellPriceCopper], [7, "Wrist", "Mail", 35, 2, 17]);
  const boots = parseSpellTooltip(2149, { name: "Handstitched Leather Boots", tooltip: "Reagents:<br /><div class=\"indent q1\"><a href=\"/forever/item=2318/light-leather\">Light Leather</a>&nbsp;(2), <a href=\"/forever/item=2320/coarse-thread\">Coarse Thread</a></div><br /><span class=\"q1\"><a href=\"/forever/item=2307/handstitched-leather-boots\">Handstitched Leather Boots</a></span> (2)" }, "t");
  assert.deepEqual(boots?.reagents, [{ itemId: 2318, name: "Light Leather", quantity: 2 }, { itemId: 2320, name: "Coarse Thread", quantity: 1 }]);
  assert.equal(boots?.createsItemId, 2307);

  const parsed = parseQuestieDataBlock("QuestieDB.questData = [[return {\n[384] = {\"Beer Basted Boar Ribs\",{{1267}},nil,5,7,4294967373,nil,{'text'},nil,{nil,nil,{{2886},{2894}}}},\n}]]", "QuestieDB.questData");
  const row = luaArray(parsed["384"]);
  assert.equal(row[0], "Beer Basted Boar Ribs");
  assert.equal(row[2], null, "nil holes keep their position");
  assert.equal(row[5], 4294967373);
  assert.throws(() => parseLuaLiteral("{ os.execute('x') }"), /unexpected token/, "code is never evaluated");

  const dir = mkdtempSync(path.join(os.tmpdir(), "wowsync-knowledge-"));
  try {
    const store = new ForeverKnowledgeStore(path.join(dir, "forever-knowledge.json"));
    assert.equal(store.status().installed, false);
    assert.throws(() => store.install(JSON.stringify({ schema: 2, version: "retail" })), /Forever knowledge bundle/);
    const status = store.install(knowledgeJson);
    assert.equal(status.installed, true);
    assert.ok(store.get() instanceof ForeverKnowledgeIndex);
    writeFileSync(path.join(dir, "forever-knowledge.json"), "{not json");
    assert.equal(store.get(), undefined, "a corrupt file is reported, not used");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  useForeverKnowledge(KNOWLEDGE, () => assert.equal(foreverItem(2853)?.armor, 35));
  assert.equal(foreverItem(2853), undefined, "knowledge is scoped to the request");
});

test("pass 3: observed weapon skills decide eligibility; talents parse; route and observed IDs", async () => {
  const { extractForeverSkillLines, extractForeverTalents, requiredSkillFor } = await import("../src/foreverSkills.ts");
  const { zoneDistance, questHubs } = await import("../src/foreverRouting.ts");
  const { collectForeverObservedIds } = await import("../src/foreverKnowledgeBundle.ts");
  const { store, read } = stable(ALL);
  try {
    const snapshot = store.listSnapshots("forever::classic beta pve::hallo")[0]!;
    const skills = extractForeverSkillLines(snapshot.parsed, snapshot.id)!;
    assert.deepEqual(skills.weapons.get("Staves"), { rank: 27, maxRank: 30 });
    assert.equal(skills.weapons.has("Two-Handed Maces"), false);
    assert.ok(skills.armor.has("Leather") && !skills.armor.has("Mail"));
    assert.deepEqual(requiredSkillFor("Two-Hand", "Mace"), { kind: "weapon", name: "Two-Handed Maces" });

    const answer = answerForeverCopilot(read, { version: "forever", question: SCENARIO_HALLO, limit: 20 }, KNOWLEDGE);
    const mainHand = answer.recommendations.find((rec) => rec.id === "discover-gear-main-hand")!;
    assert.ok(mainHand.prerequisites.some((line) => /^Train Two-Handed Maces at a weapon master first/.test(line)), "an untrained weapon skill becomes an explicit prerequisite");
    const route = answer.recommendations.find((rec) => rec.id === "quest-route");
    assert.ok(route && /Mulgore around \(47, 60\), Synthetic Plainswalker/.test(route.what), "quests are grouped into located hubs");
    assert.equal(answer.knowledge.ageDays !== undefined, true);

    const talents = extractForeverTalents({ foreverGearObservation: { talents: { observedAt: 10, completeness: "complete", data: { unspentPoints: 1, trees: [{ name: "Balance", pointsSpent: 2, talents: [{ name: "Improved Wrath", currentRank: 2, maxRank: 5 }] }] } } } }, 7)!;
    assert.deepEqual([talents.unspentPoints, talents.trees[0].pointsSpent, talents.trees[0].talents[0].currentRank], [1, 2, 2]);

    assert.equal(zoneDistance("Mulgore", "The Barrens"), 1);
    assert.equal(zoneDistance("Mulgore", "Ashenvale"), 2);
    assert.equal(zoneDistance("Mulgore", "Riverglades"), undefined, "zones outside the baseline stay unknown");
    const hubs = questHubs([{ zone: "Mulgore", coord: [47, 60], giver: "A", item: 1 }, { zone: "Mulgore", coord: [49, 61], giver: "B", item: 2 }, { zone: "Mulgore", coord: [70, 20], giver: "C", item: 3 }]);
    assert.deepEqual(hubs.map((hub) => hub.items), [[1, 2], [3]]);

    const ids = collectForeverObservedIds(read as never);
    assert.ok(ids.items.includes(10421) && ids.spells.includes(2663) && ids.quests.includes(743));
  } finally { store.close(); }
});

test("pass 3: dungeons get a level range from their creatures and respect faction and reach", () => {
  const bundle = JSON.parse(knowledgeJson) as ForeverKnowledgeBundle;
  bundle.zones["17"] = "The Barrens"; bundle.zones["1637"] = "Orgrimmar";
  bundle.dungeons = { 718: { name: "Synthetic Caverns", areas: [718], parentZone: 17, entrance: [17, 46, 36.5] }, 2437: { name: "Synthetic Chasm", areas: [2437], parentZone: 1637, entrance: [1637, 52, 49] } };
  for (let n = 0; n < 8; n += 1) bundle.npcs[String(995000 + n)] = { name: `Cave Thing ${n}`, zone: 718, level: [8 + (n % 3), 9 + (n % 3)], rank: 0 };
  for (let n = 0; n < 8; n += 1) bundle.npcs[String(996000 + n)] = { name: `Chasm Thing ${n}`, zone: 2437, level: [9, 10], rank: 0 };
  bundle.quests["990010"] = { name: "Synthetic Cavern Errand", level: 9, reqLevel: 5, races: 178, zone: 718, startNpcs: [990101], xp: 600 };
  const index = new ForeverKnowledgeIndex(bundle);
  const caverns = index.dungeons().find((entry) => entry.dungeon.name === "Synthetic Caverns")!;
  assert.deepEqual([caverns.minLevel, caverns.maxLevel], [8, 11]);
  const { store, read } = stable(ALL);
  try {
    const horde = answerForeverCopilot(read, { version: "forever", question: SCENARIO_HALLO, limit: 20 }, index);
    const dungeon = horde.recommendations.concat().find((rec) => rec.id === "dungeon-718");
    assert.ok(dungeon, "a reachable dungeon in level range is offered");
    assert.match(dungeon!.what, /Synthetic Cavern Errand/);
    assert.ok(dungeon!.prerequisites.some((line) => /group of five/.test(line)));
    assert.doesNotMatch(JSON.stringify(horde.recommendations.filter((rec) => rec.category === "DISCOVERED_QUESTS")), /Synthetic Cavern Errand/, "dungeon quests are not listed as solo quests");
  } finally { store.close(); }
});
