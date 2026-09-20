// What an import result means for the person who just pasted an export - decided
// here (pure, tested) rather than inline in the modal.
//
//   duplicate - this exact export was already stored; nothing changed.
//   first     - the character had no snapshots before.
//   older     - an older observation than one already stored: added to history,
//               the character's current state is unchanged.
//   normal    - a new latest snapshot with an earlier one to compare against.
//
// The flags are only trusted when the server actually sent them: a newer web
// build served by an OLDER server (which knows nothing of isDuplicate/isLatest)
// must behave like a normal import, not claim "older observation" because a
// missing flag happens to be falsy.
import type { ImportResult, SnapshotDiff } from "./types.ts";

export type ImportKind = "duplicate" | "first" | "older" | "normal";

export function classifyImport(result: Pick<ImportResult, "isFirstSnapshot"> & { isDuplicate?: boolean; isLatest?: boolean }): ImportKind {
  if (result.isDuplicate === true) return "duplicate";
  if (result.isFirstSnapshot) return "first";
  if (result.isLatest === false) return "older";
  return "normal";
}

/**
 * True when the diff contains ANY change the import summary lists. Must cover every
 * dimension the summary can show (level, XP, gold, /played, location, professions,
 * equipment, bags, bank, trainer unlocks) - otherwise "No changes detected." is printed
 * right below a list of changes.
 */
export function hasAnyChange(diff: SnapshotDiff): boolean {
  return Boolean(
    diff.level.delta ||
      diff.xp.delta ||
      diff.moneyCopper.delta ||
      diff.playedSeconds.delta ||
      diff.location.changed ||
      diff.professions.length > 0 ||
      diff.equipment.length > 0 ||
      diff.bagsItems.length > 0 ||
      diff.bankItems.length > 0 ||
      diff.trainerUnlocks.length > 0,
  );
}
