// Process entry for `npm run watch:saved -- <options>` (see watchSaved.ts for everything it does and never does).
import { nodeFs, runWatchSaved, USAGE } from "./watchSaved.ts";

// The same optional .env the server reads (WOWSYNC_SAVED_VARIABLES, WOWSYNC_WOW_DIR, WOWSYNC_URL, PORT, WOWSYNC_HOST).
try {
  process.loadEnvFile();
} catch (err) {
  if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
}

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
} catch (err) {
  console.error(`error: unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
  console.error(USAGE.split("\n")[0]);
  process.exitCode = 1;
}
