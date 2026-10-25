import type { VersionOrUnknown } from "./types.ts";
import { foreverBuildVerification, isForeverProfile, parseForeverProfile, supportsForeverGearEvaluation } from "./foreverProfile.ts";
import { classifyFreshness } from "./freshness.ts";
import { FOREVER_EQUIPMENT_SLOT_LABELS } from "./foreverEquipmentSlots.ts";
import { buildForeverQuestObservation } from "./foreverQuests.ts";

export interface ForeverStructuredObservation {
  clientProfile: `Forever:${string}`;
  name: string;
  realm: string;
  race?: string;
  generatedAt: number;
  sourceCharacterGuid?: string;
  sourceCharacterGuidConflict?: boolean;
  equipment?: Record<string, unknown>;
  bags?: Record<string, unknown>;
  bank?: Record<string, unknown>;
  quests?: Record<string, unknown>;
  talents?: Record<string, unknown>;
  reputation?: Record<string, unknown>;
  classSpellCatalog?: Record<string, unknown>;
  /** The latest failed profession-recipe capture (GearExport lastAttemptError/At); absent after a success. */
  recipeCaptureAttempt?: Record<string, unknown>;
  itemMetadata?: Record<string, unknown>;
  itemEvidence?: Record<string, unknown>;
  professionRecipes?: { status: { state: "OBSERVED"; completeness: "complete" | "partial"; observedAt: number }; completeness: "complete" | "partial"; observedAt: number; data: Record<string, unknown> };
}

type ForeverSectionState = "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
type ForeverEquipmentLike = { status: { state: ForeverSectionState; observedAt?: number }; slots: Array<{ slot: number; slotName: string; empty: boolean; itemRef?: string; name?: string; itemLevel?: string }> };
type ForeverInventoryLike = { status: { state: ForeverSectionState; observedAt?: number }; items: Array<{ itemRef?: string; name?: string; qty?: number }> };
type ForeverCarriedItem = { container?: number; slot?: number; itemID?: number; itemRef?: string; itemIdentity?: "OBSERVED" | "PARTIAL" | "UNKNOWN"; name?: string; nameSource?: string; nameResolution: "OBSERVED" | "UNKNOWN"; quantity?: number; bound?: boolean; bindingState?: string; quality?: number; classID?: number; subClassID?: number; equipLoc?: string; requiredLevel?: number; vendorCopper?: number; itemMetadataState?: "OBSERVED" | "UNKNOWN"; requiredProfession?: string; requiredSkill?: number; recipeAlreadyKnown?: boolean; provenance: ForeverSectionState };


