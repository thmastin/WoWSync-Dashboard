import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { assessErpNeed, buildErpResourceCommitmentSummary, ErpProjectConflictError, ErpProjectValidationError, evaluateErpProject, validateErpProject, type ErpProject } from "../src/erpProjects.ts";
import { guildOwner, ownerKey, warbandOwner, type SharedStorageProjection } from "../src/sharedStorage.ts";

const ITEM = "item:159";
function seedStore(options: Parameters<typeof buildWowSyncExport>[0] = {}) {
  const store = new SqliteSnapshotStore(":memory:");
  const raw = buildWowSyncExport({ character: { name: "Crafter", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 5000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: ITEM, name: "Rough Stone", qty: 4 }] }] }, bank: { unknown: true }, ...options });
  const imported = store.importSnapshot(raw);
  return { store, identityKey: imported.character.identityKey };
}
function seedRetailCurrency(options: { isAccountWide?: boolean; quantity?: number | null; lastSeen?: boolean } = {}) {
  const store = new SqliteSnapshotStore(":memory:");
  const raw = buildWowSyncExport({ generatedAt: 1_700_000_000, character: { name: "Crafter", realm: "Realm A", clientFamily: "Retail", clientVersion: "12.1.0", moneyCopper: 5000 } });
  const imported = store.importSnapshot(raw, { currencies: { observedAt: 1_700_000_000, completeness: "complete", data: { listRead: true, formatVersion: 1, currencies: [{ currencyID: 1822, name: "Flightstones", quantity: options.quantity === undefined ? 8 : options.quantity, isAccountWide: options.isAccountWide ?? false }] } } });
  if (options.lastSeen) store.importSnapshot(buildWowSyncExport({ generatedAt: 1_700_000_100, character: { name: "Crafter", realm: "Realm A", clientFamily: "Retail", clientVersion: "12.1.0", moneyCopper: 5000 } }));
  return { store, identityKey: imported.character.identityKey };
}
function seedRetailRecipes(recipes: Array<{ recipeID: number; learned?: boolean; learnedState: "OBSERVED_TRUE" | "OBSERVED_FALSE" | "UNKNOWN"; evidence?: "OBSERVED" | "LAST_SEEN" }>, options: { second?: typeof recipes; characterName?: string } = {}) {
  const store = new SqliteSnapshotStore(":memory:");
  const observedAt = 1_700_000_000;
  const capture = (rows: typeof recipes, generatedAt: number) => {
    const raw = buildWowSyncExport({ generatedAt, character: { name: options.characterName ?? "Recipe Keeper", realm: "Retail Realm", clientFamily: "Retail", clientVersion: "12.1.0" } });
    const recipeRows = rows.map((row) => ({ recipeID: row.recipeID, ...(row.learned === undefined ? {} : { learned: row.learned }), learnedState: row.learnedState, recipeInfoResult: row.learned === undefined ? "NIL_RESULT" : "OBSERVED_VALUE", skillLineAssociationState: "OBSERVED", skillLineIDs: [], evidence: row.evidence ?? "OBSERVED", observedAt }));
    const profession = { baseSkillLineID: 171, skillLineID: 171, professionID: 171, parentProfessionID: 171, professionName: "Alchemy", evidence: "OBSERVED", observedAt, client: { clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: 69933 }, coverage: { state: "PARTIAL", enumeration: "OBSERVED", candidateCompleteness: "UNKNOWN", filteredEnumerationUsed: false, returnedRecipeCount: recipeRows.length }, recipes: recipeRows };
    const data = { formatVersion: 1, ownerScope: "CHARACTER", coverage: { state: "PARTIAL", enumeration: "OBSERVED", candidateCompleteness: "UNKNOWN", filteredEnumerationUsed: false, returnedRecipeCount: recipeRows.length }, professions: [profession] };
    return store.importSnapshot(raw, { characterState: { formatVersion: 1, clientFamily: "Retail", professionRecipes: { formatVersion: 1, observedAt, completeness: "partial", data } } });
  };
  const imported = capture(recipes, observedAt);
  if (options.second) capture(options.second, observedAt + 10);
  return { store, identityKey: imported.character.identityKey };
}
function project(identityKey: string): ErpProject {
  return {
    stableId: "project_test", version: "classic-era", title: "Prepare first craft", status: "ACTIVE", priority: 4,
    createdAt: 1_700_000_000, updatedAt: 1_700_000_000, revision: 1,
    needs: [{ stableId: "need_stone", kind: "ITEM_REF", resourceKey: ITEM, label: "Rough Stone", requiredQuantity: 5, sourceIdentityKey: identityKey }],
    reservations: [{ stableId: "reserve_stone", needId: "need_stone", sourceIdentityKey: identityKey, quantity: 2, status: "ACTIVE", createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }],
    workOrders: [{ stableId: "gather_stone", kind: "GATHER", status: "PLANNED", title: "Gather one more Rough Stone", resourceNeedIds: ["need_stone"], dependsOn: [] }],
  };
}
function sharedFixture(options: { owner?: "warband" | "guild"; live?: boolean; completeness?: "complete" | "partial"; items?: Array<{ itemRef?: string; qty?: number }>; inaccessibleTabs?: number[]; conflict?: boolean } = {}): SharedStorageProjection {
  const owner = options.owner === "guild" ? guildOwner("84606081") : warbandOwner();
  const key = ownerKey(owner);
  const effectiveObservedAt = 1_700_000_000;
  const current = { identity: "fixture-observation", ownerKey: key, claimedObservedAt: effectiveObservedAt, effectiveObservedAt, claimedAfterCarrier: false, completeness: options.completeness ?? "complete", informative: true, contentHash: "fixture", contentHashVersion: 1, liveAtExport: options.live ?? true, carrierStates: [options.live === false ? "LAST_SEEN" : "OBSERVED"], sourceCharacterKeys: [], coverage: { observedTabs: options.owner === "guild" && !options.inaccessibleTabs?.length ? [1] : [], inaccessibleTabs: options.inaccessibleTabs ?? [], unconfirmedTabs: [], unidentifiedTabs: 0, observedContainerIds: [] }, sources: [], content: { tabs: options.owner === "guild" ? [{ id: 1, viewable: true, state: options.inaccessibleTabs?.length ? "INACCESSIBLE" : "OBSERVED" }] : [], containers: [], itemsKnownEmpty: !(options.items?.length), items: options.items ?? [] } };
  const view = { basis: "DERIVED", owner, ownerKey: key, current, latestPartial: undefined, broaderCoverageEarlier: undefined, conflict: options.conflict ? { effectiveObservedAt, others: [] } : undefined, observationCount: { total: 1, complete: options.completeness === "partial" ? 0 : 1, partial: options.completeness === "partial" ? 1 : 0, informationless: 0 } };
  return (owner.kind === "guild" ? { guilds: [view] } : { warband: view, guilds: [] }) as unknown as SharedStorageProjection;
}

test("project requirements preserve observed lower bounds, unknown bank, and explicit reservations", () => {
  const { store, identityKey } = seedStore();
  try {
    const p = project(identityKey);
    const read = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001);
    assert.equal(read.needEvidence[0]?.state, "UNKNOWN", "observed 4 is below 5 and the unobserved bank might add supply");
    assert.equal(read.needEvidence[0]?.observedQuantity, 4);
    assert.deepEqual(read.needEvidence[0]?.unresolvedSections, ["character bank", "storage completeness is partial or unconfirmed"]);
    assert.equal(read.reservationReview[0]?.state, "WITHIN_OBSERVED_SUPPLY");
    assert.equal(read.reservationReview[0]?.reservedQuantity, 2);
    assert.equal(read.workOrders[0]?.status, "PLANNED", "an inventory snapshot never auto-completes a manual work order");
  } finally { store.close(); }
});

test("LAST_SEEN stock is potential, never current coverage", () => {
  const { store, identityKey } = seedStore({ bags: { unknown: true }, bank: { lastSeen: true, containers: [{ id: 0, capacity: 16, items: [{ itemRef: ITEM, name: "Rough Stone", qty: 7 }] }] } });
  try {
    const p = project(identityKey);
    const read = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001);
    assert.equal(read.needEvidence[0]?.state, "POTENTIAL_COVERAGE_LAST_SEEN");
    assert.equal(read.needEvidence[0]?.potentialQuantity, 7);
  } finally { store.close(); }
});

test("unobserved supply remains UNKNOWN for both need and reservation checks", () => {
  const { store, identityKey } = seedStore({ bags: { unknown: true }, bank: { unknown: true } });
  try {
    const p = project(identityKey);
    const read = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001);
    assert.equal(read.needEvidence[0]?.state, "UNKNOWN");
    assert.equal(read.needEvidence[0]?.observedQuantity, undefined, "UNKNOWN sections are not represented as an observed zero");
    assert.equal(read.reservationReview[0]?.state, "SUPPLY_UNKNOWN");
  } finally { store.close(); }
});

test("partial current storage cannot establish an observed shortfall", () => {
  const { store, identityKey } = seedStore({
    bags: { partial: true, containers: [{ id: 0, capacity: 16, items: [{ itemRef: ITEM, name: "Rough Stone", qty: 1 }] }] },
    bank: { partial: true, containers: [] },
  });
  try {
    const p = { ...project(identityKey), reservations: [] };
    const read = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001);
    assert.equal(read.needEvidence[0]?.state, "UNKNOWN");
    assert.match(read.needEvidence[0]?.reason ?? "", /completeness is partial or unconfirmed/);
  } finally { store.close(); }
});

test("base-item and exact-variant reservations are conservatively treated as overlapping", () => {
  const { store, identityKey } = seedStore();
  try {
    const exact = project(identityKey);
    const broad: ErpProject = {
      ...project(identityKey), stableId: "project_base_item",
      needs: [{ stableId: "need_base", kind: "ITEM_ID", resourceKey: "159", label: "Rough Stone, any variant", requiredQuantity: 1, sourceIdentityKey: identityKey }],
      reservations: [{ stableId: "reserve_base", needId: "need_base", sourceIdentityKey: identityKey, quantity: 1, status: "ACTIVE", createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }],
    };
    const read = evaluateErpProject(exact, (key) => store.listSnapshots(key), [exact, broad], 1_700_000_001);
    assert.equal(read.reservationReview[0]?.state, "SUPPLY_UNKNOWN");
    assert.match(read.reservationReview[0]?.reason ?? "", /base item 159 and exact item variants overlap/);
  } finally { store.close(); }
});

