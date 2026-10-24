import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseWowSyncExport, WowSyncParseError } from "../src/parser.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { foreverBuildVerification, foreverCompatibility } from "../src/foreverProfile.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";

test("parses a valid, fully-populated WOWSYNC v1 export", () => {
  const raw = buildWowSyncExport({
    character: { name: "Torahn", realm: "Faerlina", class: "Shaman", level: 30, moneyCopper: 100000 },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.character.name, "Torahn");
  assert.equal(snapshot.character.realm, "Faerlina");
  assert.equal(snapshot.character.level, 30);
  assert.equal(snapshot.character.moneyCopper, 100000);
  assert.equal(snapshot.character.status.state, "OBSERVED");
});

test("real Ashtest Classic Era export parses talent text into progression and structured state", () => {
  const raw = readFileSync(new URL("./fixtures/ashtest-classic-era-wow-sync.txt", import.meta.url), "utf8");
  const parsed = parseWowSyncExport(raw);
  assert.equal(parsed.textTalents?.status.state, "OBSERVED");
  assert.equal(parsed.textTalents?.data?.trees[0]?.name, "Affliction");
  assert.equal(parsed.textTalents?.data?.trees[0]?.pointsSpent, 1);
  assert.equal(parsed.textTalents?.data?.trees[0]?.talents.length, 17);
  assert.equal(parsed.textQuests?.status.state, "OBSERVED");
  assert.equal(parsed.textReputation?.status.state, "OBSERVED");
  assert.equal(parsed.textRecipes?.status.state, "UNKNOWN");
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(raw);
    const read = new DashboardReadModel(store);
    const state = read.getCharacterState({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal((state as any).value.data.structuredObservations.talents.state, "OBSERVED");
    const progression = read.getCharacterProgression({ version: "classic-era", name: "Ashtest", realm: "Mankrik", includeTalents: true });
    assert.equal((progression as any).value.data.talents.state, "OBSERVED");
    assert.equal((progression as any).value.data.talents.trees[0].name, "Affliction");
    const affliction = (progression as any).value.data.talents.trees[0];
    assert.equal(affliction.talentCoverage, "COMPLETE");
    assert.equal(affliction.talents.find((talent: any) => talent.name === "Improved Corruption").currentRank, 1);
    assert.equal(affliction.talents.find((talent: any) => talent.name === "Improved Corruption").maxRank, 5);
    assert.equal(affliction.talents.find((talent: any) => talent.name === "Improved Corruption").index, 3);
    assert.equal((progression as any).value.data.talents.unspentPoints, 0);
    const rankedOnly = read.getCharacterProgression({ version: "classic-era", name: "Ashtest", realm: "Mankrik" }) as any;
    assert.deepEqual(rankedOnly.value.data.talents.trees[0].talents.map((talent: any) => talent.name), ["Improved Corruption"]);
    assert.equal(rankedOnly.value.data.talents.trees[0].talents[0].currentRank, 1);
    assert.equal(rankedOnly.value.data.talents.trees[0].talents[0].maxRank, 5);
    assert.equal((progression as any).value.data.talentTreeAgreement.state, "AGREE");
  } finally { store.close(); }
});

test("Forever text talents feed progression and structured observations without a sidecar", () => {
  const raw = readFileSync(new URL("./fixtures/ashtest-classic-era-wow-sync.txt", import.meta.url), "utf8")
    .replace("Client: 1.15.9 build 70003", "Client: 1.60.1 build 70291\nClientFamily: Forever\nInterface: 16001");
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(raw);
    const read = new DashboardReadModel(store);
    const state = read.getCharacterState({ version: "forever", name: "Ashtest", realm: "Mankrik" });
    assert.equal((state as any).value.data.structuredObservations.talents.state, "OBSERVED");
    const progression = read.getCharacterProgression({ version: "forever", name: "Ashtest", realm: "Mankrik", includeTalents: true });
    assert.equal((progression as any).value.data.talents.state, "OBSERVED");
    assert.equal((progression as any).value.data.talents.trees[0].name, "Affliction");
    const affliction = (progression as any).value.data.talents.trees[0];
    assert.equal(affliction.talentCoverage, "COMPLETE");
    assert.equal(affliction.talents.find((talent: any) => talent.name === "Improved Corruption").index, 3);
    assert.equal(affliction.talents.find((talent: any) => talent.name === "Improved Corruption").currentRank, 1);
    assert.equal((progression as any).value.data.talents.unspentPoints, 0);
  } finally { store.close(); }
});

test("parses optional Classic Era GUID and observed talent tree while legacy exports remain UNKNOWN", () => {
  const legacy = parseWowSyncExport(buildWowSyncExport({ character: {
    name: "EraOne", realm: "Azeroth", class: "Warrior", level: 60, clientVersion: "1.15.9", clientBuild: "70003", clientFamily: "Classic",
  } }));
  assert.equal(legacy.character.guid, undefined);
  assert.equal(legacy.character.talentStatus, undefined);
  assert.equal(legacy.character.talentTree, undefined);

  const raw = buildWowSyncExport({ character: {
    name: "EraOne", realm: "Azeroth", class: "Warrior", level: 60, clientVersion: "1.15.9", clientBuild: "70003", clientFamily: "Classic",
  } }).replace("Client: 1.15.9 build 70003\n", "Client: 1.15.9 build 70003\nGUID: Player-1234-ABCDEFGH\nTalentStatus: OBSERVED\ntalentTree\tname\tpointsSpent\ntalentTree\tArms\t31\ntalentTree\tFury\t20\ntalentTree\tProtection\t0\n");
  const parsed = parseWowSyncExport(raw);
  assert.equal(parsed.character.guid, "Player-1234-ABCDEFGH");
  assert.equal(parsed.character.talentStatus, "OBSERVED");
  assert.deepEqual(parsed.character.talentTree, [
    { name: "Arms", pointsSpent: 31 }, { name: "Fury", pointsSpent: 20 }, { name: "Protection", pointsSpent: 0 },
  ]);
});

test("Forever 70291 and 70338 surnames are optional display metadata and legacy exports remain valid", () => {
  const forever = parseWowSyncExport(buildWowSyncExport({ character: {
    name: "Hallo", surname: "Emberstone", surnameSource: "UnitName[2]+GetUnitName suffix", realm: "Classic Beta PvP 2", clientFamily: "Forever",
    clientVersion: "1.60.1", clientBuild: "70291", interface: "16001",
  } }));
  assert.equal(forever.character.name, "Hallo");
  assert.equal(forever.character.surname, "Emberstone");
  assert.equal(forever.character.surnameSource, "UnitName[2]+GetUnitName suffix");
  assert.equal(forever.character.realm, "Classic Beta PvP 2");

  const forever70338 = parseWowSyncExport(buildWowSyncExport({ character: {
    name: "Rordin", surname: "Longbraid", surnameSource: "UnitName[2]+UnitFullName[2]+UnitNameUnmodified[2]", realm: "Classic Beta PvP 2", class: "Warrior", level: 3,
    clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001",
  } }));
  assert.equal(forever70338.character.name, "Rordin");
  assert.equal(forever70338.character.surname, "Longbraid");
  assert.equal(forever70338.character.class, "Warrior");
  assert.equal(forever70338.character.level, 3);

  const withoutSurname = parseWowSyncExport(buildWowSyncExport({ character: {
    name: "Fizzwick", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001",
  } }));
  assert.equal(withoutSurname.character.surname, undefined);
  const legacy = parseWowSyncExport(buildWowSyncExport({ character: { name: "Hallo", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "69893", interface: "16001" } }));
  assert.equal(legacy.character.surname, undefined);
  const retailWithSurname = buildWowSyncExport({ character: {
    name: "RetailOne", surname: "Unexpected", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: "69933",
  } }).replace("Name: RetailOne\n", "Name: RetailOne\nSurname: Unexpected\n");
  assert.throws(() => parseWowSyncExport(retailWithSurname), /Surname is only supported for a well-formed Forever/);
  const unknownForeverWithSurname = buildWowSyncExport({ character: {
    name: "Future", surname: "Profile", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001",
  } }).replace("Client: 1.60.1 build 70338", "Client: 1.60.1 build 70339");
  const launchBuild = parseWowSyncExport(unknownForeverWithSurname);
  assert.equal(launchBuild.character.surname, "Profile", "a new Forever client build (e.g. the launch build) still imports with its surname");
  assert.equal(launchBuild.character.clientBuild, "70339");
});

test("parses all eight sections present and labeled correctly", () => {
  const raw = buildWowSyncExport();
  const snapshot = parseWowSyncExport(raw);
  for (const key of ["character", "location", "equipment", "bags", "bank", "professions", "spells", "trainer"] as const) {
    assert.ok(snapshot[key], `expected section ${key} to be present`);
  }
});

test("unknown ('?') fields become undefined, never a guessed value", () => {
  const raw = buildWowSyncExport({
    character: { playedSeconds: undefined, levelPlayedSeconds: undefined },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.character.playedSeconds, undefined);
  assert.equal(snapshot.character.levelPlayedSeconds, undefined);
});

test("Forever 70450 is verified and newer 70999 exports retain build, race, and unverified compatibility", () => {
  const verified = parseWowSyncExport(buildWowSyncExport({ character: {
    name: "Hallo", race: "Dwarf", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70450", interface: "16001",
  } }));
  assert.equal(verified.character.clientBuild, "70450");
  assert.equal(foreverBuildVerification(verified.character), "VERIFIED");

  const newer = parseWowSyncExport(buildWowSyncExport({ character: {
    name: "Hallo", race: "Dwarf", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70999", interface: "16001", compatibility: "UNVERIFIED_BUILD", compatibilityNote: "Forever build 70999 has not been compatibility-tested; each observation remains API-guarded.",
  } }));
  assert.equal(newer.character.race, "Dwarf");
  assert.equal(newer.character.clientBuild, "70999");
  assert.equal(foreverBuildVerification(newer.character), "UNVERIFIED_BUILD");
  assert.deepEqual(foreverCompatibility(newer.character), {
    dashboard: "UNVERIFIED_BUILD", exporter: "UNVERIFIED_BUILD",
    exporterNote: "Forever build 70999 has not been compatibility-tested; each observation remains API-guarded.", agreement: "AGREE",
  });
});

test("partial equipment coverage is preserved, not upgraded to complete", () => {
  const raw = buildWowSyncExport({ equipment: { partial: true, slots: [] } });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.equipment.status.state, "OBSERVED");
  assert.equal(snapshot.equipment.status.completeness, "partial");
});

test("an unvisited bank renders UNKNOWN, distinct from EMPTY", () => {
  const raw = buildWowSyncExport({ bank: { unknown: true } });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.bank.status.state, "UNKNOWN");
  assert.equal(snapshot.bank.items.length, 0);
  assert.equal(snapshot.bank.itemsKnownEmpty, false);
});

