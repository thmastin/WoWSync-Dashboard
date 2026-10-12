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

export interface RecipeFilter { recipeID?: number; outputItemID?: number; nameContains?: string }

export interface ReagentChoice { itemID?: number; currencyID?: number; quantity?: number }
export interface ReagentSlotView { slotIndex?: number; required?: boolean; quantityRequired?: number; alternatives: ReagentChoice[]; identityState: "OBSERVED" | "UNKNOWN" }

export interface RecipeKnowledgeRow {
  recipeID: number;
  name?: string;
  profession?: string;
  learnedState: string;
  evidence: "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
  sourceSnapshotId?: number;
  observedAt?: number;
  outputItemID?: number;
  outputItemType?: string;
  outputEquipLocation?: string;
  reagentSlots: ReagentSlotView[];
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

function reagentSlots(recipe: Row): ReagentSlotView[] {
  return rows(recipe.reagentSlots).map((slot) => {
    const alternatives = rows(slot.reagents).map((choice) => ({ ...(num(choice.itemID) !== undefined ? { itemID: num(choice.itemID) } : {}), ...(num(choice.currencyID) !== undefined ? { currencyID: num(choice.currencyID) } : {}), ...(num(choice.quantity) !== undefined ? { quantity: num(choice.quantity) } : {}) }));
    const quantityRequired = num(slot.quantityRequired);
    return { ...(num(slot.slotIndex) !== undefined ? { slotIndex: num(slot.slotIndex) } : {}), ...(typeof slot.required === "boolean" ? { required: slot.required } : {}), ...(quantityRequired !== undefined ? { quantityRequired } : {}), alternatives, identityState: alternatives.length > 0 && alternatives.every((choice) => choice.itemID !== undefined || choice.currencyID !== undefined) && quantityRequired !== undefined ? "OBSERVED" as const : "UNKNOWN" as const };
  });
}

/** Flatten a resolved recipe section into rows with their own provenance. */
export function knowledgeRows(resolution: RecipeEvidenceResolution): RecipeKnowledgeRow[] {
  const data = record(resolution.section?.data);
  return rows(data?.professions).flatMap((scope) => {
    const profession = str(scope.professionName) ?? str(scope.name);
    return rows(scope.recipes).filter((recipe) => num(recipe.recipeID) !== undefined).map((recipe) => {
      const info = record(recipe.outputItemInfo);
      const evidence = recipe.evidence === "OBSERVED" || recipe.evidence === "LAST_SEEN" ? recipe.evidence : "UNKNOWN";
      const observedAt = num(recipe.observedAt) ?? num(scope.observedAt) ?? resolution.observedAt;
      return {
        recipeID: num(recipe.recipeID)!,
        ...(str(recipe.name) ? { name: str(recipe.name) } : {}),
        ...(profession ? { profession } : {}),
        learnedState: str(recipe.learnedState) ?? "UNKNOWN",
        evidence,
        ...(resolution.sourceSnapshotId !== undefined ? { sourceSnapshotId: resolution.sourceSnapshotId } : {}),
        ...(observedAt !== undefined ? { observedAt } : {}),
        ...(num(recipe.outputItemID) !== undefined ? { outputItemID: num(recipe.outputItemID) } : {}),
        ...(info?.state === "OBSERVED" && str(info.itemType) ? { outputItemType: str(info.itemType) } : {}),
        ...(info?.state === "OBSERVED" && str(info.equipLocation) ? { outputEquipLocation: str(info.equipLocation) } : {}),
        reagentSlots: reagentSlots(recipe),
      } satisfies RecipeKnowledgeRow;
    });
  });
}

function matches(row: RecipeKnowledgeRow, filter: RecipeFilter): boolean {
  if (filter.recipeID !== undefined && row.recipeID !== filter.recipeID) return false;
  if (filter.outputItemID !== undefined && row.outputItemID !== filter.outputItemID) return false;
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
    semantics: "Rows come only from captured profession-panel candidate lists, which are partial. A character absent from 'learned' is not proven unable to craft; see charactersWithoutRecipeEvidence and the per-row evidence. Knowing a recipe does not establish skill, facility, or reagent readiness." };
  let count = 0;
  for (const { character, snapshots } of histories) {
    const latest = snapshots[0];
    const resolution = resolveRecipeEvidence(version, snapshots, latest);
    if (!resolution.section) { result.charactersWithoutRecipeEvidence.push({ identityKey: character.identityKey, name: character.name, realm: character.realm, reason: resolution.reason }); continue; }
    for (const row of knowledgeRows(resolution).filter((candidate) => matches(candidate, filter))) {
      if (count >= MAX_ENTRIES) { result.truncated = true; break; }
      count++;
      const entry: RecipeCrafterEntry = { identityKey: character.identityKey, name: character.name, realm: character.realm, ...(latest!.parsed.character.level !== undefined ? { level: latest!.parsed.character.level } : {}), ...(professionSkill(latest!, row.profession) ? { professionSkill: professionSkill(latest!, row.profession) } : {}), recipe: row };
      if (row.learnedState === "OBSERVED_TRUE") result.learned.push(entry);
      else if (row.learnedState === "OBSERVED_FALSE") result.observedNotLearned.push(entry);
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
