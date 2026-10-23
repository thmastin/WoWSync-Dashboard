export interface ForeverSnapshotIdentityEvidence {
  sourceCharacterGuid?: string;
  sourceCharacterGuidConflict?: boolean;
}

/** Observations are newest-first. Resolve the current source from its GUID and require all other present GUIDs to agree. */
export function foreverSnapshotIdentityIssue(observations: readonly (ForeverSnapshotIdentityEvidence | undefined)[]): string | undefined {
  if (observations.some((observation) => observation?.sourceCharacterGuidConflict)) return "A Forever snapshot contains a WoWSyncDB character GUID conflict marker; inventory is withheld to avoid mixing source characters.";
  const latestGuid = observations[0]?.sourceCharacterGuid;
  if (!latestGuid) return "The latest Forever snapshot has no WoWSyncDB character GUID; current-source inventory is unresolved.";
  const guids = new Set(observations.map((observation) => observation?.sourceCharacterGuid).filter((guid): guid is string => !!guid));
  if (guids.size > 1) return "Forever snapshot history contains differing WoWSyncDB character GUIDs; inventory is withheld to avoid mixing source characters.";
  return undefined;
}
