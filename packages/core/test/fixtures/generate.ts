// Regenerates the format-accurate placeholder fixtures. See README.md in
// this directory — real exports should replace these as they arrive.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildWowSyncExport } from "../fixtureBuilder.ts";

const dir = fileURLToPath(new URL(".", import.meta.url));

// --- Classic Era: Bromrik ---
writeFileSync(
  `${dir}classic-era/bromrik-01.txt`,
  buildWowSyncExport({
    generatedAt: 1_700_000_000,
    character: {
      name: "Bromrik",
      realm: "Whitemane",
      class: "Warrior",
      level: 12,
      faction: "Alliance",
      moneyCopper: 8342,
      playedSeconds: 21_600,
      levelPlayedSeconds: 3_100,
      clientVersion: "1.15.7",
      clientBuild: "60927",
    },
    location: { zone: "Westfall", subzone: "Sentinel Hill", x: 52.1, y: 60.4 },
    professions: { entries: [{ name: "Mining", skill: 30, maxSkill: 75 }] },
    bags: {
      containers: [
        {
          id: 0,
          capacity: 16,
          free: 9,
          items: [{ itemRef: "item:2840::::::::12:::::", name: "Copper Ore", qty: 7 }],
        },
      ],
    },
    bank: { unknown: true },
    trainer: { unknown: true },
  }),
);

// --- TBC Anniversary: Torahn (two snapshots for history/diff demo) ---
const torahnBase = {
  name: "Torahn",
  realm: "Faerlina",
  class: "Shaman",
  faction: "Horde",
  clientVersion: "2.5.6",
  clientBuild: "69546",
};
writeFileSync(
  `${dir}tbc-anniversary/torahn-01-level20.txt`,
  buildWowSyncExport({
    generatedAt: 1_700_100_000,
    character: { ...torahnBase, level: 20, moneyCopper: 250_00, playedSeconds: 100_000, levelPlayedSeconds: 6_000 },
    location: { zone: "The Barrens", subzone: "Southern Barrens" },
    professions: { entries: [{ name: "Mining", skill: 60, maxSkill: 300 }] },
    trainer: {
      categories: [
        {
          category: "CLASS",
          name: "Grillo Rendo",
          trainerType: "class",
          services: [
            { spellID: 8017, ability: "Frost Shock", status: "available", requiredLevel: 20, cost: 500 },
            { spellID: 324, ability: "Lightning Shield", status: "known", requiredLevel: 4 },
          ],
        },
      ],
    },
  }),
);
writeFileSync(
  `${dir}tbc-anniversary/torahn-02-level22.txt`,
  buildWowSyncExport({
    generatedAt: 1_700_200_000,
    character: { ...torahnBase, level: 22, moneyCopper: 700_00, playedSeconds: 118_000, levelPlayedSeconds: 4_200 },
    location: { zone: "The Barrens", subzone: "Ratchet" },
    professions: { entries: [{ name: "Mining", skill: 74, maxSkill: 300 }] },
    trainer: {
      categories: [
        {
          category: "CLASS",
          name: "Grillo Rendo",
          trainerType: "class",
          services: [
            { spellID: 8017, ability: "Frost Shock", status: "known", requiredLevel: 20, cost: 500 },
            { spellID: 324, ability: "Lightning Shield", status: "known", requiredLevel: 4 },
          ],
        },
      ],
    },
  }),
);

// --- TBC Anniversary: Voodan ---
writeFileSync(
  `${dir}tbc-anniversary/voodan-01.txt`,
  buildWowSyncExport({
    generatedAt: 1_700_150_000,
    character: { ...torahnBase, name: "Voodan", level: 19, moneyCopper: 12_00, playedSeconds: 60_000, levelPlayedSeconds: 5_000 },
    location: { zone: "Thunder Bluff" },
    bank: {
      containers: [{ id: -1, capacity: 24, free: 13, items: [{ itemRef: "item:2996::::::::19:::::", name: "Bolt of Linen Cloth", qty: 51 }] }],
    },
  }),
);

// --- TBC Anniversary: Tenivard ---
writeFileSync(
  `${dir}tbc-anniversary/tenivard-01.txt`,
  buildWowSyncExport({
    generatedAt: 1_700_160_000,
    character: { ...torahnBase, name: "Tenivard", level: 15, moneyCopper: 900, playedSeconds: 30_000, levelPlayedSeconds: 12_000 },
    location: { zone: "Durotar" },
  }),
);

// --- Retail sample ---
writeFileSync(
  `${dir}retail/sample-retail-01.txt`,
  buildWowSyncExport({
    generatedAt: 1_789_344_996,
    character: {
      name: "Retailtoon",
      realm: "Area52",
      class: "Mage",
      level: 80,
      faction: "Horde",
      moneyCopper: 1_250_000,
      playedSeconds: 500_000,
      levelPlayedSeconds: 20_000,
      clientVersion: "12.1.0",
      clientBuild: "69814",
      clientFamily: "Retail",
      interface: "120100",
    },
    professions: {
      retail: true,
      entries: [{ name: "Tailoring", skill: 100, maxSkill: 100, skillLineID: 197, tier: "Khaz Algar", expansion: "The War Within", category: "PRIMARY" }],
    },
    bags: {
      containers: [{ id: 0, capacity: 20, free: 20, storage: "CARRIED" }],
    },
  }),
);

console.log("Fixtures regenerated.");
