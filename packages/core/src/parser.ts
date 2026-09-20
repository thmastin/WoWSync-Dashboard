// Deterministic line/section parser for WOWSYNC v1 exports.
//
// This mirrors WoWSyncRender.lua exactly (see GearExport/WoWSyncRender.lua
// and WOWSYNC_SCHEMA.md): the export is a fixed sequence of sections, each
// with a known field order. We parse by walking known line shapes rather
// than pattern-matching loosely, so malformed input fails with a specific,
// actionable error instead of silently producing wrong data.

import { fieldNumber, fieldValue } from "./escape.ts";
import type {
  AccountBankSection,
  CharacterSection,
  ContainerRecord,
  EquipmentSection,
  InventoryItemRecord,
  InventorySection,
  LocationSection,
  ParsedSnapshot,
  ProfessionEntry,
  ProfessionsSection,
  SectionState,
  SectionStatus,
  SpellsSection,
  TrainerCategorySnapshot,
  TrainerSection,
} from "./types.ts";

export class WowSyncParseError extends Error {
  readonly context?: string;
  constructor(message: string, context?: string) {
    super(context ? `${message}\n  near: ${context}` : message);
    this.name = "WowSyncParseError";
    this.context = context;
  }
}

const SECTION_LABELS: Record<string, keyof ParsedSnapshot | undefined> = {
  CHARACTER: "character",
  LOCATION: "location",
  EQUIPMENT: "equipment",
  BAGS: "bags",
  BANK: "bank",
  "ACCOUNT BANK": "accountBank",
  PROFESSIONS: "professions",
  "KNOWN SPELLS": "spells",
  // Real captures show both spellings in the wild: the current addon
  // (WoWSyncRender.lua) renders "TRAINERS", but older installed builds
  // (e.g. a Classic Era client not yet updated) rendered "TRAINER". Both
  // route to the same section rather than failing on addon version skew.
  TRAINERS: "trainer",
  TRAINER: "trainer",
};

function fail(message: string, context?: string): never {
  throw new WowSyncParseError(message, context);
}

function takeLine(lines: string[], i: number, prefix: string, required: true): [string, number];
function takeLine(lines: string[], i: number, prefix: string, required?: false): [string | undefined, number];
function takeLine(lines: string[], i: number, prefix: string, required = false): [string | undefined, number] {
  const line = lines[i];
  if (line !== undefined && line.startsWith(prefix)) {
    return [line.slice(prefix.length), i + 1];
  }
  if (required) {
    fail(`Expected a line starting with "${prefix}"`, line ?? "<end of section>");
  }
  return [undefined, i];
}

// Fields are documented as tab-separated (WOWSYNC_SCHEMA.md), but real
// copy/paste round-trips (clipboard managers, chat boxes, editors) commonly
// collapse tabs to runs of spaces or trim trailing whitespace entirely. A
// literal tab is still honored first; a run of 2+ spaces is accepted as a
// fallback delimiter. A single space is never a delimiter, so normal
// "Sinister Strike" / "Finger 1" style values with one internal space are
// never split apart.
function splitFields(line: string): string[] {
  return line.split(/\t| {2,}/);
}

function splitRow(line: string, expectedColumns: number, label: string): string[] {
  const cols = splitFields(line);
  if (cols.length > expectedColumns) {
    fail(`Expected at most ${expectedColumns} columns for ${label}, found ${cols.length}`, line);
  }
  // Trailing columns are sometimes dropped entirely (trailing tab/space
  // trimmed by whatever the export passed through) rather than left empty.
  // Treat a short row as having unknown trailing fields, not a parse error.
  while (cols.length < expectedColumns) cols.push(undefined as unknown as string);
  return cols;
}

/**
 * Parses the status block common to every top-level section:
 *   (LastVisit/VisitedNPC/VisitedZone/VisitStatus)*   -- bank only, ever
 *   State: OBSERVED|LAST_SEEN; <completeness>; observed=<ts>   OR   State: UNKNOWN
 *   Reason: <text>                                              -- only when UNKNOWN
 *   (Pending: ...)? (CoverageNote: ...)? (RefreshIssue: ...)?   -- only when known
 */
