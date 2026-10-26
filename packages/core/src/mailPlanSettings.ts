import type { StoredCharacterSummary } from "./store.ts";
import type { WowVersion } from "./types.ts";

export type MailSettingsVersion = "classic-era" | "forever";
export interface MailPlanSettingsScope {
  /** A user-chosen local account label. Dashboard exports do not prove WoW account membership. */
  accountId: string;
  version: MailSettingsVersion;
  realm: string;
  faction: "Alliance" | "Horde";
}
export interface MailPlanSettings extends MailPlanSettingsScope {
  auctionCharacterIdentityKey?: string;
  mainCharacterIdentityKey?: string;
  plannedProfessionsByCharacter?: Record<string, string[]>;
  updatedAt: number;
  provenance: "USER_CONFIGURED";
}
export interface MailPlanSettingsInput extends MailPlanSettingsScope {
  auctionCharacterIdentityKey?: string;
  mainCharacterIdentityKey?: string;
  plannedProfessionsByCharacter?: Record<string, string[]>;
}

export class MailSettingsValidationError extends Error {
  constructor(message: string) { super(message); this.name = "MailSettingsValidationError"; }
}

export function validateMailSettingsScope(value: unknown): MailPlanSettingsScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MailSettingsValidationError("Settings scope must be an object.");
  const row = value as Record<string, unknown>;
  if (row.version !== "classic-era" && row.version !== "forever") throw new MailSettingsValidationError("Settings version must be classic-era or forever.");
  if (typeof row.accountId !== "string" || row.accountId.trim() !== row.accountId || !/^[A-Za-z0-9._:-]{1,80}$/.test(row.accountId)) throw new MailSettingsValidationError("accountId must be a stable 1–80 character label using letters, digits, dot, underscore, colon, or hyphen.");
  if (typeof row.realm !== "string" || row.realm.trim() !== row.realm || row.realm.length < 1 || row.realm.length > 100) throw new MailSettingsValidationError("realm must be a non-empty exact realm name.");
  if (row.faction !== "Alliance" && row.faction !== "Horde") throw new MailSettingsValidationError("faction must be Alliance or Horde.");
  return { accountId: row.accountId, version: row.version, realm: row.realm, faction: row.faction };
}

export function validateMailPlanSettingsInput(value: unknown, roster: readonly StoredCharacterSummary[], now = Math.floor(Date.now() / 1000)): MailPlanSettings {
  const scope = validateMailSettingsScope(value);
  const row = value as Record<string, unknown>;
  const selected: Record<string, string> = {};
  for (const field of ["auctionCharacterIdentityKey", "mainCharacterIdentityKey"] as const) {
    const key = row[field];
    if (key === undefined || key === null || key === "") continue;
    if (typeof key !== "string" || key.trim() !== key || key.length > 512) throw new MailSettingsValidationError(field + " must be an exact identityKey.");
    const character = roster.find((candidate) => candidate.identityKey === key);
    if (!character || character.version !== scope.version || character.realm !== scope.realm || character.faction !== scope.faction) {
      throw new MailSettingsValidationError(field + " must identify a currently listed character in the same version, realm, and known faction scope.");
    }
    selected[field] = key;
  }
  const planned: Record<string, string[]> = {};
  if (row.plannedProfessionsByCharacter !== undefined) {
    if (!row.plannedProfessionsByCharacter || typeof row.plannedProfessionsByCharacter !== "object" || Array.isArray(row.plannedProfessionsByCharacter)) throw new MailSettingsValidationError("plannedProfessionsByCharacter must map character identity keys to profession-name arrays.");
    for (const [key, values] of Object.entries(row.plannedProfessionsByCharacter as Record<string, unknown>)) {
      const character = roster.find((candidate) => candidate.identityKey === key);
      if (!character || character.version !== scope.version || character.realm !== scope.realm || character.faction !== scope.faction) throw new MailSettingsValidationError("Planned profession character must match the settings version, realm, and faction.");
      if (!Array.isArray(values) || values.length > 20 || values.some((profession) => typeof profession !== "string" || profession.trim() !== profession || profession.length < 2 || profession.length > 40)) throw new MailSettingsValidationError("Each planned profession must be a non-empty profession name.");
      planned[key] = [...new Set(values as string[])];
    }
  }
  return { ...scope, ...selected, ...(Object.keys(planned).length ? { plannedProfessionsByCharacter: planned } : {}), updatedAt: now, provenance: "USER_CONFIGURED" };
}

