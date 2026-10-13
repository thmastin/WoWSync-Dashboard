// Forever skill lines (weapon skills, armor proficiencies) from GearExport's raw C_SkillInfo capture
// (foreverGearObservation.itemEvidence.data.skillLines), and talents from the Forever talents section.
// Observations describe the character when the export was made; nothing is inferred beyond them.

export interface ForeverSkillLines {
  observedAt?: number;
  snapshotId: number;
  /** Category name ("Weapon Skills", "Armor Proficiencies", ...) to skills in it. */
  weapons: Map<string, { rank: number; maxRank: number }>;
  armor: Set<string>;
}

export interface ForeverTalents {
  observedAt?: number;
  snapshotId: number;
  completeness?: string;
  unspentPoints?: number;
  trees: Array<{ name: string; pointsSpent?: number; talents: Array<{ name: string; currentRank?: number; maxRank?: number; tier?: number }> }>;
}

type Loose = Record<string, unknown>;
const object = (value: unknown): Loose | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Loose : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : object(value) ? Object.values(value as Loose) : [];

export function extractForeverSkillLines(parsed: unknown, snapshotId: number): ForeverSkillLines | undefined {
  const evidence = object(object(object(parsed)?.foreverGearObservation)?.itemEvidence);
  const rows = list(object(evidence?.data)?.skillLines).map(object).filter((row): row is Loose => !!row && row.state === "OBSERVED_VALUE");
  if (!rows.length) return undefined;
  const weapons = new Map<string, { rank: number; maxRank: number }>();
  const armor = new Set<string>();
  let category = "";
  for (const row of rows) {
    if (row.isHeader === true) { category = String(row.name ?? ""); continue; }
    if (typeof row.name !== "string") continue;
    if (category === "Weapon Skills" && typeof row.rank === "number") weapons.set(row.name, { rank: row.rank, maxRank: typeof row.maxRank === "number" ? row.maxRank : row.rank });
    if (category === "Armor Proficiencies") armor.add(row.name);
  }
  if (!weapons.size && !armor.size) return undefined;
  return { observedAt: typeof evidence?.observedAt === "number" ? evidence.observedAt : undefined, snapshotId, weapons, armor };
}

export function extractForeverTalents(parsed: unknown, snapshotId: number): ForeverTalents | undefined {
  const section = object(object(object(parsed)?.foreverGearObservation)?.talents);
  const data = object(section?.data);
  const trees = list(data?.trees).map(object).filter((tree): tree is Loose => !!tree && typeof tree.name === "string");
  if (!section || !trees.length) return undefined;
  return {
    observedAt: typeof section.observedAt === "number" ? section.observedAt : undefined,
    snapshotId,
    completeness: typeof section.completeness === "string" ? section.completeness : undefined,
    unspentPoints: typeof data?.unspentPoints === "number" ? data.unspentPoints : undefined,
    trees: trees.map((tree) => ({
      name: String(tree.name),
      pointsSpent: typeof tree.pointsSpent === "number" ? tree.pointsSpent : undefined,
      talents: list(tree.talents).map(object).filter((talent): talent is Loose => !!talent && typeof talent.name === "string").map((talent) => ({ name: String(talent.name), currentRank: typeof talent.currentRank === "number" ? talent.currentRank : undefined, maxRank: typeof talent.maxRank === "number" ? talent.maxRank : undefined, tier: typeof talent.tier === "number" ? talent.tier : undefined })),
    })),
  };
}

/** Skill line a weapon or armor item needs, from its Forever tooltip slot and subtype. */
export function requiredSkillFor(slot: string | undefined, subtype: string | undefined): { kind: "weapon" | "armor"; name: string } | undefined {
  if (!subtype) return undefined;
  if (["Cloth", "Leather", "Mail", "Plate"].includes(subtype)) return { kind: "armor", name: subtype };
  if (subtype === "Shield") return { kind: "armor", name: "Shield" };
  const twoHand = slot === "Two-Hand";
  const names: Record<string, [string, string?]> = { Axe: ["Axes", "Two-Handed Axes"], Mace: ["Maces", "Two-Handed Maces"], Sword: ["Swords", "Two-Handed Swords"], Staff: ["Staves", "Staves"], Dagger: ["Daggers"], Polearm: ["Polearms", "Polearms"], "Fist Weapon": ["Fist Weapons"], Bow: ["Bows"], Gun: ["Guns"], Crossbow: ["Crossbows"], Wand: ["Wands"], Thrown: ["Thrown"] };
  const entry = names[subtype];
  if (!entry) return undefined;
  return { kind: "weapon", name: twoHand && entry[1] ? entry[1] : entry[0] };
}
