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
export const VERIFIED_FOREVER_BUILDS: readonly string[] = ["70291", "70338", "70450"];

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

/** Gear-screen intake floor: preserves capture from the supported Forever 1.60.1 client family at/after build 70291. */
export function supportsForeverGearEvaluation(profile: unknown): boolean {
  const parsed = parseForeverProfile(profile);
  const build = parsed ? Number(parsed.clientBuild) : NaN;
  return parsed?.clientVersion === "1.60.1" && parsed.interface === "16001" && Number.isSafeInteger(build) && build >= 70291;
}

/**
 * Exact version:build:interface profiles with direct compatibility evidence; mirrors GearExport's
 * VERIFIED_PROFILE table (WoWSyncCompat knownProfiles). A known build on another version or interface is not verified.
 */
export const VERIFIED_FOREVER_PROFILES: readonly string[] = ["1.60.1:70291:16001", "1.60.1:70338:16001", "1.60.1:70450:16001"];

/**
 * VERIFIED only for an exact verified profile. Given only a build (legacy callers), the build must be one of
 * VERIFIED_FOREVER_BUILDS; given a full client identity, the whole version/build/interface triple must match.
 */
export function foreverBuildVerification(client: string | ForeverClientFields | undefined): ForeverBuildVerification {
  if (client === undefined) return "UNVERIFIED_BUILD";
  if (typeof client === "string") return VERIFIED_FOREVER_BUILDS.includes(client) ? "VERIFIED" : "UNVERIFIED_BUILD";
  return VERIFIED_FOREVER_PROFILES.includes(`${client.clientVersion}:${client.clientBuild}:${client.interface}`) ? "VERIFIED" : "UNVERIFIED_BUILD";
}

/**
 * The exporter's own compatibility claim beside the Dashboard's verdict. GearExport 2c5e9b3+ writes
 * VERIFIED_PROFILE or UNVERIFIED_BUILD; older exporters write nothing (NOT_STATED). A disagreement is
 * surfaced, never resolved in favour of the more optimistic side.
 */
export function foreverCompatibility(character: ForeverClientFields & { exporterCompatibility?: string; exporterCompatibilityNote?: string }): { dashboard: ForeverBuildVerification; exporter: string; exporterNote?: string; agreement: "AGREE" | "DISAGREE" | "EXPORTER_NOT_STATED" } {
  const dashboard = foreverBuildVerification(character);
  const exporter = character.exporterCompatibility ?? "NOT_STATED";
  const agreement = exporter === "NOT_STATED" ? "EXPORTER_NOT_STATED" as const
    : (exporter === "VERIFIED_PROFILE") === (dashboard === "VERIFIED") ? "AGREE" as const : "DISAGREE" as const;
  return { dashboard, exporter, ...(character.exporterCompatibilityNote ? { exporterNote: character.exporterCompatibilityNote } : {}), agreement };
}
