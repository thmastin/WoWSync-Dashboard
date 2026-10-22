import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWowSyncExport } from "../src/parser.ts";
import { resolveSnapshotView } from "../src/snapshotEvidence.ts";
import type { StoredSnapshot } from "../src/store.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const RETAIL = { name: "Tinker", realm: "Area 52", class: "Mage", level: 90, clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: "69933", interface: "120100" };
const FOREVER = { name: "Hero", realm: "Classic Beta PvP 2", class: "Mage", level: 9, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" };
const domain = (state: "OBSERVED" | "LAST_SEEN", observedAt: number) => ({ status: { state, observedAt }, observedAt, completeness: "complete" as const, data: { marker: observedAt } });
function snap(id: number, generatedAt: number, character: object, extra: Record<string, unknown> = {}, parsedExtra: Record<string, unknown> = {}): StoredSnapshot {
  return { id, characterId: 1, generatedAt, importedAt: generatedAt + 1, parsed: { ...parseWowSyncExport(buildWowSyncExport({ generatedAt, character, ...extra } as any)), ...parsedExtra } };
}

test("Retail specialization and reputation domains are carried forward as LAST_SEEN when a newer import lacks them", () => {
  const older = snap(1, 1000, RETAIL, {}, { characterState: { formatVersion: 1, clientFamily: "Retail", combatSpecialization: domain("OBSERVED", 990), reputation: { character: domain("OBSERVED", 991), account: domain("OBSERVED", 992) } } });
  const latest = snap(2, 2000, RETAIL);
  const view = resolveSnapshotView("retail", [latest, older], latest);
  assert.equal(view.parsed.characterState?.combatSpecialization?.status.state, "LAST_SEEN");
  assert.equal(view.parsed.characterState?.combatSpecialization?.status.carriedFromSnapshotId, 1);
  assert.equal(view.parsed.characterState?.reputation?.character?.status.state, "LAST_SEEN");
  assert.equal(view.parsed.characterState?.reputation?.account?.status.carriedFromSnapshotId, 1);
  assert.equal(latest.parsed.characterState, undefined, "stored snapshots are never modified");
});

test("sections never carry backward from a newer snapshot, across Forever client versions, or across character GUIDs", () => {
  const newer = snap(3, 3000, FOREVER, {}, { foreverGearObservation: { clientProfile: "Forever:1.60.1:70338:16001", name: "Hero", realm: "Classic Beta PvP 2", generatedAt: 3000, sourceCharacterGuid: "G1" } });
  const selected = snap(2, 2000, FOREVER, { bank: { unknown: true } }, { foreverGearObservation: { clientProfile: "Forever:1.60.1:70338:16001", name: "Hero", realm: "Classic Beta PvP 2", generatedAt: 2000, sourceCharacterGuid: "G1" } });
  assert.equal(resolveSnapshotView("forever", [newer, selected], selected).parsed.bank.status.state, "UNKNOWN", "a pinned older snapshot does not borrow newer evidence");
  const otherClient = snap(1, 1000, { ...FOREVER, clientVersion: "1.59.0" });
  assert.equal(resolveSnapshotView("forever", [selected, otherClient], selected).parsed.bank.status.state, "UNKNOWN", "beta evidence does not cross a client version");
  const otherGuid = snap(1, 1000, FOREVER, {}, { foreverGearObservation: { clientProfile: "Forever:1.60.1:70338:16001", name: "Hero", realm: "Classic Beta PvP 2", generatedAt: 1000, sourceCharacterGuid: "G2" } });
  assert.equal(resolveSnapshotView("forever", [selected, otherGuid], selected).parsed.bank.status.state, "UNKNOWN", "a recreated same-name character is not merged");
  const sameGuid = snap(1, 1000, FOREVER, {}, { foreverGearObservation: { clientProfile: "Forever:1.60.1:70338:16001", name: "Hero", realm: "Classic Beta PvP 2", generatedAt: 1000, sourceCharacterGuid: "G1" } });
  const carried = resolveSnapshotView("forever", [selected, sameGuid], selected).parsed.bank;
  assert.equal(carried.status.state, "LAST_SEEN");
  assert.equal(carried.status.carriedFromSnapshotId, 1);
});

test("Classic Era and TBC Anniversary carry storage forward within their own identity only", () => {
  const era = { name: "Groit", realm: "Stormrage", class: "Warrior", level: 30, clientVersion: "1.15.9", clientBuild: "69547" };
  const older = snap(1, 1000, era);
  const latest = snap(2, 2000, era, { bank: { unknown: true }, professions: { unknown: true } });
  const view = resolveSnapshotView("classic-era", [latest, older], latest);
  assert.equal(view.parsed.bank.status.state, "LAST_SEEN");
  assert.equal(view.parsed.professions.status.state, "LAST_SEEN");
  assert.equal(view.parsed.bags.status.state, latest.parsed.bags.status.state, "observed sections are never replaced");
});
