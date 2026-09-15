// Builds WOWSYNC v1 export text that mirrors WoWSyncRender.lua's algorithm
// exactly (see GearExport/WoWSyncRender.lua), so fixtures are format-true
// even though they are not exports pasted from a live client. Real exports
// from Torahn/Voodan/Tenivard/Bromrik should supplement or replace these
// as they become available (see test/fixtures/README.md).

function text(value: unknown): string {
  if (value === undefined || value === null) return "?";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}
function row(...cols: unknown[]): string {
  return cols.map(text).join("\t");
}
function field(key: string, value: unknown): string {
  return `${key}: ${text(value)}`;
}

export interface FixtureItem {
  itemRef: string;
  name: string;
  qty: number;
  bound?: boolean;
  vendorEachCopper?: number;
}

export interface FixtureContainer {
  id: number;
  capacity: number;
  free?: number;
  family?: number;
  bagRef?: string;
  storage?: string;
  items?: FixtureItem[];
}

export interface FixtureEquipmentSlot {
  slot: number;
  slotName: string;
  empty?: boolean;
  itemRef?: string;
  name?: string;
  itemLevel?: number;
  requiredLevel?: number;
  effectiveStats?: string;
}

export interface FixtureProfession {
  name: string;
  skill: number;
  maxSkill: number;
  skillLineID?: number;
  tier?: string;
  expansion?: string;
  category?: string;
}

export interface FixtureSpell {
  spellID: number;
  name: string;
  rank?: string;
}

export interface FixtureTrainerService {
  spellID?: number;
  ability: string;
  rank?: string;
  status: string;
  requiredLevel?: number;
  cost?: number;
  requirements?: string;
}

export interface FixtureTrainerCategory {
  category: string;
  state?: "OBSERVED" | "LAST_SEEN";
  completeness?: string;
  observedAt?: number;
  coverageNote?: string;
  lastVisit?: number;
  visitedNPC?: string;
  visitedZone?: string;
  name?: string;
  trainerType?: string;
  coverage?: string;
  filtersAvailable?: boolean;
  filtersUnavailable?: boolean;
  filtersKnown?: boolean;
  moneyAtVisitCopper?: number;
  services?: FixtureTrainerService[];
}

export interface FixtureOptions {
  generatedAt?: number;
  character?: {
    name?: string;
    realm?: string;
    class?: string;
    level?: number;
    faction?: string;
    moneyCopper?: number;
    playedSeconds?: number;
    levelPlayedSeconds?: number;
    xp?: number;
    xpMax?: number;
    clientVersion?: string;
    clientBuild?: string;
    clientFamily?: string;
    interface?: string;
    unknown?: boolean;
  };
  location?: {
    zone?: string;
    subzone?: string;
    mapID?: number;
    x?: number;
    y?: number;
    unknown?: boolean;
  };
  equipment?: {
    slots?: FixtureEquipmentSlot[];
    unknown?: boolean;
    partial?: boolean;
  };
  bags?: {
    containers?: FixtureContainer[];
    unknown?: boolean;
  };
  bank?: {
    containers?: FixtureContainer[];
    coverage?: string;
    snapshotVisit?: number;
    purchasedBagSlots?: number;
    lastSeen?: boolean;
    unknown?: boolean;
  };
  professions?: {
    entries?: FixtureProfession[];
    retail?: boolean;
    unknown?: boolean;
  };
  spells?: {
    entries?: FixtureSpell[];
    coverage?: string;
    unknown?: boolean;
  };
  trainer?: {
    categories?: FixtureTrainerCategory[];
    unknown?: boolean;
  };
}

const ALL_EQUIP_SLOTS: [number, string][] = [
  [1, "Head"],
  [2, "Neck"],
  [3, "Shoulder"],
  [4, "Shirt"],
  [5, "Chest"],
  [6, "Waist"],
  [7, "Legs"],
  [8, "Feet"],
  [9, "Wrist"],
  [10, "Hands"],
  [11, "Finger1"],
  [12, "Finger2"],
  [13, "Trinket1"],
  [14, "Trinket2"],
  [15, "Back"],
  [16, "MainHand"],
  [17, "OffHand"],
  [18, "Ranged"],
  [19, "Tabard"],
];

