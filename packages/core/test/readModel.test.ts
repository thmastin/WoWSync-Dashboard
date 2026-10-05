import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const NOW = 1_800_000_000;
function retail(name: string, realm: string, moneyCopper?: number) {
  return buildWowSyncExport({ generatedAt: NOW - 10, character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", moneyCopper }, equipment: { slots: [{ slot: 1, slotName: "Head", itemRef: "item:1", name: "Observed Helm", itemLevel: 279 }] } });
}
function classic(name: string, realm: string) { return buildWowSyncExport({ generatedAt: NOW - 20, character: { name, realm, clientVersion: "1.15.9" } }); }

test("read model requires a version and cannot leak a same-named Classic character into Retail", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(classic("Twin", "Era"));
    store.importSnapshot(retail("Twin", "Cairne", 0));
    const read = new DashboardReadModel(store, () => NOW);
    assert.throws(() => read.listCharacters({ version: undefined as never }), /version is required/);
    const result = read.getCharacterSummary({ version: "retail", name: "Twin", realm: "Cairne" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.data?.realm, "Cairne");
      assert.equal(result.value.data?.goldCopper, 0, "observed zero remains a real zero");
      assert.equal(result.value.provenance.version, "retail");
    }
  } finally { store.close(); }
});

test("same-name realm matches are ambiguity, never a silent choice", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(retail("Twin", "Cairne"));
    store.importSnapshot(retail("Twin", "Thrall"));
    const result = new DashboardReadModel(store, () => NOW).getCharacterEquipment({ version: "retail", name: "Twin" });
    assert.equal(result.status, "AMBIGUOUS");
    if (result.status === "AMBIGUOUS") assert.deepEqual(result.candidates.map((entry) => entry.realm).sort(), ["Cairne", "Thrall"]);
  } finally { store.close(); }
});

test("unknown sections remain UNKNOWN rather than empty and profession coverage is DERIVED", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Ghost", realm: "Era", clientVersion: "1.15.9" }, equipment: { unknown: true }, bags: { unknown: true }, professions: { unknown: true } }));
    const read = new DashboardReadModel(store, () => NOW);
    const equipment = read.getCharacterEquipment({ version: "classic-era", name: "Ghost", realm: "Era" });
    assert.equal(equipment.status, "FOUND");
    if (equipment.status === "FOUND") {
      assert.equal(equipment.value.provenance.state, "UNKNOWN");
      assert.equal(equipment.value.data, undefined);
    }
    const bags = read.getCharacterStorage({ version: "classic-era", name: "Ghost", realm: "Era", storage: "bags" });
    assert.equal(bags.status, "FOUND");
    if (bags.status === "FOUND") {
      assert.equal(bags.value.data?.sectionState, "UNKNOWN");
      assert.equal(bags.value.data?.itemsKnownEmpty, false);
      assert.equal(bags.value.data?.items, undefined);
    }
    const coverage = read.getProfessionCoverage({ version: "classic-era" });
    assert.equal(coverage.provenance.state, "DERIVED");
    assert.ok(coverage.data?.coverage.every((entry) => entry.coverageStatus === "unknown"));
  } finally { store.close(); }
});

test("observed-empty character storage remains distinct from UNKNOWN", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Empty", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" }, bags: { containers: [] } }));
    const result = new DashboardReadModel(store, () => NOW).getCharacterStorage({ version: "retail", name: "Empty", realm: "Cairne", storage: "bags" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.provenance.state, "OBSERVED");
      assert.equal(result.value.data?.itemsKnownEmpty, true);
      assert.deepEqual(result.value.data?.items, []);
    }
  } finally { store.close(); }
});

test("LAST_SEEN section provenance is retained as historical, never current", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Historian", realm: "Era", clientVersion: "1.15.9" }, professions: { entries: [{ name: "Alchemy", skill: 1, maxSkill: 300 }] } }));
    const originalListSnapshots = store.listSnapshots.bind(store);
    store.listSnapshots = (identityKey) => originalListSnapshots(identityKey).map((snapshot) => ({ ...snapshot, parsed: { ...snapshot.parsed, professions: { ...snapshot.parsed.professions, status: { ...snapshot.parsed.professions.status, state: "LAST_SEEN" } } } }));
    const result = new DashboardReadModel(store, () => NOW).getCharacterProfessions({ version: "classic-era", name: "Historian", realm: "Era" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.provenance.state, "LAST_SEEN");
      assert.match(result.value.provenance.warning ?? "", /historical/i);
    }
  } finally { store.close(); }
});

