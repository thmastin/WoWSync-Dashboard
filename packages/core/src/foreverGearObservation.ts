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
  itemEvidence?: Record<string, unknown>;
}

type ForeverSectionState = "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
type ForeverEquipmentLike = { status: { state: ForeverSectionState; observedAt?: number }; slots: Array<{ slot: number; slotName: string; empty: boolean; itemRef?: string; name?: string; itemLevel?: string }> };
type ForeverInventoryLike = { status: { state: ForeverSectionState; observedAt?: number }; items: Array<{ itemRef?: string; name?: string; qty?: number }> };
type ForeverCarriedItem = { container?: number; slot?: number; itemID?: number; itemRef?: string; itemIdentity?: "OBSERVED" | "PARTIAL" | "UNKNOWN"; name?: string; quantity?: number; bound?: boolean; bindingState?: string; provenance: ForeverSectionState };

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
    ...(section("itemEvidence") ? { itemEvidence: section("itemEvidence") } : {}),
    ...(v.itemMetadata && typeof v.itemMetadata === "object" && !Array.isArray(v.itemMetadata) ? { itemMetadata: v.itemMetadata as Record<string, unknown> } : {}),
  };
}

function entries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.map((item, index) => [String(index + 1), item]);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>);
  return [];
}

/** Lua bag tables use 1-based slot keys; contiguous keys become JS arrays at index 0. */
function slotEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) return Array.from(value.entries(), ([index, item]) => [String(index + 1), item]);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>);
  return [];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function structuredEquipment(section: Record<string, unknown> | undefined, fallback: ForeverEquipmentLike["slots"], provenance: string) {
  const rawSlots = object(section?.data)?.slots;
  if (!rawSlots || typeof rawSlots !== "object") return fallback.filter((slot) => !slot.empty).map((slot) => ({ slot: slot.slot, slotName: slot.slotName, itemID: undefined, itemRef: slot.itemRef, itemIdentity: slot.itemRef ? "OBSERVED" as const : "UNKNOWN" as const, name: slot.name, itemLevel: slot.itemLevel, provenance: slot.itemRef ? provenance : "UNKNOWN" as const }));
  return entries(rawSlots).flatMap(([key, value]) => {
    const item = object(value);
    if (!item) return [];
    const slot = Number(key);
    const itemID = typeof item.itemID === "number" ? item.itemID : undefined;
    const itemString = typeof item.itemString === "string" ? item.itemString : undefined;
    const identified = itemID !== undefined || itemString !== undefined;
    return [{ slot, slotName: `Slot ${key}`, itemID, itemRef: itemString ?? (itemID === undefined ? undefined : `item:${itemID}`), itemIdentity: itemString ? "OBSERVED" as const : itemID === undefined ? "UNKNOWN" as const : "PARTIAL" as const, name: typeof item.name === "string" ? item.name : undefined, itemLevel: typeof item.itemLevel === "number" ? String(item.itemLevel) : undefined, provenance: identified ? provenance : "UNKNOWN" as const }];
  });
}

