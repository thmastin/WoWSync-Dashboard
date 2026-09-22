// Deterministic "Needs attention" digest (DASHBOARD_PRODUCT_REVIEW X4 / Overview).
// Fact-only reasons that cite their source field. No advice ("should log in").
// A character appears only when at least one reason applies; rows sort oldest sync first.
// Age bands (N4): never / >14d / 3–14d / ≤3d — fixed, not user-configurable.

import { classifyFreshness, RECENT_THRESHOLD_SECONDS, type Freshness } from "./freshness.ts";
import type { SectionState } from "./types.ts";

/** Free bag slots at or below this (when known) are listed as an attention reason. */
export const LOW_BAG_FREE_SLOTS = 5;

/** 14 days — second fixed band boundary after RECENT_THRESHOLD_SECONDS (3d). */
export const OLD_THRESHOLD_SECONDS = 14 * 24 * 60 * 60;

/**
 * Fixed sync-age bands for Needs Attention (and other age surfaces).
 * Boundaries: ≤3d = recent, 3–14d = aging, >14d = old, missing = never.
 */
export type AgeBand = "recent" | "aging" | "old" | "never";

export const AGE_BAND_ORDER: readonly AgeBand[] = ["never", "old", "aging", "recent"];

export const AGE_BAND_LABELS: Record<AgeBand, string> = {
  never: "Never synced",
  old: "Older than 14 days",
  aging: "3–14 days",
  recent: "Within 3 days",
};

export function classifyAgeBand(lastObservedAtSeconds: number | undefined, nowSeconds: number): AgeBand {
  if (lastObservedAtSeconds === undefined) return "never";
  const ageSeconds = nowSeconds - lastObservedAtSeconds;
  if (ageSeconds < 0) return "recent";
  if (ageSeconds <= RECENT_THRESHOLD_SECONDS) return "recent";
  if (ageSeconds <= OLD_THRESHOLD_SECONDS) return "aging";
  return "old";
}

export interface AttentionReason {
  /** Human-readable observed fact, e.g. "synced 12d ago". */
  text: string;
  /** Field / path the fact cites, e.g. "lastObservedAt". */
  field: string;
}

export interface AttentionRow {
  identityKey: string;
  name: string;
  realm: string;
  reasons: AttentionReason[];
  /**
   * Seconds since the character's last sync observation. Infinity when never
   * observed — sorts first (oldest / never first).
   */
  syncAgeSeconds: number;
  /** Fixed age band from lastObservedAt (N4). */
  ageBand: AgeBand;
}

export interface AttentionBandGroup {
  band: AgeBand;
  label: string;
  rows: AttentionRow[];
}

/** The fields Needs Attention reads. Matches CharacterFacts (+ optional bag/bank/profession details). */
export interface AttentionCharacter {
  identityKey: string;
  name: string;
  realm: string;
  lastObservedAt?: number;
  freshness: Freshness;
  bankStatus: SectionState;
  /** Bank section observedAt when the bank was OBSERVED or LAST_SEEN. */
  bankObservedAt?: number;
  /** Character professions section observation — UNKNOWN means never observed. */
  professionsObservationStatus?: SectionState;
  bagsStatus?: SectionState;
  bagsFreeSlots?: number;
  bagsTotalSlots?: number;
}

function syncAgeSeconds(lastObservedAt: number | undefined, now: number): number {
  if (lastObservedAt === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - lastObservedAt);
}

function daysAgoPhrase(observedAt: number, now: number, noun: string): string {
  const days = Math.floor(Math.max(0, now - observedAt) / 86400);
  if (days <= 0) return `${noun} today`;
  return `${noun} ${days}d ago`;
}

/**
 * Build the Needs Attention list for one scope. Pure: no clock, no I/O.
 * `now` is AccountFacts.generatedAt (or any fixed reference), never Date.now().
 */
export function buildNeedsAttention(characters: readonly AttentionCharacter[], now: number): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const c of characters) {
    const reasons: AttentionReason[] = [];

    if (c.freshness === "unknown" || c.lastObservedAt === undefined) {
      reasons.push({ text: "synced never", field: "lastObservedAt" });
    } else if (c.freshness === "stale") {
      reasons.push({ text: daysAgoPhrase(c.lastObservedAt, now, "synced"), field: "lastObservedAt" });
    }

    if (c.bankStatus === "UNKNOWN") {
      reasons.push({ text: "bank never observed", field: "bankStatus" });
    } else if (c.bankObservedAt !== undefined && classifyFreshness(c.bankObservedAt, now) === "stale") {
      reasons.push({ text: daysAgoPhrase(c.bankObservedAt, now, "bank last seen"), field: "bank.observedAt" });
    }

    if (c.professionsObservationStatus === "UNKNOWN") {
      reasons.push({ text: "professions never observed", field: "professions.observationStatus" });
    }

    if (
      c.bagsStatus !== "UNKNOWN" &&
      c.bagsFreeSlots !== undefined &&
      c.bagsTotalSlots !== undefined &&
      c.bagsFreeSlots <= LOW_BAG_FREE_SLOTS
    ) {
      reasons.push({
        text: `free bag slots: ${c.bagsFreeSlots} of ${c.bagsTotalSlots}`,
        field: "bags.freeSlots",
      });
    }

    if (reasons.length === 0) continue;
    rows.push({
      identityKey: c.identityKey,
      name: c.name,
      realm: c.realm,
      reasons,
      syncAgeSeconds: syncAgeSeconds(c.lastObservedAt, now),
      ageBand: classifyAgeBand(c.lastObservedAt, now),
    });
  }

  rows.sort((a, b) => {
    if (a.syncAgeSeconds !== b.syncAgeSeconds) return b.syncAgeSeconds - a.syncAgeSeconds;
    return a.name.localeCompare(b.name) || a.identityKey.localeCompare(b.identityKey);
  });
  return rows;
}

/** Group attention rows into fixed age-band sections. Empty bands are omitted. */
export function groupNeedsAttentionByAgeBand(rows: readonly AttentionRow[]): AttentionBandGroup[] {
  const byBand = new Map<AgeBand, AttentionRow[]>();
  for (const band of AGE_BAND_ORDER) byBand.set(band, []);
  for (const row of rows) {
    byBand.get(row.ageBand)!.push(row);
  }
  const groups: AttentionBandGroup[] = [];
  for (const band of AGE_BAND_ORDER) {
    const bandRows = byBand.get(band)!;
    if (bandRows.length === 0) continue;
    groups.push({ band, label: AGE_BAND_LABELS[band], rows: bandRows });
  }
  return groups;
}
