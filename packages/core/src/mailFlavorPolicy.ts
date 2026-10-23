import type { CharacterSection } from "./types.ts";
import { RECENT_THRESHOLD_SECONDS } from "./freshness.ts";

export type MailFlavor = "classic-era" | "forever";
export const CLASSIC_ERA_MAIL_RULESET = "classic-era-build-70003-mail-v1";
export const FOREVER_MAIL_RULESET = "forever-min-70291-allocation-screen-v3";
export const CLASSIC_ERA_VERIFIED_BUILDS = ["70003"] as const;

export interface FlavorMailPolicy {
  flavor: MailFlavor;
  ruleset: typeof CLASSIC_ERA_MAIL_RULESET | typeof FOREVER_MAIL_RULESET;
  freshnessSeconds: number;
  verifiedBuilds: readonly string[];
  auctionPriceSource: "UNKNOWN" | "FOREVER_MARKET";
}

export interface MailPlanGroups {
  gear: unknown[];
  materials: unknown[];
  pouches?: unknown[];
  sale: unknown[];
  keep: unknown[];
}

export function orchestrateFlavorMailPlan(policy: FlavorMailPolicy, groups: MailPlanGroups): { version: MailFlavor; ruleset: string; steps: Array<{ kind: string; action: unknown }> } {
  return {
    version: policy.flavor,
    ruleset: policy.ruleset,
    steps: [
      ...groups.gear.map((action) => ({ kind: "GEAR_MAIL", action })),
      ...groups.materials.map((action) => ({ kind: "MATERIAL_MAIL", action })),
      ...(groups.pouches ?? []).map((action) => ({ kind: "POUCH_MAIL", action })),
      ...groups.sale.map((action) => ({ kind: "SALE", action })),
      ...groups.keep.map((action) => ({ kind: "KEEP", action })),
    ],
  };
}

export const MAIL_FLAVOR_POLICIES = Object.freeze({
  "classic-era": { flavor: "classic-era", ruleset: CLASSIC_ERA_MAIL_RULESET, freshnessSeconds: 72 * 60 * 60, verifiedBuilds: CLASSIC_ERA_VERIFIED_BUILDS, auctionPriceSource: "UNKNOWN" },
  forever: { flavor: "forever", ruleset: FOREVER_MAIL_RULESET, freshnessSeconds: RECENT_THRESHOLD_SECONDS, verifiedBuilds: ["70291", "70338", "70450"], auctionPriceSource: "FOREVER_MARKET" },
} satisfies Readonly<Record<MailFlavor, FlavorMailPolicy>>);

export function classicEraBuildVerification(character: Pick<CharacterSection, "clientVersion" | "clientBuild" | "clientFamily">): "VERIFIED" | "UNVERIFIED_BUILD" | "UNSUPPORTED" {
  if (character.clientFamily !== undefined || !/^1\.\d+\.\d+$/.test(character.clientVersion ?? "") || !/^\d+$/.test(character.clientBuild ?? "")) return "UNSUPPORTED";
  const build = Number(character.clientBuild);
  if (!Number.isSafeInteger(build) || build < 70003) return "UNSUPPORTED";
  return CLASSIC_ERA_VERIFIED_BUILDS.includes(character.clientBuild as "70003") ? "VERIFIED" : "UNVERIFIED_BUILD";
}

export function classicEraGuidContinuity(guid: string | undefined, priorGuids: readonly (string | undefined)[]): { state: "OBSERVED" | "UNKNOWN"; reason?: string } {
  if (!guid || guid === "UNKNOWN") return { state: "UNKNOWN", reason: "Classic Era GUID is missing or UNKNOWN; identity continuity cannot be established." };
  const known = [...new Set(priorGuids.filter((value): value is string => !!value && value !== "UNKNOWN"))];
  if (known.some((value) => value !== guid)) return { state: "UNKNOWN", reason: "Classic Era GUID changed between snapshots; evidence is quarantined pending identity review." };
  return { state: "OBSERVED" };
}

export function deriveClassicEraSpec(talentTree: Array<{ name: string; pointsSpent?: number }> | undefined, talentStatus: "OBSERVED" | "UNKNOWN" | undefined): { state: "DERIVED" | "UNKNOWN"; name?: string; pointsSpent?: number; reason?: string } {
  if (talentStatus !== "OBSERVED" || talentTree === undefined) return { state: "UNKNOWN", reason: "Classic Era talent tree is UNKNOWN or was not captured." };
  const ranked = talentTree.filter((tree) => Number.isSafeInteger(tree.pointsSpent) && tree.pointsSpent! >= 0);
  if (ranked.length === 0) return { state: "UNKNOWN", reason: "No observed talent point totals are available." };
  const max = Math.max(...ranked.map((tree) => tree.pointsSpent!));
  const leaders = ranked.filter((tree) => tree.pointsSpent === max);
  if (leaders.length !== 1) return { state: "UNKNOWN", reason: "Talent trees are tied at " + max + " points: " + leaders.map((tree) => tree.name).join(", ") + "." };
  return { state: "DERIVED", name: leaders[0]!.name, pointsSpent: max };
}

export function classifyMailFreshness(policy: FlavorMailPolicy, observedAt: number | undefined, now: number): "recent" | "stale" | "unknown" {
  if (observedAt === undefined) return "unknown";
  return now - observedAt <= policy.freshnessSeconds ? "recent" : "stale";
}
