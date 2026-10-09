import type { VersionOrUnknown } from "./types.ts";
import { classifyFreshness } from "./freshness.ts";

export interface ForeverStructuredObservation {
  clientProfile: "Forever:1.60.1:70291:16001";
  name: string;
  realm: string;
  generatedAt: number;
  sourceCharacterGuid?: string;
  sourceCharacterGuidConflict?: boolean;
  equipment?: Record<string, unknown>;
  bags?: Record<string, unknown>;
  bank?: Record<string, unknown>;
  itemMetadata?: Record<string, unknown>;
}

type ForeverSectionState = "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
type ForeverEquipmentLike = { status: { state: ForeverSectionState; observedAt?: number }; slots: Array<{ slot: number; slotName: string; empty: boolean; itemRef?: string; name?: string; itemLevel?: string }> };
type ForeverInventoryLike = { status: { state: ForeverSectionState; observedAt?: number }; items: Array<{ itemRef?: string; name?: string; qty?: number }> };

export function normalizeForeverStructuredObservation(value: unknown, version: VersionOrUnknown, name?: string, realm?: string, generatedAt?: number): ForeverStructuredObservation | undefined {
  if (version !== "forever" || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.clientProfile !== "Forever:1.60.1:70291:16001" || typeof v.name !== "string" || typeof v.realm !== "string" || !Number.isSafeInteger(v.generatedAt)) return undefined;
  if (name?.toLocaleLowerCase() !== v.name.toLocaleLowerCase() || realm?.toLocaleLowerCase() !== v.realm.toLocaleLowerCase() || generatedAt !== v.generatedAt) return undefined;
  const section = (key: string): Record<string, unknown> | undefined => {
    const raw = v[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const s = raw as Record<string, unknown>;
    return typeof s.observedAt === "number" && Number.isFinite(s.observedAt) && s.data !== undefined ? s : undefined;
  };
  return {
    clientProfile: "Forever:1.60.1:70291:16001", name: v.name, realm: v.realm, generatedAt: v.generatedAt as number,
    ...(typeof v.sourceCharacterGuid === "string" && v.sourceCharacterGuid.length > 0 ? { sourceCharacterGuid: v.sourceCharacterGuid } : {}),
    ...(v.sourceCharacterGuidConflict === true ? { sourceCharacterGuidConflict: true } : {}),
    ...(section("equipment") ? { equipment: section("equipment") } : {}),
    ...(section("bags") ? { bags: section("bags") } : {}),
    ...(section("bank") ? { bank: section("bank") } : {}),
    ...(v.itemMetadata && typeof v.itemMetadata === "object" && !Array.isArray(v.itemMetadata) ? { itemMetadata: v.itemMetadata as Record<string, unknown> } : {}),
  };
}

function entries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.map((item, index) => [String(index + 1), item]);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>);
  return [];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function structuredEquipment(section: Record<string, unknown> | undefined, fallback: ForeverEquipmentLike["slots"], provenance: string) {
  const rawSlots = object(section?.data)?.slots;
  if (!rawSlots || typeof rawSlots !== "object") return fallback.filter((slot) => !slot.empty).map((slot) => ({ slot: slot.slot, slotName: slot.slotName, itemID: undefined, itemRef: slot.itemRef, name: slot.name, itemLevel: slot.itemLevel, provenance }));
  return entries(rawSlots).flatMap(([key, value]) => {
    const item = object(value);
    if (!item) return [];
    const slot = Number(key);
    return [{ slot, slotName: `Slot ${key}`, itemID: typeof item.itemID === "number" ? item.itemID : undefined, itemRef: typeof item.itemString === "string" ? item.itemString : undefined, name: typeof item.name === "string" ? item.name : undefined, itemLevel: typeof item.itemLevel === "number" ? String(item.itemLevel) : undefined, provenance }];
  });
}

function structuredBags(section: Record<string, unknown> | undefined, fallback: ForeverInventoryLike["items"], provenance: string) {
  const containers = object(section?.data)?.containers;
  if (!containers || typeof containers !== "object") return fallback.map((item) => ({ itemRef: item.itemRef, name: item.name, quantity: item.qty, provenance }));
  return entries(containers).flatMap(([containerKey, containerValue]) => {
    const container = object(containerValue);
    if (!container) return [];
    return entries(container.slots).flatMap(([slot, itemValue]) => {
      const item = object(itemValue);
      if (!item) return [];
      const itemID = typeof item.itemID === "number" ? item.itemID : undefined;
      return [{ container: typeof container.id === "number" ? container.id : Number(containerKey), slot: Number(slot), itemID, itemRef: typeof item.itemString === "string" ? item.itemString : itemID === undefined ? undefined : `item:${itemID}`, itemIdentity: typeof item.itemString === "string" ? "OBSERVED" as const : itemID === undefined ? "UNKNOWN" as const : "PARTIAL" as const, name: typeof item.name === "string" ? item.name : undefined, quantity: typeof item.count === "number" ? item.count : undefined, provenance }];
    });
  });
}

function usableRows(section: Record<string, unknown> | undefined, key: "slots" | "containers"): boolean {
  const raw = object(section?.data)?.[key];
  return Array.isArray(raw) || (raw !== null && typeof raw === "object");
}

