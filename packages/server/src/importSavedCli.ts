// Process entry for `npm run import:saved -- <options>` (see importSaved.ts for everything it does and never does).
import { runImportSaved, USAGE } from "./importSaved.ts";

// The same optional .env the server reads (WOWSYNC_SAVED_VARIABLES, WOWSYNC_WOW_DIR, WOWSYNC_URL, PORT, WOWSYNC_HOST).
try {
  process.loadEnvFile();
} catch (err) {
  if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
}

try {
  const result = await runImportSaved(process.argv.slice(2), {
    env: process.env,
    now: () => Math.floor(Date.now() / 1000),
    fetch,
  });
  for (const line of result.stdout) console.log(line);
  for (const line of result.stderr) console.error(line);
  process.exitCode = result.exitCode;
} catch (err) {
  console.error(`error: unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
  console.error(USAGE.split("\n")[0]);
  process.exitCode = 1;
}
