import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createWoWSyncMcpServer, defaultMcpConfiguration } from "./server.ts";

const defaults = defaultMcpConfiguration();
const configuration = {
  databasePath: process.env.WOWSYNC_MCP_DB_PATH || defaults.databasePath,
  researchRoot: process.env.WOWSYNC_MCP_RESEARCH_ROOT || defaults.researchRoot,
  planningApiBaseUrl: process.env.WOWSYNC_MCP_PLANNING_API_URL || undefined,
};

let transport: ReturnType<typeof serveStdio> | undefined;
try {
  transport = serveStdio(() => createWoWSyncMcpServer(configuration).server, {
    onerror: (error) => process.stderr.write(`WoWSync MCP transport error: ${error.message}\n`),
  });
  const shutdown = async () => {
    try { await transport?.close(); } finally { process.exit(0); }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`WoWSync MCP startup failed: ${message}\n`);
  try { await transport?.close(); } catch { /* best-effort close only */ }
  process.exitCode = 1;
}
