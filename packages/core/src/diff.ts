// Deterministic diff engine. Produces facts, not interpretation — this is
// the layer an LLM should be handed, never asked to recompute arithmetic
// itself. A delta is only reported when both sides of the comparison are
// actually known; unknown values never get treated as zero.

import type { InventoryItemRecord, InventorySection, ParsedSnapshot, TrainerSection } from "./types.ts";

export interface NumericDelta {
  from?: number;
  to?: number;
  delta?: number;
}

export interface ProfessionDelta {
  name: string;
  skill: NumericDelta;
  maxSkill: NumericDelta;
}

export interface ItemDelta {
  itemRef?: string;
  name?: string;
  fromQty: number;
  toQty: number;
  deltaQty: number;
}

export interface EquipmentDelta {
  slot: number;
  slotName: string;
  from?: string;
  to?: string;
}

export interface LocationDelta {
  fromZone?: string;
  toZone?: string;
  fromSubzone?: string;
  toSubzone?: string;
  changed: boolean;
}

export interface TrainerUnlock {
  category: string;
  ability?: string;
  rank?: string;
}

export interface CharacterStateChange {
  domain: "combat-specialization" | "profession-node-rank" | "reputation-standing" | "major-faction-renown";
  identity: Record<string, number | string>;
  from?: number | string;
  to?: number | string;
  delta?: number;
  evidence: "DERIVED";
}

export interface SnapshotDiff {
  fromGeneratedAt?: number;
  toGeneratedAt?: number;
  level: NumericDelta;
  xp: NumericDelta;
  xpMax: NumericDelta;
  moneyCopper: NumericDelta;
  playedSeconds: NumericDelta;
  levelPlayedSeconds: NumericDelta;
  location: LocationDelta;
  professions: ProfessionDelta[];
  bagsItems: ItemDelta[];
  bankItems: ItemDelta[];
  equipment: EquipmentDelta[];
  /** Abilities that moved to statusAtVisit "available" since the previous snapshot, per trainer category. Not an elaborate history feature — just the one fact worth surfacing. */
  trainerUnlocks: TrainerUnlock[];
  /** Only compatible, observed values on both snapshots; omissions are never interpreted as removal. */
  characterStateChanges: CharacterStateChange[];
}

function numericDelta(from: number | undefined, to: number | undefined): NumericDelta {
  if (from === undefined || to === undefined) return { from, to };
  return { from, to, delta: to - from };
}

// Blizzard's itemString format embeds the observing character's level at
// link time (e.g. "item:6171::::::::3::::::::::" vs "...::4::..." for the
// literal same pair of gloves, one level apart — confirmed against real
// Bromrik captures). That field is not a meaningful item "variant" the way
// an enchant, gem, or random suffix is, so it must not fragment one
// physical item/stack into a phantom "lost + gained" pair on every level
// change. Cross-snapshot matching therefore keys on the base numeric item
// ID rather than the full itemRef string. The full itemRef is still
// preserved untouched everywhere it's stored or displayed — only the
// "is this the same tracked item" decision uses the looser key.
export function baseItemId(itemRef: string | undefined): string | undefined {
  if (!itemRef) return undefined;
  const match = /^item:(\d+)/.exec(itemRef);
  return match ? match[1] : itemRef;
}

function itemKey(item: InventoryItemRecord): string {
  const id = baseItemId(item.itemRef);
  return id ? `id:${id}|${item.name ?? "?"}|${item.bound ?? "?"}` : `name:${item.name ?? "?"}`;
}

function diffInventory(from: InventorySection, to: InventorySection): ItemDelta[] {
  if (from.status.state === "UNKNOWN" || to.status.state === "UNKNOWN") return [];
  const fromMap = new Map<string, InventoryItemRecord>();
  for (const item of from.items) fromMap.set(itemKey(item), item);
  const toMap = new Map<string, InventoryItemRecord>();
  for (const item of to.items) toMap.set(itemKey(item), item);

  const deltas: ItemDelta[] = [];
  const keys = new Set([...fromMap.keys(), ...toMap.keys()]);
  for (const key of keys) {
    const fromItem = fromMap.get(key);
    const toItem = toMap.get(key);
    const fromQty = fromItem?.qty ?? 0;
    const toQty = toItem?.qty ?? 0;
    if (fromQty === toQty) continue;
    deltas.push({
      itemRef: toItem?.itemRef ?? fromItem?.itemRef,
      name: toItem?.name ?? fromItem?.name,
      fromQty,
      toQty,
      deltaQty: toQty - fromQty,
    });
  }
  deltas.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return deltas;
}

