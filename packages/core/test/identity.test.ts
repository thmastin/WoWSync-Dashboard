import assert from "node:assert/strict";
import { test } from "node:test";
import { characterIdentity } from "../src/identity.ts";
import { parseWowSyncExport } from "../src/parser.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { detectVersion } from "../src/version.ts";

function identityFor(overrides: Parameters<typeof buildWowSyncExport>[0]) {
  const snapshot = parseWowSyncExport(buildWowSyncExport(overrides));
  const version = detectVersion(snapshot.character);
  return characterIdentity(version, snapshot.character);
}

test("identity combines version, realm, and name", () => {
  const id = identityFor({ character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6" } });
  assert.equal(id.key, "tbc-anniversary::faerlina::torahn");
});

test("same character name on different realms never collides", () => {
  const a = identityFor({ character: { name: "Bromrik", realm: "Whitemane", clientVersion: "1.15.7" } });
  const b = identityFor({ character: { name: "Bromrik", realm: "Grobbulus", clientVersion: "1.15.7" } });
  assert.notEqual(a.key, b.key);
});

test("the same name+realm in different WoW versions never collides", () => {
  const era = identityFor({ character: { name: "Torahn", realm: "Faerlina", clientVersion: "1.15.7" } });
  const tbc = identityFor({ character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6" } });
  assert.notEqual(era.key, tbc.key);
  assert.equal(era.version, "classic-era");
  assert.equal(tbc.version, "tbc-anniversary");
});

test("identity is case-insensitive for realm/name matching", () => {
  const a = identityFor({ character: { name: "Voodan", realm: "Faerlina", clientVersion: "2.5.6" } });
  const b = identityFor({ character: { name: "voodan", realm: "faerlina", clientVersion: "2.5.6" } });
  assert.equal(a.key, b.key);
});