test("an observed-but-empty bank is EMPTY, distinct from UNKNOWN", () => {
  const raw = buildWowSyncExport({
    bank: { containers: [{ id: -1, capacity: 24, free: 24, family: 0 }] },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.bank.status.state, "OBSERVED");
  assert.equal(snapshot.bank.itemsKnownEmpty, true);
  assert.equal(snapshot.bank.items.length, 0);
});

test("an observed Retail Warband Bank is parsed separately from the character bank", () => {
  const base = buildWowSyncExport({ character: { clientFamily: "Retail" }, bank: { unknown: true } });
  const account = [
    "[ACCOUNT BANK]",
    "State: OBSERVED; complete; observed=1700000000",
    "Scope: ACCOUNT_WARBAND",
    "Coverage: ACCOUNT/Warband purchased tabs only",
    "SnapshotVisit: 1700000000",
    "PurchasedBankTabs: 1",
    "container\tcapacity\tfree\tfamily\tbagRef",
    "ContainerStorage 12: ACCOUNT_WARBAND",
    "12\t98\t96\t0\t-",
    "Slots: 96 free / 98",
    "itemRef\tname\tqty\tbound\tvendorEachCopper",
    "item:123\tWarband Widget\t2\tyes\t10",
  ].join("\n");
  const snapshot = parseWowSyncExport(base.replace("\n\n[PROFESSIONS]", `\n\n${account}\n\n[PROFESSIONS]`));
  assert.equal(snapshot.bank.status.state, "UNKNOWN");
  assert.equal(snapshot.accountBank?.ownerScope, "ACCOUNT_WARBAND");
  assert.equal(snapshot.accountBank?.items[0]?.name, "Warband Widget");
});

test("an unknown Warband Bank stays unknown rather than becoming an empty character bank", () => {
  const base = buildWowSyncExport({ character: { clientFamily: "Retail" } });
  const account = ["[ACCOUNT BANK]", "State: UNKNOWN", "Reason: Not observed"].join("\n");
  const snapshot = parseWowSyncExport(base.replace("\n\n[PROFESSIONS]", `\n\n${account}\n\n[PROFESSIONS]`));
  assert.equal(snapshot.accountBank?.status.state, "UNKNOWN");
  assert.equal(snapshot.accountBank?.itemsKnownEmpty, false);
  assert.equal(snapshot.bank.itemsKnownEmpty, true);
});

test("an Account Bank extension is rejected for non-Retail exports", () => {
  const base = buildWowSyncExport();
  const account = ["[ACCOUNT BANK]", "State: UNKNOWN", "Reason: Not observed"].join("\n");
  assert.throws(
    () => parseWowSyncExport(base.replace("\n\n[PROFESSIONS]", `\n\n${account}\n\n[PROFESSIONS]`)),
    WowSyncParseError,
  );
});

test("an unvisited trainer renders UNKNOWN with a reason", () => {
  const raw = buildWowSyncExport({ trainer: { unknown: true } });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.trainer.status.state, "UNKNOWN");
  assert.equal(snapshot.trainer.categories.length, 0);
});

