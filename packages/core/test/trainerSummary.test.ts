import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWowSyncExport } from "../src/parser.ts";
import { diffSnapshots } from "../src/diff.ts";
import { parseRequiredLevel, summarizeTrainerCategory } from "../src/trainerSummary.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");

const voodan = () => parseWowSyncExport(read("tbc-anniversary/voodan-1789484723.wowsync.txt"));

// --- Real Voodan data: primary validation case (requirement 11) ---

test("[REAL] Voodan CLASS trainer: 180 raw services condense into level groups without losing any", () => {
  const category = voodan().trainer.categories.find((c) => c.category === "CLASS")!;
  const summary = summarizeTrainerCategory(category);
  assert.equal(summary.totalServices, 180);
  const groupedCount = summary.upcomingByLevel.reduce((n, g) => n + g.abilities.length, 0);
  // STORE EVERYTHING: every service is accounted for in exactly one bucket.
  assert.equal(
    summary.available.length + summary.known.length + groupedCount + summary.unknownUnlockLevel.length,
    summary.totalServices,
  );
  assert.equal(summary.available.length, 0); // real capture: nothing currently trainable
  assert.equal(summary.unknownUnlockLevel.length, 0); // real capture: every row has a numeric requiredLevel
});

test("[REAL] Voodan CLASS next training is the lowest known level group (Level 18)", () => {
  const category = voodan().trainer.categories.find((c) => c.category === "CLASS")!;
  const summary = summarizeTrainerCategory(category);
  assert.equal(summary.nextTraining?.requiredLevel, 18);
  assert.equal(summary.nextTraining?.abilityCount, 3);
  assert.equal(summary.nextTraining?.totalCostCopper, 6000); // 3 abilities x 2000 copper, all costs known
  assert.equal(summary.nextTraining?.costPartial, false);
});

test("[REAL] Voodan profession categories (Cooking/First Aid/Tailoring) stay independent", () => {
  const categories = voodan().trainer.categories;
  const cooking = summarizeTrainerCategory(categories.find((c) => c.category === "PROF_COOKING")!);
  const firstAid = summarizeTrainerCategory(categories.find((c) => c.category === "PROF_FIRST_AID")!);
  const tailoring = summarizeTrainerCategory(categories.find((c) => c.category === "PROF_TAILORING")!);
  assert.equal(cooking.totalServices, 2);
  assert.equal(firstAid.totalServices, 6);
  assert.equal(tailoring.totalServices, 87);
  // A visit to one category must not leak abilities into another.
  const cookingAbilities = new Set(cooking.upcomingByLevel.flatMap((g) => g.abilities.map((a) => a.ability)));
  const tailoringAbilities = new Set(tailoring.upcomingByLevel.flatMap((g) => g.abilities.map((a) => a.ability)));
  for (const name of cookingAbilities) assert.ok(!tailoringAbilities.has(name));
});

test("[REAL] Voodan's unresolved UNKNOWN trainer category summarizes to all-empty, not an error", () => {
  const category = voodan().trainer.categories.find((c) => c.category === "UNKNOWN")!;
  const summary = summarizeTrainerCategory(category);
  assert.equal(summary.totalServices, 0);
  assert.equal(summary.nextTraining, undefined);
});

// --- 1. Available abilities ---
test("services with statusAtVisit 'available' land in the available bucket", () => {
  const raw = buildWowSyncExport({
    trainer: {
      categories: [
        {
          category: "CLASS",
          services: [{ ability: "Frost Shock", status: "available", requiredLevel: 20, cost: 500 }],
        },
      ],
    },
  });
  const category = parseWowSyncExport(raw).trainer.categories[0];
  const summary = summarizeTrainerCategory(category);
  assert.equal(summary.available.length, 1);
  assert.equal(summary.available[0].ability, "Frost Shock");
  assert.equal(summary.upcomingByLevel.length, 0);
});

// --- 2. Unavailable abilities ---
test("services with statusAtVisit 'unavailable' never land in the available bucket", () => {
  const raw = buildWowSyncExport({
    trainer: {
      categories: [
        {
          category: "CLASS",
          services: [{ ability: "Chain Heal", status: "unavailable", requiredLevel: 40, cost: 50000 }],
        },
      ],
    },
  });
  const category = parseWowSyncExport(raw).trainer.categories[0];
  const summary = summarizeTrainerCategory(category);
  assert.equal(summary.available.length, 0);
  assert.equal(summary.upcomingByLevel.length, 1);
  assert.equal(summary.upcomingByLevel[0].requiredLevel, 40);
});

