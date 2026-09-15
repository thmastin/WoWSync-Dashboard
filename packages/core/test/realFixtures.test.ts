// Regression coverage against REAL WoWSync v1 exports (see fixtures/README.md).
// These are not generated — they are byte-for-byte captures from an actual
// Classic Era client (Bromrik) and an actual Retail client (Ezaller).
//
// This file exists because real data exposed genuine bugs synthetic
// fixtures never caught: a header-framing bug (WOWSYNC v1/Generated/Format
// are three separate blank-line-separated chunks, not one three-line
// block), addon version skew (older builds omit PlayedSeconds/
// LevelPlayedSeconds entirely and render "[TRAINER]" instead of
// "[TRAINERS]"), whitespace mangled during copy/paste (tabs collapsed to
// spaces, trailing columns dropped), and Blizzard's itemString format
// embedding the observing character's level (which used to make the diff
// engine think nearly every item changed on every level-up). All of those
// are fixed in packages/core/src/parser.ts and diff.ts; this file locks
// the fixes in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { characterIdentity } from "../src/identity.ts";
import { diffSnapshots } from "../src/diff.ts";
import { parseWowSyncExport } from "../src/parser.ts";
import { detectVersion } from "../src/version.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");

const bromrikOlder = () => parseWowSyncExport(read("classic-era/bromrik-1789170870.wowsync.txt"));
const bromrikNewer = () => parseWowSyncExport(read("classic-era/bromrik-1789171621.wowsync.txt"));
const ezallerOlder = () => parseWowSyncExport(read("retail/ezaller-1789477879.wowsync.txt"));
const ezallerNewer = () => parseWowSyncExport(read("retail/ezaller-1789478317.wowsync.txt"));
const voodanBeforeAH = () => parseWowSyncExport(read("tbc-anniversary/voodan-1789484723.wowsync.txt"));
const voodanAfterAH = () => parseWowSyncExport(read("tbc-anniversary/voodan-1789492666.wowsync.txt"));
const torahn = () => parseWowSyncExport(read("tbc-anniversary/torahn-1789492498.wowsync.txt"));
const tenivard = () => parseWowSyncExport(read("tbc-anniversary/tenivard-1789492580.wowsync.txt"));

// 1. Bromrik Classic Era routing
test("[REAL] Bromrik's client (1.15.9) routes to classic-era", () => {
  assert.equal(detectVersion(bromrikNewer().character), "classic-era");
});

// 2. Ezaller Retail routing
test("[REAL] Ezaller's client (ClientFamily=Retail) routes to retail", () => {
  assert.equal(detectVersion(ezallerNewer().character), "retail");
});

// 3. Real character identity
test("[REAL] character identity is stable and version/realm/name-scoped", () => {
  const bromrik = bromrikNewer();
  const ezaller = ezallerNewer();
  const bromrikId = characterIdentity(detectVersion(bromrik.character), bromrik.character);
  const ezallerId = characterIdentity(detectVersion(ezaller.character), ezaller.character);
  assert.equal(bromrikId.key, "classic-era::defias pillager::bromrik");
  assert.equal(ezallerId.key, "retail::kel'thuzad::ezaller");
  assert.notEqual(bromrikId.key, ezallerId.key);
});

// 4. Real itemRefs
test("[REAL] full itemRef strings (including embedded stat/level fields) are preserved exactly", () => {
  const ezaller = ezallerNewer();
  const head = ezaller.equipment.slots.find((s) => s.slot === 1);
  assert.equal(head?.itemRef, "item:235962::::::::78:1467::18:1:6710:2:9:65:28:181:::::");
  assert.equal(head?.name, "Mysterious Coif");
});

// 5. Real equipment
test("[REAL] equipment slots, empty slots, and stat blocks parse correctly", () => {
  const bromrik = bromrikNewer();
  const shirt = bromrik.equipment.slots.find((s) => s.slot === 4);
  assert.equal(shirt?.empty, false);
  assert.equal(shirt?.name, "Footpad's Shirt");
  const rangedSlotEmpty = bromrik.equipment.slots.find((s) => s.slot === 18);
  assert.equal(rangedSlotEmpty?.empty, false); // Bromrik has a ranged weapon equipped
  const trinket1 = bromrik.equipment.slots.find((s) => s.slot === 13);
  assert.equal(trinket1?.empty, true);

  const ezaller = ezallerNewer();
  const mainHand = ezaller.equipment.slots.find((s) => s.slot === 16);
  assert.match(mainHand?.effectiveStats ?? "", /ITEM_MOD_INTELLECT_SHORT=50/);
});

