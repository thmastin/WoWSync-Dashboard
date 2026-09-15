// Deterministic diff engine. Produces facts, not interpretation — this is
// the layer an LLM should be handed, never asked to recompute arithmetic
// itself. A delta is only reported when both sides of the comparison are
// actually known; unknown values never get treated as zero.

import type { InventoryItemRecord, InventorySection, ParsedSnapshot } from "./types.ts";

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

export interface SnapshotDiff {
  fromGeneratedAt?: number;
  toGeneratedAt?: number;
  level: NumericDelta;
  moneyCopper: NumericDelta;
  playedSeconds: NumericDelta;
  levelPlayedSeconds: NumericDelta;
  professions: ProfessionDelta[];
  bagsItems: ItemDelta[];
  bankItems: ItemDelta[];
  equipment: EquipmentDelta[];
}

function numericDelta(from: number | undefined, to: number | undefined): NumericDelta {
  if (from === undefined || to === undefined) return { from, to };
  return { from, to, delta: to - from };
}

function itemKey(item: InventoryItemRecord): string {
  return item.itemRef ?? `name:${item.name ?? "?"}`;
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

function diffEquipment(from: ParsedSnapshot["equipment"], to: ParsedSnapshot["equipment"]): EquipmentDelta[] {
  if (from.status.state === "UNKNOWN" || to.status.state === "UNKNOWN") return [];
  const fromBySlot = new Map(from.slots.map((s) => [s.slot, s]));
  const toBySlot = new Map(to.slots.map((s) => [s.slot, s]));
  const deltas: EquipmentDelta[] = [];
  for (const [slot, toSlot] of toBySlot) {
    const fromSlot = fromBySlot.get(slot);
    const fromRef = fromSlot?.empty ? "EMPTY" : fromSlot?.itemRef;
    const toRef = toSlot.empty ? "EMPTY" : toSlot.itemRef;
    if (fromRef !== toRef) {
      deltas.push({ slot, slotName: toSlot.slotName, from: fromRef, to: toRef });
    }
  }
  deltas.sort((a, b) => a.slot - b.slot);
  return deltas;
}

export function diffSnapshots(from: ParsedSnapshot, to: ParsedSnapshot): SnapshotDiff {
  return {
    fromGeneratedAt: from.generatedAt,
    toGeneratedAt: to.generatedAt,
    level: numericDelta(from.character.level, to.character.level),
    moneyCopper: numericDelta(from.character.moneyCopper, to.character.moneyCopper),
    playedSeconds: numericDelta(from.character.playedSeconds, to.character.playedSeconds),
    levelPlayedSeconds: numericDelta(from.character.levelPlayedSeconds, to.character.levelPlayedSeconds),
    professions: diffProfessions(from.professions, to.professions),
    bagsItems: diffInventory(from.bags, to.bags),
    bankItems: diffInventory(from.bank, to.bank),
    equipment: diffEquipment(from.equipment, to.equipment),
  };
}
