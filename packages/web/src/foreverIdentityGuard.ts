export interface ForeverSnapshotIdentityEvidence {
  sourceCharacterGuid?: string;
  sourceCharacterGuidConflict?: boolean;
}

/** Every retained snapshot for one Dashboard identity must resolve to the same WoWSyncDB GUID. */
export function foreverSnapshotIdentityIssue(observations: readonly (ForeverSnapshotIdentityEvidence | undefined)[]): string | undefined {
  if (observations.length === 0 || observations.some((observation) => !observation?.sourceCharacterGuid)) {
    return "This Dashboard character history contains snapshots without a WoWSyncDB character GUID; source-character identity cannot be confirmed.";
  }
  const guids = new Set(observations.map((observation) => observation!.sourceCharacterGuid));
  if (observations.some((observation) => observation?.sourceCharacterGuidConflict)) return "Conflicting WoWSyncDB character GUIDs were recorded for this Dashboard snapshot; inventory is withheld to avoid mixing source characters.";
  if (guids.size > 1) return "Multiple WoWSyncDB character GUIDs share this Dashboard version/realm/name identity; inventory is withheld to avoid mixing source characters.";
  return undefined;
}
