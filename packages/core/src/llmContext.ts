// LlmContext ("LLM Context v1"): a compact, model-consumption-optimized
// projection of the canonical AccountContext, built specifically for
// hand-off to the "Ask My Account" LLM consumer.
//
//   AccountContext -> buildLlmContext(...) -> JSON.stringify(...) -> LLM
//
// This is NOT a second implementation of account logic and NOT a second
// canonical document - GET /api/account-context, the Developer export, and
// every existing UI consumer keep reading the full AccountContext exactly
// as before. This module only re-shapes already-computed AccountContext
// values (never re-derives a fact AccountContext hasn't already observed)
// into a much smaller, flatter, per-character-atomic structure, motivated
// by a real LLM-evaluation finding: given the full ~320KB AccountContext
// (many redundant historical transitions, a full current-inventory-by-item
// aggregate, full trainer detail, several overlapping "recent changes"
// views), a model fabricated an entire inventory transition for a
// single-snapshot character by cross-contaminating it with a different
// character's real data. The projection below removes most of that
// redundancy and, critically, makes "there is no comparison to make" an
// explicit, unambiguous field (`comparisonStatus`) rather than something
// the model has to infer from an empty/absent array.
//
// Deterministic and pure: no I/O, no clock reads, same input always
// produces the same output.

import type { AccountContext, CurrencyConvention } from "./accountContext.ts";
import { formatCopper, formatCopperDelta } from "./currency.ts";
import type { Freshness } from "./freshness.ts";
import type { SectionState, WowVersion } from "./types.ts";

export const LLM_CONTEXT_SCHEMA_VERSION = "llm-1";

/**
 * Whether a character has two or more observed snapshots to compare.
 * Named distinctly from SectionState's OBSERVED/LAST_SEEN/UNKNOWN (a
 * different question - "was this section ever seen?") and from
 * ProfessionCoverageStatus's covered/none/unknown (also different) -
 * this answers "is there a from/to pair to compute a transition from?"
 * Deliberately explicit rather than left for the model to infer from
 * `latestTransition` being present/absent: a single-snapshot character
 * must never be described as "no changes" (that claims two snapshots
 * were compared and found identical) when the true state is "not enough
 * history exists to compare at all."
 */
export type ComparisonStatus = "AVAILABLE" | "INSUFFICIENT_HISTORY";

export interface LlmItemChange {
  itemKey: string;
  name?: string;
  /** Always positive - list membership (gained vs. lost) carries the direction. */
  qty: number;
}

export interface LlmInventoryChange {
  gained: LlmItemChange[];
  lost: LlmItemChange[];
}

export interface LlmLatestTransition {
  fromGeneratedAt?: number;
  toGeneratedAt?: number;
  fromLevel?: number;
  toLevel?: number;
  levelChanged: boolean;
  previousGoldCopper?: number;
  currentGoldCopper?: number;
  goldDeltaCopper?: number;
  /** Deterministically formatted, e.g. "+1753g 77s 90c" - present exactly when goldDeltaCopper is present. */
  goldDeltaFormatted?: string;
  playtimeDeltaSeconds?: number;
  professionChanged: boolean;
  equipmentChanged: boolean;
  locationChanged: boolean;
  trainerUnlocked: boolean;
  /** Present only when inventory actually changed - never {gained:[],lost:[]} for "nothing changed". */
  inventory?: LlmInventoryChange;
}

export interface LlmProfession {
  name: string;
  skill?: number;
  maxSkill?: number;
}

export interface LlmCharacter {
  version: WowVersion;
  realm: string;
  name: string;
  identityKey: string;
  class?: string;
  faction?: string;
  level?: number;
  /** Current-level progress bar only, NOT cumulative XP - see xpCurrentLevel doc. Never compare across a level change. */
  xpCurrentLevel?: { xp?: number; xpMax?: number; xpPercent?: number };
  goldCopper?: number;
  goldFormatted?: string;
  playedSeconds?: number;
  freshness: Freshness;
  bankStatus: SectionState;
  professions: LlmProfession[];
  snapshotCount: number;
  comparisonStatus: ComparisonStatus;
  /** Present iff comparisonStatus is "AVAILABLE". Never a synthesized zero/empty object when INSUFFICIENT_HISTORY. */
  latestTransition?: LlmLatestTransition;
}

/**
 * A projection of the version's already-computed AccountFacts.gold total -
 * not a second calculation. `totalKnownCopper` is read directly from
 * `facts.gold.totalKnownCopper`; nothing here sums LlmCharacter.goldCopper
 * independently.
 *
 * Scope note: this mirrors exactly what the canonical field already means
 * for that version - it does not invent new aggregation semantics. For
 * Retail (`aggregationScope: "account-wide"`), that's a real account-wide
 * total. For Classic Era / TBC Anniversary (`aggregationScope: "realm"`),
 * the canonical `facts.gold.totalKnownCopper` is already a cross-realm sum
 * (AccountFacts computes this version-wide total unconditionally, as a
 * broader view, even though `realms[]` is the recommended figure for a
 * realm-partitioned version, since those realms share no real economy) -
 * this projection carries that same cross-realm sum forward unchanged, it
 * does not restrict it to a single realm or add a new realm-scoped total.
 */