test("multiple independent trainer categories are preserved without collapsing", () => {
  const raw = buildWowSyncExport({
    trainer: {
      categories: [
        { category: "CLASS", name: "Shaman Trainer", services: [{ spellID: 8017, ability: "Frost Shock", status: "available", requiredLevel: 20, cost: 500 }] },
        { category: "PROF_MINING", name: "Mining Trainer", services: [{ spellID: 2575, ability: "Mining", status: "known" }] },
        { category: "PROF_COOKING", name: "Cooking Trainer", services: [] },
        { category: "WEAPON", name: "Weapon Trainer", state: "LAST_SEEN" },
      ],
    },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.trainer.categories.length, 4);
  const byCategory = new Map(snapshot.trainer.categories.map((c) => [c.category, c]));
  assert.equal(byCategory.get("CLASS")?.services[0].ability, "Frost Shock");
  assert.equal(byCategory.get("PROF_MINING")?.services[0].ability, "Mining");
  assert.equal(byCategory.get("WEAPON")?.status.state, "LAST_SEEN");
});

test("item variants with different itemRefs stay distinguishable", () => {
  const raw = buildWowSyncExport({
    bags: {
      containers: [
        {
          id: 0,
          capacity: 16,
          free: 14,
          items: [
            { itemRef: "item:2589::::::::60:::::", name: "Linen Cloth", qty: 5 },
            { itemRef: "item:2589:1234::::::::60:::::", name: "Linen Cloth", qty: 2 },
          ],
        },
      ],
    },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.bags.items.length, 2);
  const refs = snapshot.bags.items.map((i) => i.itemRef);
  assert.ok(refs.includes("item:2589::::::::60:::::"));
  assert.ok(refs.includes("item:2589:1234::::::::60:::::"));
});

test("rejects text that does not begin with WOWSYNC v1", () => {
  assert.throws(() => parseWowSyncExport("not an export"), (err: unknown) => {
    assert.ok(err instanceof WowSyncParseError);
    assert.match(err.message, /WOWSYNC v1/);
    return true;
  });
});

test("rejects an export missing the [END] marker (truncated paste)", () => {
  const raw = buildWowSyncExport();
  const truncated = raw.slice(0, raw.lastIndexOf("[END]") - 2);
  assert.throws(() => parseWowSyncExport(truncated), (err: unknown) => {
    assert.ok(err instanceof WowSyncParseError);
    assert.match(err.message, /\[END\]/);
    return true;
  });
});

test("rejects an export missing a required section", () => {
  const raw = buildWowSyncExport();
  const withoutTrainer = raw.replace(/\n\n\[TRAINERS\][\s\S]*?(?=\n\n\[END\])/, "");
  assert.throws(() => parseWowSyncExport(withoutTrainer), (err: unknown) => {
    assert.ok(err instanceof WowSyncParseError);
    assert.match(err.message, /TRAINER/);
    return true;
  });
});

const candidateHeader = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
const candidateLine = "EQUIPPABLE\tCONTAINER_SLOT\t0\t1\t123\titem:123\\tvariant\t?\t0\t0\t0\t4\t0\tINVTYPE_HEAD\tno\t?\tyes\tno\t?\t9\tno\tOBSERVED";
function addCandidateSection(raw: string, body: string): string {
  return raw.replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\n${body}\n\n[END]`);
}
function candidateSection(state = "partial; observed=1700000001", version: string | null = "1", row = candidateLine): string {
  return [
    `State: ${state}`,
    ...(version === null ? [] : [`ContractVersion: ${version}`]),
    "CoverageNote: pending fields",
    candidateHeader,
    row,
  ].join("\n");
}

test("parses Retail gear candidates with UNKNOWN, false, zero, optional GUID, binding facets and escaping intact", () => {
  const raw = addCandidateSection(buildWowSyncExport({ character: { clientFamily: "Retail" } }), candidateSection());
  const section = parseWowSyncExport(raw).gearCandidates!;
  assert.equal(section.contractVersion, 1);
  assert.equal(section.completeness, "partial");
  assert.equal(section.observedAt, 1700000001);
  assert.equal(section.rows.length, 1);
  const row = section.rows[0]!;
  assert.deepEqual(row.itemID, { state: "KNOWN", value: 123 });
  assert.deepEqual(row.itemString, { state: "KNOWN", value: "item:123\tvariant" });
  assert.deepEqual(row.itemGUID, { state: "UNKNOWN" });
  assert.deepEqual(row.currentItemLevel, { state: "KNOWN", value: 0 });
  assert.deepEqual(row.requiredLevel, { state: "KNOWN", value: 0 });
  assert.deepEqual(row.classID, { state: "KNOWN", value: 4 });
  assert.deepEqual(row.subclassID, { state: "KNOWN", value: 0 });
  assert.deepEqual(row.isBound, { state: "KNOWN", value: false });
  assert.deepEqual(row.boundToAccountUntilEquip, { state: "UNKNOWN" });
  assert.deepEqual(row.itemBindToAccount, { state: "KNOWN", value: true });
  assert.deepEqual(row.itemBindToAccountUntilEquip, { state: "KNOWN", value: false });
  assert.deepEqual(row.tooltipBindingType, { state: "UNKNOWN" });
  assert.deepEqual(row.tooltipBindingRawValue, { state: "KNOWN", value: 9 });
  assert.deepEqual(row.currentCharacterCanUse, { state: "KNOWN", value: false });
  const trueRow = parseWowSyncExport(addCandidateSection(buildWowSyncExport({ character: { clientFamily: "Retail" } }), candidateSection(undefined, "1", candidateLine.replace("\tno\tOBSERVED", "\tyes\tOBSERVED")))).gearCandidates!.rows[0]!;
  assert.deepEqual(trueRow.currentCharacterCanUse, { state: "KNOWN", value: true });
  const unknownRow = parseWowSyncExport(addCandidateSection(buildWowSyncExport({ character: { clientFamily: "Retail" } }), candidateSection(undefined, "1", candidateLine.replace("\tno\tOBSERVED", "\t?\tOBSERVED")))).gearCandidates!.rows[0]!;
  assert.deepEqual(unknownRow.currentCharacterCanUse, { state: "UNKNOWN" });
});

test("tooltipBindingRawValue preserves UNKNOWN and finite negative, fractional and zero values", () => {
  const base = buildWowSyncExport({ character: { clientFamily: "Retail" } });
  const rowWithRawValue = (value: string) => {
    const columns = candidateLine.split("\t");
    columns[18] = value;
    return columns.join("\t");
  };
  const parsedValue = (value: string) => parseWowSyncExport(
    addCandidateSection(base, candidateSection(undefined, "1", rowWithRawValue(value))),
  ).gearCandidates!.rows[0]!.tooltipBindingRawValue;

  assert.deepEqual(parsedValue("?"), { state: "UNKNOWN" });
  assert.deepEqual(parsedValue("0"), { state: "KNOWN", value: 0 });
  assert.deepEqual(parsedValue("-1"), { state: "KNOWN", value: -1 });
  assert.deepEqual(parsedValue("1.5"), { state: "KNOWN", value: 1.5 });
  assert.throws(() => parsedValue("Infinity"), /expected a finite number or "\?"/);
});

test("gear candidates are optional, captured-empty is distinct, and candidate section is Retail-only", () => {
  const legacy = parseWowSyncExport(buildWowSyncExport({ character: { clientFamily: "Retail" } }));
  assert.equal(legacy.gearCandidates, undefined);
  const empty = addCandidateSection(buildWowSyncExport({ character: { clientFamily: "Retail" } }), ["State: complete; observed=0", "ContractVersion: 1", candidateHeader, "Candidates: None observed"].join("\n"));
  assert.deepEqual(parseWowSyncExport(empty).gearCandidates?.rows, []);
  const unresolvedRow = candidateLine.replace("EQUIPPABLE\tCONTAINER_SLOT\t0\t1", "UNKNOWN\t?\t?\t?").replace("\tno\tOBSERVED", "\t?\tLAST_SEEN");
  const unresolved = addCandidateSection(buildWowSyncExport({ character: { clientFamily: "Retail" } }), candidateSection("unknown; observed=?", "1", unresolvedRow));
  const unresolvedCandidate = parseWowSyncExport(unresolved).gearCandidates!.rows[0]!;
  assert.deepEqual(unresolvedCandidate.locationType, { state: "UNKNOWN" });
  assert.deepEqual(unresolvedCandidate.containerID, { state: "UNKNOWN" });
  assert.deepEqual(unresolvedCandidate.slot, { state: "UNKNOWN" });
  assert.equal(unresolvedCandidate.candidateState, "UNKNOWN");
  assert.equal(unresolvedCandidate.observationState, "LAST_SEEN");
  const classic = addCandidateSection(buildWowSyncExport(), candidateSection());
  assert.throws(() => parseWowSyncExport(classic), /only valid for a Retail export/);
});

test("gear candidate contract version, malformed rows and unrelated unknown sections fail clearly", () => {
  const base = buildWowSyncExport({ character: { clientFamily: "Retail" } });
  assert.throws(() => parseWowSyncExport(addCandidateSection(base, candidateSection(undefined, null))), /Expected a line starting with "ContractVersion:/);
  assert.throws(() => parseWowSyncExport(addCandidateSection(base, candidateSection(undefined, "2"))), /Unsupported \[GEAR CANDIDATES\] ContractVersion/);
  assert.throws(() => parseWowSyncExport(addCandidateSection(base, candidateSection(undefined, "1", candidateLine.replace("\tno\t?\tyes", "\tfalse\t?\tyes")))), /expected "yes", "no" or "\?"/);
  const unknown = base.replace("\n\n[END]", "\n\n[UNRELATED FUTURE SECTION]\nvalue\n\n[END]");
  assert.throws(() => parseWowSyncExport(unknown), /Unknown section "\[UNRELATED FUTURE SECTION\]"/);
});

test("rejects a row with more columns than the section defines", () => {
  const raw = buildWowSyncExport();
  const corrupted = raw.replace(
    "slot\titemRef\tname\tilvl\trequiredLevel\teffectiveStats",
    "slot\titemRef\tname\tilvl\trequiredLevel\teffectiveStats\textraColumn",
  );
  assert.throws(() => parseWowSyncExport(corrupted), WowSyncParseError);
});

test("tolerates a row with fewer columns than expected (trailing whitespace trimmed by copy/paste)", () => {
  const raw = buildWowSyncExport();
  // A trailing tab (an empty last column) is a common casualty of pasting
  // through chat boxes/editors that trim trailing whitespace — this must
  // not be treated as a structural parse error.
  const shortened = raw.replace(
    "slot\titemRef\tname\tilvl\trequiredLevel\teffectiveStats",
    "slot\titemRef\tname\tilvl\trequiredLevel",
  );
  const snapshot = parseWowSyncExport(shortened);
  assert.equal(snapshot.equipment.status.state, "OBSERVED");
});

test("empty input is rejected with a clear message", () => {
  assert.throws(() => parseWowSyncExport(""), (err: unknown) => {
    assert.ok(err instanceof WowSyncParseError);
    assert.match(err.message, /empty/i);
    return true;
  });
});

test("parsing is deterministic: identical input yields identical structured output", () => {
  const raw = buildWowSyncExport({
    character: { name: "Voodan", moneyCopper: 54321 },
    bags: { containers: [{ id: 0, capacity: 16, free: 10, items: [{ itemRef: "item:1234", name: "Thing", qty: 3 }] }] },
  });
  const a = parseWowSyncExport(raw);
  const b = parseWowSyncExport(raw);
  assert.deepEqual(a, b);
});

test("escaped tab/newline/backslash characters in values round-trip correctly", () => {
  const raw = buildWowSyncExport({ location: { zone: "Zone\\With\\Backslash" } });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.location.zone, "Zone\\With\\Backslash");
});
