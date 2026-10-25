import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const NOW = 1_792_700_000;
const REALM = "EvidenceRealm";
function era(name: string, options: { professions?: Array<{ name: string; skill: number; maxSkill: number }>; bound?: boolean | "unknown"; itemId?: number } = {}) {
  const itemId = options.itemId ?? 2840;
  const raw = buildWowSyncExport({ generatedAt: NOW, character: { name, realm: REALM, faction: "Alliance", class: "Warrior", level: 60, clientVersion: "1.15.9", clientBuild: "70003" }, bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [{ itemRef: `item:${itemId}`, name: "Test material", qty: 1, ...(options.bound !== "unknown" ? { bound: options.bound ?? false } : {}), vendorEachCopper: 1 }] }] }, professions: { entries: options.professions } });
  const guidSuffix = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0).toString(16).toUpperCase();
  return raw.replace(/Client: 1\.15\.9 build 70003\r?\n/, (line) => `${line}GUID: Player-1-${guidSuffix}\n`);
}

function setup(options: { holderProfessions?: Array<{ name: string; skill: number; maxSkill: number }>; altProfessions?: Array<{ name: string; skill: number; maxSkill: number }>; bound?: boolean | "unknown"; itemId?: number; holdItemIds?: number[]; usesItem?: boolean; incompleteAlt?: boolean; auctionHolder?: boolean } = {}) {
  const store = new SqliteSnapshotStore(":memory:");
  store.importSnapshot(era("Holder", { professions: options.holderProfessions ?? [], bound: options.bound, itemId: options.itemId }));
  store.importSnapshot(era("Auction", { professions: options.altProfessions ?? [] }));
  if (options.incompleteAlt) store.importSnapshot(era("Crafter", { professions: [{ name: "Blacksmithing", skill: 1, maxSkill: 75 }] }));
  const roster = store.listCharacters("classic-era");
  const holder = roster.find((row) => row.name === "Holder")!;
  const auction = roster.find((row) => row.name === (options.auctionHolder ? "Holder" : "Auction"))!;
  store.setMailPlanSettings({ accountId: "default", version: "classic-era", realm: REALM, faction: "Alliance", auctionCharacterIdentityKey: auction.identityKey, updatedAt: NOW, provenance: "USER_CONFIGURED" });
  const read = new DashboardReadModel(store, () => NOW + 1) as any;
  const getProfessions = read.getCharacterProfessions.bind(read);
  read.getCharacterProfessions = (query: any) => {
    const result = getProfessions(query);
    if (result.status !== "FOUND" || !result.value.data) return result;
    const name = query.name;
    const observedCraft = name === "Holder" && (options.holderProfessions?.length ?? 0) > 0;
    const observedIncomplete = name === "Crafter" && options.incompleteAlt;
    if (!observedCraft && !observedIncomplete) return result;
    const complete = observedCraft;
    return { ...result, value: { ...result.value, data: { ...result.value.data, recipeKnowledge: {
      completeness: complete ? "complete" : "partial", status: { state: "OBSERVED" }, evidence: { state: "OBSERVED" },
      data: { professions: [{ professionName: "Blacksmithing", recipes: complete && options.usesItem ? [{ evidence: "OBSERVED", reagentSlots: [{ alternatives: [{ itemID: options.itemId ?? 2840 }] }] }] : [] }] },
    } } } };
  };
  return { store, read, holder, holdItemIds: options.holdItemIds };
}

test("Era mail routes unused unbound materials past observed-empty profession alts", () => {
  const ctx = setup({ holderProfessions: [{ name: "Blacksmithing", skill: 1, maxSkill: 75 }] });
  try {
    const result = ctx.read.getClassicEraMailPlan({ version: "classic-era", name: "Holder", realm: REALM });
    const item = result.value.data.items[0];
    assert.equal(item.action, "MAIL_TO_AUCTION_CHARACTER", item.reason);
    assert.equal(item.recipient.name, "Auction");
  } finally { ctx.store.close(); }
});

