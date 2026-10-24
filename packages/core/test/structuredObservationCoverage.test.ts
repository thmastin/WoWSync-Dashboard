import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STRUCTURED_OBSERVATION_COVERAGE } from "../src/readModel.ts";
import { parseWowSyncExport } from "../src/parser.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

// Keep aligned with the structuredObservations projection in readModel.ts. New
// projected sections must name a parser or explicitly document unsupported scope.
const projectedByFlavor = {
  "classic-era": ["recipes", "quests", "reputation", "talents"],
  forever: ["recipes", "quests", "reputation", "talents"],
} as const;

test("structured observation coverage is explicit for Classic Era and Forever", () => {
  for (const flavor of ["classic-era", "forever"] as const) {
    const coverage = STRUCTURED_OBSERVATION_COVERAGE[flavor] as Record<string, { parser?: string; notSupportedReason?: string }>;
    for (const section of projectedByFlavor[flavor]) {
      const entry = coverage[section];
      assert.ok(entry, `${flavor}.${section} has no coverage declaration`);
      assert.ok(entry.parser || entry.notSupportedReason, `${flavor}.${section} has neither a parser nor NOT_SUPPORTED_ON_FLAVOR reason`);
      if (entry.notSupportedReason) assert.ok(entry.notSupportedReason.trim(), `${flavor}.${section} support reason is empty`);
    }
    for (const [section, entry] of Object.entries(coverage)) {
      if (entry.notSupportedReason) assert.match(entry.notSupportedReason, /^NOT_SUPPORTED_ON_FLAVOR:/);
      else assert.ok(projectedByFlavor[flavor].includes(section as never), `${flavor}.${section} coverage isn't reported by structuredObservations`);
    }
  }
});

test("every renderer section used by each flavor is accepted, while Retail stays strict", () => {
  const realEraText = readFileSync(new URL("./fixtures/ashtest-classic-era-wow-sync.txt", import.meta.url), "utf8");
  const renderedLabels = realEraText.split(/\n{2,}/).map((chunk) => /^\[([^\]]+)\]$/.exec(chunk.split("\n", 1)[0] ?? "")?.[1]).filter((label): label is string => !!label && label !== "END");
  const expectedClassicRendererLabels = ["CHARACTER", "LOCATION", "EQUIPMENT", "BAGS", "BANK", "PROFESSIONS", "KNOWN SPELLS", "TRAINERS", "ITEM METADATA", "TALENTS", "QUESTS", "REPUTATION", "KNOWN RECIPES"];
  assert.deepEqual(renderedLabels, expectedClassicRendererLabels, "real Classic renderer output covers its common, metadata and progression sections");
  const rendererSections = {
    "classic-era": ["TALENTS", "QUESTS", "REPUTATION", "KNOWN RECIPES"],
    forever: ["TALENTS", "QUESTS", "REPUTATION", "KNOWN RECIPES"],
  } as const;
  const statusOnly = (label: string) => `[${label}]\nState: UNKNOWN\nReason: Not observed`;
  for (const flavor of ["classic-era", "forever"] as const) {
    const character = flavor === "forever"
      ? { name: "Fixture", realm: "Realm", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" }
      : { name: "Fixture", realm: "Realm", clientFamily: "Classic", clientVersion: "1.15.9", clientBuild: "70003" };
    const raw = buildWowSyncExport({ character }).replace("\n\n[END]", `\n\n${rendererSections[flavor].map(statusOnly).join("\n\n")}\n\n[END]`);
    assert.doesNotThrow(() => parseWowSyncExport(raw), `${flavor} renderer sections must be accepted`);
    const realFlavorText = flavor === "classic-era" ? realEraText : realEraText.replace("Client: 1.15.9 build 70003", "Client: 1.60.1 build 70291\nClientFamily: Forever\nInterface: 16001");
    assert.deepEqual(parseWowSyncExport(realFlavorText).textTalents?.status.state, "OBSERVED", `${flavor} accepts the real renderer section set`);
  }
  const retail = buildWowSyncExport({ character: { name: "Fixture", realm: "Realm", clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: "69933" } })
    .replace("\n\n[END]", `\n\n${statusOnly("TALENTS")}\n\n[END]`);
  assert.throws(() => parseWowSyncExport(retail), /only valid for Classic Era or Forever/);
});