function structuredState(section: Record<string, unknown> | undefined): ForeverSectionState {
  if (!section?.data || typeof section.data !== "object") return "UNKNOWN";
  if (section.lastAttemptStale === true) return "LAST_SEEN";
  return section.completeness === "complete" || section.completeness === "partial" ? "OBSERVED" : "UNKNOWN";
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}

/** Additive duplicate-export merge. Newer section reads replace older reads independently; equal-time conflicts keep the first evidence. */
export function mergeForeverStructuredObservation(existing: ForeverStructuredObservation | undefined, incoming: ForeverStructuredObservation): { value: ForeverStructuredObservation; outcome: "recorded" | "updated" | "already-recorded" | "conflict" } {
  if (!existing) return { value: incoming, outcome: "recorded" };
  let updated = false;
  let conflict = false;
  const value = { ...existing };
  if (incoming.sourceCharacterGuid && existing.sourceCharacterGuid && incoming.sourceCharacterGuid !== existing.sourceCharacterGuid) {
    value.sourceCharacterGuidConflict = true;
    conflict = true;
  }
  if (incoming.sourceCharacterGuidConflict || existing.sourceCharacterGuidConflict) value.sourceCharacterGuidConflict = true;
  for (const key of ["equipment", "bags", "bank"] as const) {
    const before = existing[key]; const next = incoming[key];
    if (!next) continue;
    if (!before) { value[key] = next; updated = true; continue; }
    const a = before.observedAt as number; const b = next.observedAt as number;
    if (b > a) { value[key] = next; updated = true; }
    else if (b === a && JSON.stringify(stable(before)) !== JSON.stringify(stable(next))) conflict = true;
  }
  if (!existing.itemMetadata && incoming.itemMetadata) { value.itemMetadata = incoming.itemMetadata; updated = true; }
  else if (existing.itemMetadata && incoming.itemMetadata && JSON.stringify(stable(existing.itemMetadata)) !== JSON.stringify(stable(incoming.itemMetadata))) conflict = true;
  return { value, outcome: updated ? "updated" : conflict ? "conflict" : "already-recorded" };
}

export function buildForeverGearObservation(input: {
  identity: { version: VersionOrUnknown; identityKey: string; name: string; realm: string };
  snapshotId: number;
  generatedAt?: number;
  importedAt: number;
  equipment: ForeverEquipmentLike;
  bags: ForeverInventoryLike;
  bank: { status: { state: ForeverSectionState; observedAt?: number } };
  structured?: ForeverStructuredObservation;
  now: number;
}) {
  const { identity, equipment, bags, bank, structured } = input;
  const sectionTime = (kind: "equipment" | "bags" | "bank", fallback: number | undefined) => structured?.[kind]?.observedAt as number | undefined ?? fallback;
  const freshness = (at?: number) => at === undefined ? "unknown" : classifyFreshness(at, input.now);
  const equipmentAt = sectionTime("equipment", equipment.status.observedAt ?? input.generatedAt ?? input.importedAt);
  const bagsAt = sectionTime("bags", bags.status.observedAt ?? input.generatedAt ?? input.importedAt);
  const bankAt = sectionTime("bank", bank.status.observedAt);
  const useStructuredEquipment = usableRows(structured?.equipment, "slots");
  const useStructuredBags = usableRows(structured?.bags, "containers");
  const equipmentSource = useStructuredEquipment ? "Forever WoWSyncDB sections.equipment" : "WOWSYNC v1 equipment";
  const bagsSource = useStructuredBags ? "Forever WoWSyncDB sections.bags" : "WOWSYNC v1 bags";
  const equipmentState = useStructuredEquipment ? structuredState(structured?.equipment) : equipment.status.state;
  const bagsState = useStructuredBags ? structuredState(structured?.bags) : bags.status.state;
  const equipmentItems = structuredEquipment(useStructuredEquipment ? structured?.equipment : undefined, equipment.slots, equipmentState);
  const carriedItems = bagsState === "UNKNOWN" && !useStructuredBags ? undefined : structuredBags(useStructuredBags ? structured?.bags : undefined, bags.items, bagsState);
  return {
    identity: { ...identity, accountScope: "UNKNOWN", accountScopeReason: "WoWSync character identity carries version, realm, and name but no WoW account identifier; this view is scoped to the Dashboard import context and does not assert Battle.net account identity." },
    snapshot: { snapshotId: input.snapshotId, ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}), importedAt: input.importedAt },
    equipment: { state: equipmentState, source: equipmentSource, ...(equipmentAt !== undefined ? { observedAt: equipmentAt, freshness: freshness(equipmentAt) } : {}), items: equipmentItems },
    carried: { state: bagsState, source: bagsSource, ...(bagsAt !== undefined ? { observedAt: bagsAt, freshness: freshness(bagsAt) } : {}), items: carriedItems },
    evaluationCandidates: { state: "UNKNOWN" as const, items: [], reason: "No validated Forever equipment-location metadata is available to distinguish wearable gear from other carried items." },
    unknowns: { eligibility: "UNKNOWN", suitability: "UNKNOWN", upgradeStatus: "UNKNOWN", transferability: "UNKNOWN" },
    bank: { state: bank.status.state, ...(bankAt !== undefined ? { observedAt: bankAt, freshness: freshness(bankAt) } : {}), reason: bank.status.state === "UNKNOWN" ? "Bank contents were not observed; unavailable is not empty." : undefined },
    metadataSource: structured?.itemMetadata ? "Forever WoWSyncDB itemMetadata" : "UNKNOWN",
  };
}
