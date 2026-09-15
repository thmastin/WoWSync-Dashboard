import assert from "node:assert/strict";
import { test } from "node:test";
import { detectVersion } from "../src/version.ts";
import { UNKNOWN_VERSION } from "../src/types.ts";
import { parseWowSyncExport } from "../src/parser.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

test("routes a 1.x client to Classic Era", () => {
  const snapshot = parseWowSyncExport(buildWowSyncExport({ character: { clientVersion: "1.15.7", clientBuild: "60927" } }));
  assert.equal(detectVersion(snapshot.character), "classic-era");
});

test("routes a 2.x client to TBC Anniversary", () => {
  const snapshot = parseWowSyncExport(buildWowSyncExport({ character: { clientVersion: "2.5.6", clientBuild: "69546" } }));
  assert.equal(detectVersion(snapshot.character), "tbc-anniversary");
});

test("routes a ClientFamily=Retail client to Retail", () => {
  const snapshot = parseWowSyncExport(
    buildWowSyncExport({
      character: { clientVersion: "12.1.0", clientBuild: "69814", clientFamily: "Retail", interface: "120100" },
    }),
  );
  assert.equal(detectVersion(snapshot.character), "retail");
});

test("an unrecognized client is quarantined, never guessed into a real version", () => {
  const snapshot = parseWowSyncExport(buildWowSyncExport({ character: { clientVersion: "9.9.9", clientBuild: "1" } }));
  assert.equal(detectVersion(snapshot.character), UNKNOWN_VERSION);
});

test("a missing client version is quarantined rather than defaulted", () => {
  const snapshot = parseWowSyncExport(buildWowSyncExport({ character: { unknown: true } }));
  assert.equal(detectVersion(snapshot.character), UNKNOWN_VERSION);
});
