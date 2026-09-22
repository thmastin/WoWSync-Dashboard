// Deterministic "Needs attention" digest (DASHBOARD_PRODUCT_REVIEW X4 / Overview).
// Fact-only reasons that cite their source field. No advice ("should log in").
// A character appears only when at least one reason applies; rows sort oldest sync first.

import { classifyFreshness, type Freshness } from "./freshness.ts";
import type { SectionState } from "./types.ts";

/** Free bag slots at or below this (when known) are listed as an attention reason. */
export const LOW_BAG_FREE_SLOTS = 5;

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
    });
  }

  rows.sort((a, b) => {
    if (a.syncAgeSeconds !== b.syncAgeSeconds) return b.syncAgeSeconds - a.syncAgeSeconds;
    return a.name.localeCompare(b.name) || a.identityKey.localeCompare(b.identityKey);
  });
  return rows;
}