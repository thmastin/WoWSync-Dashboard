// Renders WOWSYNC v1 export TEXT (minimal Retail exports) whose [ACCOUNT BANK] / [GUILD BANK]
// sections come from the sharedStorageBuilders sections, in the addon's format
// (GearExport/WoWSyncRender.lua @ 3e9c6bf), so persistence tests go through the real parser and
// importer. Everything unrelated to shared storage is UNKNOWN, exactly like the sanitized Virek
// fixtures. Not a test file (the test glob is *.test.ts).
import type { AccountBankSection, GuildBankSection, InventorySection, SectionStatus } from "../src/types.ts";

const T = "\t";
const cell = (value: unknown): string => (value === undefined || value === null ? "?" : typeof value === "boolean" ? (value ? "yes" : "no") : String(value));
const row = (...values: unknown[]): string => values.map(cell).join(T);

function statusLines(status: SectionStatus): string[] {
  const out: string[] = [];
  if (status.lastVisit !== undefined) out.push(`LastVisit: ${status.lastVisit}`);
  if (status.visitedNPC !== undefined) out.push(`VisitedNPC: ${status.visitedNPC}`);
  if (status.visitedZone !== undefined) out.push(`VisitedZone: ${status.visitedZone}`);
  if (status.visitStatus !== undefined) out.push(`VisitStatus: ${status.visitStatus}`);
  out.push(`State: ${status.state}; ${status.completeness ?? "complete"}; observed=${cell(status.observedAt)}`);
  if (status.pending) out.push("Pending: Refresh pending; showing last observation");
  if (status.coverageNote !== undefined) out.push(`CoverageNote: ${status.coverageNote}`);
  if (status.refreshIssue !== undefined) out.push(`RefreshIssue: ${status.refreshIssue}`);
  return out;
}

function inventoryLines(section: AccountBankSection | GuildBankSection | InventorySection): string[] {
  const out = [row("container", "capacity", "free", "family", "bagRef")];
  for (const c of section.containers) {
    if (c.storage !== undefined) out.push(`ContainerStorage ${c.id}: ${c.storage}`);
    out.push(row(c.id, c.capacity, c.free, c.family, c.bagRef));
  }
  out.push(`Slots: ${cell(section.freeSlots)} free / ${cell(section.totalSlots)}`);
  out.push(row("itemRef", "name", "qty", "bound", "vendorEachCopper"));
  if (section.items.length === 0 && section.itemsKnownEmpty) out.push("Items: EMPTY");
  for (const i of section.items) out.push(row(i.itemRef, i.name, i.qty, i.bound, i.vendorEachCopper));
  return out;
}

/** A Character-bag section in the addon's format (State line, then the container / slots / item body). */
export function renderBags(section: InventorySection): string {
  return ["[BAGS]", ...statusLines(section.status), ...inventoryLines(section)].join("\n");
}

/** One row of the addon's `[ITEM METADATA]` block; an omitted facet is `?` (UNKNOWN), and a boolean renders yes / no. */
export interface MetadataRowSpec {
  id: number | string;
  classId?: number | string;
  subclassId?: number | string;
  bindType?: number | string;
  expansionId?: number | string;
  reagent?: boolean | string;
}

export const METADATA_HEADER = ["baseItemID", "classID", "subclassID", "bindType", "expansionID", "isCraftingReagent"].join(T);

/** The block exactly as GearExport a94288e renders it: a header row, then one row per item (the caller keeps them ascending). */
export function renderItemMetadata(rows: MetadataRowSpec[]): string {
  return ["[ITEM METADATA]", METADATA_HEADER, ...rows.map((r) => row(r.id, r.classId, r.subclassId, r.bindType, r.expansionId, r.reagent))].join("\n");
}

export function renderWarband(section: AccountBankSection): string {
  return [
    "[ACCOUNT BANK]",
    ...statusLines(section.status),
    "Scope: ACCOUNT_WARBAND",
    `Coverage: ${section.coverage ?? "ACCOUNT/Warband purchased tabs only"}`,
    `SnapshotVisit: ${cell(section.snapshotVisit)}`,
    `PurchasedBankTabs: ${cell(section.purchasedBankTabs)}`,
    ...inventoryLines(section),
  ].join("\n");
}

export function renderGuild(section: GuildBankSection): string {
  return [
    "[GUILD BANK]",
    ...statusLines(section.status),
    "Scope: GUILD",
    `GuildClubID: ${cell(section.guildClubId)}`,
    `GuildName: ${cell(section.guildName)}`,
    `Coverage: ${section.coverage ?? "All tabs currently reported viewable were serialized through QueryGuildBankTab; inaccessible tabs were not scanned."}`,
    `SnapshotVisit: ${cell(section.snapshotVisit)}`,
    row("tab", "name", "viewable", "state", "note"),
    ...section.tabs.map((t) => row(t.id, t.name, t.viewable, t.state, t.note)),
    ...inventoryLines(section),
  ].join("\n");
}

const UNKNOWN_WARBAND = "[ACCOUNT BANK]\nState: UNKNOWN\nScope: ACCOUNT_WARBAND\nReason: Not observed";
const UNKNOWN_GUILD = "[GUILD BANK]\nState: UNKNOWN\nScope: GUILD\nReason: Not observed";
const unknown = (label: string) => `[${label}]\nState: UNKNOWN\nReason: Not observed`;

export interface ExportSpec {
  name: string;
  realm?: string;
  /** The export's Generated timestamp. */
  generated: number;
  /** Omitted = the addon's default for a bank never observed: `State: UNKNOWN`. */
  warband?: AccountBankSection;
  guild?: GuildBankSection;
  /** Vary this to make two otherwise identical exports different text (so they are not whole-export duplicates). */
  level?: number;
  /** The character's own bags. Omitted = `State: UNKNOWN`. */
  bags?: InventorySection;
  /** An `[ITEM METADATA]` block: rows to render, or the exact block text (for malformed-input tests). Omitted = no such section (a legacy export). */
  itemMetadata?: MetadataRowSpec[] | string;
  /** Client build line; defaults to the current Retail build used by the Virek fixtures. */
  build?: string;
}

/** A minimal Retail export in the addon's section order. */
export function renderExport(spec: ExportSpec): string {
  return [
    "WOWSYNC v1",
    `Generated: ${spec.generated}`,
    "Format: tab-separated columns; ?=unknown; timestamps=Unix seconds; money=copper; itemRef preserves item variants.",
    [
      "[CHARACTER]",
      `State: OBSERVED; complete; observed=${spec.generated}`,
      `Name: ${spec.name}`,
      `Realm: ${spec.realm ?? "Cairne"}`,
      "Class: ?",
      `Level: ${spec.level ?? "?"}`,
      "Faction: ?",
      "MoneyCopper: ?",
      `Client: 12.1.0 build ${spec.build ?? "69875"}`,
      "ClientFamily: Retail",
      "Interface: 120100",
    ].join("\n"),
    unknown("LOCATION"),
    unknown("EQUIPMENT"),
    spec.bags ? renderBags(spec.bags) : unknown("BAGS"),
    unknown("BANK"),
    spec.warband ? renderWarband(spec.warband) : UNKNOWN_WARBAND,
    spec.guild ? renderGuild(spec.guild) : UNKNOWN_GUILD,
    unknown("PROFESSIONS"),
    unknown("KNOWN SPELLS"),
    unknown("TRAINERS"),
    ...(spec.itemMetadata === undefined ? [] : [typeof spec.itemMetadata === "string" ? spec.itemMetadata : renderItemMetadata(spec.itemMetadata)]),
    "[END]",
  ].join("\n\n") + "\n";
}
