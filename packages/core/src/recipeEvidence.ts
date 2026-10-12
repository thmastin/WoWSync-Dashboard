/**
 * Per-fact recipe evidence resolution across one character's snapshot history.
 *
 * A newer snapshot without a structured recipe section does not erase older
 * positively observed recipe rows. The freshest compatible recipe observation
 * at or before the selected snapshot is used, labelled LAST_SEEN when it came
 * from an earlier snapshot. Compatibility is version-scoped: rows never cross
 * WoW versions, client versions, or character GUIDs.
 */

import type { StoredSnapshot } from "./store.ts";
import type { CapturedCharacterDomain, CapturedCharacterState, ParsedSnapshot, VersionOrUnknown } from "./types.ts";

type Row = Record<string, unknown>;

export type RecipeEvidenceState = "OBSERVED" | "LAST_SEEN" | "UNKNOWN";

export interface ExcludedRecipeScope {
  professionName?: string;
  baseSkillLineID?: number;
  reason: string;
}

export interface RecipeEvidenceResolution {
  state: RecipeEvidenceState;
  /** Selected snapshot that the caller asked about. */
  selectedSnapshotId?: number;
  /** Snapshot whose recipe section supplied the rows. */
  sourceSnapshotId?: number;
  sourceGeneratedAt?: number;
  observedAt?: number;
  clientProfile?: string;
  completeness: "partial" | "unknown";
  /** Recipe section with row evidence relabelled LAST_SEEN when carried forward. */
  section?: CapturedCharacterDomain;
  excludedScopes: ExcludedRecipeScope[];
  /** Newer snapshots skipped because they carried no compatible recipe section. */
  snapshotsWithoutRecipeSection: number;
  reason: string;
}

function record(value: unknown): Row | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined; }

/** Raw recipe section for one snapshot, using the version's established sidecar location. */
export function snapshotRecipeSection(version: VersionOrUnknown, snapshot: StoredSnapshot): CapturedCharacterDomain | undefined {
  if (version === "forever") return snapshot.parsed.foreverGearObservation?.professionRecipes as CapturedCharacterDomain | undefined;
  if (version === "retail") return snapshot.parsed.characterState?.professionRecipes;
  return undefined;
}

function clientKey(snapshot: StoredSnapshot): string {
  const c = snapshot.parsed.character;
  return `${c.clientFamily ?? "?"}:${c.clientVersion ?? "?"}`;
}

function guid(snapshot: StoredSnapshot): string | undefined {
  return snapshot.parsed.foreverGearObservation?.sourceCharacterGuid;
}

function profileOf(version: VersionOrUnknown, snapshot: StoredSnapshot): string {
  const c = snapshot.parsed.character;
  return snapshot.parsed.foreverGearObservation?.clientProfile ?? `${c.clientFamily ?? version}:${c.clientVersion ?? "unknown"}:${c.clientBuild ?? "unknown"}:${c.interface ?? "unknown"}`;
}

/**
 * Resolve recipe evidence for `selected` from `snapshots` (newest first, one
 * character, one version). Snapshots newer than `selected` are never used.
 */
export function resolveRecipeEvidence(version: VersionOrUnknown, snapshots: readonly StoredSnapshot[], selected: StoredSnapshot | undefined): RecipeEvidenceResolution {
  const base = { excludedScopes: [] as ExcludedRecipeScope[], snapshotsWithoutRecipeSection: 0, completeness: "unknown" as const };
  if (!selected) return { ...base, state: "UNKNOWN", reason: "No snapshot exists for this character." };
  if (version !== "forever" && version !== "retail") {
    return { ...base, state: "UNKNOWN", selectedSnapshotId: selected.id, reason: `Structured learned-recipe capture is not supported for ${version}; recipe knowledge is UNKNOWN, not empty.` };
  }
  const start = snapshots.findIndex((snapshot) => snapshot.id === selected.id);
  const history = start >= 0 ? snapshots.slice(start) : [selected];
  let skipped = 0;
  for (const source of history) {
    const section = snapshotRecipeSection(version, source);
    if (!section?.data) { skipped++; continue; }
    if (source.id !== selected.id) {
      if (version === "forever" && clientKey(source) !== clientKey(selected)) {
        return { ...base, state: "UNKNOWN", selectedSnapshotId: selected.id, snapshotsWithoutRecipeSection: skipped, reason: `The newest recipe observation (snapshot ${source.id}) was captured on client ${clientKey(source)}, not the selected snapshot's ${clientKey(selected)}; Forever recipe identities are not carried across client versions.` };
      }
      const a = guid(source); const b = guid(selected);
      if (a && b && a !== b) {
        return { ...base, state: "UNKNOWN", selectedSnapshotId: selected.id, snapshotsWithoutRecipeSection: skipped, reason: `The newest recipe observation (snapshot ${source.id}) belongs to character GUID ${a}, but the selected snapshot reports ${b}; a same-name character may have been recreated, so older recipes are not attributed to it.` };
      }
    }
    return materialize(version, selected, source, section, skipped);
  }
  return { ...base, state: "UNKNOWN", selectedSnapshotId: selected.id, snapshotsWithoutRecipeSection: skipped, reason: `No structured profession recipe section (${version === "forever" ? "Forever" : "Retail"}) exists in any of the ${skipped} snapshot(s) at or before snapshot ${selected.id}. The profession panel must be opened before capture; missing rows do not mean unlearned.` };
}

