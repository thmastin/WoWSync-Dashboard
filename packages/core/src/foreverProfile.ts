/**
 * Forever client profile handling.
 *
 * Storage is never gated on an exact client build: a well-formed Forever
 * export from any build is imported and its structured sidecars retained, so
 * a client update (e.g. the Forever launch build) cannot silently discard
 * evidence. Interpretation that depends on build-specific API semantics
 * (item tuple positions, stat labels) stays limited to VERIFIED_FOREVER_BUILDS;
 * everything else is labelled with its build verification state.
 */

/** Builds whose API return shapes were live- or source-verified. */
export const VERIFIED_FOREVER_BUILDS: readonly string[] = ["70291", "70338"];

export type ForeverBuildVerification = "VERIFIED" | "UNVERIFIED_BUILD";

export interface ForeverClientFields { clientFamily?: string; clientVersion?: string; clientBuild?: string; interface?: string }

const VERSION = /^\d+\.\d+\.\d+$/;
const DIGITS = /^\d+$/;
const PROFILE = /^Forever:(\d+\.\d+\.\d+):(\d+):(\d+)$/;

/** True for a well-formed Forever client identity on any build. */
export function isForeverClient(character: ForeverClientFields): boolean {
  return character.clientFamily === "Forever"
    && VERSION.test(character.clientVersion ?? "")
    && DIGITS.test(character.clientBuild ?? "")
    && DIGITS.test(character.interface ?? "");
}

/** "Forever:<version>:<build>:<interface>" for a well-formed Forever client, else undefined. */
export function foreverProfileOf(character: ForeverClientFields): string | undefined {
  return isForeverClient(character) ? `Forever:${character.clientVersion}:${character.clientBuild}:${character.interface}` : undefined;
}

export function parseForeverProfile(profile: unknown): { clientVersion: string; clientBuild: string; interface: string } | undefined {
  const match = typeof profile === "string" ? PROFILE.exec(profile) : null;
  return match ? { clientVersion: match[1]!, clientBuild: match[2]!, interface: match[3]! } : undefined;
}

export function isForeverProfile(profile: unknown): profile is `Forever:${string}` {
  return parseForeverProfile(profile) !== undefined;
}

export function foreverBuildVerification(build: string | undefined): ForeverBuildVerification {
  return build !== undefined && VERIFIED_FOREVER_BUILDS.includes(build) ? "VERIFIED" : "UNVERIFIED_BUILD";
}
