/**
 * Classic Era / TBC Anniversary structured state sidecar (GearExport 2c5e9b3+).
 *
 * GearExport's legacy collectors persist four SavedVariables-only domains for
 * Classic clients: the player-opened TradeSkill/Craft list (`professionRecipes`),
 * the quest log with objectives and client-returned completed quest IDs
 * (`quests`), visible reputation rows (`reputation`), and talent trees
 * (`talents`). Each arrives as GearExport's section envelope
 * `{data, observedAt, changedAt, revision, completeness, reason, source, lastAttemptStale}`.
 *
 * Validation here is structural and conservative: a domain whose client
 * profile does not belong to the snapshot's WoW version, or whose shape does
 * not match the collector contract, is dropped (UNKNOWN), never repaired.
 * Row-level evidence labels written by GearExport (OBSERVED / LAST_SEEN /
 * UNKNOWN, learnedState, learnedEvidence) are preserved verbatim; nothing here
 * promotes a visible Craft row to learned or a client count to craftability.
 */

import type { CapturedCharacterDomain, CapturedCharacterState, CharacterSection, VersionOrUnknown } from "./types.ts";

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positiveID = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** Lists GearExport writes; an empty Lua table arrives as `{}`. */
const LIST_FIELDS = new Set(["professions", "recipes", "reagents", "active", "objectives", "questIDs", "quests", "factions", "majorFactions", "trees", "talents", "issues"]);

function normalizeEmptyLists(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeEmptyLists);
  if (!object(value)) return value;
  const out: Obj = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = LIST_FIELDS.has(key) && object(child) && Object.keys(child).length === 0 ? [] : normalizeEmptyLists(child);
  }
  return out;
}

const CLASSIC_PROFILE = /^Classic:([A-Za-z0-9-]+):(\d+)$/;

/** The WoW version a "Classic:<project>:<interface>" profile belongs to, by interface family. */
export function classicProfileVersion(profile: unknown): "classic-era" | "tbc-anniversary" | undefined {
  const match = typeof profile === "string" ? CLASSIC_PROFILE.exec(profile) : null;
  if (!match) return undefined;
  const family = Math.floor(Number(match[2]) / 10000);
  return family === 1 ? "classic-era" : family === 2 ? "tbc-anniversary" : undefined;
}

export function isClassicVersion(version: VersionOrUnknown): version is "classic-era" | "tbc-anniversary" {
  return version === "classic-era" || version === "tbc-anniversary";
}

const RECIPE_EVIDENCE = new Set(["OBSERVED", "LAST_SEEN", "UNKNOWN"]);
const LEARNED_STATES = new Set(["OBSERVED_TRUE", "OBSERVED_FALSE", "UNKNOWN"]);

function validRecipe(recipe: unknown): boolean {
  if (!object(recipe) || !text(recipe.name, 256)) return false;
  if (!RECIPE_EVIDENCE.has(recipe.evidence as string) || !LEARNED_STATES.has(recipe.learnedState as string)) return false;
  // Legacy collectors never manufacture recipe IDs; a numeric recipeID here is a different contract.
  if (recipe.recipeID !== undefined) return false;
  if (recipe.learnedState === "UNKNOWN" && recipe.learned !== undefined && recipe.learned !== null) return false;
  if (recipe.outputItemID !== undefined && !positiveID(recipe.outputItemID)) return false;
  if (recipe.enchantID !== undefined && !positiveID(recipe.enchantID)) return false;
  if (recipe.outputItemID !== undefined && recipe.enchantID !== undefined) return false;
  if (recipe.recipeKey !== undefined && !text(recipe.recipeKey, 1024)) return false;
  if (recipe.reagents !== undefined) {
    if (!Array.isArray(recipe.reagents)) return false;
    for (const reagent of recipe.reagents) {
      if (!object(reagent)) return false;
      if (reagent.itemID !== undefined && !positiveID(reagent.itemID)) return false;
      if (reagent.required !== undefined && !counter(reagent.required)) return false;
    }
  }
  return true;
}

function professionsState(professions: Obj[]): "OBSERVED" | "LAST_SEEN" {
  return professions.some((row) => row.evidence === "OBSERVED") ? "OBSERVED" : "LAST_SEEN";
}

function envelope(raw: unknown): { raw: Obj; data: Obj; observedAt: number } | undefined {
  if (!object(raw) || !object(raw.data) || !finite(raw.observedAt)) return undefined;
  const data = normalizeEmptyLists(raw.data) as Obj;
  if (data.formatVersion !== 1) return undefined;
  return { raw, data, observedAt: raw.observedAt };
}