function parseSectionStatus(lines: string[], start: number): { status: SectionStatus; next: number } {
  let i = start;
  const status: SectionStatus = { state: "UNKNOWN" };

  let v: string | undefined;
  [v, i] = takeLine(lines, i, "LastVisit: ");
  if (v !== undefined) status.lastVisit = fieldNumber(v);
  [v, i] = takeLine(lines, i, "VisitedNPC: ");
  if (v !== undefined) status.visitedNPC = fieldValue(v);
  [v, i] = takeLine(lines, i, "VisitedZone: ");
  if (v !== undefined) status.visitedZone = fieldValue(v);
  [v, i] = takeLine(lines, i, "VisitStatus: ");
  if (v !== undefined) status.visitStatus = v;

  const [stateLine, next] = takeLine(lines, i, "State: ", true);
  i = next;
  const parts = stateLine.split("; ");
  const word = parts[0];
  if (word === "OBSERVED" || word === "LAST_SEEN") {
    status.state = word as SectionState;
    for (const part of parts.slice(1)) {
      if (part.startsWith("observed=")) status.observedAt = fieldNumber(part.slice("observed=".length));
      else if (part.startsWith("categories=")) status.categories = fieldNumber(part.slice("categories=".length));
      else status.completeness = part;
    }
  } else if (word === "UNKNOWN") {
    status.state = "UNKNOWN";
  } else {
    fail(`Unrecognized State value "${word}"`, stateLine);
  }

  if (status.state === "UNKNOWN") {
    [v, i] = takeLine(lines, i, "Reason: ");
    if (v !== undefined) status.reason = fieldValue(v);
    return { status, next: i };
  }

  [v, i] = takeLine(lines, i, "Pending: ");
  if (v !== undefined) status.pending = true;
  [v, i] = takeLine(lines, i, "CoverageNote: ");
  if (v !== undefined) status.coverageNote = fieldValue(v);
  [v, i] = takeLine(lines, i, "RefreshIssue: ");
  if (v !== undefined) status.refreshIssue = fieldValue(v);
  return { status, next: i };
}

function parseCharacter(lines: string[]): CharacterSection {
  const { status, next } = parseSectionStatus(lines, 0);
  let i = next;
  if (status.state === "UNKNOWN") return { status };

  const get = (prefix: string, required = true): string | undefined => {
    const [v, ni] = takeLine(lines, i, prefix, required as true);
    i = ni;
    return v;
  };

  const name = fieldValue(get("Name: "));
  const realm = fieldValue(get("Realm: "));
  const cls = fieldValue(get("Class: "));
  const level = fieldNumber(get("Level: "));
  const faction = fieldValue(get("Faction: "));
  const moneyCopper = fieldNumber(get("MoneyCopper: "));
  // PlayedSeconds/LevelPlayedSeconds were added to the schema after v1's
  // initial release (see WOWSYNC_ACCEPTANCE.md, "Character playtime").
  // An export captured by an older installed addon build simply omits
  // these lines entirely — that is not the same as an unknown *value*
  // (which would still render as "PlayedSeconds: ?"), so both are treated
  // as absent/undefined rather than a parse error.
  const playedSeconds = fieldNumber(get("PlayedSeconds: ", false));
  const levelPlayedSeconds = fieldNumber(get("LevelPlayedSeconds: ", false));

  let xp: number | undefined;
  let xpMax: number | undefined;
  const xpLine = get("XP: ", false);
  if (xpLine !== undefined) {
    const [xpStr, xpMaxStr] = xpLine.split("/");
    xp = fieldNumber(xpStr);
    xpMax = fieldNumber(xpMaxStr);
  }

  const clientLine = get("Client: ") ?? fail("Missing Client line in [CHARACTER]");
  const buildSep = clientLine.indexOf(" build ");
  const clientVersion = fieldValue(buildSep >= 0 ? clientLine.slice(0, buildSep) : clientLine);
  const clientBuild = buildSep >= 0 ? fieldValue(clientLine.slice(buildSep + " build ".length)) : undefined;

  const clientFamily = fieldValue(get("ClientFamily: ", false));
  const iface = clientFamily !== undefined ? fieldValue(get("Interface: ", false)) : undefined;

  return {
    status,
    name,
    realm,
    class: cls,
    level,
    faction,
    moneyCopper,
    playedSeconds,
    levelPlayedSeconds,
    xp,
    xpMax,
    clientVersion,
    clientBuild,
    clientFamily,
    interface: iface,
  };
}