// 6. Real bags
test("[REAL] bag containers and item stacks parse correctly, including ContainerStorage tags", () => {
  const bromrik = bromrikNewer();
  assert.equal(bromrik.bags.freeSlots, 17);
  assert.equal(bromrik.bags.totalSlots, 20);
  assert.equal(bromrik.bags.items.length, 3);

  const ezaller = ezallerNewer();
  const reagentBag = ezaller.bags.containers.find((c) => c.id === 5);
  assert.equal(reagentBag?.storage, "REAGENT_BAG");
  const mainBag = ezaller.bags.containers.find((c) => c.id === 0);
  assert.equal(mainBag?.storage, "CARRIED");
});

// 7. Real profession data
test("[REAL] profession data: Classic 'none identified', Retail retail-shaped columns", () => {
  const bromrik = bromrikNewer();
  assert.equal(bromrik.professions.entries.length, 0);
  assert.equal(bromrik.professions.noneMessage, "None identified in exposed skill lines");

  const ezaller = ezallerNewer();
  assert.equal(ezaller.professions.entries.length, 1);
  const enchanting = ezaller.professions.entries[0];
  assert.equal(enchanting.name, "Enchanting");
  assert.equal(enchanting.skill, 12);
  assert.equal(enchanting.maxSkill, 100);
  assert.equal(enchanting.skillLineID, "333");
  assert.equal(enchanting.category, "PRIMARY");
});

// 8. Real spell data
test("[REAL] spell rows with missing/omitted rank columns and duplicate rows are preserved", () => {
  const bromrik = bromrikNewer();
  assert.equal(bromrik.spells.entries.length, 9);
  const throwSpell = bromrik.spells.entries.find((s) => s.name === "Throw");
  assert.equal(throwSpell?.rank, undefined); // trailing rank column omitted in the real capture

  const ezaller = ezallerNewer();
  const wingBuffetCount = ezaller.spells.entries.filter((s) => s.name === "Wing Buffet").length;
  assert.equal(wingBuffetCount, 2); // real duplicate rows are not silently deduped
  // "-" is the schema's explicit "no rank concept applies" sentinel — distinct
  // from "?" (unknown) — and is preserved literally, not collapsed to undefined.
  assert.ok(ezaller.spells.entries.every((s) => s.rank === "-"));
});

// 9. Real trainer UNKNOWN state (both section-name spellings)
test("[REAL] trainer UNKNOWN state parses whether the export says [TRAINER] or [TRAINERS]", () => {
  assert.equal(bromrikNewer().trainer.status.state, "UNKNOWN"); // real capture uses [TRAINER] (older addon build)
  assert.equal(ezallerNewer().trainer.status.state, "UNKNOWN"); // real capture uses [TRAINERS]
});

// 10. UNKNOWN bank
test("[REAL] bank UNKNOWN state (never visited) parses for both characters", () => {
  assert.equal(bromrikNewer().bank.status.state, "UNKNOWN");
  assert.equal(bromrikNewer().bank.status.reason, "Not observed");
  assert.equal(ezallerNewer().bank.status.state, "UNKNOWN");
});

// 11. Retail playtime (and its real absence on the older Classic Era build)
test("[REAL] PlayedSeconds/LevelPlayedSeconds: present on Retail, genuinely absent on an older Classic Era build", () => {
  const ezaller = ezallerNewer();
  assert.equal(ezaller.character.playedSeconds, 12638);
  assert.equal(ezaller.character.levelPlayedSeconds, 694);

  const bromrik = bromrikNewer();
  assert.equal(bromrik.character.playedSeconds, undefined);
  assert.equal(bromrik.character.levelPlayedSeconds, undefined);
});

