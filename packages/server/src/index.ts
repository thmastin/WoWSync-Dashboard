import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "./app.ts";

// Load a local .env file if present (OPENAI_API_KEY, WOWSYNC_LLM_MODEL,
// PORT, etc.) — never required, never committed (.env is gitignored).
try {
  process.loadEnvFile();
} catch (err) {
  if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "../../../");
const dataDir = process.env.WOWSYNC_DATA_DIR ?? path.join(repoRoot, "data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.WOWSYNC_DB_PATH ?? path.join(dataDir, "wowsync.sqlite");

const store = new SqliteSnapshotStore(dbPath);
const port = Number(process.env.PORT ?? 4173);
const webDist = path.join(repoRoot, "packages", "web", "dist");

const app = createApp(store, port, webDist);

app.listen(port, () => {
  console.log(`WoWSync Dashboard server listening on http://localhost:${port}`);
  console.log(`Database: ${dbPath}`);
  if (!existsSync(webDist)) {
    console.log(`(Web UI not built yet — run "npm run build:web", or run "npm run dev:web" for the dev server.)`);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.log(`(Ask My Account is disabled — set OPENAI_API_KEY to enable it. See README.)`);
  }
});

process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});
