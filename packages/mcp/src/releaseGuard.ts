import path from "node:path";

function normalized(value: string): string { return value.replace(/\\/g, "/"); }

/** Capture the process release once, then resolve releases/current on every call. */
export function createReleaseGuard(startupFile: string, currentReleaseLink: string, realpath: (value: string) => string): () => boolean {
  let startupRelease: string | undefined;
  let startupResolutionFailed = false;
  try {
    const resolvedStartupFile = normalized(realpath(startupFile));
    const parts = resolvedStartupFile.split("/");
    const releasesAt = parts.lastIndexOf("releases");
    const sha = parts[releasesAt + 1];
    if (releasesAt >= 0 && /^[0-9a-f]{40}$/i.test(sha ?? "")) {
      startupRelease = path.posix.join(parts.slice(0, releasesAt + 1).join("/"), sha!);
    }
  } catch {
    startupResolutionFailed = true;
  }

  return () => {
    if (startupResolutionFailed) return true;
    if (!startupRelease) return false;
    try { return normalized(realpath(currentReleaseLink)) !== startupRelease; }
    catch { return true; }
  };
}

/** One-shot compatibility helper for callers/tests that do not need a process-lifetime guard. */
export function isStaleRelease(sourceFile: string, currentReleaseLink: string, realpath: (value: string) => string): boolean {
  return createReleaseGuard(sourceFile, currentReleaseLink, realpath)();
}
