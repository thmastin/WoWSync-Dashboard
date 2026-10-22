/**
 * Per-section evidence resolution for one character's latest (or selected)
 * snapshot.
 *
 * An export that did not observe a character-owned section (bank not opened,
 * profession list not read, partial capture) records it as UNKNOWN. That must
 * not erase an earlier observation: the view built here carries the freshest
 * earlier OBSERVED/LAST_SEEN section forward, relabelled LAST_SEEN with its
 * source snapshot. Nothing is carried across client versions (Forever) or
 * differing character GUIDs, and nothing newer than the selected snapshot is
 * used. Stored snapshots are never modified.
 */

import { snapshotObservedAt } from "./chronology.ts";
import { resolveRecipeEvidence, snapshotRecipeSection, withResolvedRecipeSection } from "./recipeEvidence.ts";
import type { StoredSnapshot } from "./store.ts";
import type { CapturedCharacterDomain, CapturedCharacterState, ParsedSnapshot, SectionStatus, VersionOrUnknown } from "./types.ts";

export const CARRIED_SECTIONS = ["equipment", "bags", "bank", "professions", "trainer"] as const;
export type CarriedSection = typeof CARRIED_SECTIONS[number];

function newestFirst(a: StoredSnapshot, b: StoredSnapshot): number {
  return snapshotObservedAt(b.generatedAt, b.importedAt) - snapshotObservedAt(a.generatedAt, a.importedAt) || b.id - a.id;
}

/** WoWSyncDB record GUID behind a snapshot's structured sidecars, when one was sent. */
export function snapshotSourceGuid(snapshot: StoredSnapshot): string | undefined {
  return snapshot.parsed.foreverGearObservation?.sourceCharacterGuid ?? snapshot.parsed.characterState?.sourceCharacterGuid;
}

function compatible(version: VersionOrUnknown, source: StoredSnapshot, selected: StoredSnapshot): boolean {
  if (version === "forever" && source.parsed.character.clientVersion !== selected.parsed.character.clientVersion) return false;
  const a = snapshotSourceGuid(source);
  const b = snapshotSourceGuid(selected);
  return !(a && b && a !== b);
}

/**
 * The selected snapshot with UNKNOWN character-owned sections replaced by the
 * freshest compatible earlier observation (LAST_SEEN). Optionally also
 * resolves the recipe sidecar for latest-only consumers.
 */
export function resolveSnapshotView(version: VersionOrUnknown, snapshots: readonly StoredSnapshot[], selected: StoredSnapshot, options: { recipes?: boolean } = {}): StoredSnapshot {
  const ordered = [...snapshots].sort(newestFirst);
  const start = ordered.findIndex((snapshot) => snapshot.id === selected.id);
  const older = start >= 0 ? ordered.slice(start + 1) : [];
  let parsed: ParsedSnapshot = selected.parsed;
  for (const key of CARRIED_SECTIONS) {
    if (parsed[key].status.state !== "UNKNOWN") continue;
    const source = older.find((snapshot) => snapshot.parsed[key].status.state !== "UNKNOWN" && compatible(version, snapshot, selected));
    if (!source) continue;
    const section = source.parsed[key];
    const status: SectionStatus = { ...section.status, state: "LAST_SEEN", carriedFromSnapshotId: source.id, reason: `Not observed in snapshot ${selected.id}; carried forward from snapshot ${source.id}. Historical, not current.` };
    // Trainer categories carry their own visit status; relabel them too.
    const carried = key === "trainer"
      ? { ...section, status, categories: source.parsed.trainer.categories.map((category) => ({ ...category, status: { ...category.status, state: category.status.state === "UNKNOWN" ? "UNKNOWN" as const : "LAST_SEEN" as const, carriedFromSnapshotId: source.id } })) }
      : { ...section, status };
    parsed = { ...parsed, [key]: carried };
  }
  if (version === "retail") parsed = carryRetailState(parsed, older, selected.id);
  if (version === "classic-era" || version === "tbc-anniversary") parsed = carryClassicState(parsed, older.filter((snapshot) => compatible(version, snapshot, selected)), selected.id);
  if (options.recipes && (version === "forever" || version === "retail" || version === "classic-era" || version === "tbc-anniversary") && !snapshotRecipeSection(version, selected)) {
    parsed = withResolvedRecipeSection(version, parsed, resolveRecipeEvidence(version, snapshots, selected));
  }
  return parsed === selected.parsed ? selected : { ...selected, parsed };
}

const lastSeen = (domain: CapturedCharacterDomain, sourceId: number, selectedId: number): CapturedCharacterDomain => ({
  ...domain,
  status: { ...domain.status, state: "LAST_SEEN", carriedFromSnapshotId: sourceId, reason: `Not captured in snapshot ${selectedId}; carried forward from snapshot ${sourceId}. Historical, not current.` },
});

/**
 * Retail SavedVariables state domains (specializations, reputation) carried
 * forward when a newer import lacks them (e.g. a text-only import). Recipes
 * are handled by recipeEvidence.ts.
 */
function carryRetailState(parsed: ParsedSnapshot, older: readonly StoredSnapshot[], selectedId: number): ParsedSnapshot {
  const current: CapturedCharacterState = parsed.characterState ?? { formatVersion: 1, clientFamily: "Retail" };
  let next = current;
  for (const key of ["combatSpecialization", "professionSpecializations"] as const) {
    if (next[key]) continue;
    const source = older.find((snapshot) => snapshot.parsed.characterState?.[key]);
    if (source) next = { ...next, [key]: lastSeen(source.parsed.characterState![key]!, source.id, selectedId) };
  }
  for (const scope of ["character", "account"] as const) {
    if (next.reputation?.[scope]) continue;
    const source = older.find((snapshot) => snapshot.parsed.characterState?.reputation?.[scope]);
    if (source) next = { ...next, reputation: { ...next.reputation, [scope]: lastSeen(source.parsed.characterState!.reputation![scope]!, source.id, selectedId) } };
  }
  return next === current ? parsed : { ...parsed, characterState: next };
}

/**
 * Classic Era / TBC legacy-UI domains (quests, visible reputation, talents)
 * carried forward when a newer export lacks them, labelled LAST_SEEN. Only
 * Classic-family sidecars from GUID-compatible snapshots are used. Recipes are
 * handled by recipeEvidence.ts.
 */
function carryClassicState(parsed: ParsedSnapshot, older: readonly StoredSnapshot[], selectedId: number): ParsedSnapshot {
  const current: CapturedCharacterState = parsed.characterState ?? { formatVersion: 1, clientFamily: "Classic" };
  if (current.clientFamily !== "Classic") return parsed;
  const classic = older.filter((snapshot) => snapshot.parsed.characterState?.clientFamily === "Classic");
  let next = current;
  for (const key of ["quests", "talents"] as const) {
    if (next[key]) continue;
    const source = classic.find((snapshot) => snapshot.parsed.characterState?.[key]);
    if (source) next = { ...next, [key]: lastSeen(source.parsed.characterState![key]!, source.id, selectedId) };
  }
  if (!next.reputation?.character) {
    const source = classic.find((snapshot) => snapshot.parsed.characterState?.reputation?.character);
    if (source) next = { ...next, reputation: { character: lastSeen(source.parsed.characterState!.reputation!.character!, source.id, selectedId) } };
  }
  return next === current ? parsed : { ...parsed, characterState: next };
}
