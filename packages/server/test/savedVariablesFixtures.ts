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
}

export function savedVariables(records: SavedRecord[], opts: { schemaVersion?: number | null; legacy?: string } = {}): string {
  const lines = ["", "GearExportDB = {", '["exports"] = {', "},", opts.legacy ?? "", "}", "WoWSyncDB = {"];
  if (opts.schemaVersion !== null) lines.push(`["schemaVersion"] = ${opts.schemaVersion ?? 1},`);
  lines.push('["settings"] = {', '["showButton"] = false,', "},", '["characters"] = {');
  for (const r of records) {
    lines.push(`[${q(r.guid)}] = {`, '["identity"] = {', `["guid"] = ${q(r.guid)},`);
    if (r.name !== undefined) lines.push(`["name"] = ${q(r.name)},`);
    if (r.realm !== undefined) lines.push(`["realm"] = ${q(r.realm)},`);
    lines.push("},", '["sections"] = {', "},", '["visits"] = {', "},");
    if (r.text !== undefined) lines.push('["latestExport"] = {', `["generatedAt"] = ${r.generatedAt ?? 0},`, `["text"] = ${q(r.text)},`, "},");
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
