/**
 * Version-scoped, read-only recipe intelligence over captured recipe rows:
 * which characters know a recipe, and where its reagents are observed.
 *
 * Everything here is derived from observations already resolved by
 * recipeEvidence.ts. Absent rows are UNKNOWN (candidate coverage is partial),
 * other characters' holdings are separate owners, and nothing implies a
 * transfer, a craft, or that a known recipe is craftable.
 */

import { classifyFreshness, type Freshness } from "./freshness.ts";
import { resolveRecipeEvidence, type RecipeEvidenceResolution } from "./recipeEvidence.ts";
import { resolveSnapshotView } from "./snapshotEvidence.ts";
import type { StoredCharacterSummary, StoredSnapshot } from "./store.ts";
import type { InventorySection, VersionOrUnknown } from "./types.ts";

type Row = Record<string, unknown>;

export interface CharacterHistory { character: StoredCharacterSummary; snapshots: StoredSnapshot[] }

export interface RecipeFilter { recipeID?: number; recipeKey?: string; outputItemID?: number; enchantID?: number; nameContains?: string }

export interface ReagentChoice { itemID?: number; currencyID?: number; quantity?: number }
export interface ReagentSlotView {
  slotIndex?: number;
  required?: boolean;
  quantityRequired?: number;
  alternatives: ReagentChoice[];
  identityState: "OBSERVED" | "UNKNOWN";
  name?: string;
  /** Classic: the client's own carried count for this reagent at observation time (bags only). Historical, not current. */
  clientReportedCarried?: { quantity: number; scope: string; observedAt?: number };
}

/**
 * What a captured row says about the character's knowledge of the recipe:
 * - LEARNED: the client reported the recipe learned (Retail/Forever learned flag, Classic TradeSkill own list).
 * - VISIBLE_NOT_LEARNED: shown in the profession UI and reported not learned.
 * - VISIBLE_LEARNED_UNKNOWN: shown in a UI whose API does not establish learned state (Classic Craft window).
 * - LEARNED_STATE_UNKNOWN: a captured row whose learned state the client did not return.
 * The row's `evidence` (OBSERVED / LAST_SEEN) says separately whether the row itself is current.
 */
export type RecipeKnowledgeClass = "LEARNED" | "VISIBLE_NOT_LEARNED" | "VISIBLE_LEARNED_UNKNOWN" | "LEARNED_STATE_UNKNOWN";

export interface RecipeKnowledgeRow {
  /** Client recipe/spell ID (Retail, Forever). Classic legacy lists never expose one. */
  recipeID?: number;
  /** Classic opaque stable identity, present only when profession/name/output was unique in its observation. */
  recipeKey?: string;
  /** RECIPE_ID / RECIPE_KEY when the row has a stable identity; NAME_ONLY otherwise (never merged across rows). */
  identityBasis: "RECIPE_ID" | "RECIPE_KEY" | "NAME_ONLY";
  name?: string;
  profession?: string;
  learnedState: string;
  knowledgeClass: RecipeKnowledgeClass;
  /** Freshness of the learned-state claim itself, when the exporter recorded it separately from the row. */
  learnedEvidence?: string;
  evidence: "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
  sourceSnapshotId?: number;
  observedAt?: number;
  /** ITEM: a physical crafted item; ENCHANTMENT: a Classic Craft enchant identity (never an item ID). */
  outputKind: "ITEM" | "ENCHANTMENT" | "UNKNOWN";
  outputItemID?: number;
  enchantID?: number;
  outputItemType?: string;
  outputEquipLocation?: string;
  reagentSlots: ReagentSlotView[];
  /** OBSERVED / PARTIAL / UNKNOWN reagent list coverage as stated by the exporter (Classic). */
  reagentCoverage?: string;
  /** API surface that produced the row (GetTradeSkillInfo, GetCraftInfo, C_TradeSkillUI ...). */
  rowSource?: string;
  /**
   * Classic client counts reported with the row (TradeSkill numAvailable / Craft numAvailable) at observation time.
   * A client report under that moment's bags and UI state; never current craftability.
   */
  clientReportedCount?: { quantity: number; scope: string; meaning: "CLIENT_REPORTED_CRAFTABLE_AT_OBSERVATION" | "CLIENT_AVAILABLE_VALUE_NEUTRAL" };
  /** Classic Craft trainer-context fields, verbatim when returned. */
  trainerPointCost?: number;
  trainerRequiredLevel?: number;
}

