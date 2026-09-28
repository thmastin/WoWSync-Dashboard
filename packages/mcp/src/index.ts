import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createWoWSyncMcpServer, defaultMcpConfiguration } from "./server.ts";

const defaults = defaultMcpConfiguration();
const configuration = {
  databasePath: process.env.WOWSYNC_MCP_DB_PATH || defaults.databasePath,
  researchRoot: process.env.WOWSYNC_MCP_RESEARCH_ROOT || defaults.researchRoot,
};

let instance: ReturnType<typeof createWoWSyncMcpServer> | undefined;
try {
  instance = createWoWSyncMcpServer(configuration);
  const transport = new StdioServerTransport();
  transport.onerror = (error) => process.stderr.write(`WoWSync MCP transport error: ${error.message}\n`);
  await instance.server.connect(transport);
  const shutdown = async () => {
    try { await instance?.close(); } finally { process.exit(0); }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`WoWSync MCP startup failed: ${message}\n`);
  try { await instance?.close(); } catch { /* best-effort close only */ }
  process.exitCode = 1;
}
