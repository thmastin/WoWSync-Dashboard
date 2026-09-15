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
  };
}