test("resource assessments subtract overlapping plans from observed availability without turning unknown into zero", () => {
  const { store, identityKey } = seedStore();
  try {
    const consumer = { ...project(identityKey), reservations: [], needs: [{ stableId: "need_consumer", kind: "ITEM_REF" as const, resourceKey: ITEM, label: "Rough Stone", requiredQuantity: 2, sourceIdentityKey: identityKey }] };
    const reserved = { ...project(identityKey), stableId: "project_reserver", needs: [{ stableId: "need_reserver", kind: "ITEM_REF" as const, resourceKey: ITEM, label: "Rough Stone", requiredQuantity: 3, sourceIdentityKey: identityKey }], reservations: [{ stableId: "reserve_other", needId: "need_reserver", sourceIdentityKey: identityKey, quantity: 3, status: "ACTIVE" as const, createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }] };
    const evidence = evaluateErpProject(consumer, (key) => store.listSnapshots(key), [consumer, reserved], 1_700_000_001).needEvidence[0]!;
    assert.equal(evidence.reservationAssessment?.activeQuantity, 3);
    assert.equal(evidence.reservationAssessment?.availableObservedLowerBound, 1);
    assert.equal(evidence.reservationAssessment?.state, "WITHIN_OBSERVED_SUPPLY");
    const tooMuch = { ...reserved, reservations: [{ ...reserved.reservations[0]!, quantity: 5 }] };
    const uncertain = evaluateErpProject(consumer, (key) => store.listSnapshots(key), [consumer, tooMuch], 1_700_000_001).needEvidence[0]!;
    assert.equal(uncertain.reservationAssessment?.state, "UNKNOWN", "unknown bank prevents claiming reservations exceed total storage");
    assert.equal(uncertain.reservationAssessment?.availableObservedLowerBound, undefined);
  } finally { store.close(); }
});

test("reconciliation reports observed per-section changes without assigning a cause", () => {
  const { store, identityKey } = seedStore();
  try {
    store.importSnapshot(buildWowSyncExport({ generatedAt: 1_700_000_100, character: { name: "Crafter", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 7000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: ITEM, name: "Rough Stone", qty: 2 }] }] }, bank: { unknown: true } }));
    const p = { ...project(identityKey), reservations: [] };
    const read = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_101);
    assert.equal(read.needEvidence[0]?.state, "UNKNOWN", "unknown bank still prevents a complete supply conclusion");
    assert.equal(read.needEvidence[0]?.observationChange?.state, "CHANGED");
    assert.deepEqual(read.needEvidence[0]?.observationChange?.comparisons.map((c) => [c.section, c.previousQuantity, c.currentQuantity, c.delta]), [["bags", 4, 2, -2]]);
    assert.match(read.needEvidence[0]?.observationChange?.reason ?? "", /does not establish whether a project action caused/);
  } finally { store.close(); }
});

test("gold requirements use exact copper values and keep an observed shortfall distinct from UNKNOWN", () => {
  const { store, identityKey } = seedStore();
  try {
    const p = { ...project(identityKey), reservations: [], needs: [{ stableId: "gold", kind: "GOLD_COPPER" as const, resourceKey: "copper", label: "Vendor cost", requiredQuantity: 6000, sourceIdentityKey: identityKey }] };
    const result = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001);
    assert.equal(result.needEvidence[0]?.state, "SHORTFALL_OBSERVED");
    assert.equal(result.needEvidence[0]?.observedQuantity, 5000);
  } finally { store.close(); }
});

test("character-scoped Retail currencies support evidence-qualified needs and reservations", () => {
  const { store, identityKey } = seedRetailCurrency();
  try {
    const p: ErpProject = { ...project(identityKey), version: "retail", needs: [{ stableId: "currency", kind: "CURRENCY", resourceKey: "1822", label: "Flightstones", requiredQuantity: 6, sourceIdentityKey: identityKey }], reservations: [{ stableId: "reserve_currency", needId: "currency", sourceIdentityKey: identityKey, quantity: 3, status: "ACTIVE", createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }], workOrders: [] };
    const view = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001, store.listVersionCurrencies("retail"));
    assert.equal(view.needEvidence[0]?.state, "COVERED_BY_OBSERVED");
    assert.equal(view.needEvidence[0]?.observedQuantity, 8);
    assert.equal(view.needEvidence[0]?.sourceSections[0]?.section, "currencies");
    assert.equal(view.needEvidence[0]?.reservationAssessment?.availableObservedLowerBound, 5);
    assert.equal(view.reservationReview[0]?.state, "WITHIN_OBSERVED_SUPPLY");
  } finally { store.close(); }
});

test("an explicitly listed zero Retail currency balance is a real observed shortfall", () => {
  const { store, identityKey } = seedRetailCurrency({ quantity: 0 });
  try {
    const p: ErpProject = { ...project(identityKey), version: "retail", needs: [{ stableId: "currency", kind: "CURRENCY", resourceKey: "1822", label: "Flightstones", requiredQuantity: 1, sourceIdentityKey: identityKey }], reservations: [], workOrders: [] };
    const view = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001, store.listVersionCurrencies("retail"));
    assert.equal(view.needEvidence[0]?.state, "SHORTFALL_OBSERVED");
    assert.equal(view.needEvidence[0]?.observedQuantity, 0);
  } finally { store.close(); }
});

test("shared storage is planned under its own owner scope and exact item variant", () => {
  const { store, identityKey } = seedStore();
  const owner = warbandOwner();
  const sourceOwnerKey = ownerKey(owner);
  try {
    const need = { stableId: "warband_item", kind: "ITEM_REF" as const, resourceKey: "item:159:variant-a", label: "Exact variant", requiredQuantity: 2, sourceOwnerKey };
    const p: ErpProject = { ...project(identityKey), needs: [need], reservations: [{ stableId: "warband_reservation", needId: need.stableId, sourceOwnerKey, quantity: 1, status: "ACTIVE", createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }], workOrders: [] };
    const shared = sharedFixture({ items: [{ itemRef: need.resourceKey, qty: 3 }, { itemRef: "item:159:variant-b", qty: 20 }] });
    const view = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001, undefined, shared);
    assert.equal(view.needEvidence[0]?.state, "COVERED_BY_OBSERVED");
    assert.equal(view.needEvidence[0]?.observedQuantity, 3);
    assert.equal(view.needEvidence[0]?.sourceOwnerKey, sourceOwnerKey);
    assert.equal(view.needEvidence[0]?.ownerScope, "warband-installation-local");
    assert.equal(view.needEvidence[0]?.reservationAssessment?.availableObservedLowerBound, 2);
    assert.match(view.needEvidence[0]?.reason ?? "", /does not establish personal ownership, character access, or a transfer route/);
    const guildKey = ownerKey(guildOwner("84606081"));
    const otherOwner: ErpProject = { ...p, stableId: "guild_project", needs: [{ ...need, stableId: "guild_need", sourceOwnerKey: guildKey }], reservations: [{ stableId: "guild_reservation", needId: "guild_need", sourceOwnerKey: guildKey, quantity: 2, status: "ACTIVE", createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }] };
    const isolated = evaluateErpProject(p, (key) => store.listSnapshots(key), [p, otherOwner], 1_700_000_001, undefined, shared);
    assert.equal(isolated.needEvidence[0]?.reservationAssessment?.activeQuantity, 1, "guild reservation cannot consume a Warband resource reservation");
  } finally { store.close(); }
});

test("a partial Warband scan can prove its observed lower bound without proving an exhaustive shortfall", () => {
  const { store, identityKey } = seedStore();
  const sourceOwnerKey = ownerKey(warbandOwner());
  try {
    const need = { stableId: "partial_warband", kind: "ITEM_REF" as const, resourceKey: ITEM, label: "Observed ore", requiredQuantity: 2, sourceOwnerKey };
    const p: ErpProject = { ...project(identityKey), needs: [need], reservations: [], workOrders: [] };
    const view = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001, undefined, sharedFixture({ completeness: "partial", items: [{ itemRef: ITEM, qty: 2 }] }));
    const evidence = view.needEvidence[0]!;
    assert.equal(evidence.state, "COVERED_BY_OBSERVED");
    assert.equal(evidence.observedQuantity, 2);
    assert.equal(evidence.sourceSections[0]?.completeness, "partial");
    assert.deepEqual(evidence.unresolvedSections, ["shared-storage completeness is partial or unconfirmed"]);
    assert.match(evidence.reason, /location and quantity only/);
  } finally { store.close(); }
});

test("guild contents remain guild-owned and inaccessible or LAST_SEEN shared storage cannot prove current supply", () => {
  const { store, identityKey } = seedStore();
  try {
    const guildKey = ownerKey(guildOwner("84606081"));
    const make = (sourceOwnerKey: string): ErpProject => ({ ...project(identityKey), needs: [{ stableId: "guild_need", kind: "ITEM_REF", resourceKey: ITEM, label: "Observed ore", requiredQuantity: 1, sourceOwnerKey }], reservations: [], workOrders: [] });
    const guildProject = make(guildKey);
    const guild = evaluateErpProject(guildProject, (key) => store.listSnapshots(key), [guildProject], 1_700_000_001, undefined, sharedFixture({ owner: "guild", items: [{ itemRef: ITEM, qty: 1 }] }));
    assert.equal(guild.needEvidence[0]?.state, "COVERED_BY_OBSERVED");
    assert.equal(guild.needEvidence[0]?.ownerScope, "guild");
    assert.match(guild.needEvidence[0]?.reason ?? "", /selected guild storage observation/);
    const inaccessible = evaluateErpProject(guildProject, (key) => store.listSnapshots(key), [guildProject], 1_700_000_001, undefined, sharedFixture({ owner: "guild", inaccessibleTabs: [2], items: [] }));
    assert.equal(inaccessible.needEvidence[0]?.state, "UNKNOWN");
    assert.equal(inaccessible.needEvidence[0]?.observedQuantity, undefined);
    const old = evaluateErpProject(guildProject, (key) => store.listSnapshots(key), [guildProject], 1_700_000_001, undefined, sharedFixture({ owner: "guild", live: false, items: [{ itemRef: ITEM, qty: 3 }] }));
    assert.equal(old.needEvidence[0]?.state, "POTENTIAL_COVERAGE_LAST_SEEN");
    assert.equal(old.needEvidence[0]?.observedQuantity, undefined);
    assert.equal(old.needEvidence[0]?.potentialQuantity, 3);
  } finally { store.close(); }
});

