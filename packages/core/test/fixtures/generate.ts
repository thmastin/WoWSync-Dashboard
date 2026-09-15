// Regenerates the SYNTHETIC placeholder fixtures only. These exist purely
// to exercise parser/diff code paths that the current real fixtures don't
// happen to cover (e.g. a second TBC Anniversary snapshot, since no real
// TBC export was available yet — see fixtures/README.md).
//
// Character names here are deliberately NOT any of the user's real
// characters (Torahn/Voodan/Tenivard/Bromrik/Ezaller), so a synthetic
// fixture can never be mistaken for real gameplay history.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildWowSyncExport } from "../fixtureBuilder.ts";

const dir = fileURLToPath(new URL("synthetic/", import.meta.url));

// A placeholder TBC Anniversary character pair (two snapshots), standing
// in for real Torahn/Voodan/Tenivard exports until WoW servers are back
// and real captures can be provided.
const base = {
  name: "Synthtest",
  realm: "PlaceholderRealm",
  class: "Mage",
  faction: "Horde",
  clientVersion: "2.5.6",
  clientBuild: "69546",
};
writeFileSync(
  `${dir}tbc-anniversary-placeholder-01.txt`,
  buildWowSyncExport({
    generatedAt: 1_700_100_000,
    character: { ...base, level: 20, moneyCopper: 25_000, playedSeconds: 100_000, levelPlayedSeconds: 6_000 },
    location: { zone: "The Barrens", subzone: "Southern Barrens" },
    professions: { entries: [{ name: "Tailoring", skill: 60, maxSkill: 300 }] },
  }),
);
writeFileSync(
  `${dir}tbc-anniversary-placeholder-02.txt`,
  buildWowSyncExport({
    generatedAt: 1_700_200_000,
    character: { ...base, level: 22, moneyCopper: 70_000, playedSeconds: 118_000, levelPlayedSeconds: 4_200 },
    location: { zone: "The Barrens", subzone: "Ratchet" },
    professions: { entries: [{ name: "Tailoring", skill: 74, maxSkill: 300 }] },
  }),
);

console.log("Synthetic fixtures regenerated.");
