// Synthetic WoW-style SavedVariables text, shared by the developer bridge (importSaved.test.ts) and the watcher
// (watchSaved.test.ts). Nothing here touches a real WoW install.
import { renderExport, type ExportSpec } from "../../core/test/sharedStorageExports.ts";

/** A Lua string literal the way WoW writes one: backslash, quote, newline and carriage return escaped; tabs raw. */
export const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;

export interface SavedRecord {
  guid: string;
  name?: string;
  realm?: string;
  /** The export text persisted as latestExport.text; omit for a character with no saved export. */
  text?: string;
  generatedAt?: number;
  /** Raw Lua for `sections.currencies`, used only by bridge tests. */
  currencies?: string;
  professionRecipes?: string;
  /** Raw Lua for the canonical `sections.equipment` envelope (see equipmentLua). */
  equipment?: string;
  /** Raw Lua for GearExport's `latestExport.specEquipmentObservation` projection. */
  specProjection?: string;
  captureProfile?: string;
  bags?: string;
  bank?: string;
  itemMetadata?: string;
}

export function savedVariables(records: SavedRecord[], opts: { schemaVersion?: number | null; legacy?: string } = {}): string {
  const lines = ["", "GearExportDB = {", '["exports"] = {', "},", opts.legacy ?? "", "}", "WoWSyncDB = {"];
  if (opts.schemaVersion !== null) lines.push(`["schemaVersion"] = ${opts.schemaVersion ?? 1},`);
  lines.push('["settings"] = {', '["showButton"] = false,', "},", '["characters"] = {');
  for (const r of records) {
    lines.push(`[${q(r.guid)}] = {`, '["identity"] = {', `["guid"] = ${q(r.guid)},`);
    if (r.name !== undefined) lines.push(`["name"] = ${q(r.name)},`);
    if (r.realm !== undefined) lines.push(`["realm"] = ${q(r.realm)},`);
    lines.push("},", '["sections"] = {');
    if (r.currencies !== undefined) lines.push(`["currencies"] = ${r.currencies},`);
    if (r.professionRecipes !== undefined) lines.push(`["professionRecipes"] = ${r.professionRecipes},`);
    if (r.equipment !== undefined) lines.push(`["equipment"] = ${r.equipment},`);
    if (r.bags !== undefined) lines.push(`["bags"] = ${r.bags},`);
    if (r.bank !== undefined) lines.push(`["bank"] = ${r.bank},`);
    lines.push("},", '["visits"] = {', "},");
    if (r.text !== undefined || r.specProjection !== undefined) {
      lines.push('["latestExport"] = {', `["generatedAt"] = ${r.generatedAt ?? 0},`);
      if (r.text !== undefined) lines.push(`["text"] = ${q(r.text)},`);
      if (r.specProjection !== undefined) lines.push(`["specEquipmentObservation"] = ${r.specProjection},`);
      lines.push("},");
    }
    if (r.captureProfile !== undefined) lines.push(`["captureProfile"] = ${q(r.captureProfile)},`);
    if (r.itemMetadata !== undefined) lines.push(`["itemMetadata"] = ${r.itemMetadata},`);
    lines.push("},");
  }
  lines.push("},", "}", "");
  return lines.join("\r\n");
}

/** A rendered WOWSYNC v1 export for one character. */
export const exportFor = (name: string, generated: number, over: Partial<ExportSpec> = {}) => renderExport({ name, generated, ...over });

export const record = (name: string, generated: number, over: Partial<SavedRecord> & { spec?: Partial<ExportSpec> } = {}): SavedRecord => {
  const { spec, ...rest } = over;
  return { guid: `Player-1168-${name.toUpperCase().padEnd(8, "0")}`, name, realm: spec?.realm ?? "Cairne", text: exportFor(name, generated, spec), generatedAt: generated, ...rest };
};

/**
 * Plain JSON as WoW-style Lua: string keys as ["key"], integer-string keys (equipment slots) and array positions as
 * numeric [n] keys, so the bridge's luaToPlain sees exactly what GearExport persists.
 */
export function toLua(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return q(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `{\r\n${value.map((v, i) => `[${i + 1}] = ${toLua(v)},`).join("\r\n")}\r\n}`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return `{\r\n${entries.map(([k, v]) => `[${/^[1-9][0-9]*$/.test(k) ? k : q(k)}] = ${toLua(v)},`).join("\r\n")}\r\n}`;
}
