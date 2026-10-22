/** Read-only crafted-equipment assessment for Forever 1.60.1 snapshots. */

import { classifyFreshness } from "./freshness.ts";
import { compareForeverStatTables, evaluateForeverSlotCompatibility, foreverSlotsForEquipLocation, type ForeverStatTable } from "./foreverGearEvaluation.ts";
import type { RecipeEvidenceResolution } from "./recipeEvidence.ts";
import { foreverBuildVerification, foreverCompatibility, type ForeverBuildVerification } from "./foreverProfile.ts";
import type { ParsedSnapshot, SectionState } from "./types.ts";

type Row = Record<string, unknown>;
type EvidenceValue = { state?: unknown; value?: unknown; type?: unknown };
type ReferenceLead = { build: string; relationToSnapshot: "BUILD_MATCHED_REFERENCE" | "OLDER_BUILD_REFERENCE_ONLY" | "NEWER_BUILD_REFERENCE_ONLY" | "BUILD_UNVERIFIED"; source?: string; observedAt?: number; fields: Record<string, unknown> };

export interface ForeverCraftedUpgradeAssessment {
  version: "forever";
  identity: { identityKey: string; name: string; surname?: string; realm: string };
  snapshot: { snapshotId: number; generatedAt?: number; importedAt: number; clientProfile: string; buildVerification: ForeverBuildVerification; compatibility: ReturnType<typeof foreverCompatibility>; freshness: "recent" | "stale" | "unknown" };
  recipeEvidence: { state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; sourceSnapshotId?: number; observedAt?: number; freshness: "recent" | "stale" | "unknown"; excludedScopes: RecipeEvidenceResolution["excludedScopes"]; reason: string };
  recipeCoverage: { state: string; candidateCompleteness: string; returnedRecipeCount?: number; learnedTrueCount?: number; knownNonEquipmentLearnedRecipeCount: number; equipmentCandidatesReturned: number; reason: string };
  candidates: ForeverCraftedUpgradeCandidate[];
  bank: { state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; observedAt?: number; reason?: string };
  provenance: { state: "DERIVED"; source: "Forever versioned snapshot and structured sidecars"; snapshotId: number; sourceCharacterGuid?: string; gearGuidHistoryGuard: "NOT_APPLIED_TO_THIS_SNAPSHOT_SCOPED_ASSESSMENT" };
}