function parseLocation(lines: string[]): LocationSection {
  const { status, next } = parseSectionStatus(lines, 0);
  let i = next;
  if (status.state === "UNKNOWN") return { status };

  const get = (prefix: string, required = false) => {
    const [v, ni] = takeLine(lines, i, prefix, required as true);
    i = ni;
    return v;
  };
  const zone = fieldValue(get("Zone: ", true));
  const subzone = fieldValue(get("Subzone: "));
  const mapID = fieldValue(get("MapID: "));
  let x: string | undefined;
  let y: string | undefined;
  const pos = get("PositionPercent: ");
  if (pos !== undefined) {
    const [xs, ys] = pos.split(",");
    x = fieldValue(xs);
    y = fieldValue(ys);
  }
  return { status, zone, subzone, mapID, x, y };
}

function parseEquipment(lines: string[]): EquipmentSection {
  const { status, next } = parseSectionStatus(lines, 0);
  let i = next;
  if (status.state === "UNKNOWN") return { status, slots: [] };

  splitRow(lines[i] ?? fail("Missing equipment header row"), 6, "[EQUIPMENT] header");
  i++;

  const slots: EquipmentSection["slots"] = [];
  while (i < lines.length) {
    const cols = splitFields(lines[i]);
    const [slotLabel, itemRef, name, ilvl, reqLevel, stats] = cols;
    const sep = slotLabel.indexOf(":");
    if (sep < 0) fail("Malformed equipment slot label (expected \"<n>:<SlotName>\")", lines[i]);
    const slot = Number(slotLabel.slice(0, sep));
    const slotName = slotLabel.slice(sep + 1);
    if (itemRef === "EMPTY") {
      slots.push({ slot, slotName, empty: true });
    } else {
      slots.push({
        slot,
        slotName,
        empty: false,
        itemRef: fieldValue(itemRef),
        name: fieldValue(name),
        itemLevel: fieldValue(ilvl),
        requiredLevel: fieldValue(reqLevel),
        effectiveStats: fieldValue(stats),
      });
    }
    i++;
  }
  return { status, slots };
}

function parseInventoryBody(lines: string[], start: number): {
  containers: ContainerRecord[];
  freeSlots?: number;
  totalSlots?: number;
  itemsKnownEmpty: boolean;
  items: InventoryItemRecord[];
  next: number;
} {
  let i = start;
  splitRow(lines[i] ?? fail("Missing inventory container header row"), 5, "container header");
  i++;

  const containers: ContainerRecord[] = [];
  while (i < lines.length && !lines[i].startsWith("Slots: ")) {
    let storage: string | undefined;
    if (lines[i].startsWith("ContainerStorage ")) {
      const rest = lines[i].slice("ContainerStorage ".length);
      const sep = rest.indexOf(": ");
      if (sep < 0) fail("Malformed ContainerStorage line", lines[i]);
      storage = fieldValue(rest.slice(sep + 2));
      i++;
    }
    const cols = splitRow(lines[i] ?? fail("Missing container row"), 5, "container row");
    i++;
    containers.push({
      id: Number(cols[0]),
      storage,
      capacity: fieldNumber(cols[1]),
      free: fieldNumber(cols[2]),
      family: fieldValue(cols[3]),
      bagRef: fieldValue(cols[4]),
    });
  }

  const slotsLine = lines[i]?.slice("Slots: ".length) ?? fail("Missing Slots summary line");
  i++;
  const slotsMatch = /^(.+) free \/ (.+)$/.exec(slotsLine);
  if (!slotsMatch) fail("Malformed Slots summary line", slotsLine);
  const freeSlots = fieldNumber(slotsMatch[1]);
  const totalSlots = fieldNumber(slotsMatch[2]);

  splitRow(lines[i] ?? fail("Missing item header row"), 5, "item header");
  i++;

  let itemsKnownEmpty = false;
  const items: InventoryItemRecord[] = [];
  if (lines[i]?.startsWith("Items: EMPTY")) {
    itemsKnownEmpty = true;
    i++;
  } else {
    while (i < lines.length) {
      const cols = splitRow(lines[i], 5, "item row");
      items.push({
        itemRef: fieldValue(cols[0]),
        name: fieldValue(cols[1]),
        qty: fieldNumber(cols[2]),
        bound: fieldValue(cols[3]),
        vendorEachCopper: fieldNumber(cols[4]),
      });
      i++;
    }
  }
  return { containers, freeSlots, totalSlots, itemsKnownEmpty, items, next: i };
}

