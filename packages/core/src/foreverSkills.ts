// Forever skill lines (weapon skills, armor proficiencies) from GearExport's raw C_SkillInfo capture
// (foreverGearObservation.itemEvidence.data.skillLines), and talents from the Forever talents section.
// Observations describe the character when the export was made; nothing is inferred beyond them.
import type { CapturedCharacterDomain } from "./types.ts";

export interface ForeverSkillLines {
  observedAt?: number;
  snapshotId: number;
  /** Category name ("Weapon Skills", "Armor Proficiencies", ...) to skills in it. */
  weapons: Map<string, { rank: number; maxRank: number }>;
  armor: Set<string>;
}

export interface ForeverTalent {
  name: string;
  currentRank?: number;
  maxRank?: number;
  /** DERIVED: row in the tree from the node's vertical position (1 = top). */
  tier?: number;
  /** DERIVED: column from the node's horizontal position (1 = left). */
  column?: number;
  spellID?: number;
  nodeID?: number;
  /** Client-reported now (as of the export): the node is reachable / a rank can be bought. */
  isAvailable?: boolean;
  canPurchaseRank?: boolean;
  /** DERIVED from other nodes' edges: talents that must be taken first. */
  requires?: string[];
  /** Points that must be spent in the tree first (client condition). */
  pointsInTreeRequired?: number;
}

export interface ForeverTalents {
  observedAt?: number;
  snapshotId: number;
  completeness?: string;
  source?: string;
  unspentPoints?: number;
  specialization?: { id?: number; name?: string };
  trees: Array<{ name: string; pointsSpent?: number; talents: ForeverTalent[] }>;
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
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const bool = (value: unknown) => typeof value === "boolean" ? value : undefined;
  const spec = object(data?.specialization);
  return {
    observedAt: typeof section.observedAt === "number" ? section.observedAt : undefined,
    snapshotId,
    completeness: typeof section.completeness === "string" ? section.completeness : undefined,
    source: typeof data?.source === "string" ? data.source : undefined,
    unspentPoints: num(data?.unspentPoints),
    ...(spec ? { specialization: { id: num(spec.id), name: typeof spec.name === "string" ? spec.name : undefined } } : {}),
    trees: trees.map((tree) => {
      const raw = list(tree.talents).map(object).filter((talent): talent is Loose => !!talent && typeof talent.name === "string");
      // Trait trees (Forever) carry positions, not tiers: rows and columns are derived from distinct positions.
      const rank = (values: number[]) => { const sorted = [...new Set(values)].sort((a, b) => a - b); return (value: number | undefined) => value === undefined ? undefined : sorted.indexOf(value) + 1; };
      const rowOf = rank(raw.flatMap((talent) => num(talent.posY) ?? []));
      const columnOf = rank(raw.flatMap((talent) => num(talent.posX) ?? []));
      const nameByNode = new Map(raw.flatMap((talent) => num(talent.nodeID) !== undefined ? [[num(talent.nodeID)!, String(talent.name)] as const] : []));
      const requires = new Map<number, string[]>();
      for (const talent of raw) for (const target of list(talent.unlocksNodeIDs)) if (typeof target === "number") requires.set(target, [...(requires.get(target) ?? []), String(talent.name)]);
      return {
        name: String(tree.name),
        pointsSpent: num(tree.pointsSpent),
        talents: raw.map((talent): ForeverTalent => {
          const nodeID = num(talent.nodeID);
          const gate = list(talent.conditions).map(object).flatMap((condition) => num(condition?.spentAmountRequired) ?? []);
          return {
            name: String(talent.name),
            currentRank: num(talent.currentRank),
            maxRank: num(talent.maxRank),
            tier: num(talent.tier) ?? rowOf(num(talent.posY)),
            column: num(talent.column) ?? columnOf(num(talent.posX)),
            ...(num(talent.spellID) !== undefined ? { spellID: num(talent.spellID) } : {}),
            ...(nodeID !== undefined ? { nodeID } : {}),
            ...(bool(talent.isAvailable) !== undefined ? { isAvailable: bool(talent.isAvailable) } : {}),
            ...(bool(talent.canPurchaseRank) !== undefined ? { canPurchaseRank: bool(talent.canPurchaseRank) } : {}),
            ...(nodeID !== undefined && requires.has(nodeID) ? { requires: requires.get(nodeID)!.filter((name) => name !== nameByNode.get(nodeID)) } : {}),
            ...(gate.length ? { pointsInTreeRequired: Math.max(...gate) } : {}),
          };
        }),
      };
    }),
  };
}

export interface ForeverClassSpells {
  observedAt?: number;
  snapshotId: number;
  /** Abilities the spellbook lists as not yet learned, with the level the client reports. */
  entries: Array<{ spellID: number; name: string; levelLearned?: number; skillLineName?: string }>;
}

/** Forever spellbook future entries (GearExport classSpellCatalog). Undefined when not captured or unsupported. */
export function extractForeverClassSpells(parsed: unknown, snapshotId: number): ForeverClassSpells | undefined {
  const section = object(object(object(parsed)?.foreverGearObservation)?.classSpellCatalog);
  const data = object(section?.data);
  if (!section || !data || data.futureSpellType !== "OBSERVED") return undefined;
  const entries = list(data.entries).map(object).flatMap((row) => row && typeof row.spellID === "number" && typeof row.name === "string"
    ? [{ spellID: row.spellID, name: row.name, ...(typeof row.levelLearned === "number" ? { levelLearned: row.levelLearned } : {}), ...(typeof row.skillLineName === "string" ? { skillLineName: row.skillLineName } : {}) }] : []);
  // An empty list is not "nothing left to learn": the Forever 1.60.1 spellbook lists no unlearned abilities at all
  // (observed on Bramm, 2026-10-13), so an empty capture carries no information.
  if (!entries.length) return undefined;
  return { observedAt: typeof section.observedAt === "number" ? section.observedAt : undefined, snapshotId, entries };
}

/** Forever reputation section as a captured domain, so the Classic visible-row view can present it. */
export function extractForeverReputationDomain(parsed: unknown): { domain: CapturedCharacterDomain; snapshotObservedAt?: number } | undefined {
  const section = object(object(object(parsed)?.foreverGearObservation)?.reputation);
  const data = object(section?.data);
  if (!section || !data || data.factions === undefined) return undefined;
  const observedAt = typeof section.observedAt === "number" ? section.observedAt : undefined;
  const failed = typeof section.lastAttemptError === "string";
  return {
    domain: {
      status: { state: failed ? "LAST_SEEN" : "OBSERVED", ...(failed ? { reason: `Latest refresh failed: ${section.lastAttemptError}` } : {}) } as CapturedCharacterDomain["status"],
      ...(observedAt !== undefined ? { observedAt } : {}),
      completeness: section.completeness === "complete" || section.completeness === "partial" ? section.completeness : "unknown",
      data: { ...data, factions: list(data.factions) },
    },
    snapshotObservedAt: observedAt,
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
