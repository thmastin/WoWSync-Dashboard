import { existsSync, mkdirSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "./app.ts";
import {
  ConfigError,
  allowedHostsFor,
  classifyAddress,
  describeListening,
  exposureWarning,
  listenOnce,
  loopbackOrigin,
  resolveHost,
  resolvePort,
  type ResolvedHost,
} from "./net.ts";

// Load a local .env file if present (OPENAI_API_KEY, WOWSYNC_LLM_MODEL,
// PORT, WOWSYNC_HOST, etc.) — never required, never committed (.env is gitignored).
try {
  process.loadEnvFile();
} catch (err) {
  if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
}

// Validate the network configuration BEFORE touching the database, and refuse
// to start on a bad value rather than guess (a wrong guess could listen on
// every network interface).
let bind: ResolvedHost;
let port: number;
try {
  bind = resolveHost(process.env);
  port = resolvePort(process.env);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "../../../");
const dataDir = process.env.WOWSYNC_DATA_DIR ?? path.join(repoRoot, "data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.WOWSYNC_DB_PATH ?? path.join(dataDir, "wowsync.sqlite");

const store = new SqliteSnapshotStore(dbPath);
const webDist = path.join(repoRoot, "packages", "web", "dist");

const app = createApp(store, port, webDist, {
  selfOrigin: loopbackOrigin(bind.host, port),
  // Loopback binds also get the Host/Origin guard (DNS-rebinding hardening), allowing the
  // bind's own address too. A deliberate wider bind serves whatever Host it is reached by.
  allowedHosts: allowedHostsFor(bind),
});

let server: http.Server;
try {
  server = await listenOnce(app, bind.host, port);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  store.close();
  process.exit(1);
}

// Report what the OS actually bound (not what was asked for): the exposure warning and the
// startup line are based on the real socket address, so no spelling of a wildcard can slip through.
const address = server.address();
if (address && typeof address === "object") {
  console.log(`WoWSync Dashboard server listening on ${describeListening(address)}`);
  const warning = exposureWarning({ host: address.address, exposure: classifyAddress(address.address) }, address.port);
  if (warning) console.warn(`\n${warning}\n`);
} else {
  console.log(`WoWSync Dashboard server listening on port ${port}`);
}
console.log(`Database: ${dbPath}`);
if (!existsSync(webDist)) {
  console.log(`(Web UI not built yet — run "npm run build:web", or run "npm run dev:web" for the dev server.)`);
}
if (!process.env.OPENAI_API_KEY) {
  console.log(`(Ask My Account is disabled — set OPENAI_API_KEY to enable it. See README.)`);
}

function shutdown() {
  server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