test("gear candidate read preserves per-character snapshot provenance, row state, captured-empty and missing sidecars", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const append = (raw: string, body: string) => raw.replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\n${body}\n\n[END]`);
    const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
    const raw = append(retail("Evidence", "Cairne"), `State: partial; observed=${NOW - 20}\nContractVersion: 1\n${header}\nEQUIPPABLE\tCONTAINER_SLOT\t0\t1\t123\titem:123\t?\t0\t0\t0\t4\t0\tINVTYPE_HEAD\tno\t?\tyes\tno\t?\t9\tno\tLAST_SEEN`);
    store.importSnapshot(raw);
    // Newer export lacks the optional sidecar; the latest captured sidecar remains explicitly historical.
    store.importSnapshot(retail("Evidence", "Cairne").replace("Generated: 1800000000", `Generated: ${NOW - 10}`));
    store.importSnapshot(retail("NoEvidence", "Cairne"));
    const result = new DashboardReadModel(store, () => NOW).getGearCandidateEvidence({ version: "retail" });
    assert.equal(result.provenance.state, "DERIVED");
    const evidence = result.data?.characters.find((entry) => entry.identity.name === "Evidence")!;
    assert.equal(evidence.captured, true);
    assert.equal(evidence.identity.identityKey, "retail::cairne::evidence");
    assert.equal(evidence.snapshot?.snapshotId, store.listSnapshots(evidence.identity.identityKey)[1]?.id);
    assert.equal(evidence.snapshot?.freshness, "stale", "snapshot freshness is computed separately from the row evidence state");
    assert.equal(evidence.snapshot?.candidateObservedAt, NOW - 20);
    assert.equal(evidence.snapshot?.candidateFreshness, "recent", "sidecar observation age is computed independently of snapshot import timing");
    assert.equal(evidence.sidecar?.rows[0]?.observationState, "LAST_SEEN");
    assert.equal(evidence.sidecar?.observedAt, NOW - 20);
    assert.deepEqual(evidence.sidecar?.rows[0]?.currentCharacterCanUse, { state: "KNOWN", value: false });
    assert.deepEqual(evidence.sidecar?.rows[0]?.isBound, { state: "KNOWN", value: false });
    assert.deepEqual(evidence.sidecar?.rows[0]?.boundToAccountUntilEquip, { state: "UNKNOWN" });
    assert.deepEqual(evidence.sidecar?.rows[0]?.itemBindToAccount, { state: "KNOWN", value: true });
    assert.deepEqual(evidence.sidecar?.rows[0]?.itemBindToAccountUntilEquip, { state: "KNOWN", value: false });
    assert.deepEqual(evidence.sidecar?.rows[0]?.tooltipBindingRawValue, { state: "KNOWN", value: 9 });
    const unavailable = result.data?.characters.find((entry) => entry.identity.name === "NoEvidence")!;
    assert.equal(unavailable.captured, false);
    assert.equal(unavailable.sidecar, undefined);
    const empty = append(retail("EmptyEvidence", "Cairne"), `State: complete; observed=0\nContractVersion: 1\n${header}\nCandidates: None observed`);
    store.importSnapshot(empty);
    const emptyResult = new DashboardReadModel(store, () => NOW).getGearCandidateEvidence({ version: "retail" }).data?.characters.find((entry) => entry.identity.name === "EmptyEvidence");
    assert.equal(emptyResult?.captured, true);
    assert.deepEqual(emptyResult?.sidecar?.rows, []);
    assert.equal(new DashboardReadModel(store, () => NOW).getGearCandidateEvidence({ version: "classic-era" }).provenance.state, "UNKNOWN");
  } finally { store.close(); }
});

test("Retail gear candidate recipient screen applies checked rules and preserves row occurrences", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
  const row = (requiredLevel: string, observationState = "OBSERVED", currentCanUse = "yes", bound = "no") => ["EQUIPPABLE", "CONTAINER_SLOT", "0", "1", "123", "item:123:variant", "guid-not-identity", "1", "0", requiredLevel, "4", "4", "INVTYPE_HEAD", bound, "?", "yes", "no", "?", "0", currentCanUse, observationState].join("\t");
  const exportWithCandidates = (name: string, realm: string, level: number, rows: string[], generatedAt: number) => {
    const raw = buildWowSyncExport({ generatedAt, character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", level } });
    return raw.replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\nState: partial; observed=${generatedAt}\nContractVersion: 1\n${header}\n${rows.length ? rows.join("\n") : "Candidates: None observed"}\n\n[END]`);
  };
  try {
    const exporterText = exportWithCandidates("Exporter", "Cairne", 90, [row("91", "OBSERVED", "no", "yes"), row("0", "OBSERVED", "no", "yes"), row("?", "LAST_SEEN"), row("91"), row("90")], NOW - 30);
    store.importSnapshot(exporterText);
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 5, character: { name: "Recipient", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 90 } }));
    const read = new DashboardReadModel(store, () => NOW);
    const result = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne", offset: 0, limit: 10 });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND") return;
    const screen = result.value.data!;
    assert.equal(screen.accountMembership, "NOT_ESTABLISHED_BY_DASHBOARD_IDENTITY");
    assert.match(screen.accountMembershipCaveat, /does not establish/);
    assert.match(screen.uncheckedRestrictions, /native armor-family plausibility/);
    assert.equal(screen.exporter.name, "Exporter");
    assert.equal(screen.recipient.name, "Recipient");
    assert.equal(screen.candidateEvidence.captured, true);
    assert.equal(screen.candidateEvidence.totalCount, 5);
    assert.deepEqual(screen.candidateEvidence.rows?.map((entry) => [entry.rowOrdinal, entry.result]), [
      [1, "RULED_OUT"], [2, "NOT_RULED_OUT_BY_CHECKED_RULES"], [3, "UNKNOWN"], [4, "RULED_OUT"], [5, "NOT_RULED_OUT_BY_CHECKED_RULES"],
    ]);
    assert.match(screen.candidateEvidence.rows?.[0]?.reason ?? "", /required level 91.*recipient observed level 90/);
    assert.deepEqual(screen.candidateEvidence.rows?.[0]?.candidate.currentCharacterCanUse, { state: "KNOWN", value: false }, "exporter's false value is preserved and does not decide recipient screening");
    assert.deepEqual(screen.candidateEvidence.rows?.[0]?.candidate.boundToAccountUntilEquip, { state: "UNKNOWN" });
    assert.deepEqual(screen.candidateEvidence.rows?.[0]?.candidate.itemBindToAccount, { state: "KNOWN", value: true });
    assert.deepEqual(screen.candidateEvidence.rows?.[1]?.candidate.isBound, { state: "KNOWN", value: true });
    assert.equal(screen.candidateEvidence.rows?.[1]?.result, "NOT_RULED_OUT_BY_CHECKED_RULES", "binding evidence is not a required-level rule");
    assert.equal(screen.candidateEvidence.rows?.[0]?.observationState, "OBSERVED");
    assert.equal(screen.candidateEvidence.rows?.[2]?.observationState, "LAST_SEEN", "historical row state stays separate from age/freshness");
    assert.ok(screen.candidateEvidence.snapshot!.candidateFreshness);
    assert.ok(screen.candidateEvidence.snapshot!.freshness);
    assert.equal(screen.recipientLevel.evidence.state, "KNOWN");
    assert.equal(screen.recipientLevel.evidence.value, 90);
    assert.deepEqual(screen.recipientClass.evidence, { state: "KNOWN", value: "Warrior", normalizedClass: "WARRIOR", sectionState: "OBSERVED" });
    assert.equal(screen.recipientClass.snapshot?.snapshotId, screen.recipientLevel.snapshot?.snapshotId);
    assert.equal(screen.recipientLevel.snapshot?.snapshotId, store.listSnapshots("retail::cairne::recipient")[0]?.id);
    assert.equal("candidateId" in (screen.candidateEvidence.rows?.[0] ?? {}), false);
    assert.ok(screen.candidateEvidence.rows?.every((entry) => ["RULED_OUT", "NOT_RULED_OUT_BY_CHECKED_RULES", "UNKNOWN"].includes(entry.result)));
    for (const unsupportedField of ["canEquip", "upgrade", "transferable", "demand", "allocation", "surplus", "disposition"]) assert.equal(unsupportedField in screen, false);

    const duplicateRows = exportWithCandidates("DuplicateExporter", "Cairne", 90, [row("89"), row("89")], NOW - 10);
    store.importSnapshot(duplicateRows);
    const duplicate = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "DuplicateExporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne", offset: 1, limit: 1 });
    assert.equal(duplicate.status, "FOUND");
    if (duplicate.status === "FOUND") {
      assert.equal(duplicate.value.data?.candidateEvidence.totalCount, 2);
      assert.equal(duplicate.value.data?.candidateEvidence.rows?.[0]?.rowOrdinal, 2);
      assert.deepEqual(duplicate.value.data?.candidateEvidence.rows?.[0]?.candidate.itemString, { state: "KNOWN", value: "item:123:variant" });
      assert.deepEqual(duplicate.value.data?.candidateEvidence.rows?.[0]?.candidate.itemGUID, { state: "KNOWN", value: "guid-not-identity" });
      assert.deepEqual(duplicate.value.data?.candidateEvidence.rows?.[0]?.candidate.locationType, { state: "KNOWN", value: "CONTAINER_SLOT" });
    }

    const zeroLevelText = exportWithCandidates("ZeroCandidate", "Cairne", 90, [row("0")], NOW - 7);
    store.importSnapshot(zeroLevelText);
    const zeroCandidate = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "ZeroCandidate", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" });
    assert.equal(zeroCandidate.status, "FOUND");
    if (zeroCandidate.status === "FOUND") assert.equal(zeroCandidate.value.data?.candidateEvidence.rows?.[0]?.result, "NOT_RULED_OUT_BY_CHECKED_RULES", "known requiredLevel zero remains a real passing value");

    const emptyText = exportWithCandidates("EmptyCandidate", "Cairne", 90, [], NOW - 3);
    store.importSnapshot(emptyText);
    const empty = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "EmptyCandidate", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" });
    assert.equal(empty.status, "FOUND");
    if (empty.status === "FOUND") {
      assert.equal(empty.value.data?.candidateEvidence.captured, true);
      assert.deepEqual(empty.value.data?.candidateEvidence.rows, []);
      assert.equal(empty.value.data?.candidateEvidence.totalCount, 0);
    }

    const unavailable = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Recipient", exporterRealm: "Cairne", recipientName: "Exporter", recipientRealm: "Cairne" });
    assert.equal(unavailable.status, "FOUND");
    if (unavailable.status === "FOUND") {
      assert.equal(unavailable.value.data?.candidateEvidence.captured, false);
      assert.equal(unavailable.value.data?.candidateEvidence.rows, undefined);
      assert.match(unavailable.value.data?.candidateEvidence.reason ?? "", /unavailable, not an empty/);
    }

    assert.equal(read.getGearCandidateRecipientScreen({ version: "classic-era", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" }).status, "UNSUPPORTED_VERSION");
    for (const version of ["tbc-anniversary", "forever", "unknown-version"] as const) {
      assert.equal(read.getGearCandidateRecipientScreen({ version, exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" }).status, "UNSUPPORTED_VERSION", `${version} must remain outside the Retail-only recipient screen`);
    }
    assert.equal(read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "missing", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" }).status, "EXPORTER_NOT_FOUND");
    assert.equal(read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "missing", recipientRealm: "Cairne" }).status, "RECIPIENT_NOT_FOUND");
  } finally { store.close(); }
});

test("recipient screen does not compare against a non-OBSERVED or UNKNOWN recipient level and never guesses ambiguous identity", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
    const row = "EQUIPPABLE\tCONTAINER_SLOT\t0\t1\t123\titem:123\t?\t1\t0\t91\t4\t4\tINVTYPE_HEAD\t?\t?\t?\t?\t?\t?\t?\tOBSERVED";
    const exporter = buildWowSyncExport({ generatedAt: NOW - 20, character: { name: "Exporter", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 90 } }).replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\nState: complete; observed=${NOW - 20}\nContractVersion: 1\n${header}\n${row}\n\n[END]`);
    const recipient = buildWowSyncExport({ generatedAt: NOW - 10, character: { name: "Recipient", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 90 } });
    store.importSnapshot(exporter);
    store.importSnapshot(recipient);
    const originalSnapshots = store.listSnapshots.bind(store);
    store.listSnapshots = (identityKey) => originalSnapshots(identityKey).map((snapshot) => identityKey === "retail::cairne::recipient" ? { ...snapshot, parsed: { ...snapshot.parsed, character: { ...snapshot.parsed.character, status: { ...snapshot.parsed.character.status, state: "LAST_SEEN" } } } } : snapshot);
    const read = new DashboardReadModel(store, () => NOW);
    const historicalLevel = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" });
    assert.equal(historicalLevel.status, "FOUND");
    if (historicalLevel.status === "FOUND") {
      assert.deepEqual(historicalLevel.value.data?.recipientLevel.evidence, { state: "UNKNOWN", value: 90, sectionState: "LAST_SEEN", reason: "Recipient character level provenance is LAST_SEEN; only OBSERVED level evidence is used for this screen." });
      assert.equal(historicalLevel.value.data?.candidateEvidence.rows?.[0]?.result, "UNKNOWN");
    }
    store.listSnapshots = (identityKey) => originalSnapshots(identityKey).map((snapshot) => identityKey === "retail::cairne::recipient" ? { ...snapshot, parsed: { ...snapshot.parsed, character: { ...snapshot.parsed.character, level: undefined } } } : snapshot);
    const unknownLevel = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" });
    assert.equal(unknownLevel.status, "FOUND");
    if (unknownLevel.status === "FOUND") {
      assert.equal(unknownLevel.value.data?.recipientLevel.evidence.state, "UNKNOWN");
      assert.equal(unknownLevel.value.data?.candidateEvidence.rows?.[0]?.result, "UNKNOWN");
    }
    store.listSnapshots = originalSnapshots;
    const originals = store.listCharacters.bind(store);
    store.listCharacters = (version) => {
      const chars = originals(version);
      const duplicate = chars.find((character) => character.name === "Exporter")!;
      return [...chars, { ...duplicate, identityKey: `${duplicate.identityKey}::duplicate` }];
    };
    assert.equal(read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" }).status, "EXPORTER_AMBIGUOUS");
    store.listCharacters = (version) => {
      const chars = originals(version);
      const duplicate = chars.find((character) => character.name === "Recipient")!;
      return [...chars, { ...duplicate, identityKey: `${duplicate.identityKey}::duplicate` }];
    };
    assert.equal(read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" }).status, "RECIPIENT_AMBIGUOUS");
  } finally { store.close(); }
});

test("Retail recipient screen applies native armor-family checks only to coherent ordinary body armor", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
  const makeRow = (opts: { equipType: string; baseLocation: string; classID?: string; subclassID?: string; requiredLevel?: string; state?: string }) => [
    "EQUIPPABLE", "CONTAINER_SLOT", "0", "1", "123", "item:123", "?", opts.equipType, "0", opts.requiredLevel ?? "0", opts.classID ?? "4", opts.subclassID ?? "4", opts.baseLocation, "?", "?", "?", "?", "?", "?", "?", opts.state ?? "OBSERVED",
  ].join("\t");
  const familyRows = [
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", subclassID: "1" }),
    makeRow({ equipType: "3", baseLocation: "INVTYPE_SHOULDER", subclassID: "2" }),
    makeRow({ equipType: "5", baseLocation: "INVTYPE_CHEST", subclassID: "3" }),
    makeRow({ equipType: "20", baseLocation: "INVTYPE_ROBE", subclassID: "4" }),
  ];
  const nonApplicableRows = [
    makeRow({ equipType: "2", baseLocation: "INVTYPE_NECK", subclassID: "0" }),
    makeRow({ equipType: "11", baseLocation: "INVTYPE_FINGER", subclassID: "0" }),
    makeRow({ equipType: "12", baseLocation: "INVTYPE_TRINKET", subclassID: "0" }),
    makeRow({ equipType: "16", baseLocation: "INVTYPE_CLOAK", subclassID: "0" }),
    makeRow({ equipType: "14", baseLocation: "INVTYPE_SHIELD", subclassID: "6" }),
    makeRow({ equipType: "23", baseLocation: "INVTYPE_HOLDABLE", subclassID: "0" }),
    makeRow({ equipType: "13", baseLocation: "INVTYPE_WEAPON", classID: "2", subclassID: "7" }),
    makeRow({ equipType: "4", baseLocation: "INVTYPE_BODY", subclassID: "0" }),
    makeRow({ equipType: "19", baseLocation: "INVTYPE_TABARD", subclassID: "0" }),
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", subclassID: "5" }),
  ];
  const uncertainRows = [
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", classID: "?", subclassID: "4" }),
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", subclassID: "?" }),
    makeRow({ equipType: "?", baseLocation: "INVTYPE_HEAD", subclassID: "1" }),
    makeRow({ equipType: "1", baseLocation: "INVTYPE_FINGER", subclassID: "1" }),
    makeRow({ equipType: "999", baseLocation: "INVTYPE_HEAD", subclassID: "1" }),
    makeRow({ equipType: "11", baseLocation: "INVTYPE_NECK", subclassID: "1" }),
  ];
  const compositionRows = [
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", classID: "?", subclassID: "?", requiredLevel: "91" }),
    makeRow({ equipType: "5", baseLocation: "INVTYPE_CHEST", subclassID: "3", requiredLevel: "?" }),
    makeRow({ equipType: "20", baseLocation: "INVTYPE_ROBE", subclassID: "4", requiredLevel: "0" }),
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", subclassID: "?", requiredLevel: "?" }),
  ];
  const allRows = [...familyRows, ...nonApplicableRows, ...uncertainRows, ...compositionRows];
  const addCandidates = (name: string, realm: string, generatedAt: number, rows: string[]) => buildWowSyncExport({ generatedAt, character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", class: "Warrior", level: 90 } })
    .replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\nState: complete; observed=${generatedAt}\nContractVersion: 1\n${header}\n${rows.join("\n")}\n\n[END]`);
  const addRecipient = (name: string, cls: string, generatedAt: number) => store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name, realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: cls, level: 90 } }));
  const screen = (recipientName: string) => {
    const result = new DashboardReadModel(store, () => NOW).getGearCandidateRecipientScreen({ version: "retail", exporterName: "ArmorExporter", exporterRealm: "Cairne", recipientName, recipientRealm: "Cairne", limit: 100 });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND") throw new Error("Expected recipient screen");
    return result.value.data!;
  };
  try {
    store.importSnapshot(addCandidates("ArmorExporter", "Cairne", NOW - 40, allRows));
    addRecipient("MageRecipient", "Mage", NOW - 30);
    addRecipient("RogueRecipient", "Rogue", NOW - 29);
    addRecipient("HunterRecipient", "Hunter", NOW - 28);
    addRecipient("WarriorRecipient", "Warrior", NOW - 27);

    const expected = [
      ["MageRecipient", "Cloth"], ["RogueRecipient", "Leather"], ["HunterRecipient", "Mail"], ["WarriorRecipient", "Plate"],
    ] as const;
    for (const [name, nativeFamily] of expected) {
      const result = screen(name);
      assert.deepEqual(result.recipientClass.evidence, { state: "KNOWN", value: name.replace("Recipient", ""), normalizedClass: name.replace("Recipient", "").toUpperCase(), sectionState: "OBSERVED" });
      const matchingRow = result.candidateEvidence.rows?.find((row) => row.armorCheck.candidateFamily === nativeFamily);
      assert.equal(matchingRow?.armorCheck.state, "PASS", `${name} should pass native ${nativeFamily}`);
    }
    const mageRows = screen("MageRecipient").candidateEvidence.rows!;
    const magePlate = mageRows[3]!;
    assert.equal(magePlate.result, "RULED_OUT");
    assert.equal(magePlate.armorCheck.state, "RULED_OUT");
    assert.match(magePlate.armorCheck.reason, /native armor-family mismatch/i);
    assert.doesNotMatch(magePlate.armorCheck.reason, /cannot equip|CanEquip=false|technically prohibited|unusable by client/i);
    const warriorRows = screen("WarriorRecipient").candidateEvidence.rows!;
    assert.equal(warriorRows[2]?.armorCheck.state, "RULED_OUT", "Warrior + Mail body armor is a native-family mismatch");
    const mageUnknownRows = screen("MageRecipient").candidateEvidence.rows!;
    assert.equal(mageUnknownRows[familyRows.length + nonApplicableRows.length + 5]?.armorCheck.state, "UNKNOWN", "a known ring inventory type that conflicts with necklace baseEquipLocation is not silently treated as non-applicable");

    const unknownClassExport = buildWowSyncExport({ generatedAt: NOW - 26, character: { name: "UnknownClassRecipient", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: "Wizard", level: 90 } });
    store.importSnapshot(unknownClassExport);
    const unknownClass = screen("UnknownClassRecipient");
    assert.equal(unknownClass.recipientClass.evidence.state, "UNKNOWN");
    assert.equal(unknownClass.candidateEvidence.rows?.[0]?.armorCheck.state, "UNKNOWN");

    const missingClassExport = buildWowSyncExport({ generatedAt: NOW - 25, character: { name: "MissingClassRecipient", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: "Warrior", level: 90 } }).replace("Class: Warrior", "Class: ?");
    store.importSnapshot(missingClassExport);
    const missingClass = screen("MissingClassRecipient");
    assert.equal(missingClass.recipientClass.evidence.state, "UNKNOWN");
    assert.equal(missingClass.candidateEvidence.rows?.[0]?.armorCheck.state, "UNKNOWN");

    const originalListSnapshots = store.listSnapshots.bind(store);
    store.listSnapshots = (identityKey) => originalListSnapshots(identityKey).map((snapshot) => identityKey === "retail::cairne::warriorrecipient" ? { ...snapshot, parsed: { ...snapshot.parsed, character: { ...snapshot.parsed.character, status: { ...snapshot.parsed.character.status, state: "LAST_SEEN" } } } } : snapshot);
    const lastSeenClass = screen("WarriorRecipient");
    assert.equal(lastSeenClass.recipientClass.evidence.state, "UNKNOWN");
    assert.equal(lastSeenClass.recipientClass.evidence.sectionState, "LAST_SEEN");
    assert.equal(lastSeenClass.candidateEvidence.rows?.[0]?.armorCheck.state, "UNKNOWN");
    store.listSnapshots = (identityKey) => originalListSnapshots(identityKey).map((snapshot) => identityKey === "retail::cairne::warriorrecipient" ? { ...snapshot, parsed: { ...snapshot.parsed, character: { status: { state: "UNKNOWN" } } } } : snapshot);
    const unknownSection = screen("WarriorRecipient");
    assert.equal(unknownSection.recipientClass.evidence.state, "UNKNOWN");
    assert.equal(unknownSection.recipientClass.evidence.sectionState, "UNKNOWN");
    assert.equal(unknownSection.candidateEvidence.rows?.[0]?.armorCheck.state, "UNKNOWN");
    store.listSnapshots = originalListSnapshots;

    const missingClassNonArmor = addCandidates("NonArmorExporter", "Cairne", NOW - 24, nonApplicableRows);
    store.importSnapshot(missingClassNonArmor);
    const originalClasses = store.listSnapshots.bind(store);
    store.listSnapshots = (identityKey) => originalClasses(identityKey).map((snapshot) => identityKey === "retail::cairne::missingclassrecipient" ? { ...snapshot, parsed: { ...snapshot.parsed, character: { ...snapshot.parsed.character, class: undefined } } } : snapshot);
    const nonArmorResult = new DashboardReadModel(store, () => NOW).getGearCandidateRecipientScreen({ version: "retail", exporterName: "NonArmorExporter", exporterRealm: "Cairne", recipientName: "MissingClassRecipient", recipientRealm: "Cairne" });
    assert.equal(nonArmorResult.status, "FOUND");
    if (nonArmorResult.status === "FOUND") {
      assert.ok(nonArmorResult.value.data?.candidateEvidence.rows?.every((row) => row.armorCheck.state === "NOT_APPLICABLE" && row.result === "NOT_RULED_OUT_BY_CHECKED_RULES"));
    }
    store.listSnapshots = originalClasses;

    const composeExporter = addCandidates("ComposeExporter", "Cairne", NOW - 23, compositionRows);
    store.importSnapshot(composeExporter);
    const compose = new DashboardReadModel(store, () => NOW).getGearCandidateRecipientScreen({ version: "retail", exporterName: "ComposeExporter", exporterRealm: "Cairne", recipientName: "WarriorRecipient", recipientRealm: "Cairne" });
    assert.equal(compose.status, "FOUND");
    if (compose.status === "FOUND") {
      assert.deepEqual(compose.value.data?.candidateEvidence.rows?.map((row) => [row.result, row.armorCheck.state]), [
        ["RULED_OUT", "UNKNOWN"], ["RULED_OUT", "RULED_OUT"], ["NOT_RULED_OUT_BY_CHECKED_RULES", "PASS"], ["UNKNOWN", "UNKNOWN"],
      ]);
    }
    assert.match(screen("WarriorRecipient").uncheckedRestrictions, /native-family mismatch is a plausibility-screen result/i);
    assert.match(screen("WarriorRecipient").uncheckedRestrictions, /allowed-class, race, faction, profession, unique\/equip/i);
  } finally { store.close(); }
});