export interface LlmGoldSummary {
  /** Absent (not 0) when no character's gold was ever observed - a sum over zero known values is not a meaningful "0c" total. */
  totalKnownCopper?: number;
  totalKnownFormatted?: string;
}

export interface LlmVersionSummary {
  version: WowVersion;
  aggregationScope: "realm" | "account-wide";
  goldSummary: LlmGoldSummary;
  characters: LlmCharacter[];
}

/**
 * A deterministic, positive-only lookup aid over the per-character objects
 * above - built specifically to remove a discovery burden a real live test
 * exposed: asked to filter/enumerate across all characters (e.g. "which
 * characters gained or lost gold"), a model correctly computed each
 * character's data when it reached it, but did not reliably discover and
 * report the complete qualifying set itself, especially later-positioned,
 * larger entries. Every array here is `identityKey`s only - no value is
 * duplicated from `latestTransition`, and nothing here is a second
 * calculation path: each list is a direct, deterministic filter over the
 * exact same `latestTransition` fields already present on each character.
 *
 * Membership rule (see also the "non-membership" doc on each field below):
 * a name appears in a `*Changed` list ONLY when that character is
 * `comparable` AND its `latestTransition` shows an OBSERVED, non-zero
 * change in that specific dimension. UNKNOWN/absent data is never
 * classified as unchanged - it is simply excluded, the same way
 * `latestTransition` itself omits fields that were never observed.
 */
export interface LlmLatestTransitionIndex {
  /** identityKeys with comparisonStatus "AVAILABLE" (a latestTransition exists). Canonical order (same as `versions[...].characters`). */
  comparable: string[];
  /** identityKeys with comparisonStatus "INSUFFICIENT_HISTORY" (no latestTransition - not enough snapshots, not "unchanged"). Canonical order. */
  insufficientHistory: string[];
  /**
   * Comparable characters whose latestTransition.goldDeltaCopper is present
   * and non-zero. Non-membership means EITHER the gold delta was a real,
   * observed zero, OR gold was never observed on one of the two snapshots
   * (goldDeltaCopper absent) - consult that character's own
   * `latestTransition.goldDeltaCopper` (present-and-zero vs. absent) to
   * tell those two apart.
   */
  goldChanged: string[];
  /** Comparable characters whose latestTransition.inventory is present (at least one item gained or lost). Non-membership means no item-level change was recorded for that transition. */
  inventoryChanged: string[];
  /** Comparable characters whose latestTransition.levelChanged is true. */
  levelChanged: string[];
  /**
   * Comparable characters whose latestTransition.playtimeDeltaSeconds is
   * present and non-zero. Non-membership means either a real, observed
   * zero delta, or playtime was never observed on one of the two
   * snapshots (playtimeDeltaSeconds absent) - same present-and-zero
   * vs. absent distinction as goldChanged above.
   */
  playtimeChanged: string[];
}

export interface LlmContext {
  schemaVersion: typeof LLM_CONTEXT_SCHEMA_VERSION;
  generatedAt: number;
  currency: CurrencyConvention;
  /**
   * For "which characters..." questions, this is the authoritative,
   * complete answer for the dimension asked about - read the relevant
   * list here first, then look up each identityKey's own character object
   * for detail. Do not independently re-discover the qualifying set by
   * scanning every character's latestTransition.
   */
  latestTransitionIndex: LlmLatestTransitionIndex;
  versions: Record<WowVersion, LlmVersionSummary>;
}

function buildInventoryChange(
  itemChanges: { storage: string; itemKey: string; name?: string; deltaQty: number }[] | undefined,
): LlmInventoryChange | undefined {
  if (!itemChanges || itemChanges.length === 0) return undefined;
  const gained: LlmItemChange[] = [];
  const lost: LlmItemChange[] = [];
  for (const ic of itemChanges) {
    const entry: LlmItemChange = { itemKey: ic.itemKey, name: ic.name, qty: Math.abs(ic.deltaQty) };
    if (ic.deltaQty > 0) gained.push(entry);
    else if (ic.deltaQty < 0) lost.push(entry);
    // deltaQty === 0 never occurs - diffSnapshots only reports a delta when fromQty !== toQty.
  }
  return { gained, lost };
}

function buildGoldSummary(gold: AccountContext["versions"][WowVersion]["facts"]["gold"]): LlmGoldSummary {
  // A sum over zero known contributors is not a meaningful total - never
  // surface it as "0c", which would read as a confirmed observed zero.
  if (gold.charactersWithKnownGold === 0) return {};
  return {
    totalKnownCopper: gold.totalKnownCopper,
    totalKnownFormatted: formatCopper(gold.totalKnownCopper),
  };
}