function inventoryBody(containers: FixtureContainer[]): string[] {
  const out: string[] = [];
  out.push(row("container", "capacity", "free", "family", "bagRef"));
  let total = 0;
  let free: number | undefined = 0;
  for (const c of containers) {
    if (c.storage) out.push(field(`ContainerStorage ${c.id}`, c.storage));
    total += c.capacity;
    if (c.free === undefined) free = undefined;
    else if (free !== undefined) free += c.free;
    out.push(row(c.id, c.capacity, c.free, c.family ?? -1, c.bagRef ?? "-"));
  }
  out.push(field("Slots", `${text(free)} free / ${total}`));

  const grouped = new Map<string, { item: FixtureItem; count: number }>();
  for (const c of containers) {
    for (const item of c.items ?? []) {
      const key = `${item.itemRef}${item.bound}${item.name}${item.vendorEachCopper}`;
      const entry = grouped.get(key);
      if (entry) entry.count += item.qty;
      else grouped.set(key, { item, count: item.qty });
    }
  }
  out.push(row("itemRef", "name", "qty", "bound", "vendorEachCopper"));
  const rows = [...grouped.values()];
  if (rows.length === 0) {
    out.push(field("Items", "EMPTY"));
  } else {
    for (const { item, count } of rows) {
      out.push(row(item.itemRef, item.name, count, item.bound, item.vendorEachCopper));
    }
  }
  return out;
}