test("snapshot history is compact metadata and never leaks raw export text", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(retail("Archivist", "Cairne", 123));
    const result = new DashboardReadModel(store, () => NOW).getCharacterSnapshotHistory({ version: "retail", name: "Archivist", realm: "Cairne" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      const history = result.value.data;
      assert.equal(result.value.provenance.state, "DERIVED");
      assert.equal(history?.items[0]?.moneyCopper, 123);
      assert.equal("parsed" in (history?.items[0] ?? {}), false);
      assert.equal("raw" in (history?.items[0] ?? {}), false);
    }
  } finally { store.close(); }
});

test("shared storage stays Retail-only and its projection is explicitly DERIVED", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const read = new DashboardReadModel(store, () => NOW);
    assert.equal(read.getSharedStorage({ version: "classic-era" }).provenance.state, "UNKNOWN");
    const retailStorage = read.getSharedStorage({ version: "retail" });
    assert.equal(retailStorage.provenance.state, "DERIVED");
    assert.equal(retailStorage.data?.warband, null);
    assert.deepEqual(retailStorage.data?.guilds, []);
  } finally { store.close(); }
});

test("uncaptured Renown is explicitly UNKNOWN and separate from research", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(retail("Virek", "Cairne"));
    const result = new DashboardReadModel(store, () => NOW).getRenown({ version: "retail", name: "Virek", realm: "Cairne" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.provenance.state, "UNKNOWN");
      assert.match(result.value.provenance.reason ?? "", /does not currently capture Renown/);
    }
  } finally { store.close(); }
});