function parseBags(lines: string[]): InventorySection {
  const { status, next } = parseSectionStatus(lines, 0);
  if (status.state === "UNKNOWN") return { status, containers: [], itemsKnownEmpty: false, items: [] };
  const body = parseInventoryBody(lines, next);
  return { status, ...body };
}

function parseBank(lines: string[]): InventorySection {
  const { status, next } = parseSectionStatus(lines, 0);
  let i = next;
  if (status.state === "UNKNOWN") return { status, containers: [], itemsKnownEmpty: false, items: [] };

  const get = (prefix: string) => {
    const [v, ni] = takeLine(lines, i, prefix);
    i = ni;
    return v;
  };
  const coverage = fieldValue(get("Coverage: "));
  const snapshotVisit = fieldNumber(get("SnapshotVisit: "));
  const purchasedBankBagSlots = fieldNumber(get("PurchasedBankBagSlots: "));
  const purchasedBankTabs = fieldNumber(get("PurchasedBankTabs: "));

  const body = parseInventoryBody(lines, i);
  return { status, coverage, snapshotVisit, purchasedBankBagSlots, purchasedBankTabs, ...body };
}

function parseAccountBank(lines: string[]): AccountBankSection {
  const { status, next } = parseSectionStatus(lines, 0);
  let i = next;
  if (status.state === "UNKNOWN") return { status, ownerScope: "ACCOUNT_WARBAND", containers: [], itemsKnownEmpty: false, items: [] };

  const get = (prefix: string) => {
    const [v, ni] = takeLine(lines, i, prefix);
    i = ni;
    return v;
  };
  const scope = fieldValue(get("Scope: "));
  if (scope !== "ACCOUNT_WARBAND") fail("Unsupported account-bank scope", scope);
  const coverage = fieldValue(get("Coverage: "));
  const snapshotVisit = fieldNumber(get("SnapshotVisit: "));
  const purchasedBankTabs = fieldNumber(get("PurchasedBankTabs: "));
  const body = parseInventoryBody(lines, i);
  return { status, ownerScope: "ACCOUNT_WARBAND", coverage, snapshotVisit, purchasedBankTabs, ...body };
}

function parseProfessions(lines: string[]): ProfessionsSection {
  const { status, next } = parseSectionStatus(lines, 0);
  let i = next;
  if (status.state === "UNKNOWN") return { status, entries: [] };

  const [coverageLine, ci] = takeLine(lines, i, "Coverage: ");
  i = ci;
  const coverage = fieldValue(coverageLine);

  const headerCols = splitFields(lines[i] ?? fail("Missing professions header row"));
  const retailShaped = headerCols.length === 7;
  if (!retailShaped && headerCols.length !== 3) {
    fail(`Unexpected professions header column count: ${headerCols.length}`, lines[i]);
  }
  i++;

  const entries: ProfessionEntry[] = [];
  let noneMessage: string | undefined;
  while (i < lines.length) {
    if (lines[i].startsWith("Professions: ")) {
      noneMessage = fieldValue(lines[i].slice("Professions: ".length));
      i++;
      break;
    }
    const cols = splitFields(lines[i]);
    if (retailShaped) {
      entries.push({
        name: fieldValue(cols[0]) ?? "?",
        skill: fieldNumber(cols[1]),
        maxSkill: fieldNumber(cols[2]),
        skillLineID: fieldValue(cols[3]),
        tier: fieldValue(cols[4]),
        expansion: fieldValue(cols[5]),
        category: fieldValue(cols[6]),
      });
    } else {
      entries.push({
        name: fieldValue(cols[0]) ?? "?",
        skill: fieldNumber(cols[1]),
        maxSkill: fieldNumber(cols[2]),
      });
    }
    i++;
  }
  return { status, coverage, entries, noneMessage };
}

