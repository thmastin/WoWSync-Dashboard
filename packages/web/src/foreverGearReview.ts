import type { ForeverGearAllocationApi } from "./api.ts";

export interface RecipientAllocationRead {
  recipientIdentityKey: string;
  result: ForeverGearAllocationApi;
}

export type GearReviewDisposition = "EQUIP_CANDIDATE" | "KEEP" | "POSSIBLE_OTHER_CHARACTER" | "NOT_AN_UPGRADE_ON_OBSERVED_METRICS" | "INSUFFICIENT_EVIDENCE";
export interface GearReviewEvidence {
  provenance: "DERIVED" | "HYPOTHESIS" | "UNKNOWN";
  eligibility: string;
  suitability: string;
  transferability: string;
  confidence: "LIMITED" | "UNKNOWN";
  reasons: string[];
  whatWouldChange: string[];
}
export interface GearReviewComparison {
  upgradeStatus: string;
  confidence: string;
  rawComparisons: Array<{ slot: number; equippedItemRef: string; classification: string; reason: string }>;
}
export interface GearReviewCharacterEvidence {
  observedAt?: number;
  freshness: string;
  class?: { value: string; provenance: string };
  level?: { value: number; provenance: string };
  equipment: { state: string; observedAt?: number; freshness?: string };
}

export interface GearReviewRecipientRow {
  identityKey: string;
  name: string;
  realm: string;
  disposition: GearReviewDisposition;
  evidence: GearReviewEvidence;
  comparison?: GearReviewComparison;
  source: { identityKey: string; name: string; realm: string; location: "CARRIED_INVENTORY" | "EQUIPPED" | "UNKNOWN"; provenance: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; observedAt?: number; freshness: string };
  item: { name?: string; itemRef?: string; itemIdentity?: string };
  recipientEvidence: GearReviewCharacterEvidence;
  conflicting: boolean;
}

export interface GearReviewItemGroup {
  key: string;
  itemLabel: string;
  itemRef?: string;
  sourceIdentityKey: string;
  sourceLabel: string;
  location: string;
  provenance: string;
  observedAt?: number;
  freshness: string;
  sourceContextDiffers: boolean;
  recipients: GearReviewRecipientRow[];
}

export interface GearReviewFilter { recipientIdentityKey?: string; disposition?: string; query?: string }

export function describeForeverAssessment(value: string): string {
  const labels: Record<string, string> = {
    UNKNOWN: "not established",
    POSSIBLE_BY_RULE_SCREEN: "possible by a limited rule screen; not confirmed",
    INELIGIBLE: "excluded by a supported check",
    OBSERVED_SPEC_TAG_MATCH: "observed specialization hint",
    OBSERVED_SPEC_TAG_MISMATCH: "observed specialization caution",
    BLOCKED_BOUND_TO_SOURCE: "observed as bound to its current source",
    "No transfer needed for source character": "no transfer needed for the source character",
    DERIVED: "derived from observations",
    HYPOTHESIS: "hypothesis-based screen",
    OBSERVED: "directly observed",
    LAST_SEEN: "last seen; may be stale",
  };
  return labels[value] ?? value.replaceAll("_", " ").toLocaleLowerCase();
}

const dispositionOrder = ["EQUIP_CANDIDATE", "POSSIBLE_OTHER_CHARACTER", "KEEP", "NOT_AN_UPGRADE_ON_OBSERVED_METRICS", "INSUFFICIENT_EVIDENCE"];