test("bounded item and character-storage reads preserve version, section state, and metadata evidence", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const captured = buildWowSyncExport({
      generatedAt: NOW - 10,
      character: { name: "Squashpot", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      bags: { containers: [{ id: 0, capacity: 20, free: 18, items: [{ itemRef: "item:12345", name: "Midnight Thread", qty: 2 }] }] },
      bank: { containers: [{ id: 1, capacity: 28, free: 27, items: [{ itemRef: "item:23456", name: "Moonlit Hide", qty: 1 }] }] },
    }) .replace(/\n\[END\]$/, "") + "\n\n[ITEM METADATA]\nbaseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent\n12345\t7\t5\t1\t11\tyes\n\n[END]";
    store.importSnapshot(captured);
    store.importSnapshot(buildWowSyncExport({ character: { name: "Squashpot", realm: "Era", clientVersion: "1.15.9" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:12345", name: "Old Thread", qty: 7 }] }] } }));
    const read = new DashboardReadModel(store, () => NOW);
    const bags = read.getCharacterStorage({ version: "retail", name: "Squashpot", realm: "Cairne", storage: "bags" });
    assert.equal(bags.status, "FOUND");
    if (bags.status === "FOUND") {
      assert.equal(bags.value.provenance.state, "OBSERVED");
      assert.equal(bags.value.data?.items?.[0]?.name, "Midnight Thread");
      assert.equal(bags.value.data?.metadata[0]?.state, "KNOWN");
      assert.equal(bags.value.data?.metadata[0]?.value?.expansion.state, "KNOWN");
    }
    const bank = read.getCharacterStorage({ version: "retail", name: "Squashpot", realm: "Cairne", storage: "bank" });
    assert.equal(bank.status, "FOUND");
    if (bank.status === "FOUND") assert.equal(bank.value.data?.items?.[0]?.name, "Moonlit Hide");
    const retailSearch = read.searchItems({ version: "retail", query: "thread", limit: 1 });
    assert.equal(retailSearch.data?.items[0]?.item.name, "Midnight Thread");
    assert.equal(retailSearch.provenance.version, "retail");
    assert.equal(read.searchItems({ version: "classic-era", query: "thread" }).data?.items[0]?.item.name, "Old Thread");
    assert.deepEqual(read.getItemMetadata({ version: "retail", itemIds: [12345, 99999] }).data?.map((item) => item.state), ["KNOWN", "UNKNOWN"]);
    assert.throws(() => read.searchItems({ version: "retail", query: "thread", offset: -1 }), /offset/);
  } finally { store.close(); }
});

test("shared storage read slices preserve owner and historical carrier semantics", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const fixture = new URL("./fixtures/sanitized/virek-warband-last-seen-1789965777.wowsync.txt", import.meta.url);
    store.importSnapshot(readFileSync(fixture, "utf8"));
    const read = new DashboardReadModel(store, () => NOW);
    const warband = read.getSharedStorageContents({ version: "retail", kind: "warband", limit: 2 });
    assert.equal(warband.provenance.state, "DERIVED");
    assert.equal(warband.data?.owners[0]?.owner.kind, "warband");
    assert.ok(warband.data?.owners[0]?.current?.content.truncated);
    assert.equal(warband.data?.owners[0]?.current?.liveAtExport, false);
    const guildFixture = new URL("./fixtures/derived/ezaller-shared-storage-1789478317.wowsync.txt", import.meta.url);
    store.importSnapshot(readFileSync(guildFixture, "utf8"));
    const guild = read.getSharedStorageContents({ version: "retail", kind: "guild", limit: 1 });
    assert.equal(guild.data?.owners[0]?.owner.kind, "guild");
    if (guild.data?.owners[0]?.owner.kind === "guild") {
      assert.equal(typeof guild.data.owners[0].owner.guildClubId, "string");
      assert.deepEqual(guild.data.owners[0].current?.coverage.inaccessibleTabs, [3]);
      assert.equal(guild.data.owners[0].current?.provenance.sources[0]?.carrierState, "OBSERVED");
    }
    assert.equal(read.getSharedStorageContents({ version: "classic-era", kind: "warband" }).provenance.state, "UNKNOWN");
  } finally { store.close(); }
});
