import assert from "node:assert/strict";
import { test } from "node:test";
import { STRUCTURED_OBSERVATION_COVERAGE } from "../src/readModel.ts";

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
