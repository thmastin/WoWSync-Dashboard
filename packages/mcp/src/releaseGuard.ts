import path from "node:path";

export function isStaleRelease(sourceFile: string, currentReleaseLink: string, realpath: (value: string) => string): boolean {
  const normalizedFile = sourceFile.replace(/\\/g, "/");
  const parts = normalizedFile.split("/");
  const releasesAt = parts.lastIndexOf("releases");
  if (releasesAt < 0 || !/^[0-9a-f]{40}$/i.test(parts[releasesAt + 1] ?? "")) return false;
  const releaseRoot = parts.slice(0, releasesAt + 1).join("/");
  try { return realpath(currentReleaseLink).replace(/\\/g, "/") !== path.posix.join(releaseRoot, parts[releasesAt + 1]); }
  catch { return true; }
}