function buildLatestTransitionIndex(allCharacters: LlmCharacter[]): LlmLatestTransitionIndex {
  const index: LlmLatestTransitionIndex = {
    comparable: [],
    insufficientHistory: [],
    goldChanged: [],
    inventoryChanged: [],
    levelChanged: [],
    playtimeChanged: [],
  };
  // Canonical order = the same order `versions[...].characters` is already
  // built in (version, then realm, then name) - never sorted by magnitude
  // or any model-facing heuristic.
  for (const ch of allCharacters) {
    if (ch.comparisonStatus === "INSUFFICIENT_HISTORY") {
      index.insufficientHistory.push(ch.identityKey);
      continue;
    }
    index.comparable.push(ch.identityKey);
    const t = ch.latestTransition;
    if (!t) continue; // comparisonStatus guarantees this is unreachable; guards the type only.
    if (t.goldDeltaCopper !== undefined && t.goldDeltaCopper !== 0) index.goldChanged.push(ch.identityKey);
    if (t.inventory !== undefined) index.inventoryChanged.push(ch.identityKey);
    if (t.levelChanged) index.levelChanged.push(ch.identityKey);
    if (t.playtimeDeltaSeconds !== undefined && t.playtimeDeltaSeconds !== 0) index.playtimeChanged.push(ch.identityKey);
  }
  return index;
}

export function buildLlmContext(context: AccountContext): LlmContext {
  const versions = {} as Record<WowVersion, LlmVersionSummary>;
  const allCharacters: LlmCharacter[] = [];

  for (const [version, versionContext] of Object.entries(context.versions) as [WowVersion, AccountContext["versions"][WowVersion]][]) {
    const historyByKey = new Map(versionContext.characters.map((c) => [c.identityKey, c]));
    const professionsByKey = new Map(versionContext.facts.professions.byCharacter.map((p) => [p.identityKey, p]));

    const characters: LlmCharacter[] = versionContext.facts.characters.map((cf) => {
      const history = historyByKey.get(cf.identityKey);
      const transitions = history?.transitions ?? [];
      const latest = transitions[transitions.length - 1];
      const comparisonStatus: ComparisonStatus = latest ? "AVAILABLE" : "INSUFFICIENT_HISTORY";

      let latestTransition: LlmLatestTransition | undefined;
      if (latest && history) {
        // The latest transition and the last two chronological snapshotHistory
        // entries are guaranteed aligned by construction (buildCharacterContext
        // builds `transitions[i]` from the exact pair snapshotHistory[i]/[i+1]),
        // so the previous/current gold endpoints are read directly from those
        // two already-observed snapshots, not reconstructed or estimated.
        const snapshotHistory = history.snapshotHistory;
        const previous = snapshotHistory[snapshotHistory.length - 2];
        const current = snapshotHistory[snapshotHistory.length - 1];
        latestTransition = {
          fromGeneratedAt: previous?.generatedAt,
          toGeneratedAt: current?.generatedAt,
          fromLevel: latest.fromLevel,
          toLevel: latest.toLevel,
          levelChanged: latest.levelChanged,
          previousGoldCopper: previous?.moneyCopper,
          currentGoldCopper: current?.moneyCopper,
          goldDeltaCopper: latest.goldDeltaCopper,
          goldDeltaFormatted: latest.goldDeltaCopper !== undefined ? formatCopperDelta(latest.goldDeltaCopper) : undefined,
          playtimeDeltaSeconds: latest.playtimeDeltaSeconds,
          professionChanged: latest.professionChanged,
          equipmentChanged: latest.equipmentChanged,
          locationChanged: latest.locationChanged,
          trainerUnlocked: latest.trainerUnlocked,
          inventory: buildInventoryChange(latest.inventoryItemChanges),
        };
      }

      const professions = (professionsByKey.get(cf.identityKey)?.professions ?? []).map((p) => ({
        name: p.name,
        skill: p.skill,
        maxSkill: p.maxSkill,
      }));

      return {
        version,
        realm: cf.realm,
        name: cf.name,
        identityKey: cf.identityKey,
        class: cf.class,
        faction: cf.faction,
        level: cf.level,
        xpCurrentLevel: cf.xp !== undefined || cf.xpMax !== undefined ? { xp: cf.xp, xpMax: cf.xpMax, xpPercent: cf.xpPercent } : undefined,
        goldCopper: cf.goldCopper,
        goldFormatted: cf.goldCopper !== undefined ? formatCopper(cf.goldCopper) : undefined,
        playedSeconds: cf.playedSeconds,
        freshness: cf.freshness,
        bankStatus: cf.bankStatus,
        professions,
        snapshotCount: cf.snapshotCount,
        comparisonStatus,
        latestTransition,
      };
    });

    versions[version] = {
      version,
      aggregationScope: versionContext.aggregationScope,
      goldSummary: buildGoldSummary(versionContext.facts.gold),
      characters,
    };
    allCharacters.push(...characters);
  }

  return {
    schemaVersion: LLM_CONTEXT_SCHEMA_VERSION,
    generatedAt: context.generatedAt,
    currency: context.currency,
    latestTransitionIndex: buildLatestTransitionIndex(allCharacters),
    versions,
  };
}