export interface ForeverCraftedUpgradeCandidate {
  recipe: { recipeID: number; name?: string; state: "OBSERVED_TRUE"; evidence: "OBSERVED" | "LAST_SEEN"; sourceSnapshotId?: number; profession?: string; observedAt?: number; freshness: "recent" | "stale" | "unknown" };
  output: { state: "OBSERVED" | "UNKNOWN" | "CONFLICT"; itemID?: number; quantity?: number; itemType?: string; itemSubType?: string; equipLocation?: string; possibleSlots: number[]; provenance: "OBSERVED" | "UNKNOWN"; itemAPIEquippable: "OBSERVED_TRUE" | "OBSERVED_FALSE" | "UNKNOWN"; reason?: string };
  reagents: Array<{ itemID?: number; quantity?: number; identityState: "OBSERVED" | "UNKNOWN"; availability: "OBSERVED_AVAILABLE" | "OBSERVED_INSUFFICIENT" | "LAST_SEEN" | "UNKNOWN"; observedQuantity?: number; observedAt?: number; reason: string }>;
  slot: { state: "MAPPED" | "UNKNOWN" | "NOT_EQUIPMENT"; possibleSlots: number[]; equippedItem?: { itemID?: number; itemRef?: string; name?: string; slot: number; state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN" }; reason: string };
  eligibility: { state: "INELIGIBLE_REQUIRED_LEVEL" | "UNKNOWN"; requiredLevel: { state: "MET" | "NOT_MET" | "UNKNOWN"; itemLevel?: number; characterLevel?: number }; playerSpecificCheck: "TRUE" | "FALSE" | "UNKNOWN"; explicitClassRestriction: "OBSERVED_NONE" | "OBSERVED_RESTRICTION" | "UNKNOWN"; professionSkill: { name: string; state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; skill?: number; requiredSkill: "UNKNOWN" }; reason: string };
  statComparison: { state: "COMPARED" | "UNKNOWN"; provenance: "DERIVED" | "UNKNOWN"; status: "POSSIBLE_RECORDED_STAT_UPGRADE" | "RECORDED_STAT_TRADEOFF" | "RECORDED_STAT_SIDEGRADE" | "NO_RECORDED_STAT_GAIN" | "UNKNOWN"; values: Array<{ key: string; label: string; labelState: "KNOWN" | "UNKNOWN"; labelProvenance: string; candidate: number; equipped: number; delta: number }>; referenceLeads: ReferenceLead[]; reason: string };
  upgradeConclusion: { state: "POSSIBLE_RECORDED_STAT_UPGRADE" | "NOT_A_RECORDED_STAT_UPGRADE" | "UNKNOWN"; provenUpgrade: false; reason: string };
  crafting: { state: "NOT_ESTABLISHED" | "BLOCKED_BY_OBSERVED_REAGENTS" | "UNKNOWN"; professionSkill: string; requiredSkill: "UNKNOWN"; facilities: "UNKNOWN"; learnedRecipeDoesNotProveCraftability: true; reasons: string[] };
}
type ReagentAssessment = ForeverCraftedUpgradeCandidate["reagents"][number];

function record(value: unknown): Row | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function str(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function observedValue(value: unknown): unknown {
  const row = record(value) as EvidenceValue | undefined;
  return row?.state === "OBSERVED" ? row.value : undefined;
}
function rawCallFirst(call: unknown, expectedApi?: string): unknown {
  const row = record(call);
  if (!row || row.state !== "OBSERVED_VALUE" || (expectedApi && row.api !== expectedApi)) return undefined;
  const returns = array(row.returns);
  return observedValue(record(returns[0])?.observation);
}
function itemRecords(sidecar: Row): Row[] {
  const evidence = record(sidecar.itemEvidence);
  const data = record(evidence?.data);
  return array(data?.items).map(record).filter((row): row is Row => !!row);
}
function itemIDFromRef(value: unknown): number | undefined {
  const ref = str(value);
  if (!ref) return undefined;
  const match = /^(?:item:)?(\d+)/.exec(ref);
  return match ? Number(match[1]) : undefined;
}
function readStats(item: Row | undefined, now: number, expectedProfile: string): ForeverStatTable | undefined {
  if (!item || item.itemID === undefined) return undefined;
  const call = record(item.itemStats);
  const table = record(call?.table);
  const observedAt = number(call?.observedAt);
  const input = record(call?.input);
  const itemString = str(item.itemString);
  if (call?.api !== "C_Item.GetItemStats" || call.state !== "OBSERVED_VALUE" || table?.state !== "OBSERVED_TABLE" || table.complete !== true
      || !observedAt || classifyFreshness(observedAt, now) !== "recent"
      || itemString && str(input?.itemString) !== itemString
      || str(item.clientProfile) && item.clientProfile !== expectedProfile) return undefined;
  const entries = array(table.entries).map((value) => record(value)).filter((row): row is Row => !!row).map((row) => {
    const observation = record(row.observation);
    return { key: str(row.key), state: str(observation?.state), value: observation?.value };
  }).filter((entry): entry is { key: string; state: string; value: unknown } => !!entry.key);
  if (entries.some((entry) => entry.state !== "OBSERVED" || typeof entry.value !== "number" || !Number.isFinite(entry.value))) return undefined;
  return { state: "OBSERVED_TABLE", complete: true, entries };
}
function getRequiredLevel(item: Row | undefined): number | undefined {
  if (!item) return undefined;
  const call = record(item.itemInfo);
  if (call?.api !== "C_Item.GetItemInfo" || call.state !== "OBSERVED_VALUE") return undefined;
  const returns = array(call.returns).map((entry) => observedValue(record(entry)?.observation));
  return number(returns[4]);
}
function getEquippable(item: Row | undefined): boolean | undefined {
  return item ? rawCallFirst(item.isEquippableItem, "C_Item.IsEquippableItem") as boolean | undefined : undefined;
}
function apiObservedAt(item: Row | undefined, key: string): number | undefined { return number(record(item?.[key])?.observedAt); }
function getPlayerCanUse(item: Row | undefined): boolean | undefined {
  return item ? rawCallFirst(item.playerCanUseItem, "C_PlayerInfo.CanUseItem") as boolean | undefined : undefined;
}
function professionSkill(snapshot: ParsedSnapshot, name: string): ForeverCraftedUpgradeCandidate["eligibility"]["professionSkill"] & { maxSkill?: number } {
  const state = snapshot.professions.status.state;
  const entry = snapshot.professions.entries.find((row) => row.name.toLowerCase() === name.toLowerCase());
  return { name, state: !entry ? "UNKNOWN" : state === "OBSERVED" ? "OBSERVED" : state === "LAST_SEEN" ? "LAST_SEEN" : "UNKNOWN", ...(entry ? { skill: entry.skill, maxSkill: entry.maxSkill } : {}), requiredSkill: "UNKNOWN" };
}
function freshness(at: number | undefined, now: number): "recent" | "stale" | "unknown" { return at === undefined ? "unknown" : classifyFreshness(at, now); }
function sectionState(value: SectionState): "OBSERVED" | "LAST_SEEN" | "UNKNOWN" { return value === "OBSERVED" || value === "LAST_SEEN" ? value : "UNKNOWN"; }
function referenceLeads(item: Row | undefined, currentBuild?: string): ReferenceLead[] {
  const refs = array(record(item?.referenceFacts)?.leads);
  return refs.map(record).filter((row): row is Row => !!row && typeof row.build === "string" && !!record(row.fields)).map((row) => ({ build: row.build as string, relationToSnapshot: !currentBuild ? "BUILD_UNVERIFIED" as const : row.build === currentBuild ? "BUILD_MATCHED_REFERENCE" as const : Number(row.build) < Number(currentBuild) ? "OLDER_BUILD_REFERENCE_ONLY" as const : "NEWER_BUILD_REFERENCE_ONLY" as const, ...(str(row.source) ? { source: str(row.source) } : {}), ...(number(row.observedAt) !== undefined ? { observedAt: number(row.observedAt) } : {}), fields: record(row.fields)! }));
}

/** Build an evidence-only assessment from one canonical, already version-scoped Forever snapshot. */
export function buildForeverCraftedUpgradeAssessment(input: { identity: ForeverCraftedUpgradeAssessment["identity"]; snapshot: { id: number; generatedAt?: number; importedAt: number; parsed: ParsedSnapshot }; now: number; recipeEvidence?: RecipeEvidenceResolution }): ForeverCraftedUpgradeAssessment {
  const { identity, snapshot, now, recipeEvidence } = input;
  const parsed = snapshot.parsed;
  const structured = record(parsed.foreverGearObservation) ?? {};
  const recipeSection = recipeEvidence ? record(recipeEvidence.section) : record(structured.professionRecipes);
  const recipeState = recipeEvidence?.state ?? (recipeSection ? "OBSERVED" : "UNKNOWN");
  const recipeData = record(recipeSection?.data);
  const professionScopes = array(recipeData?.professions).map(record).filter((row): row is Row => !!row);
  const recipeProfession = new Map<Row, string>();
  const recipeRows = professionScopes.flatMap((scope) => array(scope.recipes).map(record).filter((row): row is Row => !!row).map((row) => {
    const name = str(scope.professionName) ?? str(scope.name);
    if (name) recipeProfession.set(row, name);
    return row;
  }));
  const coverageRows = professionScopes.map((scope) => record(scope.coverage) ?? record(recipeData?.coverage) ?? {});
  const learnedRows = recipeRows.filter((recipe) => recipe.learned === true && recipe.learnedState === "OBSERVED_TRUE" && (recipe.evidence === "OBSERVED" || recipe.evidence === "LAST_SEEN") && typeof recipe.recipeID === "number");
  const learnedNonEquipment = learnedRows.filter((recipe) => {
    const info = record(recipe.outputItemInfo);
    return info?.state === "OBSERVED" && (info.itemType !== "Armor" && info.itemType !== "Weapon" || info.equipLocation === "INVTYPE_NON_EQUIP_IGNORE");
  });
  const equipmentLearned = learnedRows.filter((recipe) => {
    const info = record(recipe.outputItemInfo);
    return info?.state === "OBSERVED" && (info.itemType === "Armor" || info.itemType === "Weapon") && typeof info.equipLocation === "string" && info.equipLocation !== "INVTYPE_NON_EQUIP_IGNORE";
  });
  const itemEvidence = itemRecords(structured);
  const equippedRows = parsed.equipment.slots.map((row) => ({ slot: row.slot, itemRef: row.itemRef, itemID: itemIDFromRef(row.itemRef), name: row.name, equipLocation: itemEvidence.find((e) => e.itemID === itemIDFromRef(row.itemRef)) ? str(observedValue(record(array(record(itemEvidence.find((e) => e.itemID === itemIDFromRef(row.itemRef))!.itemInfoInstant)?.returns)[3])?.observation)) : undefined }));
  const capturedEquipment = record(structured.equipment);
  const equipmentComplete = capturedEquipment
    ? capturedEquipment.completeness === "complete" && capturedEquipment.observedAt !== undefined
    : parsed.equipment.status.state === "OBSERVED" && parsed.equipment.status.completeness === "complete";
  const capturedBagSection = record(structured.bags);
  const bagState = capturedBagSection?.lastAttemptStale === true ? "LAST_SEEN" : sectionState(parsed.bags.status.state);
  const bagAt = parsed.bags.status.observedAt;
  const bagFreshness = freshness(bagAt, now);
  const bagComplete = (capturedBagSection?.completeness === "complete" || parsed.bags.status.completeness === "complete") && bagState === "OBSERVED";
  const equipmentAt = number(capturedEquipment?.observedAt) ?? parsed.equipment.status.observedAt;
  const equipmentCurrent = parsed.equipment.status.state === "OBSERVED" && capturedEquipment?.lastAttemptStale !== true && freshness(equipmentAt, now) === "recent";
  const candidateBuilds: ForeverCraftedUpgradeCandidate[] = equipmentLearned.map((recipe) => {
    const info = record(recipe.outputItemInfo);
    const professionName = recipeProfession.get(recipe);
    const skill = professionSkill(parsed, professionName ?? "Unidentified profession");
    const itemID = number(recipe.outputItemID);
    const metadataID = number(info?.itemID);
    const identityConflict = itemID !== undefined && metadataID !== undefined && itemID !== metadataID;
    const outputState = identityConflict ? "CONFLICT" as const : itemID !== undefined && metadataID === itemID && info?.state === "OBSERVED" ? "OBSERVED" as const : "UNKNOWN" as const;
    const equipLocation = str(info?.equipLocation);
    const possibleSlots = foreverSlotsForEquipLocation(equipLocation) ?? [];
    const matchingEquipped = possibleSlots.map((slot) => equippedRows.find((item) => item.slot === slot)).find((item) => item?.itemRef);
    const slotEval = evaluateForeverSlotCompatibility({ equipLocation, equipment: equippedRows.map((item) => ({ slot: item.slot, itemRef: item.itemRef, equipLocation: item.equipLocation, provenance: "OBSERVED_SNAPSHOT" })), equipmentComplete });
    const outputEvidence = itemEvidence.find((item) => item.itemID === itemID);
    const equipItemEvidence = matchingEquipped ? itemEvidence.find((item) => item.itemID === matchingEquipped.itemID) : undefined;
    const candidateStats = readStats(outputEvidence, now, str(structured.clientProfile) ?? "");
    const equippedStats = equipmentCurrent ? readStats(equipItemEvidence, now, str(structured.clientProfile) ?? "") : undefined;
    const rawComparison = matchingEquipped?.itemRef && candidateStats && equippedStats
      ? compareForeverStatTables(candidateStats, equippedStats, matchingEquipped.slot, matchingEquipped.itemRef, str(info?.itemType))
      : undefined;
    const playerCanUse = getPlayerCanUse(outputEvidence);
    const equippableObservedAt = apiObservedAt(outputEvidence, "isEquippableItem");
    const candidateEquippable = equippableObservedAt !== undefined && freshness(equippableObservedAt, now) === "recent" ? getEquippable(outputEvidence) : undefined;
    const apiAt = number(record(outputEvidence?.playerCanUseItem)?.observedAt);
    const candidateLevel = getRequiredLevel(outputEvidence);
    const characterLevel = parsed.character.level;
    const levelState = candidateLevel !== undefined && characterLevel !== undefined ? candidateLevel <= characterLevel ? "MET" as const : "NOT_MET" as const : "UNKNOWN" as const;
    const eligibilityState = levelState === "NOT_MET" ? "INELIGIBLE_REQUIRED_LEVEL" as const : "UNKNOWN" as const;
    const reagentSlots = array(recipe.reagentSlots).map(record).filter((row): row is Row => !!row);
    const reagents: ReagentAssessment[] = reagentSlots.flatMap((slot): ReagentAssessment[] => {
      const quantity = number(slot.quantityRequired);
      const choices = array(slot.reagents).map(record).filter((row): row is Row => !!row);
      if (choices.length !== 1 || typeof choices[0]?.itemID !== "number" || quantity === undefined) return [{ identityState: "UNKNOWN" as const, availability: "UNKNOWN" as const, reason: "The captured recipe does not identify one exact reagent item and quantity." }];
      const reagentItemID = choices[0]!.itemID as number;
      const matchingBagRows = parsed.bags.items.filter((item) => itemIDFromRef(item.itemRef) === reagentItemID);
      const observedQuantity = matchingBagRows.reduce((sum, item) => sum + (item.qty ?? 0), 0);
      const availability = bagState === "OBSERVED" && bagFreshness === "recent"
        ? observedQuantity >= quantity ? "OBSERVED_AVAILABLE" as const : bagComplete ? "OBSERVED_INSUFFICIENT" as const : "UNKNOWN" as const
        : bagState === "LAST_SEEN" || bagFreshness === "stale" ? "LAST_SEEN" as const : "UNKNOWN" as const;
      return [{ itemID: reagentItemID, quantity, identityState: "OBSERVED" as const, availability, ...((availability === "OBSERVED_AVAILABLE" || availability === "OBSERVED_INSUFFICIENT" || (availability === "LAST_SEEN" && matchingBagRows.length > 0)) ? { observedQuantity } : {}), ...(bagAt !== undefined ? { observedAt: bagAt } : {}), reason: availability === "OBSERVED_AVAILABLE" ? "Exact item identity and sufficient quantity are present in the current observed carried bags." : availability === "OBSERVED_INSUFFICIENT" ? "A complete current carried-bag observation shows fewer exact reagent items than required." : availability === "LAST_SEEN" ? matchingBagRows.length ? "This exact quantity was seen historically; it is not current availability." : "The historical bag capture did not include this exact reagent; absence is not current availability evidence." : "Current carried-bag availability is UNKNOWN; a partial scan cannot establish a shortage." }];
    });
    const currentBuild = str(structured.clientProfile)?.split(":").at(-2);
    const statValues = rawComparison?.values.map((value) => currentBuild === "70291" ? value : { ...value, label: "Unknown stat", labelState: "UNKNOWN" as const, labelProvenance: "UNKNOWN" }) ?? [];
    // Keep the narrative aligned with the build-qualified labels above. The raw comparison helper has a
    // versioned label table, but this assessment deliberately withholds those labels outside the live-validated
    // build. Reusing its reason verbatim would leak those withheld labels (for example, saying "Armor" while the
    // corresponding value is explicitly labelled "Unknown stat").
    const statComparisonReason = rawComparison
      ? `Derived from complete numeric GetItemStats tables for exact item variants. ${statValues.map((value) => `${value.labelState === "KNOWN" ? value.label : `Unknown stat (${value.key})`}: candidate ${value.candidate} vs equipped ${value.equipped} (${value.delta >= 0 ? "+" : ""}${value.delta}${value.labelState === "KNOWN" ? ` ${value.label}` : ""})`).join("; ")}. Raw API keys are preserved in each value. Missing keys are zero only within two complete tables. This compares the recorded stat vector; it does not weight stats for a build or include unreported effects.`
      : "A same-snapshot comparison requires fresh complete candidate and equipped item stat tables.";
    const statStatus = !rawComparison ? "UNKNOWN" as const : rawComparison.classification === "CANDIDATE_DOMINATES_RECORDED_STATS" ? "POSSIBLE_RECORDED_STAT_UPGRADE" as const : rawComparison.classification === "STAT_TRADEOFF" ? "RECORDED_STAT_TRADEOFF" as const : rawComparison.classification === "RECORDED_STAT_TIE" ? "RECORDED_STAT_SIDEGRADE" as const : "NO_RECORDED_STAT_GAIN" as const;
    const leads = referenceLeads(outputEvidence, currentBuild);
    const mismatchLeads = leads.filter((lead) => lead.build !== currentBuild);
    const upgradeState = statStatus === "POSSIBLE_RECORDED_STAT_UPGRADE" ? "POSSIBLE_RECORDED_STAT_UPGRADE" as const : statStatus === "UNKNOWN" ? "UNKNOWN" as const : "NOT_A_RECORDED_STAT_UPGRADE" as const;
    const reasons = [
      ...(outputState !== "OBSERVED" ? [identityConflict ? "Recipe output ID conflicts with the captured item metadata ID." : "Exact output item identity is incomplete." ] : []),
      ...(candidateEquippable === undefined ? ["Candidate-specific C_Item.IsEquippableItem evidence is unavailable."] : candidateEquippable ? [] : ["Candidate item API reports this output is not equippable."]),
      ...(playerCanUse === undefined || apiAt === undefined || classifyFreshness(apiAt, now) !== "recent" ? ["Candidate-specific current-player eligibility check is UNKNOWN."] : []),
      ...(levelState === "UNKNOWN" ? ["Candidate required level or current character level is unavailable."] : []),
      ...(!candidateStats ? ["Fresh complete candidate C_Item.GetItemStats evidence for this exact output is unavailable."] : []),
      ...(!equippedStats ? ["Fresh complete equipped-item C_Item.GetItemStats evidence is unavailable."] : []),
      ...(mismatchLeads.length ? [`Reference facts from build ${mismatchLeads.map((lead) => lead.build).join(", ")} are older than snapshot build ${currentBuild ?? "unknown"} and are not used as observed candidate stats.`] : []),
    ];
    return {
      recipe: { recipeID: recipe.recipeID as number, ...(str(recipe.name) ? { name: str(recipe.name) } : {}), state: "OBSERVED_TRUE", evidence: recipe.evidence === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED", ...(recipeEvidence?.sourceSnapshotId !== undefined ? { sourceSnapshotId: recipeEvidence.sourceSnapshotId } : {}), ...(professionName ? { profession: professionName } : {}), ...(number(recipe.observedAt) !== undefined ? { observedAt: number(recipe.observedAt) } : {}), freshness: freshness(number(recipe.observedAt) ?? number(recipeSection?.observedAt), now) },
      output: { state: outputState, ...(itemID !== undefined ? { itemID } : {}), ...(number(recipe.outputQuantityMin) === number(recipe.outputQuantityMax) && number(recipe.outputQuantityMin) !== undefined ? { quantity: number(recipe.outputQuantityMin) } : {}), ...(str(info?.itemType) ? { itemType: str(info?.itemType) } : {}), ...(str(info?.itemSubType) ? { itemSubType: str(info?.itemSubType) } : {}), ...(equipLocation ? { equipLocation } : {}), possibleSlots, provenance: outputState === "OBSERVED" ? "OBSERVED" : "UNKNOWN", itemAPIEquippable: candidateEquippable === undefined ? "UNKNOWN" : candidateEquippable ? "OBSERVED_TRUE" : "OBSERVED_FALSE", ...(outputState !== "OBSERVED" ? { reason: identityConflict ? "Output IDs disagree." : "Captured recipe output metadata is incomplete." } : {}) },
      reagents,
      slot: { state: possibleSlots.length ? slotEval.state : "UNKNOWN", possibleSlots, ...(matchingEquipped ? { equippedItem: { ...(matchingEquipped.itemID !== undefined ? { itemID: matchingEquipped.itemID } : {}), ...(matchingEquipped.itemRef ? { itemRef: matchingEquipped.itemRef } : {}), ...(matchingEquipped.name ? { name: matchingEquipped.name } : {}), slot: matchingEquipped.slot, state: equipmentCurrent ? "OBSERVED" as const : parsed.equipment.status.state === "LAST_SEEN" || capturedEquipment?.lastAttemptStale === true ? "LAST_SEEN" as const : "UNKNOWN" as const } } : {}), reason: possibleSlots.length ? slotEval.reason : "Captured equip-location does not map to a known equipment slot." },
      eligibility: { state: eligibilityState, requiredLevel: { state: levelState, ...(candidateLevel !== undefined ? { itemLevel: candidateLevel } : {}), ...(characterLevel !== undefined ? { characterLevel } : {}) }, playerSpecificCheck: playerCanUse !== undefined && apiAt !== undefined && classifyFreshness(apiAt, now) === "recent" ? playerCanUse ? "TRUE" : "FALSE" : "UNKNOWN", explicitClassRestriction: "UNKNOWN", professionSkill: { name: skill.name, state: skill.state, ...(skill.skill !== undefined ? { skill: skill.skill } : {}), requiredSkill: "UNKNOWN" }, reason: eligibilityState === "INELIGIBLE_REQUIRED_LEVEL" ? "Fresh observed character level is below the captured item required level." : "Overall eligibility remains UNKNOWN because current-player CanUseItem evidence alone does not establish explicit class restrictions or all exact-item eligibility rules." },
      statComparison: { state: rawComparison ? "COMPARED" : "UNKNOWN", provenance: rawComparison ? "DERIVED" : "UNKNOWN", status: statStatus, values: statValues, referenceLeads: leads, reason: rawComparison ? statComparisonReason : reasons.join(" ") || statComparisonReason },
      upgradeConclusion: { state: upgradeState, provenUpgrade: false, reason: upgradeState === "POSSIBLE_RECORDED_STAT_UPGRADE" ? "The candidate dominates the complete same-snapshot recorded stat vector. This is a possible recorded-stat upgrade, not a proven overall gameplay upgrade." : upgradeState === "UNKNOWN" ? reasons.join(" ") || "Required same-snapshot comparison evidence is unavailable." : "Observed recorded stats do not establish an upgrade; no build weights or unobserved effects are inferred." },
      crafting: { state: reagents.some((reagent) => reagent.availability === "OBSERVED_INSUFFICIENT") ? "BLOCKED_BY_OBSERVED_REAGENTS" : reagents.every((reagent) => reagent.availability === "OBSERVED_AVAILABLE") && reagents.length > 0 ? "NOT_ESTABLISHED" : "UNKNOWN", professionSkill: skill.state === "OBSERVED" ? `${skill.name} ${skill.skill ?? "?"}/${skill.maxSkill ?? "?"}` : `${skill.name} ${skill.state}`, requiredSkill: "UNKNOWN", facilities: "UNKNOWN", learnedRecipeDoesNotProveCraftability: true, reasons: [...(skill.state === "OBSERVED" ? [] : [`Current ${skill.name} skill is not freshly observed.`]), ...(recipe.evidence === "LAST_SEEN" ? [`Learned state is LAST_SEEN from snapshot ${recipeEvidence?.sourceSnapshotId ?? "unknown"}, not re-observed in this snapshot.`] : []), "The captured recipe does not provide a verified required crafting skill or facility/tool check.", ...reagents.map((reagent) => reagent.reason)] },
    };
  });
  const coverage = coverageRows[0] ?? record(recipeData?.coverage) ?? {};
  const bankState = sectionState(parsed.bank.status.state);
  const guid = str(structured.sourceCharacterGuid);
  return {
    version: "forever", identity,
    snapshot: { snapshotId: snapshot.id, ...(snapshot.generatedAt !== undefined ? { generatedAt: snapshot.generatedAt } : {}), importedAt: snapshot.importedAt, clientProfile: str(structured.clientProfile) ?? `Forever:${parsed.character.clientVersion ?? "unknown"}:${parsed.character.clientBuild ?? "unknown"}:${parsed.character.interface ?? "unknown"}`, buildVerification: foreverBuildVerification(parsed.character), compatibility: foreverCompatibility(parsed.character), freshness: freshness(snapshot.generatedAt ?? snapshot.importedAt, now) },
    recipeCoverage: { state: str(coverage.state) ?? str(recipeSection?.status) ?? "UNKNOWN", candidateCompleteness: str(coverage.candidateCompleteness) ?? "UNKNOWN", ...(number(coverage.returnedRecipeCount) !== undefined ? { returnedRecipeCount: number(coverage.returnedRecipeCount) } : {}), ...(number(coverage.learnedTrueCount) !== undefined ? { learnedTrueCount: number(coverage.learnedTrueCount) } : {}), knownNonEquipmentLearnedRecipeCount: learnedNonEquipment.length, equipmentCandidatesReturned: candidateBuilds.length, reason: "Only positively OBSERVED_TRUE learned recipes are assessed. Partial catalogue coverage means unreturned recipes remain unknown, not unlearned." },
    recipeEvidence: { state: recipeState, ...(recipeEvidence?.sourceSnapshotId !== undefined ? { sourceSnapshotId: recipeEvidence.sourceSnapshotId } : recipeSection ? { sourceSnapshotId: snapshot.id } : {}), ...(number(recipeSection?.observedAt) !== undefined ? { observedAt: number(recipeSection?.observedAt) } : {}), freshness: freshness(number(recipeSection?.observedAt), now), excludedScopes: recipeEvidence?.excludedScopes ?? [], reason: recipeEvidence?.reason ?? (recipeSection ? "Recipe rows were observed in this snapshot." : "This snapshot contains no structured recipe section; recipe knowledge is UNKNOWN, not empty.") },
    candidates: candidateBuilds,
    bank: { state: bankState, ...(parsed.bank.status.observedAt !== undefined ? { observedAt: parsed.bank.status.observedAt } : {}), ...(parsed.bank.status.reason ? { reason: parsed.bank.status.reason } : {}) },
    provenance: { state: "DERIVED", source: "Forever versioned snapshot and structured sidecars", snapshotId: snapshot.id, ...(guid ? { sourceCharacterGuid: guid } : {}), gearGuidHistoryGuard: "NOT_APPLIED_TO_THIS_SNAPSHOT_SCOPED_ASSESSMENT" },
  };
}