function parseSpells(lines: string[]): SpellsSection {
  const { status, next } = parseSectionStatus(lines, 0);
  let i = next;
  if (status.state === "UNKNOWN") return { status, entries: [] };

  const [coverageLine, ci] = takeLine(lines, i, "Coverage: ", true);
  i = ci;
  const coverage = fieldValue(coverageLine);

  splitRow(lines[i] ?? fail("Missing spells header row"), 3, "spells header");
  i++;

  const entries: SpellsSection["entries"] = [];
  while (i < lines.length) {
    const cols = splitRow(lines[i], 3, "spell row");
    entries.push({ spellID: fieldValue(cols[0]), name: fieldValue(cols[1]), rank: fieldValue(cols[2]) });
    i++;
  }
  return { status, coverage, entries };
}

function parseTrainerCategoryStatus(lines: string[], start: number): { status: SectionStatus; next: number } {
  let i = start;
  const [stateLine, ni] = takeLine(lines, i, "State: ", true);
  i = ni;
  const status: SectionStatus = { state: "UNKNOWN" };
  const parts = stateLine.split("; ");
  const word = parts[0];
  if (word === "OBSERVED" || word === "LAST_SEEN") {
    status.state = word as SectionState;
    for (const part of parts.slice(1)) {
      if (part.startsWith("observed=")) status.observedAt = fieldNumber(part.slice("observed=".length));
      else status.completeness = part;
    }
  } else {
    fail(`Unrecognized trainer category State value "${word}"`, stateLine);
  }
  let v: string | undefined;
  [v, i] = takeLine(lines, i, "CoverageNote: ");
  if (v !== undefined) status.coverageNote = fieldValue(v);
  [v, i] = takeLine(lines, i, "LastVisit: ");
  if (v !== undefined) status.lastVisit = fieldNumber(v);
  [v, i] = takeLine(lines, i, "VisitedNPC: ");
  if (v !== undefined) status.visitedNPC = fieldValue(v);
  [v, i] = takeLine(lines, i, "VisitedZone: ");
  if (v !== undefined) status.visitedZone = fieldValue(v);
  [v, i] = takeLine(lines, i, "VisitStatus: ");
  if (v !== undefined) status.visitStatus = v;
  return { status, next: i };
}

function parseTrainer(lines: string[]): TrainerSection {
  let i = 0;
  const [stateLine, ni] = takeLine(lines, i, "State: ", true);
  i = ni;
  const outer: SectionStatus = { state: "UNKNOWN" };
  const parts = stateLine.split("; ");
  if (parts[0] === "OBSERVED") {
    outer.state = "OBSERVED";
    for (const part of parts.slice(1)) {
      if (part.startsWith("observed=")) outer.observedAt = fieldNumber(part.slice("observed=".length));
      else if (part.startsWith("categories=")) outer.categories = fieldNumber(part.slice("categories=".length));
    }
  } else if (parts[0] === "UNKNOWN") {
    outer.state = "UNKNOWN";
  } else {
    fail(`Unrecognized [TRAINERS] State value "${parts[0]}"`, stateLine);
  }

  let v: string | undefined;
  [v, i] = takeLine(lines, i, "CoverageNote: ");
  if (v !== undefined) outer.coverageNote = fieldValue(v);
  if (outer.state === "UNKNOWN") {
    [v, i] = takeLine(lines, i, "Reason: ");
    if (v !== undefined) outer.reason = fieldValue(v);
    return { status: outer, categories: [] };
  }

  const categories: TrainerCategorySnapshot[] = [];
  while (i < lines.length) {
    const header = lines[i];
    if (!header.startsWith("[") || !header.endsWith("]")) {
      fail("Expected a [CATEGORY] header inside [TRAINERS]", header);
    }
    const category = header.slice(1, -1);
    i++;
    const { status, next } = parseTrainerCategoryStatus(lines, i);
    i = next;

    const get = (prefix: string, required = false) => {
      const [val, nextI] = takeLine(lines, i, prefix, required as true);
      i = nextI;
      return val;
    };
    const name = fieldValue(get("Name: "));
    const trainerType = fieldValue(get("Type: "));
    const coverage = fieldValue(get("Coverage: "));
    const filters = fieldValue(get("Filters: "));
    const moneyAtVisitCopper = fieldNumber(get("MoneyAtVisitCopper: "));

    splitRow(lines[i] ?? fail("Missing trainer services header row"), 7, "trainer services header");
    i++;
    const services: TrainerCategorySnapshot["services"] = [];
    while (i < lines.length && !lines[i].startsWith("[")) {
      const cols = splitRow(lines[i], 7, "trainer service row");
      services.push({
        spellID: fieldValue(cols[0]),
        ability: fieldValue(cols[1]),
        rank: cols[2] === "-" ? undefined : fieldValue(cols[2]),
        statusAtVisit: fieldValue(cols[3]),
        requiredLevel: fieldValue(cols[4]),
        costCopper: fieldNumber(cols[5]),
        requirementsAtVisit: cols[6] === "-" ? undefined : fieldValue(cols[6]),
      });
      i++;
    }
    categories.push({ category, status, name, trainerType, coverage, filters, moneyAtVisitCopper, services });
  }

  return { status: outer, categories };
}