export function buildWowSyncExport(opts: FixtureOptions = {}): string {
  const generatedAt = opts.generatedAt ?? 1_700_000_000;
  const sections: string[] = [];

  // [CHARACTER]
  {
    const out = ["[CHARACTER]"];
    const c = opts.character ?? {};
    if (c.unknown) {
      out.push(field("State", "UNKNOWN"));
      out.push(field("Reason", "Not observed"));
    } else {
      out.push(field("State", "OBSERVED; complete; observed=" + generatedAt));
      out.push(field("Name", c.name ?? "Fixture"));
      out.push(field("Realm", c.realm ?? "TestRealm"));
      out.push(field("Class", c.class ?? "Warrior"));
      out.push(field("Level", c.level ?? 1));
      out.push(field("Faction", c.faction ?? "Horde"));
      out.push(field("MoneyCopper", c.moneyCopper));
      out.push(field("PlayedSeconds", c.playedSeconds));
      out.push(field("LevelPlayedSeconds", c.levelPlayedSeconds));
      if (c.xp !== undefined && c.xpMax !== undefined && c.xpMax > 0) {
        out.push(field("XP", `${c.xp}/${c.xpMax}`));
      }
      out.push(field("Client", `${c.clientVersion ?? "1.15.7"} build ${c.clientBuild ?? "60927"}`));
      if (c.clientFamily) {
        out.push(field("ClientFamily", c.clientFamily));
        out.push(field("Interface", c.interface ?? "?"));
      }
    }
    sections.push(out.join("\n"));
  }

  // [LOCATION]
  {
    const out = ["[LOCATION]"];
    const l = opts.location ?? {};
    if (l.unknown) {
      out.push(field("State", "UNKNOWN"));
      out.push(field("Reason", "Not observed"));
    } else {
      out.push(field("State", "OBSERVED; complete; observed=" + generatedAt));
      out.push(field("Zone", l.zone ?? "Elwynn Forest"));
      if (l.subzone) out.push(field("Subzone", l.subzone));
      if (l.mapID !== undefined) out.push(field("MapID", l.mapID));
      if (l.x !== undefined && l.y !== undefined) out.push(field("PositionPercent", `${l.x},${l.y}`));
    }
    sections.push(out.join("\n"));
  }

  // [EQUIPMENT]
  {
    const out = ["[EQUIPMENT]"];
    const e = opts.equipment ?? {};
    if (e.unknown) {
      out.push(field("State", "UNKNOWN"));
      out.push(field("Reason", "Not observed"));
    } else {
      out.push(field("State", `OBSERVED; ${e.partial ? "partial" : "complete"}; observed=` + generatedAt));
      out.push(row("slot", "itemRef", "name", "ilvl", "requiredLevel", "effectiveStats"));
      const bySlot = new Map((e.slots ?? []).map((s) => [s.slot, s]));
      for (const [slot, defaultName] of ALL_EQUIP_SLOTS) {
        const item = bySlot.get(slot);
        const label = `${slot}:${defaultName}`;
        if (!item || item.empty) {
          out.push(row(label, "EMPTY"));
        } else {
          out.push(row(label, item.itemRef, item.name, item.itemLevel, item.requiredLevel, item.effectiveStats));
        }
      }
    }
    sections.push(out.join("\n"));
  }

  // [BAGS]
  {
    const out = ["[BAGS]"];
    const b = opts.bags ?? {};
    if (b.unknown) {
      out.push(field("State", "UNKNOWN"));
      out.push(field("Reason", "Not observed"));
    } else {
      out.push(field("State", "OBSERVED; complete; observed=" + generatedAt));
      out.push(...inventoryBody(b.containers ?? []));
    }
    sections.push(out.join("\n"));
  }

  // [BANK]
  {
    const out = ["[BANK]"];
    const bk = opts.bank ?? {};
    if (bk.unknown) {
      out.push(field("State", "UNKNOWN"));
      out.push(field("Reason", "Not observed"));
    } else {
      if (bk.snapshotVisit !== undefined) out.push(field("LastVisit", bk.snapshotVisit));
      out.push(field("State", `${bk.lastSeen ? "LAST_SEEN" : "OBSERVED"}; complete; observed=` + generatedAt));
      if (bk.coverage) out.push(field("Coverage", bk.coverage));
      if (bk.snapshotVisit !== undefined) out.push(field("SnapshotVisit", bk.snapshotVisit));
      if (bk.purchasedBagSlots !== undefined) out.push(field("PurchasedBankBagSlots", bk.purchasedBagSlots));
      out.push(...inventoryBody(bk.containers ?? []));
    }
    sections.push(out.join("\n"));
  }

  // [PROFESSIONS]
  {
    const out = ["[PROFESSIONS]"];
    const p = opts.professions ?? {};
    if (p.unknown) {
      out.push(field("State", "UNKNOWN"));
      out.push(field("Reason", "Not observed"));
    } else {
      out.push(field("State", "OBSERVED; complete; observed=" + generatedAt));
      if (p.retail) {
        out.push(row("profession", "skill", "maxSkill", "skillLineID", "tier", "expansion", "category"));
        for (const e of p.entries ?? []) {
          out.push(row(e.name, e.skill, e.maxSkill, e.skillLineID, e.tier, e.expansion, e.category));
        }
        if (!p.entries || p.entries.length === 0) {
          out.push(field("Professions", "None exposed by tracked profession APIs"));
        }
      } else {
        out.push(row("profession", "skill", "maxSkill"));
        for (const e of p.entries ?? []) out.push(row(e.name, e.skill, e.maxSkill));
        if (!p.entries || p.entries.length === 0) {
          out.push(field("Professions", "None identified in exposed skill lines"));
        }
      }
    }
    sections.push(out.join("\n"));
  }

  // [KNOWN SPELLS]
  {
    const out = ["[KNOWN SPELLS]"];
    const s = opts.spells ?? {};
    if (s.unknown) {
      out.push(field("State", "UNKNOWN"));
      out.push(field("Reason", "Not observed"));
    } else {
      out.push(field("State", "OBSERVED; complete; observed=" + generatedAt));
      out.push(field("Coverage", s.coverage ?? "Full spellbook scan"));
      out.push(row("spellID", "name", "rank"));
      for (const e of s.entries ?? []) out.push(row(e.spellID, e.name, e.rank ?? "-"));
    }
    sections.push(out.join("\n"));
  }

  // [TRAINERS]
  {
    const out = ["[TRAINERS]"];
    const t = opts.trainer ?? {};
    if (t.unknown || !t.categories || t.categories.length === 0) {
      out.push(field("State", "UNKNOWN"));
      out.push(field("Reason", "Not observed"));
    } else {
      out.push(field("State", `OBSERVED; categories=${t.categories.length}; observed=` + generatedAt));
      const sorted = [...t.categories].sort((a, b) => a.category.localeCompare(b.category));
      for (const cat of sorted) {
        out.push(`[${cat.category}]`);
        out.push(
          field("State", `${cat.state ?? "OBSERVED"}; ${cat.completeness ?? "complete"}; observed=${cat.observedAt ?? generatedAt}`),
        );
        if (cat.coverageNote) out.push(field("CoverageNote", cat.coverageNote));
        if (cat.lastVisit !== undefined) out.push(field("LastVisit", cat.lastVisit));
        if (cat.visitedNPC) out.push(field("VisitedNPC", cat.visitedNPC));
        if (cat.visitedZone) out.push(field("VisitedZone", cat.visitedZone));
        out.push(field("Name", cat.name ?? cat.category));
        out.push(field("Type", cat.trainerType ?? "class"));
        out.push(field("Coverage", cat.coverage ?? "Full window scan"));
        out.push(
          field(
            "Filters",
            `available=${text(cat.filtersAvailable ?? true)}; unavailable=${text(cat.filtersUnavailable ?? true)}; known=${text(cat.filtersKnown ?? true)}`,
          ),
        );
        out.push(field("MoneyAtVisitCopper", cat.moneyAtVisitCopper ?? 0));
        out.push(row("spellID", "ability", "rank", "statusAtVisit", "requiredLevel", "costCopper", "requirementsAtVisit"));
        for (const svc of cat.services ?? []) {
          out.push(
            row(svc.spellID, svc.ability, svc.rank ?? "-", svc.status, svc.requiredLevel, svc.cost, svc.requirements ?? "-"),
          );
        }
      }
    }
    sections.push(out.join("\n"));
  }

  // WoWSyncRender.lua's S.Render joins its whole output array (including
  // these three lines individually) with "\n\n" — each is its own chunk,
  // not one three-line header block.
  return [
    "WOWSYNC v1",
    `Generated: ${generatedAt}`,
    "Format: tab-separated columns; ?=unknown; timestamps=Unix seconds; money=copper; itemRef preserves item variants.",
    ...sections,
    "[END]",
  ].join("\n\n");
}
