import { loadPolestarCodexDirectory, importPolestarCodex } from "@wowsync-dashboard/core/polestarCodex.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = process.env.WOWSYNC_POLESTAR_CODEX_PATH;
if (!source?.trim()) throw new Error("Set WOWSYNC_POLESTAR_CODEX_PATH to the local Polestar_Codex directory.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dbPath = process.env.WOWSYNC_DB_PATH ?? path.join(root, "data", "wowsync.sqlite");
const dataset = loadPolestarCodexDirectory(source);
const result = importPolestarCodex(dbPath, dataset);
console.log(JSON.stringify({ status: "IMPORTED", source: "polestar-codex", provenance: "REFERENCE", ...result }));