// --- 3. Grouping by requiredLevel ---
test("unavailable abilities group by requiredLevel, ascending", () => {
  const raw = buildWowSyncExport({
    trainer: {
      categories: [
        {
          category: "CLASS",
          services: [
            { ability: "A", status: "unavailable", requiredLevel: 24 },
            { ability: "B", status: "unavailable", requiredLevel: 18 },
            { ability: "C", status: "unavailable", requiredLevel: 18 },
            { ability: "D", status: "unavailable", requiredLevel: 20 },
          ],
        },
      ],
    },
  });
  const category = parseWowSyncExport(raw).trainer.categories[0];
  const summary = summarizeTrainerCategory(category);
  assert.deepEqual(
    summary.upcomingByLevel.map((g) => g.requiredLevel),
    [18, 20, 24],
  );
  assert.equal(summary.upcomingByLevel[0].abilities.length, 2);
});

// --- 4. Unknown requiredLevel ---
test("a missing/non-numeric requiredLevel is never inferred, only bucketed as unknown", () => {
  assert.equal(parseRequiredLevel(undefined), undefined);
  assert.equal(parseRequiredLevel("?"), undefined);
  assert.equal(parseRequiredLevel("not-a-number"), undefined);
  assert.equal(parseRequiredLevel("18"), 18);
  assert.equal(parseRequiredLevel("0"), 0); // 0 is a real, known value - not unknown

  const raw = buildWowSyncExport({
    trainer: {
      categories: [
        {
          category: "CLASS",
          services: [{ ability: "Mystery Spell", status: "unavailable", requiredLevel: undefined }],
        },
      ],
    },
  });
  const category = parseWowSyncExport(raw).trainer.categories[0];
  const summary = summarizeTrainerCategory(category);
  assert.equal(summary.upcomingByLevel.length, 0);
  assert.equal(summary.unknownUnlockLevel.length, 1);
  assert.equal(summary.unknownUnlockLevel[0].ability, "Mystery Spell");
});

// --- 5 & 6. Multiple trainer categories / category isolation ---
test("multiple categories in one snapshot summarize independently", () => {
  const raw = buildWowSyncExport({
    trainer: {
      categories: [
        { category: "CLASS", services: [{ ability: "Frost Shock", status: "available" }] },
        { category: "PROF_MINING", services: [{ ability: "Mining", status: "unavailable", requiredLevel: 5 }] },
        { category: "PROF_COOKING", services: [] },
      ],
    },
  });
  const categories = parseWowSyncExport(raw).trainer.categories;
  const summaries = categories.map(summarizeTrainerCategory);
  const byCategory = new Map(summaries.map((s) => [s.category, s]));
  assert.equal(byCategory.get("CLASS")?.available.length, 1);
  assert.equal(byCategory.get("PROF_MINING")?.upcomingByLevel.length, 1);
  assert.equal(byCategory.get("PROF_COOKING")?.totalServices, 0);
});

// --- 7. Cost calculation ---
test("group cost totals sum only known costs, and flag when the total is partial", () => {
  const raw = buildWowSyncExport({
    trainer: {
      categories: [
        {
          category: "CLASS",
          services: [
            { ability: "A", status: "unavailable", requiredLevel: 20, cost: 1000 },
            { ability: "B", status: "unavailable", requiredLevel: 20, cost: 2000 },
            { ability: "C", status: "unavailable", requiredLevel: 20, cost: undefined },
          ],
        },
      ],
    },
  });
  const category = parseWowSyncExport(raw).trainer.categories[0];
  const summary = summarizeTrainerCategory(category);
  const group = summary.upcomingByLevel[0];
  assert.equal(group.totalCostCopper, 3000);
  assert.equal(group.costPartial, true);
});

// --- 8. "Next Training" calculation ---
test("next training is the lowest-level group, never a group with unknown level", () => {
  const raw = buildWowSyncExport({
    trainer: {
      categories: [
        {
          category: "CLASS",
          services: [
            { ability: "A", status: "unavailable", requiredLevel: 30, cost: 1000 },
            { ability: "B", status: "unavailable", requiredLevel: 22, cost: 500 },
            { ability: "Mystery", status: "unavailable", requiredLevel: undefined },
          ],
        },
      ],
    },
  });
  const category = parseWowSyncExport(raw).trainer.categories[0];
  const summary = summarizeTrainerCategory(category);
  assert.equal(summary.nextTraining?.requiredLevel, 22);
});

test("next training is absent when every unavailable ability has an unknown level", () => {
  const raw = buildWowSyncExport({
    trainer: {
      categories: [
        {
          category: "CLASS",
          services: [{ ability: "Mystery", status: "unavailable", requiredLevel: undefined }],
        },
      ],
    },
  });
  const category = parseWowSyncExport(raw).trainer.categories[0];
  const summary = summarizeTrainerCategory(category);
  assert.equal(summary.nextTraining, undefined);
  assert.equal(summary.unknownUnlockLevel.length, 1);
});