test("conflicting shared-owner evidence and owner sources outside Retail remain UNKNOWN or invalid", () => {
  const { store, identityKey } = seedStore();
  try {
    const sourceOwnerKey = ownerKey(warbandOwner());
    const p: ErpProject = { ...project(identityKey), needs: [{ stableId: "warband_item", kind: "ITEM_REF", resourceKey: ITEM, label: "Stone", requiredQuantity: 1, sourceOwnerKey }], reservations: [], workOrders: [] };
    const conflict = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001, undefined, sharedFixture({ conflict: true, items: [{ itemRef: ITEM, qty: 5 }] }));
    assert.equal(conflict.needEvidence[0]?.state, "UNKNOWN");
    assert.equal(conflict.needEvidence[0]?.observedQuantity, undefined);
    assert.throws(() => validateErpProject({ ...p, version: "classic-era" }, () => true), (e: unknown) => e instanceof ErpProjectValidationError && e.code === "INVALID_PROJECT_STORAGE_OWNER");
  } finally { store.close(); }
});

test("account-wide, absent, non-Retail, and LAST_SEEN currency evidence never becomes character-owned zero", () => {
  const account = seedRetailCurrency({ isAccountWide: true });
  const historical = seedRetailCurrency({ lastSeen: true });
  const classic = seedStore();
  try {
    const need = (identityKey: string, version: ErpProject["version"] = "retail"): ErpProject => ({ ...project(identityKey), version, needs: [{ stableId: "currency", kind: "CURRENCY", resourceKey: "1822", label: "Flightstones", requiredQuantity: 1, sourceIdentityKey: identityKey }], reservations: [] });
    const accountProject = need(account.identityKey);
    const accountView = evaluateErpProject(accountProject, (key) => account.store.listSnapshots(key), [accountProject], 1_700_000_001, account.store.listVersionCurrencies("retail"));
    assert.equal(accountView.needEvidence[0]?.state, "UNKNOWN");
    assert.match(accountView.needEvidence[0]?.reason ?? "", /does not establish this character's access/);
    const absentProject = { ...accountProject, needs: [{ ...accountProject.needs[0]!, resourceKey: "999" }] };
    const absent = evaluateErpProject(absentProject, (key) => account.store.listSnapshots(key), [absentProject], 1_700_000_001, account.store.listVersionCurrencies("retail"));
    assert.equal(absent.needEvidence[0]?.observedQuantity, undefined);
    assert.match(absent.needEvidence[0]?.reason ?? "", /not a zero balance/);
    const oldProject = need(historical.identityKey);
    const old = evaluateErpProject(oldProject, (key) => historical.store.listSnapshots(key), [oldProject], 1_700_000_001, historical.store.listVersionCurrencies("retail"));
    assert.equal(old.needEvidence[0]?.state, "POTENTIAL_COVERAGE_LAST_SEEN");
    assert.equal(old.needEvidence[0]?.potentialQuantity, 8);
    const classicProject = need(classic.identityKey, "classic-era");
    const notRetail = evaluateErpProject(classicProject, (key) => classic.store.listSnapshots(key), [classicProject], 1_700_000_001, classic.store.listVersionCurrencies("classic-era"));
    assert.equal(notRetail.needEvidence[0]?.state, "UNKNOWN");
    assert.match(notRetail.needEvidence[0]?.reason ?? "", /only for Retail/);
  } finally { account.store.close(); historical.store.close(); classic.store.close(); }
});

test("profession requirements compare exact observed skill names without implying recipe ability", () => {
  const { store, identityKey } = seedStore({ professions: { entries: [{ name: "Mining", skill: 30, maxSkill: 75 }] } });
  try {
    const p = { ...project(identityKey), reservations: [], needs: [{ stableId: "mining_skill", kind: "PROFESSION" as const, resourceKey: "Mining", label: "Mining skill", requiredQuantity: 35, sourceIdentityKey: identityKey }] };
    const result = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001);
    assert.equal(result.needEvidence[0]?.state, "SHORTFALL_OBSERVED");
    assert.equal(result.needEvidence[0]?.observedQuantity, 30);
    assert.match(result.needEvidence[0]?.reason ?? "", /not a recipe or craftability/);
  } finally { store.close(); }
});

test("an observed complete profession list can show a missing exact profession name", () => {
  const { store, identityKey } = seedStore({ professions: { entries: [{ name: "Mining", skill: 30, maxSkill: 75 }] } });
  try {
    const p = { ...project(identityKey), reservations: [], needs: [{ stableId: "smithing", kind: "PROFESSION" as const, resourceKey: "Blacksmithing", label: "Blacksmithing capability", requiredQuantity: 1, sourceIdentityKey: identityKey }] };
    const result = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001);
    assert.equal(result.needEvidence[0]?.state, "SHORTFALL_OBSERVED");
    assert.equal(result.needEvidence[0]?.observedQuantity, 0);
  } finally { store.close(); }
});

test("LAST_SEEN profession skill without its source timestamp stays stale-unknown in freshness", () => {
  const { store, identityKey } = seedStore({ professions: { lastSeen: true, entries: [{ name: "Mining", skill: 30, maxSkill: 75 }] } });
  try {
    const p = { ...project(identityKey), reservations: [], needs: [{ stableId: "mining_skill", kind: "PROFESSION" as const, resourceKey: "Mining", label: "Mining skill", requiredQuantity: 25, sourceIdentityKey: identityKey }] };
    const evidence = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001).needEvidence[0]!;
    assert.equal(evidence.state, "POTENTIAL_COVERAGE_LAST_SEEN");
    assert.equal(evidence.observedAt, undefined);
    assert.equal(evidence.freshness, "unknown");
    assert.equal(evidence.sourceSections[0]?.state, "LAST_SEEN");
  } finally { store.close(); }
});

test("missing profession evidence retains its known source state and completeness", () => {
  const { store, identityKey } = seedStore({ professions: { partial: true, entries: [{ name: "Mining", skill: 30, maxSkill: 75 }] } });
  try {
    const p = { ...project(identityKey), reservations: [], needs: [{ stableId: "smithing", kind: "PROFESSION" as const, resourceKey: "Blacksmithing", label: "Blacksmithing skill", requiredQuantity: 1, sourceIdentityKey: identityKey }] };
    const evidence = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_001).needEvidence[0]!;
    assert.equal(evidence.state, "UNKNOWN");
    assert.equal(evidence.sourceSections[0]?.state, "OBSERVED");
    assert.equal(evidence.sourceSections[0]?.completeness, "partial");
  } finally { store.close(); }
});

test("Retail recipe plans evaluate only an exact explicit learned-state row", () => {
  const { store, identityKey } = seedRetailRecipes([
    { recipeID: 3001, learned: true, learnedState: "OBSERVED_TRUE" },
    { recipeID: 3002, learned: false, learnedState: "OBSERVED_FALSE" },
    { recipeID: 3003, learnedState: "UNKNOWN" },
  ]);
  try {
    const p: ErpProject = { ...project(identityKey), version: "retail", needs: [3001, 3002, 3003, 3999].map((recipeID) => ({ stableId: `recipe_${recipeID}`, kind: "RECIPE", resourceKey: String(recipeID), label: `Recipe ${recipeID}`, requiredQuantity: 1, sourceIdentityKey: identityKey })), reservations: [], workOrders: [] };
    const view = evaluateErpProject(p, (key) => store.listSnapshots(key), [p], 1_700_000_020);
    assert.equal(view.needEvidence[0]?.state, "COVERED_BY_OBSERVED");
    assert.equal(view.needEvidence[0]?.observedQuantity, 1);
    assert.match(view.needEvidence[0]?.reason ?? "", /does not establish current profession skill, unlock requirements, reagents/);
    assert.equal(view.needEvidence[1]?.state, "SHORTFALL_OBSERVED");
    assert.equal(view.needEvidence[1]?.observedQuantity, 0);
    assert.equal(view.needEvidence[2]?.state, "UNKNOWN", "an explicit unknown API result stays unknown");
    assert.equal(view.needEvidence[3]?.state, "UNKNOWN", "absence from partial candidate enumeration is not a negative result");
    assert.match(view.needEvidence[3]?.reason ?? "", /absence does not mean unlearned/);
  } finally { store.close(); }
});

test("Retail recipe plans preserve LAST_SEEN history and never borrow recipe evidence across versions", () => {
  const historical = seedRetailRecipes([{ recipeID: 3001, learned: true, learnedState: "OBSERVED_TRUE" }], { second: [{ recipeID: 3004, learned: true, learnedState: "OBSERVED_TRUE" }] });
  const classic = seedStore();
  try {
    const retailNeed = { stableId: "old_recipe", kind: "RECIPE" as const, resourceKey: "3001", label: "Historical recipe", requiredQuantity: 1, sourceIdentityKey: historical.identityKey };
    const retail: ErpProject = { ...project(historical.identityKey), version: "retail", needs: [retailNeed], reservations: [], workOrders: [] };
    const view = evaluateErpProject(retail, (key) => historical.store.listSnapshots(key), [retail], 1_700_000_020);
    assert.equal(view.needEvidence[0]?.state, "POTENTIAL_COVERAGE_LAST_SEEN");
    assert.equal(view.needEvidence[0]?.sourceSections[0]?.state, "LAST_SEEN");
    const unsupported = assessErpNeed({ ...retailNeed, sourceIdentityKey: classic.identityKey }, classic.store.listSnapshots(classic.identityKey), 1_700_000_020, undefined, "classic-era");
    assert.equal(unsupported.state, "UNSUPPORTED_EVIDENCE");
    assert.match(unsupported.reason, /supported only for Retail/);
  } finally { historical.store.close(); classic.store.close(); }
});

