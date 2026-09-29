import { existsSync, mkdirSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "./app.ts";
import { createCaptureApp } from "./captureReceiver.ts";
import {
  ConfigError,
  allowedHostsFor,
  classifyAddress,
  describeListening,
  exposureWarning,
  listenOnUnixSocket,
  listenOnce,
  loopbackOrigin,
  resolveHost,
  resolveListenSocket,
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
let listenSocket: string | undefined;
let capturePort: number;
try {
  bind = resolveHost(process.env);
  port = resolvePort(process.env);
  listenSocket = resolveListenSocket(process.env);
  capturePort = process.env.WOWSYNC_CAPTURE_PORT?.trim() ? resolvePort({ PORT: process.env.WOWSYNC_CAPTURE_PORT }) : 4175;
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const captureToken = process.env.WOWSYNC_CAPTURE_TOKEN?.trim();
const captureDirectory = process.env.WOWSYNC_CAPTURE_DIR?.trim();
const captureTarget = process.env.WOWSYNC_CAPTURE_TARGET?.trim();
const captureRequested = !!(captureToken || captureDirectory || captureTarget);
if (captureRequested && (!captureToken || !captureDirectory || !captureTarget)) {
  console.error("Authenticated capture receiver configuration is incomplete: set WOWSYNC_CAPTURE_TOKEN, WOWSYNC_CAPTURE_DIR, and WOWSYNC_CAPTURE_TARGET together.");
  process.exit(1);
}
if (captureRequested && (captureToken!.length < 32 || !path.isAbsolute(captureDirectory!) || !/^[A-Z][A-Z0-9_-]{1,15}$/.test(captureTarget!))) {
  console.error("Capture receiver configuration is invalid: token must be 32+ characters, directory absolute, and target a short uppercase name.");
  process.exit(1);
}
if (captureRequested && capturePort === port) {
  console.error("WOWSYNC_CAPTURE_PORT must differ from the Dashboard PORT.");
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

let server: http.Server | undefined;
let captureServer: http.Server | undefined;
try {
  server = listenSocket ? await listenOnUnixSocket(app, listenSocket) : await listenOnce(app, bind.host, port);
  if (captureRequested) {
    const captureApp = createCaptureApp(store, { token: captureToken!, directory: captureDirectory!, target: captureTarget! });
    captureServer = await listenOnce(captureApp, "127.0.0.1", capturePort);
    console.log(`Authenticated capture receiver listening on http://127.0.0.1:${capturePort} (loopback only; target ${captureTarget})`);
  }
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  server?.close();
  captureServer?.close();
  store.close();
  process.exit(1);
}

if (!server) {
  store.close();
  process.exit(1);
}

// Report what the OS actually bound (not what was asked for): the exposure warning and the
// startup line are based on the real socket address, so no spelling of a wildcard can slip through.
const address = server.address();
if (typeof address === "string") {
  console.log(`WoWSync Dashboard server listening on Unix socket ${address}`);
} else if (address && typeof address === "object") {
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
  server?.close();
  captureServer?.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