function structuredBags(section: Record<string, unknown> | undefined, fallback: ForeverInventoryLike["items"], provenance: ForeverSectionState): ForeverCarriedItem[] {
  const containers = object(section?.data)?.containers;
  if (!containers || typeof containers !== "object") return fallback.map((item) => ({ itemRef: item.itemRef, itemIdentity: item.itemRef ? "OBSERVED" : "UNKNOWN", name: item.name, quantity: item.qty, provenance }));
  return entries(containers).flatMap(([containerKey, containerValue]) => {
    const container = object(containerValue);
    if (!container) return [];
    return slotEntries(container.slots).flatMap(([slot, itemValue]) => {
      const item = object(itemValue);
      if (!item) return [];
      const itemID = typeof item.itemID === "number" ? item.itemID : undefined;
      return [{ container: typeof container.id === "number" ? container.id : Number(containerKey), slot: Number(slot), itemID, itemRef: typeof item.itemString === "string" ? item.itemString : itemID === undefined ? undefined : `item:${itemID}`, itemIdentity: typeof item.itemString === "string" ? "OBSERVED" as const : itemID === undefined ? "UNKNOWN" as const : "PARTIAL" as const, name: typeof item.name === "string" ? item.name : undefined, quantity: typeof item.count === "number" ? item.count : undefined, ...(typeof item.bound === "boolean" ? { bound: item.bound } : {}), ...(typeof item.bindingState === "string" ? { bindingState: item.bindingState } : {}), provenance }];
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

function tupleObservation(call: Record<string, unknown> | undefined, index: number): Record<string, unknown> | undefined {
  const rows = Array.isArray(call?.returns) ? call.returns : [];
  const row = rows.map(object).find((entry) => entry?.index === index) ?? object(rows[index - 1]);
  return object(row?.observation);
}

function itemApiEvidence(fact: Record<string, unknown>, itemRef: string, observedName: string | undefined, itemFactsObservedAt: number | undefined, statDeltaComparisons: unknown, statDeltaSourceCurrent: boolean, equippedItemRefs: Set<string>, now: number) {
  const info = object(fact.itemInfo);
  const instant = object(fact.itemInfoInstant);
  const stats = object(fact.itemStats);
  const statsTable = object(stats?.table);
  const infoValue = (index: number) => tupleObservation(info, index);
  const instantValue = (index: number) => tupleObservation(instant, index);
  const value = (row: Record<string, unknown> | undefined) => row?.state === "OBSERVED" ? row.value : undefined;
  const name = value(infoValue(1));
  const hyperlink = value(infoValue(2));
  const returnedVariantMatches = typeof hyperlink === "string" && hyperlink.includes(`|H${itemRef}|h`);
  const instantAgreement = value(infoValue(6)) === value(instantValue(2))
    && value(infoValue(7)) === value(instantValue(3))
    && value(infoValue(9)) === value(instantValue(4))
    && value(infoValue(12)) === value(instantValue(6))
    && value(infoValue(13)) === value(instantValue(7));
  const nameAgreement = typeof observedName !== "string" || name === observedName;
  const tupleShapeObserved = info?.state === "OBSERVED_VALUE" && info?.returnCount === 18
    && returnedVariantMatches && instantAgreement && nameAgreement;
  const field = (index: number, type: string, semantic: string) => {
    const row = infoValue(index);
    if (tupleShapeObserved && row?.state === "OBSERVED" && row.type === type) {
      return { state: "OBSERVED" as const, value: row.value, api: "C_Item.GetItemInfo", observedAt: info?.observedAt };
    }
    return { state: "UNKNOWN" as const, reason: tupleShapeObserved ? `The validated ${semantic} return was absent or had an unexpected type.` : "GetItemInfo tuple, exact item variant, or cross-API corroboration did not match the validated Forever 70291 capture contract." };
  };
  const infoReturns = Array.isArray(info?.returns) ? info.returns : [];
  const statEntries = Array.isArray(statsTable?.entries) ? statsTable.entries : [];
  const deltaSection = object(statDeltaComparisons);
  const deltaRows = Array.isArray(deltaSection?.comparisons) ? deltaSection.comparisons : [];
  const exactPairDeltas = deltaRows.flatMap((entry) => {
    const row = object(entry); const pair = object(row?.input); const table = object(row?.table);
    if (!statDeltaSourceCurrent || row?.api !== "C_Item.GetItemStatDelta" || row?.state !== "OBSERVED_VALUE"
      || pair?.candidateItemString !== itemRef || typeof pair.equippedItemString !== "string" || !equippedItemRefs.has(pair.equippedItemString)
      || table?.state !== "OBSERVED_TABLE" || table.complete !== true) return [];
    return [{ api: row?.api ?? "UNKNOWN", state: row?.state ?? "UNKNOWN", candidateItemString: pair.candidateItemString,
      equippedItemString: pair.equippedItemString, ...(typeof deltaSection?.observedAt === "number" ? { observedAt: deltaSection.observedAt, freshness: classifyFreshness(deltaSection.observedAt, now) } : {}),
      ...(typeof table?.complete === "boolean" ? { complete: table.complete } : {}), entries: Array.isArray(table?.entries) ? table.entries : [],
      interpretation: "RAW_ORDERED_PAIR_RESULT" as const }];
  });
  return {
    itemInfo: { state: info?.state ?? "UNKNOWN", api: info?.api ?? "UNKNOWN", returnCount: info?.returnCount ?? null, ...(typeof info?.observedAt === "number" ? { observedAt: info.observedAt } : {}), returns: infoReturns },
    itemStats: { state: statsTable?.state ?? stats?.state ?? "UNKNOWN", callState: stats?.state ?? "UNKNOWN", api: stats?.api ?? "UNKNOWN", entryCount: statsTable?.entryCount ?? null, complete: statsTable?.complete ?? false, ...((typeof stats?.observedAt === "number" ? stats.observedAt : itemFactsObservedAt) !== undefined ? { observedAt: typeof stats?.observedAt === "number" ? stats.observedAt : itemFactsObservedAt } : {}), entries: statEntries },
    statDeltaEvidence: { api: deltaSection?.state === "API_MISSING" ? "API_MISSING" : "C_Item.GetItemStatDelta", state: deltaSection?.state ?? "UNKNOWN", completeness: deltaSection?.completeness ?? "unknown", ...(typeof deltaSection?.observedAt === "number" ? { observedAt: deltaSection.observedAt, freshness: classifyFreshness(deltaSection.observedAt, now) } : {}), reason: statDeltaSourceCurrent ? "Complete, recent pair observations are filtered to the candidate and exact equipped variants present in this equipment snapshot." : "Raw pair results are withheld unless item facts, bag/equipment sources, pair-section completeness, and freshness are all current." },
    statDeltaComparisons: exactPairDeltas,
    validatedFields: {
      contractState: tupleShapeObserved ? "OBSERVED" as const : "UNKNOWN" as const,
      itemName: field(1, "string", "item name"),
      itemLevel: field(4, "number", "item level"),
      requiredLevel: field(5, "number", "required level"),
      itemClass: field(6, "string", "item class"),
      itemSubclass: field(7, "string", "item subclass"),
      equipLocation: field(9, "string", "equipment location"),
      classID: field(12, "number", "item class ID"),
      subclassID: field(13, "number", "item subclass ID"),
      crossChecks: { exactReturnedVariant: returnedVariantMatches, observedName: nameAgreement, instantAPIFieldsAgree: instantAgreement },
      reason: tupleShapeObserved
        ? "Tuple positions listed here were live-corroborated against exact item links, GetItemInfoInstant fields, observed names, and equipped level fields on Forever 1.60.1 build 70291. GetItemStats entries remain raw stat keys and values."
        : "No item metadata is interpreted unless the 70291 tuple shape and independent cross-checks pass.",
    },
    semanticInterpretation: tupleShapeObserved ? "PARTIALLY_VALIDATED" as const : "UNKNOWN" as const,
    reason: tupleShapeObserved
      ? "Selected GetItemInfo fields are corroborated for Forever 70291. Raw GetItemStats keys are retained without translating them into upgrade or build conclusions."
      : "Forever 70291 GetItemInfo/GetItemStats results are retained as raw API evidence; semantics remain UNKNOWN when tuple or cross-check evidence is incomplete.",
  };
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
  const beforeFacts = existing.itemEvidence; const nextFacts = incoming.itemEvidence;
  if (nextFacts) {
    if (!beforeFacts || (nextFacts.observedAt as number) > (beforeFacts.observedAt as number)) { value.itemEvidence = nextFacts; updated = true; }
    else if ((nextFacts.observedAt as number) === (beforeFacts.observedAt as number) && JSON.stringify(stable(beforeFacts)) !== JSON.stringify(stable(nextFacts))) conflict = true;
  }
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
  const evidence = object(structured?.itemEvidence);
  const evidenceData = object(evidence?.data);
  const statDeltaComparisons = evidenceData?.statDeltaComparisons;
  const evidenceBagSource = object(object(evidenceData?.sourceSections)?.bags);
  const evidenceBagObservedAt = typeof evidenceBagSource?.observedAt === "number" ? evidenceBagSource.observedAt : undefined;
  const evidenceBagFreshness = freshness(evidenceBagObservedAt);
  const evidenceBagComplete = evidenceBagSource?.state === "complete" && evidenceBagFreshness === "recent"
    && structured?.bags?.completeness === "complete" && bagsState === "OBSERVED" && freshness(bagsAt) === "recent";
  const evidenceEquipmentSource = object(object(evidenceData?.sourceSections)?.equipment);
  const evidenceEquipmentComplete = evidenceEquipmentSource?.state === "complete" && freshness(typeof evidenceEquipmentSource.observedAt === "number" ? evidenceEquipmentSource.observedAt : undefined) === "recent"
    && structured?.equipment?.completeness === "complete" && equipmentState === "OBSERVED" && freshness(equipmentAt) === "recent";
  const deltaSection = object(statDeltaComparisons);
  const statDeltaSourceCurrent = evidence?.completeness === "complete" && deltaSection?.completeness === "complete"
    && freshness(typeof deltaSection.observedAt === "number" ? deltaSection.observedAt : undefined) === "recent"
    && evidenceBagComplete && evidenceEquipmentComplete;
  const equippedItemRefs = new Set(equipmentItems.flatMap((item) => item.provenance === "OBSERVED" && typeof item.itemRef === "string" ? [item.itemRef] : []));
  const itemFactsLastSeen = evidence !== undefined && (bagsState === "LAST_SEEN" || evidence?.lastAttemptStale === true
    || evidenceBagSource?.state === "LAST_SEEN"
    || evidenceBagFreshness === "stale"
    || freshness(bagsAt) === "stale"
    || (typeof evidence?.observedAt === "number" && freshness(evidence.observedAt) === "stale"));
  const rawFacts = evidenceData?.items;
  const factRows = Array.isArray(rawFacts) ? rawFacts.map(object).filter((row): row is Record<string, unknown> => row !== undefined) : [];
  const factsByRef = new Map(factRows.flatMap((row) => typeof row.itemString === "string" ? [[row.itemString, row] as const] : []));
  const observedCarried = carriedItems ?? [];
  const itemFactsAvailable = evidence !== undefined && evidenceData !== undefined;
  const carriedCovered = observedCarried.filter((item) => item.itemRef && factsByRef.has(item.itemRef)).length;
  const itemFactCoverageComplete = itemFactsAvailable && evidenceBagComplete && carriedItems !== undefined && carriedCovered === observedCarried.length
    && observedCarried.every((item) => {
      if (!item.itemRef) return false;
      const fact = factsByRef.get(item.itemRef);
      const instant = object(fact?.itemInfoInstant);
      const returns = instant && Array.isArray(instant.returns) ? instant.returns : [];
      const apiID = object(object(returns[0])?.observation);
      const itemType = object(object(returns[1])?.observation);
      const itemSubType = object(object(returns[2])?.observation);
      const equipLocation = object(object(returns[3])?.observation);
      const equippableCall = object(fact?.isEquippableItem);
      const equippableReturns = equippableCall && Array.isArray(equippableCall.returns) ? equippableCall.returns : [];
      const equippable = object(object(equippableReturns[0])?.observation);
      return instant?.api === "C_Item.GetItemInfoInstant" && instant.state === "OBSERVED_VALUE"
        && apiID?.state === "OBSERVED" && apiID.type === "number" && apiID.value === (item.itemID ?? itemIdFromRef(item.itemRef))
        && itemType?.state === "OBSERVED" && itemType.type === "string"
        && itemSubType?.state === "OBSERVED" && itemSubType.type === "string"
        && equipLocation?.state === "OBSERVED" && equipLocation.type === "string"
        && equippableCall?.api === "C_Item.IsEquippableItem" && equippableCall.state === "OBSERVED_VALUE"
        && equippable?.state === "OBSERVED" && equippable.type === "boolean";
    });
  const evaluationItems = observedCarried.flatMap((item) => {
    if (!item.itemRef) return [];
    const fact = factsByRef.get(item.itemRef);
    if (!fact) return [];
    const instant = object(fact.itemInfoInstant);
    const returns = instant && Array.isArray(instant.returns) ? instant.returns : [];
    const observedReturn = (index: number) => object(object(returns[index - 1])?.observation);
    const returnedID = observedReturn(1);
    const itemType = observedReturn(2);
    const itemSubType = observedReturn(3);
    const equipLocation = observedReturn(4);
    const itemID = item.itemID ?? itemIdFromRef(item.itemRef);
    const equippableCall = object(fact.isEquippableItem);
    const equippableRows = equippableCall && Array.isArray(equippableCall.returns) ? equippableCall.returns : [];
    const equippable = object(object(equippableRows[0])?.observation);
    const apiItemType = instant?.api === "C_Item.GetItemInfoInstant" && instant.state === "OBSERVED_VALUE"
      && returnedID?.state === "OBSERVED" && returnedID.type === "number" && returnedID.value === itemID;
    const usableEquipLocation = equipLocation?.state === "OBSERVED" && equipLocation.type === "string"
      && typeof equipLocation.value === "string" && equipLocation.value.length > 0 && equipLocation.value !== "INVTYPE_NON_EQUIP_IGNORE";
    const isProjectile = itemType?.state === "OBSERVED" && itemType.type === "string" && itemType.value === "Projectile";
    const itemLevelVerdict = equippableCall?.api === "C_Item.IsEquippableItem" && equippableCall.state === "OBSERVED_VALUE"
      && equippable?.state === "OBSERVED" && equippable.type === "boolean" && equippable.value === true;
    if (!apiItemType || !usableEquipLocation || !itemLevelVerdict || isProjectile) return [];
    return [{ ...item,
      locatedWith: { state: item.provenance, characterIdentityKey: identity.identityKey, locationScope: "CHARACTER_CARRIED_INVENTORY" as const, source: bagsSource, ...(bagsAt !== undefined ? { observedAt: bagsAt, freshness: freshness(bagsAt) } : {}) },
      ownership: { state: "UNKNOWN" as const, reason: "Carried inventory location does not independently establish ownership." },
      binding: typeof item.bound === "boolean" ? { state: item.provenance, value: item.bound, observedAt: bagsAt, provenance: item.provenance } : { state: "UNKNOWN" as const, reason: "The carried item binding facet was not observed." },
      transferabilityEvidence: { state: "UNKNOWN" as const, reason: "A binding facet alone does not prove whether this item can be transferred to the requested character." },
      classification: "POTENTIAL_EQUIPMENT" as const,
      itemType: itemType?.state === "OBSERVED" && itemType.type === "string" ? itemType.value as string : undefined,
      itemSubType: itemSubType?.state === "OBSERVED" && itemSubType.type === "string" ? itemSubType.value as string : undefined,
      equipLocation: equipLocation.value as string,
      itemApiEvidence: itemApiEvidence(fact, item.itemRef, item.name, typeof evidence?.observedAt === "number" ? evidence.observedAt : undefined, statDeltaComparisons, statDeltaSourceCurrent, equippedItemRefs, input.now),
      evidenceSource: evidence?.source ?? "Forever 70291 C_Item item facts",
      ...(typeof evidence?.observedAt === "number" ? { evidenceObservedAt: evidence.observedAt } : {}),
      provenance: itemFactsLastSeen ? "LAST_SEEN" as const : "DERIVED" as const,
      eligibility: "UNKNOWN" as const, suitability: "UNKNOWN" as const,
      upgradeStatus: "UNKNOWN" as const, transferability: "UNKNOWN" as const,
      reason: "The client marked this item type equippable; this does not establish character eligibility, proficiency, suitability, upgrade value, or transferability." }];
  });
  const evaluationState = itemFactsLastSeen ? "LAST_SEEN" as const
    : itemFactCoverageComplete ? "OBSERVED" as const
    : evaluationItems.length > 0 || evidence?.completeness === "partial" || (evidence !== undefined && bagsState === "OBSERVED" && structured?.bags?.completeness === "partial") ? "PARTIAL" as const : "UNKNOWN" as const;
  const evaluationReason = evaluationState === "LAST_SEEN"
    ? "Potential equipment classification uses historical Forever item API evidence; verify its freshness before using it in an allocation decision."
    : evaluationState === "OBSERVED"
    ? "Every carried row has matching, complete, recent Forever item API evidence. Candidate classification covers carried inventory only; character eligibility and allocation conclusions remain unknown."
    : evaluationState === "PARTIAL"
      ? `${evaluationItems.length} potential item(s) have matching Forever evidence; item API coverage is incomplete for ${Math.max(0, observedCarried.length - carriedCovered)} carried row(s). Unclassified rows are not ruled out.`
      : "Potential equipment classification is UNKNOWN because matching, complete Forever item API evidence is unavailable.";
  return {
    identity: { ...identity, accountScope: "UNKNOWN", accountScopeReason: "WoWSync character identity carries version, realm, and name but no WoW account identifier; this view is scoped to the Dashboard import context and does not assert Battle.net account identity." },
    snapshot: { snapshotId: input.snapshotId, ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}), importedAt: input.importedAt },
    equipment: { state: equipmentState, source: equipmentSource, ...(equipmentAt !== undefined ? { observedAt: equipmentAt, freshness: freshness(equipmentAt) } : {}), items: equipmentItems.map((item) => {
      const fact = item.itemRef ? factsByRef.get(item.itemRef) : undefined;
      return fact && item.itemRef ? { ...item, itemApiEvidence: itemApiEvidence(fact, item.itemRef, item.name, typeof evidence?.observedAt === "number" ? evidence.observedAt : undefined, statDeltaComparisons, statDeltaSourceCurrent, equippedItemRefs, input.now) } : item;
    }) },
    carried: { state: bagsState, source: bagsSource, ...(bagsAt !== undefined ? { observedAt: bagsAt, freshness: freshness(bagsAt) } : {}), items: carriedItems?.map((item) => ({ ...item, locatedWith: { state: item.provenance, characterIdentityKey: identity.identityKey, locationScope: "CHARACTER_CARRIED_INVENTORY" as const, source: bagsSource, ...(bagsAt !== undefined ? { observedAt: bagsAt, freshness: freshness(bagsAt) } : {}) }, ownership: { state: "UNKNOWN" as const, reason: "Carried inventory location does not independently establish ownership." }, binding: typeof item.bound === "boolean" ? { state: item.provenance, value: item.bound, observedAt: bagsAt, provenance: item.provenance } : { state: "UNKNOWN" as const, reason: "The carried item binding facet was not observed." }, transferability: { state: "UNKNOWN" as const, reason: "A binding facet alone does not prove whether this item can be transferred to the requested character." } })) },
    evaluationCandidates: { state: evaluationState, source: evidence?.source ?? "UNKNOWN", ...(typeof evidence?.observedAt === "number" ? { observedAt: evidence.observedAt, freshness: freshness(evidence.observedAt) } : {}), items: evaluationItems, reason: evaluationReason, unknowns: { eligibility: "UNKNOWN", suitability: "UNKNOWN", upgradeStatus: "UNKNOWN", transferability: "UNKNOWN" } },
    unknowns: { eligibility: "UNKNOWN", suitability: "UNKNOWN", upgradeStatus: "UNKNOWN", transferability: "UNKNOWN" },
    bank: { state: bank.status.state, ...(bankAt !== undefined ? { observedAt: bankAt, freshness: freshness(bankAt) } : {}), reason: bank.status.state === "UNKNOWN" ? "Bank contents were not observed; unavailable is not empty." : undefined },
    metadataSource: structured?.itemMetadata ? "Forever WoWSyncDB itemMetadata" : "UNKNOWN",
  };
}

function itemIdFromRef(itemRef: string): number | undefined {
  const id = /^item:(\d+)/.exec(itemRef)?.[1];
  const parsed = id === undefined ? undefined : Number(id);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