/** Collects only recipient-specific rows from each matching, version-checked Forever response. */
export function buildForeverGearReview(reads: readonly RecipientAllocationRead[]): GearReviewItemGroup[] {
  const groups = new Map<string, GearReviewItemGroup>();
  reads.forEach(({ recipientIdentityKey, result }) => {
    const data = result.status === "FOUND" ? result.value?.data : undefined;
    if (data?.version !== "forever" || data.ruleset !== "forever-70291-allocation-screen-v2") return;
    const entries = data.allocationPlan ?? [];
    entries.forEach((entry, index) => {
      if (entry.recipient.identityKey !== recipientIdentityKey) return;
      // Do not merge partial or unknown item identities across characters.
      const itemKey = entry.item.itemIdentity === "OBSERVED" && entry.item.itemRef
        ? `variant:${entry.item.itemRef}`
        : `unknown:${recipientIdentityKey}:${index}`;
      const key = `${entry.source.identityKey}|${itemKey}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          itemLabel: entry.item.name ?? "Unidentified observed item",
          itemRef: entry.item.itemRef,
          sourceIdentityKey: entry.source.identityKey,
          sourceLabel: `${entry.source.name} · ${entry.source.realm}`,
          location: entry.source.location,
          provenance: entry.source.provenance,
          observedAt: entry.source.observedAt,
          freshness: entry.source.freshness,
          sourceContextDiffers: false,
          recipients: [],
        };
        groups.set(key, group);
      }
      if (group.location !== entry.source.location || group.provenance !== entry.source.provenance || group.observedAt !== entry.source.observedAt || group.freshness !== entry.source.freshness) {
        group.sourceContextDiffers = true;
      }
      const candidateRow: GearReviewRecipientRow = {
        identityKey: entry.recipient.identityKey,
        name: entry.recipient.name,
        realm: entry.recipient.realm,
        disposition: entry.disposition,
        evidence: entry.evidence,
        comparison: entry.comparison,
        source: entry.source,
        item: entry.item,
        recipientEvidence: {
          observedAt: data.recipient.observedAt,
          freshness: data.recipient.freshness,
          class: data.recipient.class ? { value: data.recipient.class.value, provenance: data.recipient.class.provenance } : undefined,
          level: data.recipient.level ? { value: data.recipient.level.value, provenance: data.recipient.level.provenance } : undefined,
          equipment: { state: data.recipient.equipment.state, observedAt: data.recipient.equipment.observedAt, freshness: data.recipient.equipment.freshness },
        },
        conflicting: false,
      };
      if (group.recipients.some((row) => row.identityKey === entry.recipient.identityKey && JSON.stringify(row) === JSON.stringify(candidateRow))) return;
      group.recipients.push(candidateRow);
    });
  });
  return [...groups.values()].map((group) => {
    const verdicts = new Map<string, Set<string>>();
    for (const row of group.recipients) {
      const set = verdicts.get(row.identityKey) ?? new Set<string>();
      set.add(JSON.stringify([row.disposition, row.evidence.eligibility, row.evidence.suitability, row.evidence.transferability, row.comparison?.upgradeStatus]));
      verdicts.set(row.identityKey, set);
    }
    return {
    ...group,
    recipients: group.recipients.map((row) => ({ ...row, conflicting: (verdicts.get(row.identityKey)?.size ?? 0) > 1 })).sort((a, b) => {
      const order = (dispositionOrder.indexOf(a.disposition) - dispositionOrder.indexOf(b.disposition));
      return order || a.name.localeCompare(b.name) || a.identityKey.localeCompare(b.identityKey);
    }),
  };
  }).sort((a, b) => a.itemLabel.localeCompare(b.itemLabel) || a.sourceIdentityKey.localeCompare(b.sourceIdentityKey) || a.key.localeCompare(b.key));
}

export function gearReviewSummary(groups: readonly GearReviewItemGroup[]) {
  const dispositions = new Map<string, number>();
  let recipientRows = 0;
  for (const group of groups) for (const row of group.recipients) {
    recipientRows++;
    dispositions.set(row.disposition, (dispositions.get(row.disposition) ?? 0) + 1);
  }
  return { itemCount: groups.length, recipientRows, insufficient: dispositions.get("INSUFFICIENT_EVIDENCE") ?? 0, conditional: (dispositions.get("EQUIP_CANDIDATE") ?? 0) + (dispositions.get("POSSIBLE_OTHER_CHARACTER") ?? 0) };
}

export function filterForeverGearReview(groups: readonly GearReviewItemGroup[], filter: GearReviewFilter): GearReviewItemGroup[] {
  const query = (filter.query ?? "").trim().toLowerCase();
  return groups.map((group) => ({ ...group, recipients: group.recipients.filter((row) =>
    (!filter.recipientIdentityKey || row.identityKey === filter.recipientIdentityKey) &&
    (!filter.disposition || row.disposition === filter.disposition) &&
    (!query || `${group.itemLabel} ${group.itemRef ?? ""} ${group.sourceLabel} ${row.name} ${row.realm}`.toLowerCase().includes(query))
  ) })).filter((group) => group.recipients.length > 0);
}