test("CRAFT readiness binds recipe and profession evidence to the assigned character without claiming craftability", () => {
  const recipeFixture = seedRetailRecipes([{ recipeID: 3001, learned: true, learnedState: "OBSERVED_TRUE" }]);
  const otherCrafterFixture = seedRetailRecipes([{ recipeID: 3001, learned: false, learnedState: "OBSERVED_FALSE" }], { characterName: "Other Crafter" });
  const professionFixture = seedStore({ professions: { entries: [{ name: "Leatherworking", skill: 100, maxSkill: 150 }] } });
  try {
    const unspecifiedCraft: ErpProject = { ...project(recipeFixture.identityKey), workOrders: [{ stableId: "unspecified", kind: "CRAFT", status: "PLANNED", title: "Unspecified craft", resourceNeedIds: [], dependsOn: [], assignedIdentityKey: recipeFixture.identityKey }] };
    const unspecifiedReadiness = evaluateErpProject(unspecifiedCraft, (key) => recipeFixture.store.listSnapshots(key), [unspecifiedCraft], 1_700_000_020).workOrderReadiness[0]!;
    assert.equal(unspecifiedReadiness.state, "WAITING_FOR_EVIDENCE", "a material-free or otherwise unspecified craft does not appear ready without an exact profession or recipe requirement");
    assert.match(unspecifiedReadiness.reason, /No exact profession or recipe requirement is linked/);
    const materialsOnlyFixture = seedStore();
    try {
      const materialsOnlyCharacter = materialsOnlyFixture.store.listCharacters("classic-era")[0]!;
      const materialsOnlyCraft: ErpProject = { ...project(materialsOnlyCharacter.identityKey), needs: [{ stableId: "stone", kind: "ITEM_REF", resourceKey: ITEM, label: "Rough Stone", requiredQuantity: 3, sourceIdentityKey: materialsOnlyCharacter.identityKey }], reservations: [], workOrders: [{ stableId: "materials-only", kind: "CRAFT", status: "PLANNED", title: "Craft with materials only", resourceNeedIds: ["stone"], dependsOn: [], assignedIdentityKey: materialsOnlyCharacter.identityKey }] };
      const materialsOnlyReadiness = evaluateErpProject(materialsOnlyCraft, (key) => materialsOnlyFixture.store.listSnapshots(key), [materialsOnlyCraft], 1_700_000_020).workOrderReadiness[0]!;
      assert.equal(materialsOnlyReadiness.linkedNeeds?.[0]?.state, "COVERED_BY_OBSERVED", "the fixture has enough observed material");
      assert.equal(materialsOnlyReadiness.state, "WAITING_FOR_EVIDENCE", "material coverage alone does not establish an observed profession or recipe prerequisite");
    } finally { materialsOnlyFixture.store.close(); }

    const other = otherCrafterFixture.store.listCharacters("retail")[0]!;
    const recipeNeed = { stableId: "recipe", kind: "RECIPE" as const, resourceKey: "3001", label: "Observed recipe", requiredQuantity: 1, sourceIdentityKey: recipeFixture.identityKey };
    const recipeProject: ErpProject = { ...project(recipeFixture.identityKey), version: "retail", needs: [recipeNeed], reservations: [], workOrders: [{ stableId: "craft", kind: "CRAFT", status: "PLANNED", title: "Craft recipe", resourceNeedIds: ["recipe"], dependsOn: [], assignedIdentityKey: other.identityKey }] };
    const snapshotsFor = (key: string) => key === other.identityKey ? otherCrafterFixture.store.listSnapshots(key) : recipeFixture.store.listSnapshots(key);
    let readiness = evaluateErpProject(recipeProject, snapshotsFor, [recipeProject], 1_700_000_020).workOrderReadiness[0]!;
    assert.equal(readiness.state, "OBSERVED_RESOURCE_SHORTFALL", "the assigned crafter's own observed unlearned state blocks the step even though another character knows the recipe");
    assert.equal(readiness.capabilityChecks?.[0]?.state, "REQUIREMENT_NOT_MET");
    assert.equal(readiness.capabilityChecks?.[0]?.evidenceSourceIdentityKey, other.identityKey);
    assert.equal(readiness.capabilityChecks?.[0]?.freshness, "recent");
    assert.deepEqual(readiness.linkedNeeds?.map((need) => [need.kind, need.state, need.freshness, need.requiredQuantity, need.sourceIdentityKey]), [["RECIPE", "SHORTFALL_OBSERVED", "recent", 1, other.identityKey]], "the work-order view uses the assigned crafter's own explicit recipe evidence");
    assert.ok(readiness.linkedNeeds?.[0]?.sourceSections.some((section) => section.section === "character" && section.state === "OBSERVED"), "the linked input retains the assigned character section provenance");
    assert.equal(evaluateErpProject(recipeProject, snapshotsFor, [recipeProject], 1_700_000_020).needEvidence[0]?.sourceIdentityKey, recipeFixture.identityKey, "the project-level source observation remains independent from the assignee check");
    const sameCrafter = { ...recipeProject, workOrders: [{ ...recipeProject.workOrders[0]!, assignedIdentityKey: recipeFixture.identityKey }] };
    readiness = evaluateErpProject(sameCrafter, snapshotsFor, [sameCrafter], 1_700_000_020).workOrderReadiness[0]!;
    assert.equal(readiness.capabilityChecks?.[0]?.state, "SUPPORTED_FOR_ASSIGNEE");
    assert.equal(readiness.linkedNeeds?.[0]?.observedQuantity, 1);
    assert.equal(readiness.state, "READY_FOR_PLAYER_REVIEW");
    assert.match(readiness.reason, /do not establish current skill, unlocks, or craftability/);
    const assignedOnlyNeed = { ...recipeNeed, sourceIdentityKey: undefined };
    const assignedOnlyProject = { ...sameCrafter, needs: [assignedOnlyNeed] };
    readiness = evaluateErpProject(assignedOnlyProject, snapshotsFor, [assignedOnlyProject], 1_700_000_020).workOrderReadiness[0]!;
    assert.equal(readiness.capabilityChecks?.[0]?.state, "SUPPORTED_FOR_ASSIGNEE", "the work order reads the assigned crafter directly even when a capability need has no inventory-style source selection");
    assert.equal(readiness.linkedNeeds?.[0]?.observedQuantity, 1);
    assert.equal(evaluateErpProject(assignedOnlyProject, snapshotsFor, [assignedOnlyProject], 1_700_000_020).workOrderProgress[0]?.linkedNeedState, "ALL_CURRENTLY_MET");
    const crossVersionOrder = { ...sameCrafter, workOrders: [{ ...sameCrafter.workOrders[0]!, assignedIdentityKey: "classic-era::retail realm::recipe keeper" }] };
    const queried = new Set<string>();
    const crossVersionView = evaluateErpProject(crossVersionOrder, (key) => { queried.add(key); return snapshotsFor(key); }, [crossVersionOrder], 1_700_000_020);
    assert.equal(crossVersionView.workOrderReadiness[0]?.capabilityChecks?.[0]?.state, "EVIDENCE_UNKNOWN");
    assert.ok(!queried.has("classic-era::retail realm::recipe keeper"), "an incompatible assigned-character identity is rejected before reading snapshots");

    const skillNeed = { stableId: "profession", kind: "PROFESSION" as const, resourceKey: "Leatherworking", label: "Leatherworking", requiredQuantity: 90, sourceIdentityKey: professionFixture.identityKey };
    const skillProject: ErpProject = { ...project(professionFixture.identityKey), needs: [skillNeed], reservations: [], workOrders: [{ stableId: "craft_skill", kind: "CRAFT", status: "PLANNED", title: "Craft with observed skill", resourceNeedIds: ["profession"], dependsOn: [], assignedIdentityKey: professionFixture.identityKey }] };
    readiness = evaluateErpProject(skillProject, (key) => professionFixture.store.listSnapshots(key), [skillProject], 1_700_000_020).workOrderReadiness[0]!;
    assert.equal(readiness.capabilityChecks?.[0]?.state, "SUPPORTED_FOR_ASSIGNEE");
    assert.equal(readiness.state, "READY_FOR_PLAYER_REVIEW");
    const unmet = { ...skillProject, needs: [{ ...skillNeed, requiredQuantity: 125 }] };
    readiness = evaluateErpProject(unmet, (key) => professionFixture.store.listSnapshots(key), [unmet], 1_700_000_020).workOrderReadiness[0]!;
    assert.equal(readiness.capabilityChecks?.[0]?.state, "REQUIREMENT_NOT_MET");
    assert.equal(readiness.state, "OBSERVED_RESOURCE_SHORTFALL");
  } finally { recipeFixture.store.close(); otherCrafterFixture.store.close(); professionFixture.store.close(); }
});

