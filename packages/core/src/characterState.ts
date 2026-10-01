import type { CapturedCharacterDomain, CapturedCharacterState, ParsedSnapshot, VersionOrUnknown } from "./types.ts";

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positiveID = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value > 0;
const LIST_FIELDS = new Set(["professions", "tiers", "trees", "nodes", "currencies", "factions", "majorFactions", "committedEntryIDs"]);

/** WoW writes empty Lua tables as `{}`; normalize only known list fields, and only when empty. */
function normalizeEmptyLists(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeEmptyLists);
  if (!object(value)) return value;
  const out: Obj = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = LIST_FIELDS.has(key) && object(child) && Object.keys(child).length === 0 ? [] : normalizeEmptyLists(child);
  }
  return out;
}

function validArrayIDs(rows: unknown, idField: string): boolean {
  return Array.isArray(rows) && rows.every((row) => object(row) && positiveID(row[idField]));
}

function normalizeSection(raw: unknown, domain: "combat" | "professions" | "reputation"): CapturedCharacterDomain | undefined {
  if (!object(raw) || !object(raw.data) || !finite(raw.observedAt)) return undefined;
  const data = normalizeEmptyLists(raw.data) as Obj;
  if (data.formatVersion !== 1 || data.client && (!object(data.client) || data.client.clientFamily !== "Retail")) return undefined;
  if (domain === "combat") {
    if (object(data.activeSpec) && data.activeSpec.specID !== undefined && !positiveID(data.activeSpec.specID)) return undefined;
    if (object(data.talentConfig) && data.talentConfig.configID !== undefined && !positiveID(data.talentConfig.configID)) return undefined;
    if (object(data.heroTalent) && data.heroTalent.subtreeID !== undefined && !positiveID(data.heroTalent.subtreeID)) return undefined;
  } else if (domain === "professions") {
    if (!Array.isArray(data.professions)) return undefined;
    for (const profession of data.professions) {
      if (!object(profession) || !positiveID(profession.baseSkillLineID)) return undefined;
      if (profession.tiers !== undefined && !Array.isArray(profession.tiers)) return undefined;
      for (const tier of (profession.tiers ?? []) as unknown[]) {
        if (!object(tier) || !positiveID(tier.skillLineID) || !positiveID(tier.configID) || !Array.isArray(tier.trees)) return undefined;
        for (const tree of tier.trees) {
          if (!object(tree) || !positiveID(tree.treeID) || tree.nodes !== undefined && !validArrayIDs(tree.nodes, "nodeID")) return undefined;
        }
      }
    }
  } else {
    if (data.factions !== undefined && !validArrayIDs(data.factions, "factionID")) return undefined;
    if (data.majorFactions !== undefined && !validArrayIDs(data.majorFactions, "majorFactionID")) return undefined;
  }
  const completeness = raw.completeness === "complete" || raw.completeness === "partial" ? raw.completeness : "unknown";
  return {
    status: { state: "OBSERVED", completeness, observedAt: raw.observedAt,
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}) },
    formatVersion: 1,
    observedAt: raw.observedAt,
    completeness,
    data: data as Record<string, unknown>,
  };
}

/** Validate the Retail-only SavedVariables sidecar and keep each domain separate. Invalid/missing data stays UNKNOWN. */
export function normalizeCharacterStateSidecar(input: unknown, version: VersionOrUnknown): CapturedCharacterState | undefined {
  if (version !== "retail" || !object(input) || input.formatVersion !== 1) return undefined;
  const clientFamily = input.clientFamily;
  if (clientFamily !== "Retail") return undefined;
  const reputationInput = object(input.reputation) ? input.reputation : undefined;
  const state: CapturedCharacterState = { formatVersion: 1, clientFamily: "Retail" };
  const combat = normalizeSection(input.combatSpecialization, "combat");
  const professions = normalizeSection(input.professionSpecializations, "professions");
  const characterRep = normalizeSection(reputationInput?.character, "reputation");
  const accountRep = normalizeSection(reputationInput?.account, "reputation");
  if (combat) state.combatSpecialization = combat;
  if (professions) state.professionSpecializations = professions;
  if (characterRep || accountRep) state.reputation = { ...(characterRep ? { character: characterRep } : {}), ...(accountRep ? { account: accountRep } : {}) };
  return Object.keys(state).length > 2 ? state : undefined;
}