function domain(raw: Obj, data: Obj, observedAt: number, state: "OBSERVED" | "LAST_SEEN", defaultCompleteness: "complete" | "partial", honorStale = true): CapturedCharacterDomain {
  const completeness = raw.completeness === "complete" ? "complete" : raw.completeness === "partial" ? "partial" : defaultCompleteness;
  // A later failed attempt leaves the last good data in place with lastAttemptStale. For recipes GearExport
  // sets it whenever the profession window is merely closed and already relabels rows from earlier sessions
  // LAST_SEEN itself, so the per-row labels (not the flag) decide recipe recency.
  const stale = honorStale && raw.lastAttemptStale === true;
  const reason = [typeof raw.reason === "string" ? raw.reason : undefined, stale ? "The most recent refresh attempt did not observe this domain; values are the last successful observation." : undefined].filter(Boolean).join(" ");
  return {
    status: { state: stale ? "LAST_SEEN" : state, completeness, observedAt, ...(reason ? { reason } : {}) },
    formatVersion: 1,
    observedAt,
    completeness,
    data: { ...data, ...(stale ? { lastAttemptStale: true } : {}) },
  };
}

function profileMatches(data: Obj, version: "classic-era" | "tbc-anniversary"): boolean {
  return classicProfileVersion(data.clientProfile) === version;
}

function currentCollectorMatches(data: Obj, version: "classic-era" | "tbc-anniversary"): boolean {
  if (data.evidence !== "OBSERVED" || typeof data.clientFamily !== "string") return false;
  const major = /^(\d+)\./.exec(data.clientFamily)?.[1];
  return version === "classic-era" ? major === "1" : major === "2";
}