const PLANNED_MATERIAL_PROFESSIONS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  2589: ["Tailoring", "First Aid"], 2592: ["Tailoring", "First Aid"], 4306: ["Tailoring", "First Aid"], 4338: ["Tailoring", "First Aid"], 14047: ["Tailoring", "First Aid"],
});

export function plannedProfessionForMaterial(itemId: number | undefined, name: string | undefined, plannedProfessions: readonly string[] = []): string | undefined {
  const planned = new Set(plannedProfessions.map((value) => value.toLocaleLowerCase()));
  const matches = itemId === undefined ? undefined : PLANNED_MATERIAL_PROFESSIONS[itemId];
  const byName = name && /\b(linen|wool|silk|mageweave|runecloth) cloth\b/i.test(name) ? ["Tailoring", "First Aid"] : undefined;
  return [...(matches ?? byName ?? [])].find((profession) => planned.has(profession.toLocaleLowerCase()));
}

export function resolveMailSettingsCharacter(key: string | undefined, scope: MailPlanSettingsScope, roster: readonly StoredCharacterSummary[]): { state: "ELIGIBLE"; character: StoredCharacterSummary } | { state: "UNDETERMINED"; reason: string } {
  if (!key) return { state: "UNDETERMINED", reason: "No character is configured for this settings scope." };
  const character = roster.find((candidate) => candidate.identityKey === key);
  if (!character) return { state: "UNDETERMINED", reason: "Configured character is no longer present in the Dashboard roster." };
  if (character.version !== scope.version || character.realm !== scope.realm || character.faction !== scope.faction) return { state: "UNDETERMINED", reason: "Configured character does not match the version, realm, and faction scope." };
  return { state: "ELIGIBLE", character };
}

export interface CrafterCandidate {
  identityKey: string;
  name: string;
  profession: string;
  skill?: number;
  skillState: "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
}

export function selectCrafterByObservedSkill(candidates: readonly CrafterCandidate[], mainCharacterIdentityKey?: string):
  | { state: "SELECTED"; candidate: CrafterCandidate; reason: string }
  | { state: "UNDETERMINED"; candidates: Array<Pick<CrafterCandidate, "identityKey" | "name" | "profession" | "skill">>; reason: string } {
  const usable = candidates.filter((candidate) => candidate.skillState === "OBSERVED" && Number.isSafeInteger(candidate.skill) && candidate.skill! >= 0);
  if (usable.length === 0) return { state: "UNDETERMINED", candidates: candidates.map(({ identityKey, name, profession, skill }) => ({ identityKey, name, profession, ...(skill !== undefined ? { skill } : {}) })), reason: "No candidate has a usable OBSERVED profession skill." };
  const highest = Math.max(...usable.map((candidate) => candidate.skill!));
  const tied = usable.filter((candidate) => candidate.skill === highest);
  if (tied.length === 1) return { state: "SELECTED", candidate: tied[0]!, reason: "Selected the candidate with the highest OBSERVED " + tied[0]!.profession + " skill (" + highest + ")." };
  const main = tied.find((candidate) => candidate.identityKey === mainCharacterIdentityKey);
  if (main) return { state: "SELECTED", candidate: main, reason: "Main character setting broke an exact OBSERVED skill tie at " + highest + "." };
  return { state: "UNDETERMINED", candidates: tied.map(({ identityKey, name, profession, skill }) => ({ identityKey, name, profession, skill })), reason: "Candidates are tied at the highest OBSERVED skill (" + highest + "); configure one tied character as main to break the exact tie." };
}

export function isMailSettingsVersion(version: WowVersion | "unknown-version"): version is MailSettingsVersion {
  return version === "classic-era" || version === "forever";
}