export interface RecipeCrafterEntry {
  identityKey: string;
  name: string;
  realm: string;
  level?: number;
  professionSkill?: { name: string; skill?: number; maxSkill?: number; state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN" };
  recipe: RecipeKnowledgeRow;
}

export interface RecipeCraftersResult {
  version: VersionOrUnknown;
  filter: RecipeFilter;
  learned: RecipeCrafterEntry[];
  observedNotLearned: RecipeCrafterEntry[];
  unresolved: RecipeCrafterEntry[];
  charactersWithoutRecipeEvidence: Array<{ identityKey: string; name: string; realm: string; reason: string }>;
  truncated: boolean;
  semantics: string;
}

function record(value: unknown): Row | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined; }
function num(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function str(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.map(record).filter((row): row is Row => !!row) : []; }

export function itemIDFromRef(ref: string | undefined): number | undefined {
  const match = ref ? /^(?:item:)?(\d+)/.exec(ref) : null;
  return match ? Number(match[1]) : undefined;
}

function reagentSlots(recipe: Row, observedAt: number | undefined): ReagentSlotView[] {
  if (Array.isArray(recipe.reagentSlots)) return rows(recipe.reagentSlots).map((slot) => {
    const alternatives = rows(slot.reagents).map((choice) => ({ ...(num(choice.itemID) !== undefined ? { itemID: num(choice.itemID) } : {}), ...(num(choice.currencyID) !== undefined ? { currencyID: num(choice.currencyID) } : {}), ...(num(choice.quantity) !== undefined ? { quantity: num(choice.quantity) } : {}) }));
    const quantityRequired = num(slot.quantityRequired);
    return { ...(num(slot.slotIndex) !== undefined ? { slotIndex: num(slot.slotIndex) } : {}), ...(typeof slot.required === "boolean" ? { required: slot.required } : {}), ...(quantityRequired !== undefined ? { quantityRequired } : {}), alternatives, identityState: alternatives.length > 0 && alternatives.every((choice) => choice.itemID !== undefined || choice.currencyID !== undefined) && quantityRequired !== undefined ? "OBSERVED" as const : "UNKNOWN" as const };
  });
  // Classic legacy lists: one required reagent per row, no alternatives.
  return rows(recipe.reagents).map((reagent) => {
    const itemID = num(reagent.itemID);
    const quantityRequired = num(reagent.required);
    const carried = num(reagent.carriedByClient);
    return {
      ...(num(reagent.index) !== undefined ? { slotIndex: num(reagent.index) } : {}),
      required: true,
      ...(quantityRequired !== undefined ? { quantityRequired } : {}),
      alternatives: itemID !== undefined ? [{ itemID }] : [],
      identityState: itemID !== undefined && quantityRequired !== undefined ? "OBSERVED" as const : "UNKNOWN" as const,
      ...(str(reagent.name) ? { name: str(reagent.name) } : {}),
      ...(carried !== undefined && reagent.carriedEvidence === "OBSERVED" ? { clientReportedCarried: { quantity: carried, scope: str(reagent.carriedScope) ?? "CURRENT_CHARACTER_BAGS_AS_REPORTED_BY_CLIENT", ...(observedAt !== undefined ? { observedAt } : {}) } } : {}),
    };
  });
}

function knowledgeClass(recipe: Row): RecipeKnowledgeClass {
  if (recipe.learnedState === "OBSERVED_TRUE") return "LEARNED";
  if (recipe.learnedState === "OBSERVED_FALSE") return "VISIBLE_NOT_LEARNED";
  return recipe.rowSource === "GetCraftInfo" ? "VISIBLE_LEARNED_UNKNOWN" : "LEARNED_STATE_UNKNOWN";
}

/** Flatten a resolved recipe section into rows with their own provenance. */
export function knowledgeRows(resolution: RecipeEvidenceResolution): RecipeKnowledgeRow[] {
  const data = record(resolution.section?.data);
  return rows(data?.professions).flatMap((scope) => {
    const profession = str(scope.professionName) ?? str(scope.name);
    return rows(scope.recipes).filter((recipe) => num(recipe.recipeID) !== undefined || str(recipe.name) !== undefined).map((recipe) => {
      const info = record(recipe.outputItemInfo);
      const evidence = recipe.evidence === "OBSERVED" || recipe.evidence === "LAST_SEEN" ? recipe.evidence : "UNKNOWN";
      const observedAt = num(recipe.observedAt) ?? num(scope.observedAt) ?? resolution.observedAt;
      const recipeID = num(recipe.recipeID);
      const recipeKey = recipeID === undefined ? str(recipe.recipeKey) : undefined;
      const enchantID = num(recipe.enchantID);
      const outputItemID = num(recipe.outputItemID);
      const craftable = num(recipe.currentlyCraftableCount);
      const available = num(recipe.clientAvailableCount);
      return {
        ...(recipeID !== undefined ? { recipeID } : {}),
        ...(recipeKey ? { recipeKey } : {}),
        identityBasis: recipeID !== undefined ? "RECIPE_ID" : recipeKey ? "RECIPE_KEY" : "NAME_ONLY",
        ...(str(recipe.name) ? { name: str(recipe.name) } : {}),
        ...(profession ? { profession } : {}),
        learnedState: str(recipe.learnedState) ?? "UNKNOWN",
        knowledgeClass: knowledgeClass(recipe),
        ...(str(recipe.learnedEvidence) ? { learnedEvidence: resolution.state === "LAST_SEEN" && recipe.learnedEvidence === "OBSERVED" && resolution.sourceSnapshotId !== resolution.selectedSnapshotId ? "LAST_SEEN" : str(recipe.learnedEvidence) } : {}),
        evidence,
        ...(resolution.sourceSnapshotId !== undefined ? { sourceSnapshotId: resolution.sourceSnapshotId } : {}),
        ...(observedAt !== undefined ? { observedAt } : {}),
        outputKind: outputItemID !== undefined ? "ITEM" : enchantID !== undefined ? "ENCHANTMENT" : "UNKNOWN",
        ...(outputItemID !== undefined ? { outputItemID } : {}),
        ...(enchantID !== undefined ? { enchantID } : {}),
        ...(info?.state === "OBSERVED" && str(info.itemType) ? { outputItemType: str(info.itemType) } : {}),
        ...(info?.state === "OBSERVED" && str(info.equipLocation) ? { outputEquipLocation: str(info.equipLocation) } : {}),
        reagentSlots: reagentSlots(recipe, observedAt),
        ...(str(recipe.reagentState) ? { reagentCoverage: str(recipe.reagentState) } : {}),
        ...(str(recipe.rowSource) ?? str(recipe.sourceAPI) ? { rowSource: str(recipe.rowSource) ?? str(recipe.sourceAPI) } : {}),
        ...(craftable !== undefined && recipe.currentlyCraftableEvidence === "OBSERVED" ? { clientReportedCount: { quantity: craftable, scope: str(recipe.currentlyCraftableScope) ?? "CLIENT_REPORT", meaning: "CLIENT_REPORTED_CRAFTABLE_AT_OBSERVATION" as const } }
          : available !== undefined && recipe.clientAvailableEvidence === "OBSERVED" ? { clientReportedCount: { quantity: available, scope: str(recipe.clientAvailableScope) ?? "CLIENT_REPORT", meaning: "CLIENT_AVAILABLE_VALUE_NEUTRAL" as const } } : {}),
        ...(num(recipe.trainerPointCost) !== undefined ? { trainerPointCost: num(recipe.trainerPointCost) } : {}),
        ...(num(recipe.trainerRequiredLevel) !== undefined ? { trainerRequiredLevel: num(recipe.trainerRequiredLevel) } : {}),
      } satisfies RecipeKnowledgeRow;
    });
  });
}

/** A stable string identity for one row: recipe ID, Classic recipe key, or (never merged) profession/name/output. */
export function recipeRowIdentity(row: RecipeKnowledgeRow): string {
  if (row.recipeID !== undefined) return `id:${row.recipeID}`;
  if (row.recipeKey) return `key:${row.recipeKey}`;
  return `name:${row.profession ?? "?"}:${row.name ?? "?"}:${row.outputItemID ?? row.enchantID ?? "?"}`;
}

export function matchesRecipeFilter(row: RecipeKnowledgeRow, filter: RecipeFilter): boolean {
  if (filter.recipeID !== undefined && row.recipeID !== filter.recipeID) return false;
  if (filter.recipeKey !== undefined && row.recipeKey !== filter.recipeKey) return false;
  if (filter.outputItemID !== undefined && row.outputItemID !== filter.outputItemID) return false;
  if (filter.enchantID !== undefined && row.enchantID !== filter.enchantID) return false;
  if (filter.nameContains !== undefined && !(row.name ?? "").toLowerCase().includes(filter.nameContains.toLowerCase())) return false;
  return true;
}

function professionSkill(snapshot: StoredSnapshot, profession: string | undefined): RecipeCrafterEntry["professionSkill"] {
  if (!profession) return undefined;
  const section = snapshot.parsed.professions;
  const entry = section.entries.find((row) => profession.toLowerCase().includes(row.name.toLowerCase()));
  if (!entry) return { name: profession, state: "UNKNOWN" };
  return { name: entry.name, skill: entry.skill, maxSkill: entry.maxSkill, state: section.status.state === "OBSERVED" ? "OBSERVED" : section.status.state === "LAST_SEEN" ? "LAST_SEEN" : "UNKNOWN" };
}

const MAX_ENTRIES = 100;

/** Which characters in one version have captured evidence for a recipe or output item. */
export function findRecipeCrafters(version: VersionOrUnknown, histories: CharacterHistory[], filter: RecipeFilter): RecipeCraftersResult {
  const result: RecipeCraftersResult = { version, filter, learned: [], observedNotLearned: [], unresolved: [], charactersWithoutRecipeEvidence: [], truncated: false,
    semantics: "Rows come only from captured profession-panel candidate lists, which are partial. learned = client reported the recipe learned; observedNotLearned = shown in the UI and reported not learned; unresolved = learned state not established (e.g. a Classic Craft window row, knowledgeClass VISIBLE_LEARNED_UNKNOWN). Each row's evidence says whether the row is current (OBSERVED) or historical (LAST_SEEN). A character absent from 'learned' is not proven unable to craft; see charactersWithoutRecipeEvidence. Knowing a recipe does not establish skill, facility, or reagent readiness." };
  let count = 0;
  for (const { character, snapshots } of histories) {
    const latest = snapshots[0];
    const resolution = resolveRecipeEvidence(version, snapshots, latest);
    if (!resolution.section) { result.charactersWithoutRecipeEvidence.push({ identityKey: character.identityKey, name: character.name, realm: character.realm, reason: resolution.reason }); continue; }
    for (const row of knowledgeRows(resolution).filter((candidate) => matchesRecipeFilter(candidate, filter))) {
      if (count >= MAX_ENTRIES) { result.truncated = true; break; }
      count++;
      const entry: RecipeCrafterEntry = { identityKey: character.identityKey, name: character.name, realm: character.realm, ...(latest!.parsed.character.level !== undefined ? { level: latest!.parsed.character.level } : {}), ...(professionSkill(latest!, row.profession) ? { professionSkill: professionSkill(latest!, row.profession) } : {}), recipe: row };
      if (row.knowledgeClass === "LEARNED") result.learned.push(entry);
      else if (row.knowledgeClass === "VISIBLE_NOT_LEARNED") result.observedNotLearned.push(entry);
      else result.unresolved.push(entry);
    }
  }
  return result;
}

export type HoldingState = "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
export interface ReagentHolding {
  ownerScope: "CRAFTER_BAGS" | "CRAFTER_BANK" | "OTHER_CHARACTER";
  identityKey: string;
  name: string;
  realm: string;
  state: HoldingState;
  freshness: Freshness;
  completeness: string;
  quantity?: number;
  observedAt?: number;
  snapshotId?: number;
  usableForCraftingWithoutMove: boolean | "UNKNOWN";
  reason: string;
}

export interface ReagentAvailabilityView {
  slot: ReagentSlotView;
  perAlternative: Array<{ choice: ReagentChoice; holdings: ReagentHolding[]; carriedConclusion: "SUFFICIENT_IN_CURRENT_BAGS" | "INSUFFICIENT_IN_COMPLETE_CURRENT_BAGS" | "UNKNOWN"; reason: string }>;
}

function inventoryHolding(section: InventorySection, itemID: number, base: Omit<ReagentHolding, "state" | "freshness" | "completeness" | "reason" | "quantity" | "observedAt">, now: number): ReagentHolding {
  const state: HoldingState = section.status.state === "OBSERVED" ? "OBSERVED" : section.status.state === "LAST_SEEN" ? "LAST_SEEN" : "UNKNOWN";
  const observedAt = section.status.observedAt;
  const freshness = classifyFreshness(observedAt, now);
  const completeness = section.status.completeness ?? "unknown";
  if (state === "UNKNOWN") return { ...base, state, freshness, completeness, reason: section.status.reason ?? "This storage was not observed; UNKNOWN is not empty." };
  const quantity = section.items.filter((item) => itemIDFromRef(item.itemRef) === itemID).reduce((sum, item) => sum + (item.qty ?? 0), 0);
  const presentOrComplete = quantity > 0 || completeness === "complete";
  return { ...base, state, freshness, completeness, ...(presentOrComplete ? { quantity } : {}), ...(observedAt !== undefined ? { observedAt } : {}),
    reason: state === "LAST_SEEN" || freshness === "stale" ? "Historical observation; not current availability." : presentOrComplete ? (completeness === "complete" ? "Exact item count from a complete observation." : "At least this many were observed in a partial scan.") : "Not seen in a partial scan; absence is not zero." };
}

/** Where one recipe's reagents are observed, separated by owner and accessibility. */
export function reagentAvailability(version: VersionOrUnknown, crafter: CharacterHistory, others: CharacterHistory[], recipe: RecipeKnowledgeRow, now: number): ReagentAvailabilityView[] {
  const latest = resolveSnapshotView(version, crafter.snapshots, crafter.snapshots[0]!);
  const crafterBase = (scope: "CRAFTER_BAGS" | "CRAFTER_BANK") => ({ ownerScope: scope, identityKey: crafter.character.identityKey, name: crafter.character.name, realm: crafter.character.realm, snapshotId: latest.id, usableForCraftingWithoutMove: scope === "CRAFTER_BAGS" ? true as const : "UNKNOWN" as const });
  return recipe.reagentSlots.map((slot) => ({
    slot,
    perAlternative: slot.alternatives.map((choice) => {
      if (choice.itemID === undefined) return { choice, holdings: [], carriedConclusion: "UNKNOWN" as const, reason: "Currency or unidentified reagent; item storage does not apply." };
      const itemID = choice.itemID;
      const bags = inventoryHolding(latest.parsed.bags, itemID, crafterBase("CRAFTER_BAGS"), now);
      const bank = inventoryHolding(latest.parsed.bank, itemID, crafterBase("CRAFTER_BANK"), now);
      const otherHoldings = others.flatMap(({ character, snapshots }) => {
        const snap = snapshots[0] && resolveSnapshotView(version, snapshots, snapshots[0]);
        if (!snap) return [];
        return [snap.parsed.bags, snap.parsed.bank].map((section) => inventoryHolding(section, itemID, { ownerScope: "OTHER_CHARACTER", identityKey: character.identityKey, name: character.name, realm: character.realm, snapshotId: snap.id, usableForCraftingWithoutMove: false }, now))
          .filter((holding) => (holding.quantity ?? 0) > 0)
          .map((holding) => ({ ...holding, reason: `${holding.reason} Held by a separate character; transfer is not assumed and account/realm/faction access is UNKNOWN.` }));
      });
      const needed = slot.quantityRequired;
      const current = bags.state === "OBSERVED" && bags.freshness === "recent";
      const carriedConclusion = needed === undefined || !current ? "UNKNOWN" as const
        : (bags.quantity ?? 0) >= needed ? "SUFFICIENT_IN_CURRENT_BAGS" as const
        : bags.completeness === "complete" ? "INSUFFICIENT_IN_COMPLETE_CURRENT_BAGS" as const : "UNKNOWN" as const;
      return { choice, holdings: [bags, bank, ...otherHoldings], carriedConclusion,
        reason: carriedConclusion === "SUFFICIENT_IN_CURRENT_BAGS" ? "Current carried bags hold at least the required quantity of this alternative." : carriedConclusion === "INSUFFICIENT_IN_COMPLETE_CURRENT_BAGS" ? "A complete current bag scan holds fewer than required." : "Current carried availability cannot be established; this is not a shortage." };
    }),
  }));
}

export interface TrainerRecipeMatch {
  /** RECIPE_ID: the trainer service spell ID equals a captured recipe ID. DERIVED_NAME: unique exact name match only. */
  basis: "RECIPE_ID" | "DERIVED_NAME";
  recipeID?: number;
  recipeKey?: string;
  learnedState: string;
  knowledgeClass: RecipeKnowledgeClass;
  evidence: RecipeKnowledgeRow["evidence"];
  sourceSnapshotId?: number;
  outputKind: RecipeKnowledgeRow["outputKind"];
  outputItemID?: number;
  enchantID?: number;
  reagentSlots: ReagentSlotView[];
}

/** Join one trainer service to this character's captured recipe rows, conservatively. */
export function matchTrainerService(service: { spellID?: string; ability?: string }, allRows: readonly RecipeKnowledgeRow[], trainerCategory?: string): TrainerRecipeMatch | undefined {
  // Only rows whose profession is compatible with the trainer category may match
  // (Retail tier names contain the base profession name); unknown sides stay eligible.
  const category = trainerCategory?.trim().toLowerCase();
  const compatible = (row: RecipeKnowledgeRow) => !category || !row.profession || row.profession.toLowerCase().includes(category) || category.includes(row.profession.toLowerCase());
  const rows = allRows.filter(compatible);
  const view = (row: RecipeKnowledgeRow, basis: TrainerRecipeMatch["basis"]): TrainerRecipeMatch => ({ basis, ...(row.recipeID !== undefined ? { recipeID: row.recipeID } : {}), ...(row.recipeKey ? { recipeKey: row.recipeKey } : {}), learnedState: row.learnedState, knowledgeClass: row.knowledgeClass, evidence: row.evidence, ...(row.sourceSnapshotId !== undefined ? { sourceSnapshotId: row.sourceSnapshotId } : {}), outputKind: row.outputKind, ...(row.outputItemID !== undefined ? { outputItemID: row.outputItemID } : {}), ...(row.enchantID !== undefined ? { enchantID: row.enchantID } : {}), reagentSlots: row.reagentSlots });
  const id = service.spellID !== undefined && /^\d+$/.test(service.spellID) ? Number(service.spellID) : undefined;
  const byId = id !== undefined ? rows.find((row) => row.recipeID === id) : undefined;
  if (byId) return view(byId, "RECIPE_ID");
  const name = service.ability?.trim().toLowerCase();
  if (!name) return undefined;
  const byName = rows.filter((row) => row.name?.trim().toLowerCase() === name);
  const ids = new Set(byName.map(recipeRowIdentity));
  return ids.size === 1 ? view(byName[0]!, "DERIVED_NAME") : undefined;
}