test("project persistence is version-isolated, survives reopen, and rejects stale revisions", () => {
  const { store, identityKey } = seedStore();
  const p = project(identityKey);
  try {
    const created = store.createErpProject(p);
    assert.deepEqual(store.listErpProjectHistory(created.stableId).map((event) => [event.revision, event.kind, event.changedFields]), [[1, "CREATED", ["project"]]]);
    assert.equal(created.version, "classic-era");
    assert.equal(store.listErpProjects("retail").length, 0);
    assert.equal(store.listErpProjects("classic-era")[0]?.stableId, created.stableId);
    const changed = store.updateErpProject({ ...created, title: "Prepare the craft", workOrders: created.workOrders.map((order) => ({ ...order, status: "IN_PROGRESS" as const })) }, created.revision)!;
    assert.equal(changed.revision, 2);
    const paused = store.setErpProjectStatus(created.stableId, "PAUSED", changed.revision)!;
    assert.equal(paused.revision, 3);
    const history = store.listErpProjectHistory(created.stableId);
    assert.deepEqual(history.map((event) => [event.revision, event.kind, event.changedFields]), [[3, "STATUS_CHANGED", ["status"]], [2, "UPDATED", ["title", "workOrders"]], [1, "CREATED", ["project"]]]);
    assert.deepEqual(history[1]?.workOrderStatusChanges, [{ workOrderId: "gather_stone", title: "Gather one more Rough Stone", fromStatus: "PLANNED", toStatus: "IN_PROGRESS" }]);
    assert.equal(history[2]?.workOrderStatusChanges, undefined, "initial tasks are not falsely represented as status transitions");
    assert.throws(() => store.updateErpProject({ ...changed, title: "Stale edit" }, 1), ErpProjectConflictError);
    assert.equal(store.getErpProject(created.stableId)?.title, "Prepare the craft");
  } finally { store.close(); }
});

test("project read model bounds recent history while reporting the full durable event count", () => {
  const { store, identityKey } = seedStore();
  try {
    let current = store.createErpProject({ version: "classic-era", title: "Plan" });
    for (let index = 1; index <= 50; index++) current = store.updateErpProject({ ...current, title: `Plan revision ${index}` }, current.revision)!;
    const view = new DashboardReadModel(store, () => 1_700_000_200).getErpProjects({ version: "classic-era" })[0]!;
    assert.equal(view.historyEventCount, 51);
    assert.equal(view.history.length, 50);
    assert.equal(view.historyTruncated, true);
    assert.equal(view.history[0]?.revision, 51);
  } finally { store.close(); }
});

test("work order readiness respects recorded dependencies, evidence freshness, and manual action limits", () => {
  const { store, identityKey } = seedStore();
  try {
    const plan: ErpProject = {
      ...project(identityKey), reservations: [],
      needs: [
        { stableId: "gold_need", kind: "GOLD_COPPER", resourceKey: "copper", label: "Trainer gold", requiredQuantity: 7000, sourceIdentityKey: identityKey },
        { stableId: "unknown_need", kind: "ITEM_REF", resourceKey: "item:999", label: "Unknown item", requiredQuantity: 1 },
        { stableId: "covered_need", kind: "GOLD_COPPER", resourceKey: "copper", label: "Observed gold", requiredQuantity: 100, sourceIdentityKey: identityKey },
      ],
      workOrders: [
        { stableId: "prereq", kind: "INVESTIGATE", status: "PLANNED", title: "Check the trainer", resourceNeedIds: [], dependsOn: [] },
        { stableId: "blocked", kind: "OTHER", status: "PLANNED", title: "Continue after investigation", resourceNeedIds: ["covered_need"], dependsOn: ["prereq"] },
        { stableId: "short", kind: "PURCHASE", status: "PLANNED", title: "Buy after saving", resourceNeedIds: ["gold_need"], dependsOn: [] },
        { stableId: "unknown", kind: "TRANSFER", status: "PLANNED", title: "Move the unknown item", resourceNeedIds: ["unknown_need"], dependsOn: [] },
        { stableId: "review", kind: "TRANSFER", status: "PLANNED", title: "Review source transfer", resourceNeedIds: ["covered_need"], dependsOn: [] },
      ],
    };
    const read = (p: ErpProject, now = 1_700_000_020) => evaluateErpProject(p, (key) => store.listSnapshots(key), [p], now);
    const initial = read(plan);
    assert.equal(initial.workOrderReadiness.find((entry) => entry.workOrderId === "blocked")?.state, "BLOCKED_BY_DEPENDENCY");
    assert.equal(initial.workOrderReadiness.find((entry) => entry.workOrderId === "short")?.state, "OBSERVED_RESOURCE_SHORTFALL");
    assert.equal(initial.workOrderReadiness.find((entry) => entry.workOrderId === "unknown")?.state, "WAITING_FOR_EVIDENCE");
    const review = initial.workOrderReadiness.find((entry) => entry.workOrderId === "review")!;
    assert.equal(review.state, "READY_FOR_PLAYER_REVIEW");
    assert.match(review.reason, /does not establish access or a transfer route/);
    const completedDependency: ErpProject = { ...plan, workOrders: plan.workOrders.map((order) => order.stableId === "prereq" ? { ...order, status: "COMPLETED", completionNote: "Player recorded completion." } : order) };
    assert.equal(read(completedDependency).workOrderReadiness.find((entry) => entry.workOrderId === "blocked")?.state, "READY_FOR_PLAYER_REVIEW");
    store.importSnapshot(buildWowSyncExport({ generatedAt: 1_700_000_100, character: { name: "Crafter", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 7000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: ITEM, name: "Rough Stone", qty: 2 }] }] }, bank: { unknown: true } }));
    const changed = read(plan, 1_700_000_101).workOrderReadiness.find((entry) => entry.workOrderId === "review")!;
    assert.equal(changed.state, "OBSERVATION_CHANGED_REQUIRES_REVIEW");
    assert.deepEqual(changed.changedNeedIds, ["covered_need"]);
    assert.match(changed.reason, /does not establish that this work order caused it or that the planned step is complete/);
    const recordedComplete: ErpProject = { ...plan, workOrders: plan.workOrders.map((order) => order.stableId === "review" ? { ...order, status: "COMPLETED", completionNote: "Player recorded a manual transfer." } : order) };
    const changedAfterCompletion = read(recordedComplete, 1_700_000_101).workOrderReadiness.find((entry) => entry.workOrderId === "review")!;
    assert.equal(changedAfterCompletion.state, "OBSERVATION_CHANGED_REQUIRES_REVIEW", "later inventory evidence asks for review without overwriting the player's recorded status");
    assert.match(changedAfterCompletion.reason, /marked complete by the player/);
    const completedWithUnknown: ErpProject = { ...recordedComplete, workOrders: recordedComplete.workOrders.map((order) => order.stableId === "review" ? { ...order, resourceNeedIds: ["covered_need", "unknown_need"] } : order) };
    const mixedEvidence = read(completedWithUnknown, 1_700_000_101).workOrderReadiness.find((entry) => entry.workOrderId === "review")!;
    assert.deepEqual(mixedEvidence.changedNeedIds, ["covered_need"]);
    assert.deepEqual(mixedEvidence.unresolvedNeedIds, ["unknown_need"]);
    assert.match(mixedEvidence.reason, /Linked evidence also remains unknown/);
    assert.equal(read(plan, 1_900_000_000).workOrderReadiness.find((entry) => entry.workOrderId === "review")?.state, "WAITING_FOR_EVIDENCE", "stale observed supply is not marked ready");
    assert.equal(read({ ...plan, status: "PAUSED" }).workOrderReadiness.find((entry) => entry.workOrderId === "review")?.state, "PROJECT_NOT_ACTIVE");
  } finally { store.close(); }
});

test("work order readiness aggregates linked needs and treats saved reservations as intent", () => {
  const { store, identityKey } = seedStore();
  try {
    const targetNeed = { stableId: "target_need", kind: "ITEM_REF" as const, resourceKey: ITEM, label: "Rough Stone for craft", requiredQuantity: 3, sourceIdentityKey: identityKey };
    const current: ErpProject = { ...project(identityKey), needs: [targetNeed], reservations: [], workOrders: [{ stableId: "craft_step", kind: "OTHER", status: "PLANNED", title: "Review observed resource allocation", resourceNeedIds: [targetNeed.stableId], dependsOn: [] }] };
    const competitorNeed = { ...targetNeed, stableId: "competing_need", label: "Stone for another project" };
    const competing: ErpProject = { ...project(identityKey), stableId: "competing_project", needs: [competitorNeed], reservations: [{ stableId: "competing_hold", needId: competitorNeed.stableId, sourceIdentityKey: identityKey, quantity: 3, status: "ACTIVE", createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }], workOrders: [] };
    const read = (plans: ErpProject[]) => evaluateErpProject(current, (key) => store.listSnapshots(key), plans, 1_700_000_010).workOrderReadiness[0]!;
    const blocked = read([current, competing]);
    assert.equal(blocked.state, "RESOURCE_ALLOCATION_REQUIRES_REVIEW");
    assert.deepEqual(blocked.unresolvedNeedIds, ["target_need"]);
    assert.match(blocked.reason, /Reservations record player intent; they do not lock or prove possession/);
    const conflictedProgress = evaluateErpProject(current, (key) => store.listSnapshots(key), [current, competing], 1_700_000_010).workOrderProgress[0]!;
    assert.equal(conflictedProgress.linkedNeedState, "RESOURCE_ALLOCATION_REQUIRES_REVIEW", "progress must not say a linked need is independently met while another saved reservation overlaps it");
    assert.equal(conflictedProgress.reconciliation, "RESOURCE_ALLOCATION_REQUIRES_REVIEW");
    assert.deepEqual(conflictedProgress.allocationConflictNeedIds, ["target_need"]);

    const ownReservation: ErpProject = { ...current, reservations: [{ stableId: "own_hold", needId: targetNeed.stableId, sourceIdentityKey: identityKey, quantity: 2, status: "ACTIVE", createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }] };
    const enoughForBoth: ErpProject = { ...competing, reservations: [{ ...competing.reservations[0]!, quantity: 1 }] };
    const ready = evaluateErpProject(ownReservation, (key) => store.listSnapshots(key), [ownReservation, enoughForBoth], 1_700_000_010).workOrderReadiness[0]!;
    assert.equal(ready.state, "READY_FOR_PLAYER_REVIEW", "own reserved units plus unreserved observed supply meet the linked need");

    const secondNeed = { ...targetNeed, stableId: "second_target_need", label: "More stone for the same work order", requiredQuantity: 2 };
    const duplicateNeeds: ErpProject = { ...current, needs: [targetNeed, secondNeed], workOrders: [{ ...current.workOrders[0]!, resourceNeedIds: [targetNeed.stableId, secondNeed.stableId] }] };
    const duplicateNoReservation = evaluateErpProject(duplicateNeeds, (key) => store.listSnapshots(key), [duplicateNeeds], 1_700_000_010).workOrderReadiness[0]!;
    assert.equal(duplicateNoReservation.state, "RESOURCE_ALLOCATION_REQUIRES_REVIEW", "two linked needs cannot each count the same observed stack independently");
    assert.deepEqual(duplicateNoReservation.unresolvedNeedIds, ["second_target_need", "target_need"]);

    const duplicateWithExternalReservation = evaluateErpProject(duplicateNeeds, (key) => store.listSnapshots(key), [duplicateNeeds, competing], 1_700_000_010).workOrderReadiness[0]!;
    assert.equal(duplicateWithExternalReservation.state, "RESOURCE_ALLOCATION_REQUIRES_REVIEW", "combined linked needs and another saved reservation cannot exceed the observed lower bound");

    const sufficientDuplicates: ErpProject = { ...duplicateNeeds, needs: [targetNeed, { ...secondNeed, requiredQuantity: 1 }] };
    const sufficient = evaluateErpProject(sufficientDuplicates, (key) => store.listSnapshots(key), [sufficientDuplicates], 1_700_000_010).workOrderReadiness[0]!;
    assert.equal(sufficient.state, "READY_FOR_PLAYER_REVIEW", "aggregated linked requirements within the observed amount remain reviewable");

    const unrelatedHold = { ...targetNeed, stableId: "other_need_in_same_project", label: "Separate reservation", requiredQuantity: 1 };
    const sameProjectHold: ErpProject = { ...current, needs: [targetNeed, unrelatedHold], reservations: [{ stableId: "other_hold", needId: unrelatedHold.stableId, sourceIdentityKey: identityKey, quantity: 2, status: "ACTIVE", createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }] };
    const sameProjectBlocked = evaluateErpProject(sameProjectHold, (key) => store.listSnapshots(key), [sameProjectHold], 1_700_000_010).workOrderReadiness[0]!;
    assert.equal(sameProjectBlocked.state, "RESOURCE_ALLOCATION_REQUIRES_REVIEW", "an unlinked reservation in the same project still competes for the source quantity");

    const ambiguousNeed = { ...targetNeed, stableId: "base_target_need", kind: "ITEM_ID" as const, resourceKey: "159", requiredQuantity: 1 };
    const overlappingNeeds: ErpProject = { ...current, needs: [targetNeed, ambiguousNeed], workOrders: [{ ...current.workOrders[0]!, resourceNeedIds: [targetNeed.stableId, ambiguousNeed.stableId] }] };
    const ambiguous = evaluateErpProject(overlappingNeeds, (key) => store.listSnapshots(key), [overlappingNeeds], 1_700_000_010).workOrderReadiness[0]!;
    assert.equal(ambiguous.state, "RESOURCE_ALLOCATION_REQUIRES_REVIEW", "base-item and exact-variant needs are ambiguous even without reservations");
  } finally { store.close(); }
});