function materialize(version: VersionOrUnknown, selected: StoredSnapshot, source: StoredSnapshot, section: CapturedCharacterDomain, skipped: number): RecipeEvidenceResolution {
  const carried = source.id !== selected.id;
  const data = record(section.data)!;
  const excludedScopes: ExcludedRecipeScope[] = [];
  const professions = Array.isArray(data.professions) ? data.professions.map(record).filter((row): row is Row => !!row) : [];
  // A newer complete profession observation that no longer lists a profession
  // conflicts with older learned rows for that profession (it may have been
  // dropped). Those scopes are excluded rather than reported as known.
  const current = selected.parsed.professions;
  const currentNames = current.status.state === "OBSERVED" ? new Set(current.entries.map((entry) => entry.name.toLowerCase())) : undefined;
  const kept = professions.filter((scope) => {
    const name = typeof scope.professionName === "string" ? scope.professionName : typeof scope.name === "string" ? scope.name : undefined;
    // Retail scopes carry tier names ("Midnight Engineering"), so match by containment.
    if (carried && currentNames && currentNames.size > 0 && name && ![...currentNames].some((current) => name.toLowerCase().includes(current))) {
      excludedScopes.push({ professionName: name, ...(typeof scope.baseSkillLineID === "number" ? { baseSkillLineID: scope.baseSkillLineID } : {}), reason: `Snapshot ${selected.id} observed professions without ${name}; older recipe rows for it conflict with current evidence and are excluded.` });
      return false;
    }
    return true;
  });
  const relabel = (row: Row): Row => carried && row.evidence === "OBSERVED" ? { ...row, evidence: "LAST_SEEN" } : row;
  const rewritten = carried
    ? kept.map((scope) => ({ ...scope, ...(scope.evidence === "OBSERVED" ? { evidence: "LAST_SEEN" } : {}), recipes: Array.isArray(scope.recipes) ? scope.recipes.map(record).filter((row): row is Row => !!row).map(relabel) : scope.recipes }))
    : kept;
  const observedAt = section.observedAt ?? (typeof section.status?.observedAt === "number" ? section.status.observedAt : undefined);
  // An in-snapshot section keeps its own status (Retail import merges may
  // already have marked it LAST_SEEN); only carried sections are relabelled.
  const state: RecipeEvidenceState = carried || section.status?.state === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED";
  const outSection: CapturedCharacterDomain = carried
    ? { ...section, status: { ...section.status, state, ...(observedAt !== undefined ? { observedAt } : {}), reason: `Carried forward from snapshot ${source.id}; not a current observation.` } as CapturedCharacterDomain["status"], completeness: "partial", data: { ...data, professions: rewritten } }
    : excludedScopes.length ? { ...section, data: { ...data, professions: rewritten } } : section;
  return {
    state,
    selectedSnapshotId: selected.id,
    sourceSnapshotId: source.id,
    ...(source.generatedAt !== undefined ? { sourceGeneratedAt: source.generatedAt } : {}),
    ...(observedAt !== undefined ? { observedAt } : {}),
    clientProfile: profileOf(version, source),
    completeness: "partial",
    section: outSection,
    excludedScopes,
    snapshotsWithoutRecipeSection: skipped,
    reason: carried
      ? `Snapshot ${selected.id} has no structured recipe section; using the freshest compatible observation from snapshot ${source.id}. Learned rows are LAST_SEEN, not current, and candidate coverage remains partial.`
      : `Recipe rows were observed in snapshot ${selected.id}. Candidate coverage is partial; absence does not mean unlearned.`,
  };
}

/**
 * Latest-snapshot view whose recipe sidecar is the resolved (possibly
 * LAST_SEEN) section, for latest-only consumers such as account facts. The
 * stored snapshot is not modified.
 */
export function withResolvedRecipeSection(version: VersionOrUnknown, parsed: ParsedSnapshot, resolution: RecipeEvidenceResolution): ParsedSnapshot {
  if (!resolution.section) return parsed;
  if (version === "forever") return { ...parsed, foreverGearObservation: { ...(parsed.foreverGearObservation ?? {}), professionRecipes: resolution.section } as ParsedSnapshot["foreverGearObservation"] };
  if (version === "retail") return { ...parsed, characterState: { ...(parsed.characterState ?? { formatVersion: 1, clientFamily: "Retail" }), professionRecipes: resolution.section } as CapturedCharacterState };
  return parsed;
}
