import assert from "node:assert/strict";
import { test } from "node:test";
import { characterDisplayName, characterIdentity } from "../src/identity.ts";
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

test("Forever surname distinguishes characters while other version keys retain their established shape", () => {
  const first = identityFor({ character: { name: "Hallo", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" } });
  const withSurname = identityFor({ character: { name: "Hallo", surname: "Emberstone", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" } });
  assert.equal(first.key, "forever::classic beta pvp 2::hallo");
  assert.equal(withSurname.key, "forever::classic beta pvp 2::hallo::emberstone");
  assert.notEqual(withSurname.key, first.key);
  assert.equal(characterIdentity("forever", { name: "Hallo", realm: "Classic Beta PvP 2" }, "Player-123").key, "forever::classic beta pvp 2::hallo::guid:player-123");
  assert.equal(withSurname.name, "Hallo");
  assert.equal(characterDisplayName({ name: "Hallo", surname: "Emberstone" }), "Hallo Emberstone");
  assert.equal(characterDisplayName({ name: "Hallo" }), "Hallo");
});

test("Retail, Classic Era, and TBC Anniversary identity keys stay unchanged", () => {
  assert.equal(identityFor({ character: { name: "A", realm: "R", clientFamily: "Retail", clientVersion: "12.1.0", interface: "120100" } }).key, "retail::r::a");
  assert.equal(identityFor({ character: { name: "A", realm: "R", clientVersion: "1.15.7" } }).key, "classic-era::r::a");
  assert.equal(identityFor({ character: { name: "A", realm: "R", clientVersion: "2.5.6" } }).key, "tbc-anniversary::r::a");
});