test("an alt with an observed crafting profession and incomplete recipes is named as the blocker", () => {
  const ctx = setup({ holderProfessions: [{ name: "Blacksmithing", skill: 1, maxSkill: 75 }], incompleteAlt: true });
  try {
    const result = ctx.read.getClassicEraMailPlan({ version: "classic-era", name: "Holder", realm: REALM });
    assert.equal(result.value.data.items[0].action, "KEEP");
    assert.match(result.value.data.items[0].reason, /Crafter \(Blacksmithing\)/);
  } finally { ctx.store.close(); }
});

test("Era mail keeps bound items, leaves unknown binding undetermined, and holds configured IDs", () => {
  for (const [bound, hold, expected] of [[true, undefined, "KEEP"], ["unknown", undefined, "UNDETERMINED"], [false, [2840], "KEEP"]] as const) {
    const ctx = setup({ bound, holdItemIds: hold ? [...hold] : undefined });
    try {
      const result = ctx.read.getClassicEraMailPlan({ version: "classic-era", name: "Holder", realm: REALM }, { holdItemIds: ctx.holdItemIds });
      assert.equal(result.value.data.items[0].action, expected);
      if (bound === true) assert.equal(result.value.data.items[0].reason, "Item is OBSERVED bound and cannot be routed to another character.");
      if (hold) assert.equal(result.value.data.items[0].reason, "on hold list");
    } finally { ctx.store.close(); }
  }
});

test("the configured auction character receives SELL_AH for an unused unbound material", () => {
  const ctx = setup({ auctionHolder: true });
  try {
    const result = ctx.read.getClassicEraMailPlan({ version: "classic-era", name: "Holder", realm: REALM });
    assert.equal(result.value.data.items[0].action, "SELL_AH", result.value.data.items[0].reason);
  } finally { ctx.store.close(); }
});

test("real Classic Era recipe sidecar is complete and routes unused Linen Cloth to the auction character", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const holderText = era("Holder", { professions: [{ name: "Cooking", skill: 1, maxSkill: 75 }], itemId: 2589 });
    const rawRecipeSidecar = { capture: 119, revision: 4, observedAt: NOW, completeness: "complete", data: {
      formatVersion: 1, clientFamily: "1.15.9", professions: [{ name: "Cooking", professionName: "Cooking", observedAt: NOW, sessionObservedAt: NOW - 2,
        recipes: [{ name: "Herb Baked Egg", itemID: 6888, difficulty: "optimal", reagents: [{ name: "Small Egg", count: 1 }, { name: "Mild Spices", count: 1 }] },
          { name: "Mystery Recipe", difficulty: "optimal", reagents: [{ name: "Chunk of Boar Meat", count: 1 }] }] }] } };
    store.importSnapshot(holderText, { characterState: { formatVersion: 1, clientFamily: "Classic", professionRecipes: rawRecipeSidecar } } as any);
    store.importSnapshot(era("Auction"));
    const auction = store.listCharacters("classic-era").find((row) => row.name === "Auction")!;
    store.setMailPlanSettings({ accountId: "default", version: "classic-era", realm: REALM, faction: "Alliance", auctionCharacterIdentityKey: auction.identityKey, updatedAt: NOW, provenance: "USER_CONFIGURED" });
    const read = new DashboardReadModel(store, () => NOW + 1);
    const professions = read.getCharacterProfessions({ version: "classic-era", name: "Holder", realm: REALM });
    assert.equal(professions.status, "FOUND");
    if (professions.status === "FOUND") {
      const knowledge = professions.value.data?.recipeKnowledge as any;
      assert.equal(knowledge.status.state, "OBSERVED");
      assert.equal(knowledge.completeness, "complete");
      assert.equal(knowledge.data.professions[0].recipes[1].outputItemID, undefined, "nil output itemID is retained as unknown");
      assert.equal(knowledge.data.professions[0].recipes[1].learnedState, "UNKNOWN");
    }
    const plan = read.getClassicEraMailPlan({ version: "classic-era", name: "Holder", realm: REALM });
    assert.equal(plan.status, "FOUND");
    if (plan.status === "FOUND") {
      const cloth = (plan.value as any).data.items.find((item: any) => item.name === "Test material");
      assert.equal(cloth?.action, "MAIL_TO_AUCTION_CHARACTER", cloth?.reason);
      assert.equal(cloth?.recipient?.name, "Auction");
    }
  } finally { store.close(); }
});
