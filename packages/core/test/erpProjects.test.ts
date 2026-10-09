import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { assessErpNeed, ErpProjectConflictError, ErpProjectValidationError, evaluateErpProject, validateErpProject, type ErpProject } from "../src/erpProjects.ts";
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
function seedRetailRecipes(recipes: Array<{ recipeID: number; learned?: boolean; learnedState: "OBSERVED_TRUE" | "OBSERVED_FALSE" | "UNKNOWN"; evidence?: "OBSERVED" | "LAST_SEEN" }>, options: { second?: typeof recipes } = {}) {
  const store = new SqliteSnapshotStore(":memory:");
  const observedAt = 1_700_000_000;
  const capture = (rows: typeof recipes, generatedAt: number) => {
    const raw = buildWowSyncExport({ generatedAt, character: { name: "Recipe Keeper", realm: "Retail Realm", clientFamily: "Retail", clientVersion: "12.1.0" } });
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

test("project persistence is version-isolated, survives reopen, and rejects stale revisions", () => {
  const { store, identityKey } = seedStore();
  const p = project(identityKey);
  try {
    const created = store.createErpProject(p);
    assert.deepEqual(store.listErpProjectHistory(created.stableId).map((event) => [event.revision, event.kind, event.changedFields]), [[1, "CREATED", ["project"]]]);
    assert.equal(created.version, "classic-era");
    assert.equal(store.listErpProjects("retail").length, 0);
    assert.equal(store.listErpProjects("classic-era")[0]?.stableId, created.stableId);
    const changed = store.updateErpProject({ ...created, title: "Prepare the craft" }, created.revision)!;
    assert.equal(changed.revision, 2);
    const paused = store.setErpProjectStatus(created.stableId, "PAUSED", changed.revision)!;
    assert.equal(paused.revision, 3);
    assert.deepEqual(store.listErpProjectHistory(created.stableId).map((event) => [event.revision, event.kind, event.changedFields]), [[3, "STATUS_CHANGED", ["status"]], [2, "UPDATED", ["title"]], [1, "CREATED", ["project"]]]);
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
        { stableId: "blocked", kind: "CRAFT", status: "PLANNED", title: "Craft after training", resourceNeedIds: ["covered_need"], dependsOn: ["prereq"] },
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
    assert.equal(read(plan, 1_900_000_000).workOrderReadiness.find((entry) => entry.workOrderId === "review")?.state, "WAITING_FOR_EVIDENCE", "stale observed supply is not marked ready");
    assert.equal(read({ ...plan, status: "PAUSED" }).workOrderReadiness.find((entry) => entry.workOrderId === "review")?.state, "PROJECT_NOT_ACTIVE");
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
