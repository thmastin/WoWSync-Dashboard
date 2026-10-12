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
import type { ParsedSnapshot, SectionStatus, VersionOrUnknown } from "./types.ts";

export const CARRIED_SECTIONS = ["equipment", "bags", "bank", "professions"] as const;
export type CarriedSection = typeof CARRIED_SECTIONS[number];

function newestFirst(a: StoredSnapshot, b: StoredSnapshot): number {
  return snapshotObservedAt(b.generatedAt, b.importedAt) - snapshotObservedAt(a.generatedAt, a.importedAt) || b.id - a.id;
}

function compatible(version: VersionOrUnknown, source: StoredSnapshot, selected: StoredSnapshot): boolean {
  if (version === "forever" && source.parsed.character.clientVersion !== selected.parsed.character.clientVersion) return false;
  const a = source.parsed.foreverGearObservation?.sourceCharacterGuid;
  const b = selected.parsed.foreverGearObservation?.sourceCharacterGuid;
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
    parsed = { ...parsed, [key]: { ...section, status } };
  }
  if (options.recipes && (version === "forever" || version === "retail") && !snapshotRecipeSection(version, selected)) {
    parsed = withResolvedRecipeSection(version, parsed, resolveRecipeEvidence(version, snapshots, selected));
  }
  return parsed === selected.parsed ? selected : { ...selected, parsed };
}