test("gather and purchase work orders surface only complete observed item gaps as manual next steps", () => {
  const complete = seedStore({ bank: { containers: [] } });
  try {
    const identityKey = complete.identityKey;
    const itemNeed = { stableId: "need_item", kind: "ITEM_REF" as const, resourceKey: ITEM, label: "Rough Stone", requiredQuantity: 6, sourceIdentityKey: identityKey };
    const make = (kind: "GATHER" | "PURCHASE", needs: ErpProject["needs"] = [itemNeed]): ErpProject => ({
      ...project(identityKey), needs,
      reservations: [],
      workOrders: [{ stableId: `step_${kind}`, kind, status: "PLANNED", title: `${kind} the missing item`, resourceNeedIds: needs.map((need) => need.stableId), dependsOn: [] }],
    });
    for (const kind of ["GATHER", "PURCHASE"] as const) {
      const readiness = evaluateErpProject(make(kind), (key) => complete.store.listSnapshots(key), [make(kind)], 1_700_000_010).workOrderReadiness[0]!;
      assert.equal(readiness.state, "MANUAL_SUPPLY_STEP_RECOMMENDED");
      assert.deepEqual(readiness.actionTargetNeedIds, ["need_item"]);
      assert.match(readiness.reason, /does not establish a gathering route, purchase availability, price, or action completion/);
    }
    const gold = { stableId: "need_gold", kind: "GOLD_COPPER" as const, resourceKey: "copper", label: "Purchase budget", requiredQuantity: 7000, sourceIdentityKey: identityKey };
    const purchaseWithInsufficientBudget = make("PURCHASE", [itemNeed, gold]);
    assert.equal(evaluateErpProject(purchaseWithInsufficientBudget, (key) => complete.store.listSnapshots(key), [purchaseWithInsufficientBudget], 1_700_000_010).workOrderReadiness[0]?.state, "OBSERVED_RESOURCE_SHORTFALL", "an item procurement step does not bypass a linked observed gold shortfall");
  } finally { complete.store.close(); }

  const incomplete = seedStore();
  try {
    const itemNeed = { stableId: "need_item", kind: "ITEM_REF" as const, resourceKey: ITEM, label: "Rough Stone", requiredQuantity: 6, sourceIdentityKey: incomplete.identityKey };
    const gather = { ...project(incomplete.identityKey), needs: [itemNeed], reservations: [], workOrders: [{ stableId: "gather", kind: "GATHER" as const, status: "PLANNED" as const, title: "Gather stone", resourceNeedIds: [itemNeed.stableId], dependsOn: [] }] };
    assert.equal(evaluateErpProject(gather, (key) => incomplete.store.listSnapshots(key), [gather], 1_700_000_010).workOrderReadiness[0]?.state, "WAITING_FOR_EVIDENCE", "unknown bank evidence means the system cannot call this a confirmed shortfall or supply action target");
  } finally { incomplete.store.close(); }
});

test("work-order progress separates player completion, observed state, changed evidence, and unresolved data", () => {
  const options = (generatedAt: number, quantity: number) => ({ generatedAt, character: { name: "Crafter", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 5000 }, bags: { containers: [{ id: 0, capacity: 16, items: quantity ? [{ itemRef: ITEM, name: "Rough Stone", qty: quantity }] : [] }] }, bank: { containers: [] } });
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const imported = store.importSnapshot(buildWowSyncExport(options(1_700_000_000, 8)));
    const planned = { ...project(imported.character.identityKey), workOrders: [{ ...project(imported.character.identityKey).workOrders[0]!, status: "IN_PROGRESS" as const }] };
    const current = evaluateErpProject(planned, (key) => store.listSnapshots(key), [planned], 1_700_000_010).workOrderProgress[0]!;
    assert.equal(current.recordedStatus, "IN_PROGRESS");
    assert.equal(current.completionRecorded, false);
    assert.equal(current.linkedNeedState, "ALL_CURRENTLY_MET");
    assert.equal(current.observationChange, "UNKNOWN", "one capture establishes current stock but no before/after change");
    assert.equal(current.reconciliation, "CURRENT_LINKED_NEEDS_MET", "resource condition does not claim that the gather task happened");

    store.importSnapshot(buildWowSyncExport(options(1_700_000_100, 7)));
    const changed = evaluateErpProject(planned, (key) => store.listSnapshots(key), [planned], 1_700_000_110).workOrderProgress[0]!;
    assert.equal(changed.observationChange, "CHANGED");
    assert.equal(changed.reconciliation, "OBSERVATION_CHANGED_CAUSE_UNKNOWN");
    assert.match(changed.reason, /does not establish whether this work order caused the change/);

    const completed = { ...planned, workOrders: planned.workOrders.map((order) => ({ ...order, status: "COMPLETED" as const, completionNote: "Player recorded manual completion." })) };
    const declared = evaluateErpProject(completed, (key) => store.listSnapshots(key), [completed], 1_700_000_110).workOrderProgress[0]!;
    assert.equal(declared.completionRecorded, true);
    assert.equal(declared.reconciliation, "PLAYER_RECORDED_COMPLETE", "manual completion remains separate from the observed resource change");

    store.importSnapshot(buildWowSyncExport(options(1_700_000_200, 3)));
    const currentShortfall = evaluateErpProject(planned, (key) => store.listSnapshots(key), [planned], 1_700_000_210).workOrderProgress[0]!;
    assert.equal(currentShortfall.linkedNeedState, "CURRENT_SHORTFALL");
    assert.equal(currentShortfall.observationChange, "CHANGED");
    assert.equal(currentShortfall.reconciliation, "CURRENT_LINKED_NEEDS_UNMET", "the current shortfall takes precedence while change provenance stays separately visible");
    assert.deepEqual(currentShortfall.shortfallNeedIds, ["need_stone"]);

    const missingStore = new SqliteSnapshotStore(":memory:");
    try {
      const missing = missingStore.importSnapshot(buildWowSyncExport(options(1_700_000_000, 0)));
      const shortPlan = { ...project(missing.character.identityKey), workOrders: [{ ...project(missing.character.identityKey).workOrders[0]!, status: "COMPLETED" as const, completionNote: "Player says complete." }] };
      const conflict = evaluateErpProject(shortPlan, (key) => missingStore.listSnapshots(key), [shortPlan], 1_700_000_010).workOrderProgress[0]!;
      assert.equal(conflict.linkedNeedState, "CURRENT_SHORTFALL");
      assert.equal(conflict.reconciliation, "COMPLETION_CONFLICTS_WITH_LINKED_SHORTFALL");
      assert.match(conflict.reason, /does not prove the task failed or identify the cause/);
      const stale = evaluateErpProject(planned, (key) => store.listSnapshots(key), [planned], 1_700_000_000 + 4 * 86400).workOrderProgress[0]!;
      assert.equal(stale.linkedNeedState, "STALE_OR_UNKNOWN");
      assert.equal(stale.reconciliation, "INSUFFICIENT_EVIDENCE");
    } finally { missingStore.close(); }
  } finally { store.close(); }
});