const SECTION_PARSERS: Record<string, (lines: string[]) => any> = {
  character: parseCharacter,
  location: parseLocation,
  equipment: parseEquipment,
  bags: parseBags,
  bank: parseBank,
  accountBank: parseAccountBank,
  professions: parseProfessions,
  spells: parseSpells,
  trainer: parseTrainer,
};

export function parseWowSyncExport(raw: string): ParsedSnapshot {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    fail("Export text is empty");
  }
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const chunks = normalized.split(/\n{2,}/);
  if (chunks.length < 5) {
    fail("Export is too short to be a valid WOWSYNC v1 export (missing header, sections, or [END])");
  }

  // The canonical renderer (WoWSyncRender.lua's S.Render) joins its whole
  // output array — including "WOWSYNC v1", "Generated: ...", and
  // "Format: ..." — with "\n\n". So those three lines are three separate
  // blank-line-separated chunks, not one three-line block.
  if (chunks[0]?.trim() !== "WOWSYNC v1") {
    fail(`Export must begin with "WOWSYNC v1". This does not look like a WoWSync export.`, chunks[0]?.slice(0, 80));
  }
  const [generatedRaw] = takeLine([chunks[1] ?? ""], 0, "Generated: ", true);
  const generatedAt = fieldNumber(generatedRaw);
  const formatLine = chunks[2];

  const lastChunk = chunks[chunks.length - 1].trim();
  if (lastChunk !== "[END]") {
    fail('Export must end with "[END]". The export may have been truncated when copied.', lastChunk.slice(0, 80));
  }

  const sectionChunks = chunks.slice(3, -1);
  const result: Partial<ParsedSnapshot> = {};
  const seen = new Set<string>();

  for (const chunk of sectionChunks) {
    const lines = chunk.split("\n");
    const headerLine = lines[0];
    const match = /^\[(.+)\]$/.exec(headerLine ?? "");
    if (!match) fail("Expected a [SECTION] header", headerLine);
    const label = match[1];
    const key = SECTION_LABELS[label];
    if (!key) fail(`Unknown section "[${label}]"`, headerLine);
    if (seen.has(key)) fail(`Duplicate section "[${label}]"`, headerLine);
    seen.add(key);
    const parser = SECTION_PARSERS[key];
    (result as any)[key] = parser(lines.slice(1));
  }

  const required: (keyof ParsedSnapshot)[] = [
    "character",
    "location",
    "equipment",
    "bags",
    "bank",
    "professions",
    "spells",
    "trainer",
  ];
  const missing = required.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    fail(`Export is missing required section(s): ${missing.map((m) => m.toUpperCase()).join(", ")}`);
  }
  if (result.accountBank && result.character?.clientFamily?.toLowerCase() !== "retail") {
    fail("[ACCOUNT BANK] is only valid for a Retail export");
  }

  return {
    raw,
    generatedAt,
    formatLine,
    character: result.character!,
    location: result.location!,
    equipment: result.equipment!,
    bags: result.bags!,
    bank: result.bank!,
    accountBank: result.accountBank,
    professions: result.professions!,
    spells: result.spells!,
    trainer: result.trainer!,
  };
}