function diffProfessions(from: ParsedSnapshot["professions"], to: ParsedSnapshot["professions"]): ProfessionDelta[] {
  if (from.status.state === "UNKNOWN" || to.status.state === "UNKNOWN") return [];
  const fromMap = new Map(from.entries.map((e) => [e.name, e]));
  const toMap = new Map(to.entries.map((e) => [e.name, e]));
  const names = new Set([...fromMap.keys(), ...toMap.keys()]);
  const deltas: ProfessionDelta[] = [];
  for (const name of names) {
    const fromEntry = fromMap.get(name);
    const toEntry = toMap.get(name);
    const skill = numericDelta(fromEntry?.skill, toEntry?.skill);
    const maxSkill = numericDelta(fromEntry?.maxSkill, toEntry?.maxSkill);
    if (skill.delta || maxSkill.delta || !fromEntry || !toEntry) {
      deltas.push({ name, skill, maxSkill });
    }
  }
  deltas.sort((a, b) => a.name.localeCompare(b.name));
  return deltas;
}

function diffLocation(from: ParsedSnapshot["location"], to: ParsedSnapshot["location"]): LocationDelta {
  if (from.status.state === "UNKNOWN" || to.status.state === "UNKNOWN") {
    return { fromZone: from.zone, toZone: to.zone, fromSubzone: from.subzone, toSubzone: to.subzone, changed: false };
  }
  const changed = from.zone !== to.zone || from.subzone !== to.subzone;
  return { fromZone: from.zone, toZone: to.zone, fromSubzone: from.subzone, toSubzone: to.subzone, changed };
}

function diffEquipment(from: ParsedSnapshot["equipment"], to: ParsedSnapshot["equipment"]): EquipmentDelta[] {
  if (from.status.state === "UNKNOWN" || to.status.state === "UNKNOWN") return [];
  const fromBySlot = new Map(from.slots.map((s) => [s.slot, s]));
  const toBySlot = new Map(to.slots.map((s) => [s.slot, s]));
  const deltas: EquipmentDelta[] = [];
  for (const [slot, toSlot] of toBySlot) {
    const fromSlot = fromBySlot.get(slot);
    const fromRef = fromSlot?.empty ? "EMPTY" : fromSlot?.itemRef;
    const toRef = toSlot.empty ? "EMPTY" : toSlot.itemRef;
    // Same rationale as itemKey() above: compare by base item ID, not the
    // full itemRef, so a level-up alone doesn't flag every equipped slot
    // as "changed". The actual observed itemRef strings are still
    // reported below for full transparency.
    const fromId = fromRef === "EMPTY" ? "EMPTY" : baseItemId(fromRef);
    const toId = toRef === "EMPTY" ? "EMPTY" : baseItemId(toRef);
    if (fromId !== toId) {
      deltas.push({ slot, slotName: toSlot.slotName, from: fromRef, to: toRef });
    }
  }
  deltas.sort((a, b) => a.slot - b.slot);
  return deltas;
}

function serviceKey(ability: string | undefined, rank: string | undefined): string {
  return `${ability ?? "?"}|${rank ?? "?"}`;
}

function diffTrainerUnlocks(from: TrainerSection, to: TrainerSection): TrainerUnlock[] {
  if (from.status.state === "UNKNOWN" || to.status.state === "UNKNOWN") return [];
  const fromByCategory = new Map(from.categories.map((c) => [c.category, c]));
  const unlocks: TrainerUnlock[] = [];
  for (const toCategory of to.categories) {
    const fromCategory = fromByCategory.get(toCategory.category);
    if (!fromCategory) continue; // a brand-new category has no "before" state to compare against
    const wasAvailable = new Set(
      fromCategory.services
        .filter((s) => s.statusAtVisit?.toLowerCase() === "available")
        .map((s) => serviceKey(s.ability, s.rank)),
    );
    for (const service of toCategory.services) {
      if (service.statusAtVisit?.toLowerCase() !== "available") continue;
      if (wasAvailable.has(serviceKey(service.ability, service.rank))) continue;
      unlocks.push({ category: toCategory.category, ability: service.ability, rank: service.rank });
    }
  }
  return unlocks;
}

