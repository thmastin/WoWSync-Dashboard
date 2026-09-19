// Pure logic behind the "delete character" confirmation, kept free of React
// so it can be unit-tested directly (packages/web/test). The modal renders
// exactly what this returns; it never decides on its own whether a delete
// is allowed.
//
// Deletion is permanent and takes the character's whole snapshot history
// with it, so it is deliberately not a one-click action: the user must type
// the character's exact name before the destructive button enables (and
// the server independently requires a matching confirmIdentityKey).

export interface DeleteTarget {
  identityKey: string;
  name: string;
  realm: string;
  /** Human-readable version label, e.g. "Forever" - never the raw key. */
  versionLabel: string;
  snapshotCount: number;
}

/** The text the user must type, exactly, to enable deletion. */
export function requiredConfirmationText(target: DeleteTarget): string {
  return target.name;
}

/**
 * True only when `typed` is exactly the character's name. Case-sensitive and
 * exact (only surrounding whitespace, e.g. from pasting, is ignored) - a
 * near-miss must never enable a permanent delete. An empty character name
 * can never be confirmed.
 */
export function isDeleteConfirmed(typed: string, target: DeleteTarget): boolean {
  const required = requiredConfirmationText(target);
  return required.length > 0 && typed.trim() === required;
}

/** Plain-language lines stating exactly what will be removed. */
export function describeDeletion(target: DeleteTarget): string[] {
  const snapshots = `${target.snapshotCount} stored snapshot${target.snapshotCount === 1 ? "" : "s"}`;
  return [
    `Character: ${target.name}`,
    `Realm: ${target.realm}`,
    `Version: ${target.versionLabel}`,
    `This permanently deletes the character and its ${snapshots} (its entire imported history) from this dashboard's local database.`,
    "It can't be undone. Other characters, realms, and versions are not affected. You can re-import a fresh export later, but it will start a new history.",
  ];
}