const ENTITY_ID: Record<string, string> = {
  professions: "baseSkillLineID", tiers: "skillLineID", trees: "treeID", nodes: "nodeID", currencies: "currencyID",
  factions: "factionID", majorFactions: "majorFactionID",
};

function mergeRows(previous: unknown, current: unknown, observedAt: number | undefined): unknown {
  if (!object(previous) || !object(current)) return current;
  const result: Obj = { ...current };
  for (const [list, id] of Object.entries(ENTITY_ID)) {
    if (!Array.isArray(previous[list]) && !Array.isArray(current[list])) continue;
    const freshByID = new Map<number, Obj>();
    for (const row of (current[list] as unknown[] | undefined) ?? []) if (object(row) && positiveID(row[id])) freshByID.set(row[id] as number, row);
    const out: Obj[] = [];
    for (const old of (previous[list] as unknown[] | undefined) ?? []) {
      if (!object(old) || !positiveID(old[id])) continue;
      const fresh = freshByID.get(old[id] as number);
      if (fresh) {
        out.push(mergeRows(old, fresh, observedAt) as Obj);
        freshByID.delete(old[id] as number);
      } else {
        out.push({ ...old, evidence: "LAST_SEEN", lastSeenAt: observedAt });
      }
    }
    for (const row of (current[list] as unknown[] | undefined) ?? []) if (object(row) && positiveID(row[id]) && freshByID.has(row[id] as number)) out.push(row);
    result[list] = out;
  }
  for (const [key, value] of Object.entries(previous)) {
    if (result[key] === undefined) {
      result[key] = object(value) ? { ...value, evidence: "LAST_SEEN", lastSeenAt: observedAt } : value;
    } else if (!ENTITY_ID[key] && object(value) && object(result[key])) {
      result[key] = mergeRows(value, result[key], observedAt);
    }
  }
  return result;
}

/** Merge successive sidecars without interpreting omissions as erasure. */
export function mergeCharacterState(previous: CapturedCharacterState | undefined, current: CapturedCharacterState | undefined): CapturedCharacterState | undefined {
  if (!previous) return current;
  if (!current) {
    const last = structuredClone(previous);
    const mark = (domain: CapturedCharacterDomain | undefined) => {
      if (domain) { domain.status = { ...domain.status, state: "LAST_SEEN", reason: "Not present in this later capture; earlier observation retained." }; }
    };
    mark(last.combatSpecialization); mark(last.professionSpecializations); mark(last.reputation?.character); mark(last.reputation?.account);
    return last;
  }
  const result = structuredClone(current);
  const mergeDomain = <T>(old: CapturedCharacterDomain<T> | undefined, fresh: CapturedCharacterDomain<T> | undefined): CapturedCharacterDomain<T> | undefined => {
    if (!old) return fresh;
    if (!fresh?.data) return { ...old, status: { ...old.status, state: "LAST_SEEN", reason: "Not present in this later capture; earlier observation retained." } };
    return { ...fresh, data: mergeRows(old.data, fresh.data, old.observedAt) as T };
  };
  result.combatSpecialization = mergeDomain(previous.combatSpecialization, current.combatSpecialization);
  result.professionSpecializations = mergeDomain(previous.professionSpecializations, current.professionSpecializations);
  result.reputation = {
    ...(mergeDomain(previous.reputation?.character, current.reputation?.character) ? { character: mergeDomain(previous.reputation?.character, current.reputation?.character) } : {}),
    ...(mergeDomain(previous.reputation?.account, current.reputation?.account) ? { account: mergeDomain(previous.reputation?.account, current.reputation?.account) } : {}),
  };
  return result;
}

export interface LatestDomain<T> {
  observation: CapturedCharacterDomain<T>;
  snapshot: ParsedSnapshot;
  state: "OBSERVED" | "LAST_SEEN";
}

/** Prefer the newest usable observation; absence from a later export never erases it. */
export function latestCharacterDomain<T>(snapshots: readonly { parsed: ParsedSnapshot }[], select: (state: CapturedCharacterState) => CapturedCharacterDomain<T> | undefined): LatestDomain<T> | undefined {
  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i].parsed;
    const observation = snapshot.characterState && select(snapshot.characterState);
    if (!observation?.data) continue;
    if (i === 0 && observation.status.state !== "LAST_SEEN") return { observation, snapshot, state: "OBSERVED" };
    return { observation: { ...observation, status: { ...observation.status, state: "LAST_SEEN" } }, snapshot, state: "LAST_SEEN" };
  }
  return undefined;
}