// 12. Snapshot history (see also fixtureFiles.test.ts for the store-level version)
test("[REAL] both snapshots in each real pair remain independently readable", () => {
  const older = bromrikOlder();
  const newer = bromrikNewer();
  assert.equal(older.character.level, 3);
  assert.equal(newer.character.level, 4);
  assert.notEqual(older.generatedAt, newer.generatedAt);
});

// 13. Gold deltas
test("[REAL] gold deltas are exact for both real pairs", () => {
  assert.equal(diffSnapshots(bromrikOlder(), bromrikNewer()).moneyCopper.delta, 304 - 114);
  assert.equal(diffSnapshots(ezallerOlder(), ezallerNewer()).moneyCopper.delta, 24_797_508 - 24_205_308);
});

// 14. XP deltas
test("[REAL] XP deltas are exact, including the raw (uninterpreted) reset-on-levelup case", () => {
  const ezallerDiff = diffSnapshots(ezallerOlder(), ezallerNewer());
  assert.equal(ezallerDiff.xp.delta, 55642 - 413);
  assert.equal(ezallerDiff.level.delta, 0);

  // Bromrik leveled up between captures, so raw XP goes "down" (51 -> 1) and
  // xpMax changes (1400 -> 2100). The diff engine reports this as a fact,
  // exactly as observed — it does not try to detect or explain the reset.
  const bromrikDiff = diffSnapshots(bromrikOlder(), bromrikNewer());
  assert.equal(bromrikDiff.level.delta, 1);
  assert.equal(bromrikDiff.xp.delta, 1 - 51);
  assert.equal(bromrikDiff.xpMax.delta, 2100 - 1400);
});

// 15. Playtime deltas
test("[REAL] playtime deltas (total and current-level) are exact for Ezaller", () => {
  const diff = diffSnapshots(ezallerOlder(), ezallerNewer());
  assert.equal(diff.playedSeconds.delta, 65);
  assert.equal(diff.levelPlayedSeconds.delta, 65);
});

// 16. Equipment changes
test("[REAL] equipment diff reports genuine swaps, not the level-linked itemRef churn on unchanged gear", () => {
  const diff = diffSnapshots(bromrikOlder(), bromrikNewer());
  // Real, intentional swaps: Feet (shoes -> boots), Wrist (empty -> bracers),
  // Back (cloak -> shawl).
  const bySlot = new Map(diff.equipment.map((e) => [e.slot, e]));
  assert.equal(bySlot.get(8)?.slotName, "Feet");
  assert.equal(bySlot.get(9)?.from, "EMPTY");
  assert.equal(bySlot.get(15)?.slotName, "Back");
  // Hands (Wolf Handler Gloves) did NOT change physically — only the
  // level-link digit inside its itemRef did (":3:" -> ":4:") — so it must
  // not appear as a changed slot.
  assert.equal(bySlot.has(10), false);

  const ezallerDiff = diffSnapshots(ezallerOlder(), ezallerNewer());
  assert.equal(ezallerDiff.equipment.length, 0); // Ezaller's gear genuinely didn't change
});

// 17. Bag changes
test("[REAL] bag quantity deltas track the same item across a level-linked itemRef change", () => {
  const diff = diffSnapshots(bromrikOlder(), bromrikNewer());
  const jerky = diff.bagsItems.find((i) => i.name === "Tough Jerky");
  // itemRef literally differs (":3:" -> ":4:") but this must read as one
  // continuous stack going from 2 to 5, not "lost 2, gained 5".
  assert.equal(jerky?.fromQty, 2);
  assert.equal(jerky?.toQty, 5);
  assert.equal(jerky?.deltaQty, 3);

  const ezallerDiff = diffSnapshots(ezallerOlder(), ezallerNewer());
  const shard = ezallerDiff.bagsItems.find((i) => i.name === "Depleted Elemental Shard");
  assert.equal(shard?.deltaQty, 3);
});

// 18. Deterministic rendering/diffing
test("[REAL] parsing and diffing real exports is deterministic across repeated runs", () => {
  const a1 = bromrikNewer();
  const a2 = bromrikNewer();
  assert.deepEqual(a1, a2);

  const diff1 = diffSnapshots(bromrikOlder(), bromrikNewer());
  const diff2 = diffSnapshots(bromrikOlder(), bromrikNewer());
  assert.deepEqual(diff1, diff2);
});