test("transfer reconciliation compares explicitly planned source and destination changes without claiming causality", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const baseAt = 1_700_100_000;
  const capture = (name: string, realm: string, quantity: number, generatedAt: number) => buildWowSyncExport({
    generatedAt,
    character: { name, realm, clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 5000 },
    bags: { containers: [{ id: 0, capacity: 16, items: quantity ? [{ itemRef: ITEM, name: "Rough Stone", qty: quantity }] : [] }] },
    bank: { containers: [] },
  });
  try {
    const source = store.importSnapshot(capture("Sender", "Realm A", 2, baseAt)).character.identityKey;
    const destination = store.importSnapshot(capture("Receiver", "Realm A", 0, baseAt)).character.identityKey;
    store.importSnapshot(capture("Sender", "Realm A", 1, baseAt + 100));
    store.importSnapshot(capture("Receiver", "Realm A", 1, baseAt + 100));
    const need = { stableId: "mail_item", kind: "ITEM_REF" as const, resourceKey: ITEM, label: "Rough Stone", requiredQuantity: 1, sourceIdentityKey: source, destinationIdentityKey: destination };
    const order = { stableId: "mail_step", kind: "TRANSFER" as const, status: "WAITING_FOR_EVIDENCE" as const, title: "Review item movement", resourceNeedIds: [need.stableId], dependsOn: [], sourceIdentityKey: source, destinationIdentityKey: destination };
    const plan = { ...project(source), needs: [need], reservations: [], workOrders: [order] };
    const read = evaluateErpProject(plan, (key) => store.listSnapshots(key), [plan], baseAt + 110);
    const review = read.workOrderProgress[0]?.transferObservationReviews?.[0];
    assert.equal(review?.state, "BOTH_SIDES_CHANGED");
    assert.equal(review?.interpretation, "CAUSE_UNKNOWN");
    const sourceBagChange = review?.source.comparisons.find((comparison) => comparison.section === "bags" && comparison.delta !== 0);
    const destinationBagChange = review?.destination.comparisons.find((comparison) => comparison.section === "bags" && comparison.delta !== 0);
    assert.deepEqual(sourceBagChange && [sourceBagChange.previousQuantity, sourceBagChange.currentQuantity, sourceBagChange.delta], [2, 1, -1]);
    assert.deepEqual(destinationBagChange && [destinationBagChange.previousQuantity, destinationBagChange.currentQuantity, destinationBagChange.delta], [0, 1, 1]);
    assert.equal(sourceBagChange?.previousObservedAt, baseAt);
    assert.equal(destinationBagChange?.currentObservedAt, baseAt + 100);
    assert.match(review?.reason ?? "", /do not establish that the changes are related or that a transfer occurred/);
    const broadIdPlan = { ...plan, needs: [{ ...need, kind: "ITEM_ID" as const, resourceKey: "159" }] };
    const broadIdReview = evaluateErpProject(broadIdPlan, (key) => store.listSnapshots(key), [broadIdPlan], baseAt + 110).workOrderProgress[0]?.transferObservationReviews?.[0];
    assert.match(broadIdReview?.reason ?? "", /group all observed itemString variants.*do not prove the same exact variant changed/);
    assert.equal(evaluateErpProject(plan, (key) => store.listSnapshots(key), [plan], baseAt + 5 * 86400).workOrderProgress[0]?.transferObservationReviews?.[0]?.state, "EVIDENCE_UNKNOWN", "stale pairs do not produce a paired change conclusion");
    const conflicting = { ...plan, workOrders: [{ ...order, sourceIdentityKey: destination }] };
    assert.equal(evaluateErpProject(conflicting, (key) => store.listSnapshots(key), [conflicting], baseAt + 110).workOrderProgress[0]?.transferObservationReviews?.[0]?.state, "IDENTITY_CONFLICT", "order source intent conflicting with its need is surfaced rather than silently reconciled");
  } finally { store.close(); }
});

test("shared-owner transfer need cannot be overridden by a character source on the work order", () => {
  const { store, identityKey } = seedRetailCurrency();
  try {
    const need = { stableId: "warband_item", kind: "ITEM_REF" as const, resourceKey: "item:159:variant-a", label: "Exact item", requiredQuantity: 1, sourceOwnerKey: ownerKey(warbandOwner()) };
    const order = { stableId: "retrieve", kind: "TRANSFER" as const, status: "PLANNED" as const, title: "Review shared storage manually", resourceNeedIds: [need.stableId], dependsOn: [], sourceIdentityKey: identityKey };
    const plan: ErpProject = { ...project(identityKey), version: "retail", needs: [need], reservations: [], workOrders: [order] };
    const review = evaluateErpProject(plan, (key) => store.listSnapshots(key), [plan], 1_700_000_010).workOrderProgress[0]?.transferObservationReviews?.[0];
    assert.equal(review?.state, "IDENTITY_CONFLICT");
    assert.equal(review?.source.identityKey, undefined, "the work-order character is not substituted for the owner source");
    assert.deepEqual(review?.source.comparisons, [], "no character deltas are presented as shared-owner deltas");
    assert.match(review?.reason ?? "", /shared-storage owner conflicts.*character source/);
  } finally { store.close(); }
});

test("progress preserves evidence-quality and shortfall precedence over ambiguous linked item scopes", () => {
  const makePlan = (identityKey: string): ErpProject => {
    const needs: ErpProject["needs"] = [
      { stableId: "base", kind: "ITEM_ID", resourceKey: "159", label: "Any Rough Stone variant", requiredQuantity: 5, sourceIdentityKey: identityKey },
      { stableId: "exact", kind: "ITEM_REF", resourceKey: ITEM, label: "Exact Rough Stone variant", requiredQuantity: 3, sourceIdentityKey: identityKey },
    ];
    return { ...project(identityKey), needs, reservations: [], workOrders: [{ stableId: "inspect", kind: "INVESTIGATE", status: "IN_PROGRESS", title: "Review linked items", resourceNeedIds: ["base", "exact"], dependsOn: [] }] };
  };
  const unknown = seedStore({ bags: { unknown: true }, bank: { unknown: true } });
  try {
    const plan = makePlan(unknown.identityKey);
    const progress = evaluateErpProject(plan, (key) => unknown.store.listSnapshots(key), [plan], 1_700_000_010).workOrderProgress[0]!;
    assert.equal(progress.linkedNeedState, "STALE_OR_UNKNOWN");
    assert.equal(progress.reconciliation, "INSUFFICIENT_EVIDENCE");
    assert.deepEqual(progress.allocationConflictNeedIds, [], "unobserved supplies do not become an allocation conflict fact");
  } finally { unknown.store.close(); }

  const stale = seedStore({ generatedAt: 1_700_000_000, bank: { containers: [] } });
  try {
    const plan = makePlan(stale.identityKey);
    const progress = evaluateErpProject(plan, (key) => stale.store.listSnapshots(key), [plan], 1_700_000_000 + 5 * 86400).workOrderProgress[0]!;
    assert.equal(progress.linkedNeedState, "STALE_OR_UNKNOWN");
    assert.equal(progress.reconciliation, "INSUFFICIENT_EVIDENCE");
    assert.deepEqual(progress.allocationConflictNeedIds, []);
  } finally { stale.store.close(); }

  const shortfall = seedStore({ generatedAt: 1_700_000_000, bank: { containers: [] } });
  try {
    const plan = makePlan(shortfall.identityKey);
    const progress = evaluateErpProject(plan, (key) => shortfall.store.listSnapshots(key), [plan], 1_700_000_010).workOrderProgress[0]!;
    assert.equal(progress.linkedNeedState, "MIXED_CURRENT_EVIDENCE", "a current exact-variant lower bound can be covered while the base-item target has a confirmed shortfall");
    assert.equal(progress.reconciliation, "MIXED_LINKED_EVIDENCE");
    assert.deepEqual(progress.allocationConflictNeedIds, [], "a real shortfall takes precedence over a static ambiguity claim");
  } finally { shortfall.store.close(); }
});