function normalizeRecipes(raw: unknown, version: "classic-era" | "tbc-anniversary"): CapturedCharacterDomain | undefined {
  const parsed = envelope(raw);
  if (!parsed) return undefined;
  const { data } = parsed;
  // Current GearExport Classic sidecar (capture/revision envelope): clientFamily
  // is the exact client version (for example 1.15.9), and recipes are the
  // visible profession window rows with reagent names/counts. Do not infer
  // learned state from visibility; complete here means the captured section
  // itself declared complete, not that absent recipes are unlearned.
  const clientMajor = typeof data.clientFamily === "string" ? /^(\d+)\./.exec(data.clientFamily)?.[1] : undefined;
  const currentVersionMatches = version === "classic-era" ? clientMajor === "1" : clientMajor === "2";
  if (currentVersionMatches && Array.isArray(data.professions) && data.professions.length > 0) {
    const professions: Obj[] = [];
    for (const profession of data.professions) {
      if (!object(profession) || !text(profession.professionName ?? profession.name, 128) || !Array.isArray(profession.recipes) || profession.recipes.length === 0) return undefined;
      const recipes: Obj[] = [];
      for (const recipe of profession.recipes) {
        if (!object(recipe) || !text(recipe.name, 256) || recipe.itemID !== undefined && !positiveID(recipe.itemID) || !Array.isArray(recipe.reagents)) return undefined;
        const reagents: Obj[] = [];
        for (const reagent of recipe.reagents) {
          if (!object(reagent) || !text(reagent.name, 256) || !positiveID(reagent.count) || reagent.itemID !== undefined && !positiveID(reagent.itemID)) return undefined;
          reagents.push({ name: reagent.name, required: reagent.count, ...(reagent.itemID ? { itemID: reagent.itemID } : {}) });
        }
        recipes.push({ name: recipe.name, ...(recipe.itemID ? { outputItemID: recipe.itemID } : {}), evidence: "OBSERVED", learnedState: "UNKNOWN", reagents });
      }
      professions.push({ name: profession.professionName ?? profession.name, professionName: profession.professionName ?? profession.name, professionKey: profession.professionName ?? profession.name, evidence: "OBSERVED", recipes });
    }
    const completeness = parsed.raw.completeness === "complete" ? "complete" : "partial";
    return {
      status: { state: "OBSERVED", completeness, observedAt: parsed.observedAt }, formatVersion: 1, observedAt: parsed.observedAt,
      completeness, data: { ...data, ownerScope: "CHARACTER", professions },
    };
  }
  if (!profileMatches(data, version) || !Array.isArray(data.professions) || data.professions.length === 0) return undefined;
  for (const profession of data.professions) {
    if (!object(profession) || !text(profession.name, 128) || !text(profession.professionKey, 512) || !Array.isArray(profession.recipes) || profession.recipes.length === 0) return undefined;
    if (profession.evidence !== "OBSERVED" && profession.evidence !== "LAST_SEEN") return undefined;
    if (profession.clientProfile !== undefined && classicProfileVersion(profession.clientProfile) !== version) return undefined;
    if (!profession.recipes.every(validRecipe)) return undefined;
  }
  // Legacy lists are the player's currently visible rows: always partial candidate coverage.
  const professions = data.professions as Obj[];
  return domain(parsed.raw, { ...data, ownerScope: "CHARACTER", coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", source: "LEGACY_OPEN_WINDOW" } }, parsed.observedAt, professionsState(professions), "partial", false);
}

function normalizeQuests(raw: unknown, version: "classic-era" | "tbc-anniversary"): CapturedCharacterDomain | undefined {
  const parsed = envelope(raw);
  if (!parsed) return undefined;
  const { data } = parsed;
  const currentCollector = currentCollectorMatches(data, version);
  if (!profileMatches(data, version) && !currentCollector) return undefined;
  if (data.evidence === "OBSERVED" && typeof data.clientFamily === "string" && /^\d+\./.test(data.clientFamily) && !currentCollector) return undefined;
  if (!currentCollector && (data.clientFamily !== "Classic" || data.source !== "legacy quest log APIs")) return undefined;
  if (currentCollector) {
    const rows = Array.isArray(data.quests) ? data.quests : undefined;
    if (!rows || !rows.every((row) => object(row) && text(row.title, 512))) return undefined;
    const active = rows.map((row) => ({
      ...(positiveID(row.questID) ? { questID: row.questID } : {}), title: row.title,
      ...(counter(row.level) ? { level: row.level } : {}),
      ...(Array.isArray(row.objectives) ? { objectives: row.objectives.filter(object).map((objective: Obj) => ({ ...(text(objective.text, 512) ? { text: objective.text } : {}) })), objectiveState: "PARTIAL" } : {}),
      ...(typeof row.complete === "boolean" ? { isComplete: row.complete, completionState: "OBSERVED" } : {}),
      rowEvidence: row.evidence === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED",
    }));
    const observedAt = parsed.observedAt;
    return domain(parsed.raw, { ...data, clientFamily: "Classic", clientProfile: data.clientProfile ?? "Classic:1:11509", source: "legacy quest log APIs", activeState: "OBSERVED", activeCompleteness: parsed.raw.completeness === "complete" ? "complete" : "partial", active, completedHistory: { state: "UNKNOWN" } }, observedAt, "OBSERVED", "partial");
  }
  if (data.activeState !== undefined && data.activeState !== "OBSERVED" && data.activeState !== "UNKNOWN") return undefined;
  if (data.active !== undefined && (!Array.isArray(data.active) || !data.active.every((row) => object(row) && positiveID(row.questID)))) return undefined;
  if (data.completedHistory !== undefined && !object(data.completedHistory)) return undefined;
  return domain(parsed.raw, data, parsed.observedAt, "OBSERVED", "partial");
}

function normalizeReputation(raw: unknown, version: "classic-era" | "tbc-anniversary"): CapturedCharacterDomain | undefined {
  const parsed = envelope(raw);
  if (!parsed) return undefined;
  const { data } = parsed;
  const currentCollector = currentCollectorMatches(data, version);
  if (!profileMatches(data, version) && !currentCollector) return undefined;
  if (data.evidence === "OBSERVED" && typeof data.clientFamily === "string" && /^\d+\./.test(data.clientFamily) && !currentCollector) return undefined;
  if ((!currentCollector && data.source !== "GetFactionInfo") || !Array.isArray(data.factions)) return undefined;
  for (const row of data.factions) {
    if (!object(row) || !text(row.name, 256)) return undefined;
    // Stable IDs are optional on legacy rows; missing IDs keep their client factionKey, never a synthetic ID.
    if (row.factionID !== undefined && !positiveID(row.factionID)) return undefined;
    if (row.factionID === undefined && !text(row.factionKey, 1024)) return undefined;
  }
  // Visible-row coverage only: reputation is always partial.
  return domain(parsed.raw, { ...data, clientFamily: "Classic", ownerScope: "CHARACTER" }, parsed.observedAt, "OBSERVED", "partial");
}

function normalizeTalents(raw: unknown, version: "classic-era" | "tbc-anniversary"): CapturedCharacterDomain | undefined {
  const parsed = envelope(raw);
  if (!parsed) return undefined;
  const { data } = parsed;
  if (!profileMatches(data, version) || !Array.isArray(data.trees)) return undefined;
  for (const tree of data.trees) {
    if (!object(tree) || !counter(tree.tab) || !Array.isArray(tree.talents)) return undefined;
    for (const talent of tree.talents) if (!object(talent) || talent.currentRank !== undefined && !counter(talent.currentRank) || talent.maxRank !== undefined && !counter(talent.maxRank)) return undefined;
  }
  return domain(parsed.raw, data, parsed.observedAt, "OBSERVED", "complete");
}

/**
 * Validate a Classic Era / TBC Anniversary sidecar for one snapshot. Every
 * domain must carry a profile from the snapshot's own version; the export's
 * client version must agree. Invalid domains are dropped individually.
 */
export function normalizeClassicCharacterState(input: unknown, version: VersionOrUnknown, character?: CharacterSection): CapturedCharacterState | undefined {
  if (!isClassicVersion(version) || !object(input) || input.formatVersion !== 1 || input.clientFamily !== "Classic") return undefined;
  // A family-tagged export (Retail, Forever) can never carry a Classic sidecar.
  if (character?.clientFamily) return undefined;
  const state: CapturedCharacterState = { formatVersion: 1, clientFamily: "Classic" };
  if (typeof input.sourceCharacterGuid === "string" && /^Player-\d+-[0-9A-F]+$/i.test(input.sourceCharacterGuid)) state.sourceCharacterGuid = input.sourceCharacterGuid;
  const recipes = normalizeRecipes(input.professionRecipes, version);
  const quests = normalizeQuests(input.quests, version);
  const reputation = normalizeReputation(object(input.reputation) ? input.reputation.character : undefined, version);
  const talents = normalizeTalents(input.talents, version);
  if (recipes) state.professionRecipes = recipes;
  if (quests) {
    const qdata = quests.data as Obj;
    if (typeof qdata.clientProfile !== "string" && character?.clientVersion) {
      const interfaceID = character.interface?.replace(/\D/g, "");
      if (interfaceID && /^\d{5,6}$/.test(interfaceID)) qdata.clientProfile = `Classic:${version === "classic-era" ? "1" : "2"}:${interfaceID}`;
    }
    state.quests = quests;
  }
  if (reputation) state.reputation = { character: reputation };
  if (talents) state.talents = talents;
  const profile = [recipes, quests, reputation, talents].map((entry) => (entry?.data as Obj | undefined)?.clientProfile).find((value): value is string => typeof value === "string");
  if (profile) state.clientProfile = profile;
  return recipes || quests || reputation || talents ? state : undefined;
}

/**
 * Same-snapshot re-import of a Classic sidecar: GearExport already merges rows
 * across refreshes inside each domain, so the fresher domain replaces the
 * older one; a domain the new payload lacks is retained, labelled LAST_SEEN.
 * Never merges across families or differing character GUIDs.
 */
export function mergeClassicCharacterState(previous: CapturedCharacterState | undefined, current: CapturedCharacterState | undefined): CapturedCharacterState | undefined {
  if (!previous || previous.clientFamily !== "Classic") return current;
  // An absent or invalid re-sent payload carries no new evidence; it must not degrade what this snapshot already holds.
  if (!current) return previous;
  if (current && current.clientFamily !== "Classic") return current;
  if (current?.sourceCharacterGuid && previous.sourceCharacterGuid && current.sourceCharacterGuid !== previous.sourceCharacterGuid) return current;
  const retained = (domain: CapturedCharacterDomain | undefined): CapturedCharacterDomain | undefined => domain && { ...domain, status: { ...domain.status, state: "LAST_SEEN", reason: "Not present in this later payload for the same export; earlier observation retained." } };
  const result: CapturedCharacterState = current ? structuredClone(current) : { formatVersion: 1, clientFamily: "Classic", ...(previous.sourceCharacterGuid ? { sourceCharacterGuid: previous.sourceCharacterGuid } : {}), ...(previous.clientProfile ? { clientProfile: previous.clientProfile } : {}) };
  result.professionRecipes ??= retained(previous.professionRecipes);
  result.quests ??= retained(previous.quests);
  result.talents ??= retained(previous.talents);
  if (!result.reputation?.character && previous.reputation?.character) result.reputation = { character: retained(previous.reputation.character)! };
  for (const key of ["professionRecipes", "quests", "talents"] as const) if (result[key] === undefined) delete result[key];
  return result;
}