// --- 9. Character already at/above requiredLevel but status remains unavailable ---
test("an ability stays in its level group even when the character's current level already exceeds it", () => {
  const raw = buildWowSyncExport({
    character: { level: 25 }, // character is well past this ability's requiredLevel
    trainer: {
      categories: [
        {
          category: "CLASS",
          services: [
            {
              ability: "Circle of Healing",
              rank: "Rank 2",
              status: "unavailable", // blocked by a prerequisite, not by level
              requiredLevel: 18,
              requirements: "Circle of Healing (Rank 1) met=no",
            },
          ],
        },
      ],
    },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.character.level, 25);
  const summary = summarizeTrainerCategory(snapshot.trainer.categories[0]);
  // Must NOT be promoted to "available" just because 25 >= 18. The real
  // trainer status (still unavailable, blocked by a prerequisite) and the
  // reason are preserved exactly as observed.
  assert.equal(summary.available.length, 0);
  assert.equal(summary.upcomingByLevel[0].requiredLevel, 18);
  assert.equal(summary.upcomingByLevel[0].abilities[0].requirementsAtVisit, "Circle of Healing (Rank 1) met=no");
});

// --- Trainer unlocks (history/changes, requirement 7) ---
test("trainerUnlocks reports an ability that newly became available between snapshots", () => {
  const buildSnap = (status: "unavailable" | "available") =>
    buildWowSyncExport({
      trainer: {
        categories: [
          {
            category: "CLASS",
            services: [
              { ability: "Shadow Word: Pain", rank: "Rank 2", status, requiredLevel: 18, cost: 4000 },
              { ability: "Renew", rank: "Rank 2", status: "unavailable", requiredLevel: 20 },
            ],
          },
        ],
      },
    });
  const from = parseWowSyncExport(buildSnap("unavailable"));
  const to = parseWowSyncExport(buildSnap("available"));
  const diff = diffSnapshots(from, to);
  assert.equal(diff.trainerUnlocks.length, 1);
  assert.equal(diff.trainerUnlocks[0].ability, "Shadow Word: Pain");
  assert.equal(diff.trainerUnlocks[0].category, "CLASS");
});

test("trainerUnlocks is empty when nothing newly unlocked", () => {
  const raw = buildWowSyncExport({
    trainer: { categories: [{ category: "CLASS", services: [{ ability: "A", status: "unavailable", requiredLevel: 20 }] }] },
  });
  const snap = parseWowSyncExport(raw);
  assert.deepEqual(diffSnapshots(snap, snap).trainerUnlocks, []);
});

// --- 10, 11, 12. Client/version compatibility (synthetic - real trainer data only exists for TBC/Voodan today) ---

test("[SYNTHETIC] Classic Era-shaped trainer export summarizes identically to any other version", () => {
  const raw = buildWowSyncExport({
    character: { clientVersion: "1.15.7", clientBuild: "60927" },
    trainer: {
      categories: [
        { category: "CLASS", services: [{ ability: "Eviscerate", status: "available", rank: "Rank 3", cost: 1000 }] },
      ],
    },
  });
  const category = parseWowSyncExport(raw).trainer.categories[0];
  const summary = summarizeTrainerCategory(category);
  assert.equal(summary.available.length, 1);
});

test("[SYNTHETIC] TBC Anniversary-shaped trainer export (mirrors the real Voodan structure)", () => {
  const raw = buildWowSyncExport({
    character: { clientVersion: "2.5.6", clientBuild: "69795" },
    trainer: {
      categories: [
        { category: "CLASS", services: [{ ability: "Chain Heal", status: "unavailable", requiredLevel: 40, cost: 50000 }] },
        { category: "PROF_TAILORING", services: [{ ability: "Bolt of Netherweave", status: "unavailable", requiredLevel: 0 }] },
      ],
    },
  });
  const categories = parseWowSyncExport(raw).trainer.categories;
  const summaries = categories.map(summarizeTrainerCategory);
  assert.equal(summaries.length, 2);
  assert.equal(summaries.find((s) => s.category === "PROF_TAILORING")?.upcomingByLevel[0].requiredLevel, 0);
});

test("[SYNTHETIC] Retail-shaped trainer export where trainer data exists", () => {
  const raw = buildWowSyncExport({
    character: { clientVersion: "12.1.0", clientBuild: "69814", clientFamily: "Retail", interface: "120100" },
    trainer: {
      categories: [
        {
          category: "PROF_ENCHANTING",
          services: [{ ability: "Enchant Weapon - Sharpness", status: "available", cost: 2500 }],
        },
      ],
    },
  });
  const category = parseWowSyncExport(raw).trainer.categories[0];
  const summary = summarizeTrainerCategory(category);
  assert.equal(summary.available.length, 1);
  assert.equal(summary.available[0].ability, "Enchant Weapon - Sharpness");
});