test("resource commitment summary aggregates plan asks by explicit source but reports observed stock once", () => {
  const { store, identityKey } = seedStore();
  try {
    const makeProject = (stableId: string, needId: string, quantity: number, status: ErpProject["status"] = "ACTIVE"): ErpProject => ({
      ...project(identityKey), stableId, status,
      needs: [{ stableId: needId, kind: "ITEM_REF", resourceKey: ITEM, label: "Rough Stone", requiredQuantity: quantity, sourceIdentityKey: identityKey }],
      reservations: [], workOrders: [],
    });
    const first = { ...makeProject("plan_a", "need_a", 3), reservations: [{ stableId: "hold_a", needId: "need_a", sourceIdentityKey: identityKey, quantity: 2, status: "ACTIVE" as const, createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }] };
    const second = makeProject("plan_b", "need_b", 2);
    const variant = { ...makeProject("plan_variant", "need_variant", 1), needs: [{ stableId: "need_variant", kind: "ITEM_REF" as const, resourceKey: "item:159:123", label: "Rough Stone variant", requiredQuantity: 1, sourceIdentityKey: identityKey }], reservations: [{ stableId: "hold_variant", needId: "need_variant", sourceIdentityKey: identityKey, quantity: 1, status: "ACTIVE" as const, createdAt: 1_700_000_000, updatedAt: 1_700_000_000 }] };
    const broad = { ...makeProject("plan_base_id", "need_base_id", 1), needs: [{ stableId: "need_base_id", kind: "ITEM_ID" as const, resourceKey: "159", label: "Rough Stone base ID", requiredQuantity: 1, sourceIdentityKey: identityKey }] };
    const unknownA = { ...makeProject("unknown_a", "unknown_need_a", 4), needs: [{ stableId: "unknown_need_a", kind: "ITEM_REF" as const, resourceKey: "item:999", label: "Unknown source A", requiredQuantity: 4 }] };
    const unknownB = { ...makeProject("unknown_b", "unknown_need_b", 5), needs: [{ stableId: "unknown_need_b", kind: "ITEM_REF" as const, resourceKey: "item:999", label: "Unknown source B", requiredQuantity: 5 }] };
    const plans = [first, second, variant, broad, unknownA, unknownB];
    const views = plans.map((plan) => ({ ...evaluateErpProject(plan, (key) => store.listSnapshots(key), plans, 1_700_000_010), history: [], historyEventCount: 0, historyTruncated: false }));
    const summary = buildErpResourceCommitmentSummary(views);
    const exact = summary.items.find((line) => line.sourceIdentityKey === identityKey && line.kind === "ITEM_REF" && line.resourceKey === ITEM)!;
    assert.equal(exact.activeNeedCount, 2);
    assert.equal(exact.activeNeedQuantity, 5, "planned quantities aggregate across active projects");
    assert.equal(exact.observedQuantity, 4, "the same character observation appears once, not once per project");
    assert.equal(exact.activeReservationQuantity, 2, "reservation intent stays separate from planned requirement totals");
    assert.equal(exact.availableObservedLowerBound, 2);
    assert.deepEqual(exact.overlappingResourceKeys, ["159"], "an exact base itemString overlaps only the broader ITEM_ID scope, not another exact variant");
    const exactVariant = summary.items.find((line) => line.resourceKey === "item:159:123")!;
    assert.deepEqual(exactVariant.overlappingResourceKeys, ["159"]);
    assert.equal(exactVariant.activeReservationQuantity, 1);
    const broadItem = summary.items.find((line) => line.kind === "ITEM_ID" && line.resourceKey === "159")!;
    assert.equal(broadItem.activeReservationQuantity, 0);
    assert.equal(broadItem.overlappingReservationQuantity, 3, "a base-ID line calls out reservations on matching exact-itemString scopes");
    assert.equal(summary.linesWithReservations, 3);
    const unknownSourceLines = summary.items.filter((line) => line.sourceScope === "UNKNOWN_SOURCE" && line.resourceKey === "item:999");
    assert.equal(unknownSourceLines.length, 2, "unsourced plans are not merged as though they share a source");
    const manyUnknown = Array.from({ length: 105 }, (_, index) => ({
      ...makeProject(`unscoped_${index}`, `unscoped_need_${index}`, 1),
      needs: [{ stableId: `unscoped_need_${index}`, kind: "ITEM_REF" as const, resourceKey: `item:${10000 + index}`, label: `Unknown ${index}`, requiredQuantity: 1 }],
    }));
    const manyViews = manyUnknown.map((plan) => ({ ...evaluateErpProject(plan, (key) => store.listSnapshots(key), manyUnknown, 1_700_000_010), history: [], historyEventCount: 0, historyTruncated: false }));
    const bounded = buildErpResourceCommitmentSummary(manyViews);
    assert.equal(bounded.returnedCount, 100);
    assert.equal(bounded.totalCount, 105);
    assert.equal(bounded.unknownSourceLines, 105, "whole-set summary counters are exact even when the returned rows are truncated");
    assert.equal(bounded.truncated, true);
  } finally { store.close(); }
});

test("project source screening finds same-version observed item holders but preserves access and transfer as unknown", () => {
  const { store, identityKey: recipientIdentity } = seedStore({ generatedAt: 1_700_000_000, bank: { containers: [] } });
  try {
    const otherRaw = buildWowSyncExport({ generatedAt: 1_700_000_010, character: { name: "Supply Alt", realm: "Other Realm", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: ITEM, name: "Rough Stone", qty: 2 }, { itemRef: "item:159:42", name: "Rough Stone variant fixture", qty: 1 }] }] }, bank: { containers: [] } });
    store.importSnapshot(otherRaw);
    const retailRaw = buildWowSyncExport({ generatedAt: 1_700_000_020, character: { name: "Retail Alt", realm: "Other Realm", clientFamily: "Retail", clientVersion: "12.1.0" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: ITEM, name: "Rough Stone", qty: 99 }] }] }, bank: { containers: [] } });
    store.importSnapshot(retailRaw);
    const plan: ErpProject = { ...project(recipientIdentity), needs: [{ stableId: "gift_stone", kind: "ITEM_REF", resourceKey: ITEM, label: "Rough Stone", requiredQuantity: 1, destinationIdentityKey: recipientIdentity }, { stableId: "gift_stone_base", kind: "ITEM_ID", resourceKey: "159", label: "Rough Stone base search", requiredQuantity: 1, destinationIdentityKey: recipientIdentity }], reservations: [], workOrders: [] };
    const view = evaluateErpProject(plan, (key) => store.listSnapshots(key), [plan], 1_700_000_030, undefined, undefined, [...store.listCharacters("classic-era"), ...store.listCharacters("retail")]);
    const screen = view.resourceSourceScreens[0]!;
    assert.equal(screen.needId, "gift_stone");
    assert.equal(screen.scannedCharacterCount, 1, "the recipient is excluded and other versions are never scanned");
    assert.equal(screen.unresolvedCharacterCount, 0, "both source bags and bank were completely observed in this fixture");
    assert.equal(screen.candidates.length, 1);
    assert.equal(screen.candidateCount, 1);
    assert.equal(screen.candidatesTruncated, false);
    assert.equal(screen.candidates[0]?.sourceName, "Supply Alt");
    assert.equal(screen.candidates[0]?.sourceRealm, "Other Realm");
    assert.equal(screen.candidates[0]?.state, "OBSERVED");
    assert.equal(screen.candidates[0]?.observedQuantity, 2);
    assert.deepEqual(screen.candidates[0]?.locations.map((location) => [location.section, location.state, location.quantity]), [["bags", "OBSERVED", 2], ["character bank", "OBSERVED", 0]]);
    assert.deepEqual(screen.candidates[0]?.matchingItems.map((item) => [item.itemRef, item.section, item.state, item.quantity]), [[ITEM, "bags", "OBSERVED", 2]], "source leads preserve the exact observed itemString variant");
    assert.equal(screen.candidates[0]?.accountMembership, "UNKNOWN");
    assert.equal(screen.candidates[0]?.access, "UNKNOWN");
    assert.equal(screen.candidates[0]?.transferability, "UNKNOWN");
    const baseScreen = view.resourceSourceScreens.find((entry) => entry.needId === "gift_stone_base")!;
    assert.equal(baseScreen.candidates[0]?.observedQuantity, 3);
    assert.deepEqual(baseScreen.candidates[0]?.matchingItems.map((item) => item.itemRef), ["item:159", "item:159:42"], "base-item discovery preserves every exact matched variant and does not merge their identities");
  } finally { store.close(); }
});

test("project source screening bounds candidate output while retaining exact candidate counts", () => {
  const { store, identityKey: recipientIdentity } = seedStore({ generatedAt: 1_700_000_000, bank: { containers: [] } });
  try {
    for (let index = 0; index < 30; index++) store.importSnapshot(buildWowSyncExport({ generatedAt: 1_700_000_010 + index, character: { name: `Holder ${index}`, realm: `Realm ${index}`, clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: ITEM, name: "Rough Stone", qty: 1 }] }] }, bank: { containers: [] } }));
    const plan: ErpProject = { ...project(recipientIdentity), needs: [{ stableId: "many_sources", kind: "ITEM_REF", resourceKey: ITEM, label: "Rough Stone", requiredQuantity: 1, destinationIdentityKey: recipientIdentity }], reservations: [], workOrders: [] };
    const view = evaluateErpProject(plan, (key) => store.listSnapshots(key), [plan], 1_700_000_100, undefined, undefined, store.listCharacters("classic-era"));
    const screen = view.resourceSourceScreens[0]!;
    assert.equal(screen.candidateCount, 30);
    assert.equal(screen.candidates.length, 25);
    assert.equal(screen.candidatesTruncated, true);
  } finally { store.close(); }
});

test("validation rejects cross-version character references, unsupported assumptions, and unrecorded completion", () => {
  const { store, identityKey } = seedStore();
  try {
    const valid = project(identityKey);
    assert.throws(() => validateErpProject({ ...valid, version: "forever" }, (key) => store.getCharacter(key)?.version === "forever"), (e: unknown) => e instanceof ErpProjectValidationError && e.code === "INVALID_PROJECT_CHARACTER");
    assert.throws(() => validateErpProject({ ...valid, status: "COMPLETED" }, (key) => store.getCharacter(key)?.version === "classic-era"), (e: unknown) => e instanceof ErpProjectValidationError && e.code === "COMPLETION_EVIDENCE_REQUIRED");
    validateErpProject({ ...valid, status: "COMPLETED", completionNote: "Observed the final planned state in game." }, (key) => store.getCharacter(key)?.version === "classic-era");
    assert.throws(() => validateErpProject({ ...valid, workOrders: [{ ...valid.workOrders[0]!, status: "COMPLETED" }] }, (key) => store.getCharacter(key)?.version === "classic-era"), (e: unknown) => e instanceof ErpProjectValidationError && e.code === "COMPLETION_EVIDENCE_REQUIRED");
    assert.throws(() => validateErpProject({ ...valid, workOrders: [{ ...valid.workOrders[0]!, dependsOn: ["unknown"] }] }, (key) => store.getCharacter(key)?.version === "classic-era"), (e: unknown) => e instanceof ErpProjectValidationError && e.code === "UNKNOWN_WORK_ORDER_DEPENDENCY");
    assert.throws(() => validateErpProject({ ...valid, needs: [{ stableId: "recipe", kind: "RECIPE", resourceKey: "9007199254740993", label: "Unsafe recipe ID", requiredQuantity: 1, sourceIdentityKey: identityKey }], reservations: [], workOrders: [] }, (key) => store.getCharacter(key)?.version === "classic-era"), (e: unknown) => e instanceof ErpProjectValidationError && e.code === "INVALID_RECIPE_NEED");
    assert.throws(() => validateErpProject({ ...valid, needs: [{ stableId: "profession", kind: "PROFESSION", resourceKey: "Mining", label: "Mining", requiredQuantity: 1, sourceIdentityKey: identityKey }], reservations: [{ ...valid.reservations[0]!, needId: "profession" }], workOrders: [] }, (key) => store.getCharacter(key)?.version === "classic-era"), (e: unknown) => e instanceof ErpProjectValidationError && e.code === "NON_QUANTIFIABLE_RESERVATION");
  } finally { store.close(); }
});
