export interface ForeverSpecTree { name: string; pointsSpent?: number }
export const FOREVER_SPEC_NEAR_EVEN_POINTS = 1;

export function deriveForeverSpec(trees: readonly ForeverSpecTree[] | undefined, level: number | undefined): string {
  if (level === undefined || level < 10 || !trees?.length || trees.some((tree) => tree.pointsSpent === undefined)) return "UNDETERMINED";
  const ranked = [...trees].sort((a, b) => b.pointsSpent! - a.pointsSpent!);
  const top = ranked[0]!, second = ranked[1];
  return second && top.pointsSpent! - second.pointsSpent! <= FOREVER_SPEC_NEAR_EVEN_POINTS ? "UNDETERMINED" : top.name;
}

export function foreverSpecProjection(derived: string, planned?: string) {
  return {
    derived: { value: derived, provenance: "DERIVED" as const, rule: "Tree with the most pointsSpent; UNDETERMINED below level 10, without complete talent point data, or when the leading trees differ by at most 1 point." },
    planned: planned ? { value: planned, provenance: "USER_CONFIGURED" as const } : { value: "UNKNOWN", provenance: "UNKNOWN" as const },
    display: planned ?? derived,
  };
}
