// Process entry for `npm run watch:saved -- <options>` (see watchSaved.ts for everything it does and never does).
import { nodeFs, runWatchSaved, USAGE } from "./watchSaved.ts";
import { createCaptureStatusWriter } from "./captureStatus.ts";
import path from "node:path";

// The same optional .env the server reads (WOWSYNC_SAVED_VARIABLES, WOWSYNC_WOW_DIR, WOWSYNC_URL, PORT, WOWSYNC_HOST).
try {
  process.loadEnvFile();
} catch (err) {
  if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
}

const statusPath = process.env.WOWSYNC_CAPTURE_STATUS_PATH?.trim();
if (statusPath && !path.isAbsolute(statusPath)) throw new Error("WOWSYNC_CAPTURE_STATUS_PATH must be an absolute path.");
const status = statusPath ? createCaptureStatusWriter(statusPath) : undefined;
status?.write({ serviceState: "running" });
const heartbeat = status ? setInterval(() => status.write(), 30_000) : undefined;
heartbeat?.unref();

const stamp = () => new Date().toLocaleTimeString();
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  process.exitCode = await runWatchSaved(process.argv.slice(2), {
    env: process.env,
    fs: nodeFs,
    clock: () => performance.now(),
    fetch,
    out: (line) => console.log(line.startsWith(" ") || line === "" ? line : `[${stamp()}] ${line}`),
    err: (line) => console.error(line.startsWith(" ") || line === "" ? line : `[${stamp()}] ${line}`),
    status: (event) => status?.apply(event),
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done);
      }),
  }, controller.signal);
  if (controller.signal.aborted) console.log("Stopped.");
  if (status) status.write({ serviceState: "stopped" });
} catch (err) {
  console.error(`error: unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
  console.error(USAGE.split("\n")[0]);
  if (status) status.apply({ type: "error", at: new Date().toISOString(), message: err instanceof Error ? err.message : String(err) });
  if (status) status.write({ serviceState: "stopped" });
  process.exitCode = 1;
} finally {
  if (heartbeat) clearInterval(heartbeat);
}