function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function flattenProfessionNodes(state: ParsedSnapshot["characterState"]): Map<string, { identity: Record<string, number | string>; rank: number }> {
  const out = new Map<string, { identity: Record<string, number | string>; rank: number }>();
  const data = state?.professionSpecializations?.data;
  const professions = isRecord(data) && Array.isArray(data.professions) ? data.professions : [];
  for (const profession of professions) for (const tier of (profession.tiers ?? [])) for (const tree of (tier.trees ?? [])) for (const node of (tree.nodes ?? [])) {
    if (node.evidence !== "OBSERVED") continue;
    const rank = typeof node.ranksPurchased === "number" ? node.ranksPurchased : typeof node.currentRank === "number" ? node.currentRank : undefined;
    if (rank === undefined || typeof tier.skillLineID !== "number" || typeof tree.treeID !== "number" || typeof node.nodeID !== "number") continue;
    const identity = { skillLineID: tier.skillLineID, treeID: tree.treeID, nodeID: node.nodeID };
    out.set(`${identity.skillLineID}:${identity.treeID}:${identity.nodeID}`, { identity, rank });
  }
  return out;
}

function diffCharacterState(from: ParsedSnapshot["characterState"], to: ParsedSnapshot["characterState"]): CharacterStateChange[] {
  if (!from || !to || from.clientFamily !== "Retail" || to.clientFamily !== "Retail") return [];
  const changes: CharacterStateChange[] = [];
  const combatObserved = from.combatSpecialization?.status.state === "OBSERVED" && to.combatSpecialization?.status.state === "OBSERVED";
  const a = combatObserved ? from.combatSpecialization?.data?.activeSpec : undefined;
  const b = combatObserved ? to.combatSpecialization?.data?.activeSpec : undefined;
  if (isRecord(a) && isRecord(b) && a.evidence === "OBSERVED" && b.evidence === "OBSERVED" && typeof a.specID === "number" && typeof b.specID === "number" && a.specID !== b.specID) {
    changes.push({ domain: "combat-specialization", identity: { field: "specID" }, from: a.specID, to: b.specID, evidence: "DERIVED" });
  }
  const configsA = from.combatSpecialization?.data?.talentConfig;
  const configsB = to.combatSpecialization?.data?.talentConfig;
  if (isRecord(configsA) && isRecord(configsB) && configsA.evidence === "OBSERVED" && configsB.evidence === "OBSERVED" && typeof configsA.configID === "number" && typeof configsB.configID === "number" && configsA.configID !== configsB.configID) changes.push({ domain: "combat-specialization", identity: { field: "configID" }, from: configsA.configID, to: configsB.configID, evidence: "DERIVED" });
  const heroA = from.combatSpecialization?.data?.heroTalent;
  const heroB = to.combatSpecialization?.data?.heroTalent;
  if (isRecord(heroA) && isRecord(heroB) && heroA.evidence === "OBSERVED" && heroB.evidence === "OBSERVED" && typeof heroA.subtreeID === "number" && typeof heroB.subtreeID === "number" && heroA.subtreeID !== heroB.subtreeID) changes.push({ domain: "combat-specialization", identity: { field: "heroSubtreeID" }, from: heroA.subtreeID, to: heroB.subtreeID, evidence: "DERIVED" });
  const professionsObserved = from.professionSpecializations?.status.state === "OBSERVED" && to.professionSpecializations?.status.state === "OBSERVED";
  const oldNodes = professionsObserved ? flattenProfessionNodes(from) : new Map(); const newNodes = professionsObserved ? flattenProfessionNodes(to) : new Map();
  for (const [key, before] of oldNodes) {
    const after = newNodes.get(key);
    if (after && before.rank !== after.rank) changes.push({ domain: "profession-node-rank", identity: before.identity, from: before.rank, to: after.rank, delta: after.rank - before.rank, evidence: "DERIVED" });
  }
  const reputationRows = (state: ParsedSnapshot["characterState"], part: "character" | "account", key: "factions" | "majorFactions") => {
    const data = state?.reputation?.[part]?.data;
    return isRecord(data) && Array.isArray(data[key]) ? data[key] : [];
  };
  for (const part of ["character", "account"] as const) {
    const oldDomain = from.reputation?.[part]; const newDomain = to.reputation?.[part];
    if (oldDomain?.status.state !== "OBSERVED" || newDomain?.status.state !== "OBSERVED") continue;
    const oldFactions = new Map(reputationRows(from, part, "factions").filter((x: any) => x.evidence === "OBSERVED" && typeof x.factionID === "number" && typeof x.currentStanding === "number").map((x: any) => [`${x.factionID}:${x.ownerScope ?? "UNKNOWN"}`, x]));
    for (const row of reputationRows(to, part, "factions")) {
      if (row.evidence !== "OBSERVED") continue;
      if (typeof row.factionID !== "number" || typeof row.currentStanding !== "number") continue;
      const previous: any = oldFactions.get(`${row.factionID}:${row.ownerScope ?? "UNKNOWN"}`);
      if (previous && previous.currentStanding !== row.currentStanding) changes.push({ domain: "reputation-standing", identity: { factionID: row.factionID, ownerScope: row.ownerScope ?? "UNKNOWN" }, from: previous.currentStanding, to: row.currentStanding, delta: row.currentStanding - previous.currentStanding, evidence: "DERIVED" });
    }
    const oldMajors = new Map(reputationRows(from, part, "majorFactions").filter((x: any) => x.evidence === "OBSERVED" && typeof x.majorFactionID === "number" && x.renownEvidence === "OBSERVED_VALUE" && isRecord(x.renown)).map((x: any) => [x.majorFactionID, x]));
    for (const row of reputationRows(to, part, "majorFactions")) {
      if (row.evidence !== "OBSERVED") continue;
      if (typeof row.majorFactionID !== "number" || row.renownEvidence !== "OBSERVED_VALUE" || !isRecord(row.renown)) continue;
      const previous: any = oldMajors.get(row.majorFactionID); if (!previous || !isRecord(previous.renown)) continue;
      for (const field of ["level", "earned"] as const) if (typeof previous.renown[field] === "number" && typeof row.renown[field] === "number" && previous.renown[field] !== row.renown[field]) changes.push({ domain: "major-faction-renown", identity: { majorFactionID: row.majorFactionID, ...(typeof row.conventionalFactionID === "number" ? { conventionalFactionID: row.conventionalFactionID } : {}), ownerScope: part === "account" ? "ACCOUNT_WARBAND" : row.ownerScope ?? "UNKNOWN", field }, from: previous.renown[field], to: row.renown[field], delta: row.renown[field] - previous.renown[field], evidence: "DERIVED" });
    }
  }
  return changes;
}

export function diffSnapshots(from: ParsedSnapshot, to: ParsedSnapshot): SnapshotDiff {
  return {
    fromGeneratedAt: from.generatedAt,
    toGeneratedAt: to.generatedAt,
    level: numericDelta(from.character.level, to.character.level),
    xp: numericDelta(from.character.xp, to.character.xp),
    xpMax: numericDelta(from.character.xpMax, to.character.xpMax),
    moneyCopper: numericDelta(from.character.moneyCopper, to.character.moneyCopper),
    playedSeconds: numericDelta(from.character.playedSeconds, to.character.playedSeconds),
    levelPlayedSeconds: numericDelta(from.character.levelPlayedSeconds, to.character.levelPlayedSeconds),
    location: diffLocation(from.location, to.location),
    professions: diffProfessions(from.professions, to.professions),
    bagsItems: diffInventory(from.bags, to.bags),
    bankItems: diffInventory(from.bank, to.bank),
    equipment: diffEquipment(from.equipment, to.equipment),
    trainerUnlocks: diffTrainerUnlocks(from.trainer, to.trainer),
    characterStateChanges: diffCharacterState(from.characterState, to.characterState),
  };
}
