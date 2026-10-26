import { loadPolestarCodexDirectory, importPolestarCodex } from "@wowsync-dashboard/core/polestarCodex.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = process.env.WOWSYNC_POLESTAR_CODEX_PATH;
if (!source?.trim()) throw new Error("Set WOWSYNC_POLESTAR_CODEX_PATH to the local Polestar_Codex directory.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dbPath = process.env.WOWSYNC_DB_PATH ?? path.join(root, "data", "wowsync.sqlite");
try {
  const dataset = loadPolestarCodexDirectory(source);
  const counts = Object.fromEntries([...new Set(dataset.records.map((record) => record.kind))].sort().map((kind) => [kind, dataset.records.filter((record) => record.kind === kind).length]));
  const result = importPolestarCodex(dbPath, dataset);
  console.log(JSON.stringify({ status: "IMPORTED", source: "polestar-codex", provenance: "REFERENCE", ...result, counts }));
} catch (error) {
  console.error(JSON.stringify({ status: "ERROR", source: "polestar-codex", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