export function normalizeForeverStructuredObservation(value: unknown, version: VersionOrUnknown, name?: string, realm?: string, generatedAt?: number): ForeverStructuredObservation | undefined {
  if (version !== "forever" || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!isForeverProfile(v.clientProfile) || typeof v.name !== "string" || typeof v.realm !== "string" || !Number.isSafeInteger(v.generatedAt)) return undefined;
  if (name?.toLocaleLowerCase() !== v.name.toLocaleLowerCase() || realm?.toLocaleLowerCase() !== v.realm.toLocaleLowerCase() || generatedAt !== v.generatedAt) return undefined;
  const section = (key: string): Record<string, unknown> | undefined => {
    const raw = v[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const s = raw as Record<string, unknown>;
    if (typeof s.observedAt !== "number" || !Number.isFinite(s.observedAt) || s.data === undefined) return undefined;
    const data = object(s.data);
    // Current GearExport Classic/Forever collectors identify the client in data.clientFamily
    // and name quest rows `quests`; older adapters already use `active` plus clientProfile/source.
    if (key === "quests" && data && Array.isArray(data.quests) && data.evidence === "OBSERVED") {
      return { ...s, data: { ...data, clientFamily: "Forever", clientProfile: v.clientProfile, source: "C_QuestLog", activeState: "OBSERVED", activeCompleteness: s.completeness, active: data.quests, completedHistory: { state: "UNKNOWN" } } };
    }
    return s;
  };
  const recipeSection = section("professionRecipes");
  const recipeData = object(recipeSection?.data);
  const simpleProfessionRows = Array.isArray(recipeData?.professions) ? recipeData.professions : undefined;
  const expectedClientVersion = v.clientProfile.split(":")[1];
  const simpleRecipes = recipeSection !== undefined && recipeData?.formatVersion === 1
    && recipeData.clientFamily === expectedClientVersion
    && simpleProfessionRows?.length
    && simpleProfessionRows.every((rawProfession) => {
      const profession = object(rawProfession);
      if (!profession || typeof (profession.professionName ?? profession.name) !== "string" || !Array.isArray(profession.recipes) || profession.recipes.length === 0) return false;
      return profession.recipes.every((rawRecipe) => {
        const recipe = object(rawRecipe);
        return !!recipe && typeof recipe.name === "string" && (recipe.itemID === undefined || Number.isSafeInteger(recipe.itemID) && (recipe.itemID as number) > 0)
          && Array.isArray(recipe.reagents) && recipe.reagents.every((rawReagent) => {
            const reagent = object(rawReagent);
            return !!reagent && typeof reagent.name === "string" && Number.isSafeInteger(reagent.count) && (reagent.count as number) > 0
              && (reagent.itemID === undefined || Number.isSafeInteger(reagent.itemID) && (reagent.itemID as number) > 0);
          });
      });
    });
  if (simpleRecipes) {
    const professions = simpleProfessionRows!.map((rawProfession) => {
      const profession = rawProfession as Record<string, unknown>;
      const professionName = (profession.professionName ?? profession.name) as string;
      return { ...profession, name: professionName, professionName, professionKey: professionName, evidence: "OBSERVED", recipes: (profession.recipes as unknown[]).map((rawRecipe) => {
        const recipe = rawRecipe as Record<string, unknown>;
        return { ...recipe, ...(recipe.itemID ? { outputItemID: recipe.itemID } : {}), evidence: "OBSERVED", learnedState: "UNKNOWN", reagents: (recipe.reagents as Array<Record<string, unknown>>).map((reagent) => ({ ...reagent, required: reagent.count })) };
      }) };
    });
    recipeData!.professions = professions;
    recipeData!.ownerScope = "CHARACTER";
  }
  const recipeCoverage = object(recipeData?.coverage);
  const recipeProfessions = Array.isArray(recipeData?.professions) ? recipeData.professions : undefined;
  const validRecipes = simpleRecipes || recipeSection !== undefined
    && recipeData?.formatVersion === 1
    && recipeData.ownerScope === "CHARACTER"
    && recipeCoverage?.state === "PARTIAL"
    && recipeCoverage.candidateCompleteness === "UNKNOWN"
    && Array.isArray(recipeProfessions)
    && recipeProfessions.length > 0
    && recipeProfessions.every((rawProfession) => {
      const profession = object(rawProfession);
      if (!profession || !Number.isSafeInteger(profession.baseSkillLineID) || !Number.isSafeInteger(profession.skillLineID)
        || (profession.evidence !== "OBSERVED" && profession.evidence !== "LAST_SEEN")
        || !Array.isArray(profession.recipes) || typeof profession.observedAt !== "number") return false;
      // A profession GearExport carried forward after a failed refresh is LAST_SEEN as a whole; its rows keep the
      // learned state observed earlier and are labelled LAST_SEEN downstream. Otherwise learned states must be OBSERVED.
      const carried = profession.evidence === "LAST_SEEN";
      return profession.recipes.every((rawRecipe) => {
        const recipe = object(rawRecipe);
        if (!recipe || !Number.isSafeInteger(recipe.recipeID) || (recipe.evidence !== "OBSERVED" && recipe.evidence !== "LAST_SEEN")) return false;
        const evidenceOk = recipe.evidence === "OBSERVED" || (carried && recipe.evidence === "LAST_SEEN");
        if (recipe.learnedState === "OBSERVED_TRUE") return recipe.learned === true && evidenceOk;
        if (recipe.learnedState === "OBSERVED_FALSE") return recipe.learned === false && evidenceOk;
        return (recipe.learnedState === "UNKNOWN" || recipe.learnedState === "NIL_RESULT") && recipe.learned === undefined;
      });
    });
  return {
    clientProfile: v.clientProfile as ForeverStructuredObservation["clientProfile"], name: v.name, realm: v.realm, generatedAt: v.generatedAt as number,
    ...(typeof v.race === "string" && v.race.trim() ? { race: v.race.trim() } : {}),
    ...(typeof v.sourceCharacterGuid === "string" && v.sourceCharacterGuid.length > 0 ? { sourceCharacterGuid: v.sourceCharacterGuid } : {}),
    ...(v.sourceCharacterGuidConflict === true ? { sourceCharacterGuidConflict: true } : {}),
    ...(section("equipment") ? { equipment: section("equipment") } : {}),
    ...(section("bags") ? { bags: section("bags") } : {}),
    ...(section("bank") ? { bank: section("bank") } : {}),
    ...(section("quests") ? { quests: section("quests") } : {}),
    ...(section("talents") ? { talents: section("talents") } : {}),
    ...(section("reputation") ? { reputation: section("reputation") } : {}),
    ...(section("classSpellCatalog") ? { classSpellCatalog: section("classSpellCatalog") } : {}),
    ...(section("recipeCaptureAttempt") && typeof object(section("recipeCaptureAttempt")!.data)?.error === "string" ? { recipeCaptureAttempt: section("recipeCaptureAttempt") } : {}),
    ...(section("itemEvidence") ? { itemEvidence: section("itemEvidence") } : {}),
    ...(validRecipes ? { professionRecipes: {
      status: { state: "OBSERVED" as const, completeness: simpleRecipes && recipeSection!.completeness === "complete" ? "complete" as const : "partial" as const, observedAt: recipeSection!.observedAt as number },
      completeness: simpleRecipes && recipeSection!.completeness === "complete" ? "complete" as const : "partial" as const,
      observedAt: recipeSection!.observedAt as number,
      data: recipeData!,
    } } : {}),
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
  if (!rawSlots || typeof rawSlots !== "object") return fallback.filter((slot) => !slot.empty).map((slot) => ({ slot: slot.slot, slotName: FOREVER_EQUIPMENT_SLOT_LABELS[slot.slot] ?? slot.slotName, itemID: undefined, itemRef: slot.itemRef, itemIdentity: slot.itemRef ? "OBSERVED" as const : "UNKNOWN" as const, name: slot.name, nameSource: slot.name ? "WOWSYNC_V1_OBSERVED_NAME" : undefined, nameResolution: slot.name ? "OBSERVED" as const : "UNKNOWN" as const, itemLevel: slot.itemLevel, provenance: slot.itemRef ? provenance : "UNKNOWN" as const }));
  return entries(rawSlots).flatMap(([key, value]) => {
    const item = object(value);
    if (!item) return [];
    const slot = Number(key);
    const itemID = typeof item.itemID === "number" ? item.itemID : undefined;
    const itemString = typeof item.itemString === "string" ? item.itemString : undefined;
    const identified = itemID !== undefined || itemString !== undefined;
    const name = typeof item.name === "string" && item.name.length > 0 ? item.name : undefined;
    return [{ slot, slotName: FOREVER_EQUIPMENT_SLOT_LABELS[slot] ?? `Slot ${key}`, itemID, itemRef: itemString ?? (itemID === undefined ? undefined : `item:${itemID}`), itemIdentity: itemString ? "OBSERVED" as const : itemID === undefined ? "UNKNOWN" as const : "PARTIAL" as const, name, nameSource: name ? (typeof item.nameSource === "string" ? item.nameSource : "WOWSYNC_V1_OBSERVED_NAME") : undefined, nameResolution: name ? "OBSERVED" as const : "UNKNOWN" as const, itemLevel: typeof item.itemLevel === "number" ? String(item.itemLevel) : undefined, provenance: identified ? provenance : "UNKNOWN" as const }];
  });
}

function structuredBags(section: Record<string, unknown> | undefined, fallback: ForeverInventoryLike["items"], provenance: ForeverSectionState): ForeverCarriedItem[] {
  const containers = object(section?.data)?.containers;
  if (!containers || typeof containers !== "object") return fallback.map((item) => ({ itemRef: item.itemRef, itemIdentity: item.itemRef ? "OBSERVED" : "UNKNOWN", name: item.name, nameSource: item.name ? "WOWSYNC_V1_OBSERVED_NAME" : undefined, nameResolution: item.name ? "OBSERVED" : "UNKNOWN", quantity: item.qty, provenance }));
  return entries(containers).flatMap(([containerKey, containerValue]) => {
    const container = object(containerValue);
    if (!container) return [];
    return slotEntries(container.slots).flatMap(([slot, itemValue]) => {
      const item = object(itemValue);
      if (!item) return [];
      const itemID = typeof item.itemID === "number" ? item.itemID : undefined;
      const name = typeof item.name === "string" && item.name.length > 0 ? item.name : undefined;
      const metadataObserved = item.itemMetadataState === "OBSERVED";
      return [{ container: typeof container.id === "number" ? container.id : Number(containerKey), slot: Number(slot), itemID, itemRef: typeof item.itemString === "string" ? item.itemString : itemID === undefined ? undefined : `item:${itemID}`, itemIdentity: typeof item.itemString === "string" ? "OBSERVED" as const : itemID === undefined ? "UNKNOWN" as const : "PARTIAL" as const, name, nameSource: name ? "C_Container.GetContainerItemInfo" : undefined, nameResolution: name ? "OBSERVED" as const : "UNKNOWN" as const, quantity: typeof item.count === "number" ? item.count : undefined, ...(typeof item.bound === "boolean" ? { bound: item.bound } : {}), ...(typeof item.bindingState === "string" ? { bindingState: item.bindingState } : {}), ...(item.itemMetadataState === "OBSERVED" || item.itemMetadataState === "UNKNOWN" ? { itemMetadataState: item.itemMetadataState } : {}), ...(metadataObserved ? { ...Object.fromEntries(["quality", "classID", "subClassID", "requiredLevel", "requiredSkill", "vendorCopper"].flatMap((key) => typeof item[key] === "number" ? [[key, item[key]]] : [])), ...(typeof item.equipLoc === "string" ? { equipLoc: item.equipLoc } : {}), ...(typeof item.requiredProfession === "string" ? { requiredProfession: item.requiredProfession } : {}), ...(typeof item.recipeAlreadyKnown === "boolean" ? { recipeAlreadyKnown: item.recipeAlreadyKnown } : {}) } : {}), provenance }];
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

function itemApiEvidence(fact: Record<string, unknown>, clientProfile: ForeverStructuredObservation["clientProfile"] | undefined, itemRef: string, observedName: string | undefined, itemFactsObservedAt: number | undefined, statDeltaComparisons: unknown, statDeltaSourceCurrent: boolean, statDeltaPairContextCurrent: boolean, equippedItemRefs: Set<string>, now: number) {
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
  const tupleShapeObserved = supportsForeverGearEvaluation(clientProfile) && info?.state === "OBSERVED_VALUE" && info?.returnCount === 18
    && returnedVariantMatches && instantAgreement && nameAgreement;
  const profile = parseForeverProfile(clientProfile);
  const buildVerified = profile ? foreverBuildVerification(profile) === "VERIFIED" : false;
  const field = (index: number, type: string, semantic: string) => {
    const row = infoValue(index);
    if (tupleShapeObserved && row?.state === "OBSERVED" && row.type === type) {
      return { state: "OBSERVED" as const, value: row.value, api: "C_Item.GetItemInfo", observedAt: info?.observedAt };
    }
    return { state: "UNKNOWN" as const, reason: tupleShapeObserved ? `The observed ${semantic} return was absent or had an unexpected type.` : "GetItemInfo tuple, exact item variant, or cross-API corroboration did not match the Forever gear-screen intake contract." };
  };
  const infoReturns = Array.isArray(info?.returns) ? info.returns : [];
  const statEntries = Array.isArray(statsTable?.entries) ? statsTable.entries : [];
  const equippable = object(fact.isEquippableItem);
  const equippableReturns = Array.isArray(equippable?.returns) ? equippable.returns : [];
  const equippableValue = object(object(equippableReturns[0])?.observation);
  const canUseCall = object(fact.playerCanUseItem);
  const canUseInput = object(canUseCall?.input);
  const canUseReturns = Array.isArray(canUseCall?.returns) ? canUseCall.returns : [];
  const canUseValue = object(object(canUseReturns[0])?.observation);
  const expectedItemID = Number(itemRef.match(/^item:(\d+)/)?.[1]);
  const playerCanUseItem = canUseCall?.api === "C_PlayerInfo.CanUseItem" && canUseInput?.scope === "CURRENT_PLAYER_ONLY"
    && canUseInput?.itemString === itemRef && canUseInput?.itemID === expectedItemID
    && canUseCall?.state === "OBSERVED_VALUE" && canUseValue?.state === "OBSERVED" && canUseValue.type === "boolean"
    ? { state: "OBSERVED" as const, value: canUseValue.value as boolean, api: canUseCall.api, itemString: itemRef, itemID: expectedItemID,
      ...(typeof canUseCall.observedAt === "number" ? { observedAt: canUseCall.observedAt, freshness: classifyFreshness(canUseCall.observedAt, now) } : {}),
      provenance: "OBSERVED_PLAYER_SCOPED_BASE_ITEM_SIGNAL" as const, identityScope: "BASE_ITEM_ID" as const, reason: "C_PlayerInfo.CanUseItem is called with the base item ID for the current player; itemString is only the exact observed variant associated with that call. This is not exact-variant or other-character eligibility." }
    : { state: "UNKNOWN" as const, api: canUseCall?.api ?? "UNKNOWN", itemString: canUseInput?.itemString ?? "UNKNOWN", identityScope: "BASE_ITEM_ID" as const, reason: "No complete current-player C_PlayerInfo.CanUseItem result for the base item ID is available." };
  const itemSpec = object(fact.itemSpecInfo);
  const itemSpecTable = object(itemSpec?.table);
  const itemSpecInput = object(itemSpec?.input);
  const itemSpecEntries = Array.isArray(itemSpecTable?.entries) ? itemSpecTable.entries : [];
  const itemSpecIDs = itemSpecEntries.map((entry) => {
    const row = object(entry);
    const observation = object(row?.observation);
    return observation?.state === "OBSERVED" && observation.type === "number" && typeof observation.value === "number"
      ? observation.value : undefined;
  });
  const itemSpecInfo = itemSpec?.api === "C_Item.GetItemSpecInfo" && itemSpecInput?.itemString === itemRef
    && itemSpec?.state === "OBSERVED_VALUE" && itemSpecTable?.state === "OBSERVED_TABLE" && itemSpecTable.complete === true
    && itemSpecIDs.length === itemSpecEntries.length && itemSpecIDs.every((id) => typeof id === "number")
    ? { state: "OBSERVED_TABLE" as const, api: itemSpec.api, itemString: itemRef, specializationIDs: itemSpecIDs as number[], complete: true,
      ...(typeof itemSpec.observedAt === "number" ? { observedAt: itemSpec.observedAt, freshness: classifyFreshness(itemSpec.observedAt, now) } : {}),
      provenance: "OBSERVED_RAW_API_RESULT" as const }
    : { state: "UNKNOWN" as const, api: itemSpec?.api ?? "UNKNOWN", itemString: itemSpecInput?.itemString ?? "UNKNOWN",
      reason: "No complete exact-item C_Item.GetItemSpecInfo result is available." };
  const bindingEvidence = object(fact.bindingEvidence);
  const deltaSection = object(statDeltaComparisons);
  const deltaRows = Array.isArray(deltaSection?.comparisons) ? deltaSection.comparisons : [];
  const deltaObservedAt = typeof deltaSection?.observedAt === "number" ? deltaSection.observedAt : undefined;
  const deltaPairEvidenceCurrent = deltaSection?.state === "OBSERVED_RAW_COMPARISONS"
    && deltaObservedAt !== undefined && classifyFreshness(deltaObservedAt, now) === "recent"
    && typeof itemFactsObservedAt === "number" && classifyFreshness(itemFactsObservedAt, now) === "recent"
    && statDeltaPairContextCurrent;
  const exactPairDeltas = deltaRows.flatMap((entry) => {
    const row = object(entry); const pair = object(row?.input); const table = object(row?.table);
    if (!deltaPairEvidenceCurrent || row?.api !== "C_Item.GetItemStatDelta" || row?.state !== "OBSERVED_VALUE"
      || pair?.candidateItemString !== itemRef || typeof pair.equippedItemString !== "string" || !equippedItemRefs.has(pair.equippedItemString)
      || table?.state !== "OBSERVED_TABLE" || table.complete !== true) return [];
    return [{ api: row?.api ?? "UNKNOWN", state: row?.state ?? "UNKNOWN", candidateItemString: pair.candidateItemString,
      equippedItemString: pair.equippedItemString, ...(typeof deltaSection?.observedAt === "number" ? { observedAt: deltaSection.observedAt, freshness: classifyFreshness(deltaSection.observedAt, now) } : {}),
      ...(typeof table?.complete === "boolean" ? { complete: table.complete } : {}), entries: Array.isArray(table?.entries) ? table.entries : [],
      interpretation: "RAW_ORDERED_PAIR_RESULT" as const }];
  });
  return {
    clientProfile: clientProfile ?? "UNKNOWN",
    itemInfo: { state: info?.state ?? "UNKNOWN", api: info?.api ?? "UNKNOWN", returnCount: info?.returnCount ?? null, ...(typeof info?.observedAt === "number" ? { observedAt: info.observedAt } : {}), returns: infoReturns },
    playerEquipability: { api: equippable?.api ?? "UNKNOWN", state: equippable?.state ?? "UNKNOWN", itemString: object(equippable?.input)?.itemString ?? "UNKNOWN", ...(equippableValue?.state === "OBSERVED" && equippableValue.type === "boolean" ? { value: equippableValue.value } : {}), ...(typeof equippable?.observedAt === "number" ? { observedAt: equippable.observedAt, freshness: classifyFreshness(equippable.observedAt, now) } : {}), reason: "C_Item.IsEquippableItem is a point-in-time check for the currently logged-in player; it cannot be reused as another character's check." },
    playerCanUseItem,
    itemSpecInfo,
    bindingEvidence: bindingEvidence ? { ...bindingEvidence, freshness: typeof bindingEvidence.observedAt === "number" ? classifyFreshness(bindingEvidence.observedAt, now) : "unknown" } : { state: "UNKNOWN", semanticInterpretation: "UNKNOWN_UNVALIDATED", reason: "No exact-item raw binding API calls are available." },
    itemStats: { state: statsTable?.state ?? stats?.state ?? "UNKNOWN", callState: stats?.state ?? "UNKNOWN", api: stats?.api ?? "UNKNOWN", entryCount: statsTable?.entryCount ?? null, complete: statsTable?.complete ?? false, ...((typeof stats?.observedAt === "number" ? stats.observedAt : itemFactsObservedAt) !== undefined ? { observedAt: typeof stats?.observedAt === "number" ? stats.observedAt : itemFactsObservedAt } : {}), entries: statEntries },
    statDeltaEvidence: { api: deltaSection?.state === "API_MISSING" ? "API_MISSING" : "C_Item.GetItemStatDelta", state: deltaSection?.state ?? "UNKNOWN", completeness: deltaSection?.completeness ?? "unknown", ...(typeof deltaSection?.observedAt === "number" ? { observedAt: deltaSection.observedAt, freshness: classifyFreshness(deltaSection.observedAt, now) } : {}), reason: statDeltaSourceCurrent ? "Complete, recent pair observations are filtered to the candidate and exact equipped variants present in this equipment snapshot." : deltaPairEvidenceCurrent ? "This section is partial, but complete raw results for exact current candidate/equipped variants are retained individually; pairs not attempted remain unknown." : "Pair results require recent item facts, a recent pair capture, and an exact currently observed candidate/equipped variant match." },
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
        ? "Tuple positions are screened only when the 18-return shape, exact item link, GetItemInfoInstant cross-checks, and observed name all agree. GetItemStats entries remain raw stat keys and values."
        : "No item metadata is interpreted unless the Forever gear-screen tuple shape and independent cross-checks pass.",
    },
    semanticInterpretation: tupleShapeObserved ? buildVerified ? "PARTIALLY_VALIDATED" as const : "SCREENED_UNVERIFIED_BUILD" as const : "UNKNOWN" as const,
    reason: tupleShapeObserved
      ? "Selected GetItemInfo fields pass the shape, exact-variant, and cross-API checks for this captured build. Unverified builds remain confidence-qualified. Raw GetItemStats keys are retained without translating them into weighted build conclusions."
      : "Forever GetItemInfo/GetItemStats results are retained as raw API evidence; semantics remain UNKNOWN when tuple or cross-check evidence is incomplete.",
    buildVerification: profile ? foreverBuildVerification(profile) : "UNVERIFIED_BUILD",
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
  for (const key of ["equipment", "bags", "bank", "quests", "talents", "reputation", "classSpellCatalog", "recipeCaptureAttempt"] as const) {
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
  const beforeRecipes = existing.professionRecipes; const nextRecipes = incoming.professionRecipes;
  if (nextRecipes) {
    if (!beforeRecipes || (nextRecipes.observedAt as number) > (beforeRecipes.observedAt as number)) { value.professionRecipes = nextRecipes; updated = true; }
    else if ((nextRecipes.observedAt as number) === (beforeRecipes.observedAt as number) && JSON.stringify(stable(beforeRecipes)) !== JSON.stringify(stable(nextRecipes))) conflict = true;
  }
  return { value, outcome: updated ? "updated" : conflict ? "conflict" : "already-recorded" };
}

export function buildForeverGearObservation(input: {
  identity: { version: VersionOrUnknown; identityKey: string; name: string; surname?: string; surnameSource?: string; realm: string };
  snapshotId: number;
  generatedAt?: number;
  importedAt: number;
  equipment: ForeverEquipmentLike;
  bags: ForeverInventoryLike;
  bank: ForeverInventoryLike;
  structured?: ForeverStructuredObservation;
  now: number;
}) {
  const { identity, equipment, bags, bank, structured } = input;
  const sectionTime = (kind: "equipment" | "bags" | "bank", fallback: number | undefined) => structured?.[kind]?.observedAt as number | undefined ?? fallback;
  const freshness = (at?: number) => at === undefined ? "unknown" : classifyFreshness(at, input.now);
  const equipmentAt = sectionTime("equipment", equipment.status.observedAt ?? input.generatedAt ?? input.importedAt);
  // Bag freshness belongs to the bag capture itself. A recent character export
  // cannot refresh an absent or failed bag section.
  const bagsAt = sectionTime("bags", bags.status.observedAt);
  const bankAt = sectionTime("bank", bank.status.observedAt);
  const useStructuredEquipment = usableRows(structured?.equipment, "slots");
  const useStructuredBags = usableRows(structured?.bags, "containers");
  const useStructuredBank = usableRows(structured?.bank, "containers");
  const equipmentSource = useStructuredEquipment ? "Forever WoWSyncDB sections.equipment" : "WOWSYNC v1 equipment";
  const bagsSource = useStructuredBags ? "Forever WoWSyncDB sections.bags" : "WOWSYNC v1 bags";
  const equipmentState = useStructuredEquipment ? structuredState(structured?.equipment) : equipment.status.state;
  const bagsState = useStructuredBags ? structuredState(structured?.bags) : bags.status.state;
  const equipmentItems = structuredEquipment(useStructuredEquipment ? structured?.equipment : undefined, equipment.slots, equipmentState);
  const carriedItems = bagsState === "UNKNOWN" && !useStructuredBags ? undefined : structuredBags(useStructuredBags ? structured?.bags : undefined, bags.items, bagsState);
  const bankItems = bank.status.state === "UNKNOWN" && !useStructuredBank ? undefined : structuredBags(useStructuredBank ? structured?.bank : undefined, bank.items, structuredState(structured?.bank));
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
  const statDeltaPairContextCurrent = evidenceBagObservedAt !== undefined && evidenceBagFreshness === "recent" && bagsState === "OBSERVED" && freshness(bagsAt) === "recent"
    && typeof evidenceEquipmentSource?.observedAt === "number" && freshness(evidenceEquipmentSource.observedAt) === "recent" && equipmentState === "OBSERVED" && freshness(equipmentAt) === "recent";
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
  const itemSemanticsValidated = supportsForeverGearEvaluation(structured?.clientProfile);
  const carriedCovered = observedCarried.filter((item) => item.itemRef && factsByRef.has(item.itemRef)).length;
  const itemFactCoverageComplete = itemSemanticsValidated && itemFactsAvailable && evidenceBagComplete && carriedItems !== undefined && carriedCovered === observedCarried.length
    && observedCarried.every((item) => {
      if (!item.itemRef || item.itemIdentity !== "OBSERVED") return false;
      const fact = factsByRef.get(item.itemRef);
      const instant = object(fact?.itemInfoInstant);
      const instantInput = object(instant?.input);
      const returns = instant && Array.isArray(instant.returns) ? instant.returns : [];
      const apiID = object(object(returns[0])?.observation);
      const itemType = object(object(returns[1])?.observation);
      const itemSubType = object(object(returns[2])?.observation);
      const equipLocation = object(object(returns[3])?.observation);
      const equippableCall = object(fact?.isEquippableItem);
      const equippableReturns = equippableCall && Array.isArray(equippableCall.returns) ? equippableCall.returns : [];
      const equippable = object(object(equippableReturns[0])?.observation);
      return instant?.api === "C_Item.GetItemInfoInstant" && instant.state === "OBSERVED_VALUE"
        && instantInput?.itemString === item.itemRef
        && apiID?.state === "OBSERVED" && apiID.type === "number" && apiID.value === (item.itemID ?? itemIdFromRef(item.itemRef))
        && itemType?.state === "OBSERVED" && itemType.type === "string"
        && itemSubType?.state === "OBSERVED" && itemSubType.type === "string"
        && equipLocation?.state === "OBSERVED" && equipLocation.type === "string"
        && equippableCall?.api === "C_Item.IsEquippableItem" && equippableCall.state === "OBSERVED_VALUE"
        && equippable?.state === "OBSERVED" && equippable.type === "boolean";
    });
  const evaluationItems = itemSemanticsValidated ? observedCarried.flatMap((item) => {
    if (!item.itemRef || item.itemIdentity !== "OBSERVED") return [];
    const fact = factsByRef.get(item.itemRef);
    if (!fact) return [];
    const instant = object(fact.itemInfoInstant);
    const instantInput = object(instant?.input);
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
      && instantInput?.itemString === item.itemRef
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
      itemApiEvidence: itemApiEvidence(fact, structured?.clientProfile, item.itemRef, item.name, typeof evidence?.observedAt === "number" ? evidence.observedAt : undefined, statDeltaComparisons, statDeltaSourceCurrent, statDeltaPairContextCurrent, equippedItemRefs, input.now),
      evidenceSource: evidence?.source ?? "Forever C_Item item facts",
      ...(typeof evidence?.observedAt === "number" ? { evidenceObservedAt: evidence.observedAt } : {}),
      provenance: itemFactsLastSeen ? "LAST_SEEN" as const : "DERIVED" as const,
      eligibility: "UNKNOWN" as const, suitability: "UNKNOWN" as const,
      upgradeStatus: "UNKNOWN" as const, transferability: "UNKNOWN" as const,
      reason: "The client marked this item type equippable; this does not establish character eligibility, proficiency, suitability, upgrade value, or transferability." }];
  }) : [];
  const candidateRefs = new Set(evaluationItems.flatMap((item) => item.itemRef ? [item.itemRef] : []));
  // Preserve rows that cannot be classified because exact-variant API
  // evidence is absent or malformed. Explicit non-equipment/projectile and
  // observed IsEquippableItem=false rows remain outside the gear plan.
  const unclassifiedItems = observedCarried.flatMap((item) => {
    if (!itemSemanticsValidated) return [{ ...item, reason: "The Forever client profile is below the supported gear-screen intake floor; raw item observations are retained without classification." }];
    if (item.itemRef && candidateRefs.has(item.itemRef)) return [];
    if (!item.itemRef || item.itemIdentity !== "OBSERVED") return [{ ...item, reason: "An exact item variant and matching exact-variant Forever item API result were not captured for this carried row; its item identity and equipment class are UNKNOWN." }];
    const fact = factsByRef.get(item.itemRef);
    if (!fact) return [{ ...item, reason: "No exact-variant Forever item API result was captured for this carried item; its equipment class and slot are UNKNOWN." }];
    const instant = object(fact.itemInfoInstant);
    const instantInput = object(instant?.input);
    const returns = instant && Array.isArray(instant.returns) ? instant.returns : [];
    const observedReturn = (index: number) => object(object(returns[index - 1])?.observation);
    const returnedID = observedReturn(1);
    const itemType = observedReturn(2);
    const equipLocation = observedReturn(4);
    const itemID = item.itemID ?? itemIdFromRef(item.itemRef);
    const apiItemType = instant?.api === "C_Item.GetItemInfoInstant" && instant.state === "OBSERVED_VALUE"
      && instantInput?.itemString === item.itemRef
      && returnedID?.state === "OBSERVED" && returnedID.type === "number" && returnedID.value === itemID;
    const nonEquipmentLocation = equipLocation?.state === "OBSERVED" && equipLocation.type === "string" && equipLocation.value === "INVTYPE_NON_EQUIP_IGNORE";
    const usableEquipLocation = equipLocation?.state === "OBSERVED" && equipLocation.type === "string"
      && typeof equipLocation.value === "string" && equipLocation.value.length > 0 && !nonEquipmentLocation;
    const isProjectile = itemType?.state === "OBSERVED" && itemType.type === "string" && itemType.value === "Projectile";
    if (apiItemType && (isProjectile || nonEquipmentLocation)) return [];
    const equippableCall = object(fact.isEquippableItem);
    const equippableRows = equippableCall && Array.isArray(equippableCall.returns) ? equippableCall.returns : [];
    const equippable = object(object(equippableRows[0])?.observation);
    const completeBoolean = equippableCall?.api === "C_Item.IsEquippableItem" && equippableCall.state === "OBSERVED_VALUE"
      && equippable?.state === "OBSERVED" && equippable.type === "boolean" && typeof equippable.value === "boolean";
    if (apiItemType && completeBoolean && equippable.value === false) return [];
    if (apiItemType && usableEquipLocation && completeBoolean && equippable.value === true) return [];
    return [{ ...item, reason: "Exact-variant item type, equip-location, or IsEquippableItem evidence is missing or inconsistent; equipment candidacy remains UNKNOWN." }];
  });
  // Inventory taxonomy is independent from the exact-variant gear evaluator.
  // Only API observations for this exact item string may classify a row.
  const carriedBuckets = { consumables: [] as Array<Record<string, unknown>>, materials: [] as Array<Record<string, unknown>>, questUtility: [] as Array<Record<string, unknown>>, unknown: [] as Array<Record<string, unknown>> };
  for (const item of observedCarried) {
    if (item.itemRef && candidateRefs.has(item.itemRef)) continue;
    const fact = item.itemRef ? factsByRef.get(item.itemRef) : undefined;
    const instant = object(fact?.itemInfoInstant);
    const instantInput = object(instant?.input);
    const returns = instant && Array.isArray(instant.returns) ? instant.returns : [];
    const val = (i: number) => object(object(returns[i - 1])?.observation);
    const exact = typeof item.itemRef === "string" && instant?.api === "C_Item.GetItemInfoInstant" && instant.state === "OBSERVED_VALUE" && instantInput?.itemString === item.itemRef && val(1)?.state === "OBSERVED" && val(1)?.value === (item.itemID ?? itemIdFromRef(item.itemRef));
    const cls = exact && val(2)?.state === "OBSERVED" && val(2)?.type === "string" ? val(2)?.value as string : undefined;
    const sub = exact && val(3)?.state === "OBSERVED" && val(3)?.type === "string" ? val(3)?.value as string : undefined;
    const loc = exact && val(4)?.state === "OBSERVED" && val(4)?.type === "string" ? val(4)?.value as string : undefined;
    const row = { ...item, classification: "UNKNOWN" as string, itemType: cls, itemSubType: sub, equipLocation: loc,
      reason: !item.itemRef || item.itemIdentity !== "OBSERVED" ? "Exact item identity is UNKNOWN for this carried slot." : "Exact item class, subclass, or equip location is UNKNOWN." };
    let bucket: keyof typeof carriedBuckets = "unknown";
    if (cls && sub && loc !== undefined) {
      const lower = `${cls} ${sub}`.toLowerCase();
      if (["consumable", "potion", "elixir", "food & drink"].some((x) => lower.includes(x))) bucket = "consumables";
      else if (["trade goods", "tradegoods", "reagent", "profession"].some((x) => lower.includes(x))) bucket = "materials";
      else if (["quest", "key", "miscellaneous"].some((x) => lower.includes(x)) || loc === "INVTYPE_NON_EQUIP_IGNORE") bucket = "questUtility";
      else if (fact && cls !== "Weapon" && cls !== "Armor" && loc === "") bucket = "questUtility";
      else bucket = "unknown";
      row.classification = bucket === "unknown" ? "UNKNOWN" : bucket === "questUtility" ? "QUEST_UTILITY" : bucket.toUpperCase();
      row.reason = bucket === "unknown" ? "Observed item class and location do not match a supported non-gear bucket." : "Confirmed non-gear from observed exact-item class, subclass, and equip location.";
    }
    carriedBuckets[bucket].push(row);
  }
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
    snapshot: { snapshotId: input.snapshotId, ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}), importedAt: input.importedAt, ...(structured?.clientProfile ? { clientProfile: structured.clientProfile } : {}), ...(parseForeverProfile(structured?.clientProfile) ? { clientBuild: Number(parseForeverProfile(structured?.clientProfile)!.clientBuild) } : {}), buildVerification: (() => { const parsed = parseForeverProfile(structured?.clientProfile); return parsed ? foreverBuildVerification(parsed) : "UNVERIFIED_BUILD"; })() },
    equipment: { state: equipmentState, source: equipmentSource, ...(equipmentAt !== undefined ? { observedAt: equipmentAt, freshness: freshness(equipmentAt) } : {}), items: equipmentItems.map((item) => {
      const fact = item.itemRef ? factsByRef.get(item.itemRef) : undefined;
      return fact && item.itemRef ? { ...item, itemApiEvidence: itemApiEvidence(fact, structured?.clientProfile, item.itemRef, item.name, typeof evidence?.observedAt === "number" ? evidence.observedAt : undefined, statDeltaComparisons, statDeltaSourceCurrent, statDeltaPairContextCurrent, equippedItemRefs, input.now) } : item;
    }) },
    carried: { state: bagsState, source: bagsSource, ...(bagsAt !== undefined ? { observedAt: bagsAt, freshness: freshness(bagsAt) } : {}), items: carriedItems?.map((item) => ({ ...item, locatedWith: { state: item.provenance, characterIdentityKey: identity.identityKey, locationScope: "CHARACTER_CARRIED_INVENTORY" as const, source: bagsSource, ...(bagsAt !== undefined ? { observedAt: bagsAt, freshness: freshness(bagsAt) } : {}) }, ownership: { state: "UNKNOWN" as const, reason: "Carried inventory location does not independently establish ownership." }, binding: typeof item.bound === "boolean" ? { state: item.provenance, value: item.bound, observedAt: bagsAt, provenance: item.provenance } : { state: "UNKNOWN" as const, reason: "The carried item binding facet was not observed." }, transferability: { state: "UNKNOWN" as const, reason: "A binding facet alone does not prove whether this item can be transferred to the requested character." } })) },
    evaluationCandidates: { state: evaluationState, source: evidence?.source ?? "UNKNOWN", ...(typeof evidence?.observedAt === "number" ? { observedAt: evidence.observedAt, freshness: freshness(evidence.observedAt) } : {}), items: evaluationItems, unclassifiedItems, carriedBuckets, reason: evaluationReason, unknowns: { eligibility: "UNKNOWN", suitability: "UNKNOWN", upgradeStatus: "UNKNOWN", transferability: "UNKNOWN" } },
    unknowns: { eligibility: "UNKNOWN", suitability: "UNKNOWN", upgradeStatus: "UNKNOWN", transferability: "UNKNOWN" },
    bank: { state: useStructuredBank ? structuredState(structured?.bank) : bank.status.state, ...(bankAt !== undefined ? { observedAt: bankAt, freshness: freshness(bankAt) } : {}), source: useStructuredBank ? "Forever WoWSyncDB character bank tabs" : "WOWSYNC v1 character bank", items: bankItems, reason: bank.status.state === "UNKNOWN" && !useStructuredBank ? "Bank contents were not observed; unavailable is not empty." : undefined },
    quests: buildForeverQuestObservation({ section: structured?.quests, profile: structured?.clientProfile ?? "UNKNOWN", identity: { identityKey: identity.identityKey, name: identity.name, realm: identity.realm }, now: input.now }),
    trainerEvidence: evidenceData?.trainerEvidence ?? { state: "UNKNOWN", reason: "The Forever trainer window has not been observed with raw service data." },
    metadataSource: structured?.itemMetadata ? "Forever WoWSyncDB itemMetadata" : "UNKNOWN",
  };
}

function itemIdFromRef(itemRef: string): number | undefined {
  const id = /^item:(\d+)/.exec(itemRef)?.[1];
  const parsed = id === undefined ? undefined : Number(id);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