// Location changes (from the "Diff Quality" review — Bromrik traveled zones)
test("[REAL] location changes are captured as a fact", () => {
  const diff = diffSnapshots(bromrikOlder(), bromrikNewer());
  assert.equal(diff.location.changed, true);
  assert.equal(diff.location.fromZone, "Dun Morogh");
  assert.equal(diff.location.toZone, "Anvilmar");
});

// --- Voodan before/after an Auction House run: real multi-snapshot history,
// and the "observed fact != inferred event" principle. ---

test("[REAL] Voodan's two real snapshots route to the same TBC Anniversary Dreamscythe character", () => {
  const before = voodanBeforeAH();
  const after = voodanAfterAH();
  assert.equal(detectVersion(before.character), "tbc-anniversary");
  assert.equal(before.character.realm, "Dreamscythe");
  assert.equal(after.character.realm, "Dreamscythe");
  assert.equal(before.character.name, after.character.name);
});

test("[REAL] Voodan's post-AH snapshot: gold, playtime, and inventory changed; level/XP/profession/trainer did not", () => {
  const diff = diffSnapshots(voodanBeforeAH(), voodanAfterAH());
  // Exact observed facts - not narrative labels.
  assert.equal(diff.moneyCopper.delta, 1_101_858 - 1_065_796);
  assert.equal(diff.playedSeconds.delta, 114_630 - 114_517);
  assert.equal(diff.level.delta, 0);
  assert.equal(diff.xp.delta, 0);
  assert.equal(diff.location.changed, false); // both snapshots: Thunder Bluff
  assert.equal(diff.professions.length, 0);
  assert.equal(diff.trainerUnlocks.length, 0);
  assert.equal(diff.equipment.length, 0);
  assert.ok(diff.bagsItems.length > 0);
});

test("[REAL] Voodan's post-AH bag changes are exact quantities, not an inferred 'AH sale/purchase' label", () => {
  const diff = diffSnapshots(voodanBeforeAH(), voodanAfterAH());
  const byName = new Map(diff.bagsItems.map((i) => [i.name, i]));
  assert.equal(byName.get("Small Blue Pouch")?.deltaQty, -1);
  assert.equal(byName.get("Thin Kodo Leather")?.deltaQty, -1);
  assert.equal(byName.get("Raptor Egg")?.deltaQty, 18);
  assert.equal(byName.get("Robust Shoulders of Intellect")?.deltaQty, 1);
  // The diff engine only ever reports quantities/facts - it has no concept
  // of "purchase" or "sale" at all, so there is nothing to assert against
  // for those (this test exists to document that the fixture drives real,
  // asymmetric (some lost, some gained, net gold +) inventory/gold facts,
  // exactly as WoWSync observed them).
});

// 19. Real Torahn/Tenivard recognition (previously untested - no real TBC data existed yet)
test("[REAL] Torahn and Tenivard are recognized as real TBC Anniversary Dreamscythe characters", () => {
  const t = torahn();
  const n = tenivard();
  assert.equal(detectVersion(t.character), "tbc-anniversary");
  assert.equal(detectVersion(n.character), "tbc-anniversary");
  assert.equal(t.character.realm, "Dreamscythe");
  assert.equal(n.character.realm, "Dreamscythe");
  assert.equal(t.character.name, "Torahn");
  assert.equal(n.character.name, "Tenivard");
});

test("[REAL] Tenivard's never-observed bank/trainer stay UNKNOWN, not empty", () => {
  const n = tenivard();
  assert.equal(n.bank.status.state, "UNKNOWN");
  assert.equal(n.trainer.status.state, "UNKNOWN");
});

test("[REAL] Torahn's trainer visit under an unresolved category is preserved, not discarded", () => {
  const t = torahn();
  assert.equal(t.trainer.status.state, "OBSERVED");
  const unknownCategory = t.trainer.categories.find((c) => c.category === "UNKNOWN");
  assert.ok(unknownCategory);
  assert.equal(unknownCategory!.services.length, 7);
});
