// AccountContext: a single, deterministic, LLM-readable snapshot of the
// whole dashboard (every known WoW version) for hand-off to an
// external LLM conversation. This is explicitly NOT a second
// implementation of account logic — it is a thin, pure assembly layer
// over things that already exist:
//
//   - AccountFacts (one per version, embedded wholesale — already
//     realm-scoped for Classic Era/TBC Anniversary/Forever, account-wide
//     for Retail, already carries gold/playtime/professions/inventory/
//     recentChanges/freshness with full UNKNOWN-vs-NONE-vs-zero fidelity)
//   - diffSnapshots (reused, via diffToChangeSummary, to build a
//     transition entry between every consecutive pair of snapshots, not
//     just the latest "meaningful" one AccountFacts.recentChanges covers)
//   - summarizeTrainerCategory (reused as-is — the export embeds the same
//     grouped/summarized trainer view the character page shows, never
//     the raw hundreds-of-services array)
//
// Nothing here recomputes a gold total, a freshness classification, or a
// profession coverage rule. If a future consumer needs different facts,
// the fix belongs in accountFacts.ts, not here.
//
// Determinism: buildAccountContext is pure (no I/O, no clock reads) and
// every collection is explicitly sorted, so the same input + the same
// `now` always produces byte-identical JSON.

import { diffToChangeSummary, type AccountChangeSummary, type AccountFacts } from "./accountFacts.ts";
import { snapshotObservedAt } from "./chronology.ts";
import { diffSnapshots } from "./diff.ts";
import { summarizeTrainerCategory, type TrainerCategorySummary } from "./trainerSummary.ts";
import type { ParsedSnapshot, SectionState, WowVersion } from "./types.ts";
import type { StoredSnapshot } from "./store.ts";
import { WOW_VERSIONS } from "./version.ts";

// Bumped to "3" (additive, on top of the v2 changes below): gold/playtime
// totals gained freshness fields (staleCharactersWith*/oldest*ObservedAt),
// change summaries gained `observedAt`, realm-partitioned versions gained an
// in-band `scopeNote`, and the `currency` note now states that a total over
// zero observed values is not zero.
//
// Bumped to "2": added the `currency` field, renamed the two differently-
// scoped profession `status` fields to `observationStatus`/`coverageStatus`
// (see accountFacts.ts), and added `AccountChangeSummary.inventoryItemChanges`
// — all identified as concrete gaps by a real LLM-evaluation pass (a model
// misread 102815 copper as "102.8 gold", contradicted itself on profession
// coverage, and reported inventory item changes as absent from its context).
export const ACCOUNT_CONTEXT_SCHEMA_VERSION = "3";

/**
 * Explicit, in-band documentation of the one unit convention this document
 * uses everywhere: every field ending in "Copper" (goldCopper, moneyCopper,
 * deltaCopper, costCopper, totalKnownCopper, goldDeltaCopper, ...) is a raw
 * copper integer, WoW's smallest currency unit. Embedding this in the
 * exported JSON itself (rather than relying solely on an LLM consumer's
 * system prompt) means the convention travels with the data to any
 * consumer, not just the one prompt that happens to mention it.
 */
export interface CurrencyConvention {
  unit: "copper";
  conversion: string;
  note: string;
}

const CURRENCY_CONVENTION: CurrencyConvention = {
  unit: "copper",
  conversion: "1 gold = 100 silver = 10000 copper",
  note:
    "Every field whose name ends in \"Copper\" (e.g. goldCopper, moneyCopper, deltaCopper, costCopper, totalKnownCopper) is an integer amount of copper, WoW's smallest currency unit — never gold, and never a decimal gold amount. To display as gold/silver/copper: gold = floor(copper / 10000), silver = floor((copper % 10000) / 100), remaining copper = copper % 100. A total whose known-character count is 0 (charactersWithKnownGold / charactersWithKnownPlaytime) is a sum over nothing observed - it means unknown, NOT zero gold. Totals are sums of each character's last observed value (not live balances); staleCharactersWith* and oldest*ObservedAt say how old the contributions are.",
};

/**
 * In-band explanation attached to realm-partitioned versions (Classic Era,
 * TBC Anniversary, Forever). The version-wide totals in `facts` (gold,
 * playtime, inventory, ...) are computed for every version, but across
 * separate realm economies they are DERIVED sums that no player could spend
 * as one balance. The note travels with the data so a consumer that never
 * sees a system prompt (a pasted developer export) is still told which view
 * to use.
 */
export const REALM_SCOPE_NOTE =
  "This version is realm-partitioned: characters on different realms do not share an economy. The version-wide totals in facts (gold, playtime, inventory, profession coverage) are DERIVED sums across separate realms, kept for completeness only - use facts.realms[] (one entry per realm) for any per-realm or economic question, and never present a cross-realm sum as one account balance.";

export interface SnapshotHistoryEntry {
  generatedAt?: number;
  importedAt: number;
  level?: number;
  moneyCopper?: number;
  xp?: number;
  xpMax?: number;
  playedSeconds?: number;
  levelPlayedSeconds?: number;
  zone?: string;
  subzone?: string;
}

export interface CharacterTrainerCategoryContext {
  category: string;
  /** Status of the raw trainer category section itself (UNKNOWN = never visited). */
  status: SectionState;
  /** Trainer NPC name, when observed. */
  name?: string;
  /** The existing grouped/summarized view (available now / grouped by required level / unknown unlock level / next training) — never the raw services list. Full per-service drill-down remains available via the existing GET /api/characters/:identityKey/snapshots endpoint if ever needed. */
  summary: TrainerCategorySummary;
}

export interface CharacterContext {
  identityKey: string;
  name: string;
  realm: string;
  /** Chronological, oldest first. */
  snapshotHistory: SnapshotHistoryEntry[];
  /** One entry per consecutive snapshot pair, chronological, oldest transition first. Same shape as AccountFacts.recentChanges — reused, not reinvented. */
  transitions: AccountChangeSummary[];
  /** From the character's latest snapshot only. */
  trainer: CharacterTrainerCategoryContext[];
}

export interface VersionContext {
  version: WowVersion;
  aggregationScope: AccountFacts["aggregationScope"];
  /** Present only when aggregationScope is "realm": says the version-wide totals are derived cross-realm sums and that facts.realms[] is the per-realm view. */
  scopeNote?: string;
  /** The full, authoritative AccountFacts for this version — embedded wholesale, not re-derived. */
  facts: AccountFacts;
  /** Per-character history/trainer detail AccountFacts itself doesn't carry (it only has "latest + one diff"). Same character set and order as facts.characters. */
  characters: CharacterContext[];
}

export interface AccountContext {
  schemaVersion: typeof ACCOUNT_CONTEXT_SCHEMA_VERSION;
  generatedAt: number;
  currency: CurrencyConvention;
  versions: Record<WowVersion, VersionContext>;
}

export interface AccountContextInput {
  now: number;
  /** One AccountFacts per known WoW version (WOW_VERSIONS: classic-era, tbc-anniversary, retail, forever) — already built via SqliteSnapshotStore.buildAccountFacts. */
  versionFacts: Record<WowVersion, AccountFacts>;
  /** Every stored snapshot for every character appearing in any versionFacts, keyed by identityKey. Newest-first or any order — sorted internally. */
  characterSnapshots: Map<string, StoredSnapshot[]>;
}

// The one chronology rule (see chronology.ts) - shared with the SQLite
// queries behind "latest"/"previous", so the store, AccountFacts and this
// document always describe the same snapshot pairs.
function snapshotSortKey(s: StoredSnapshot): number {
  return snapshotObservedAt(s.generatedAt, s.importedAt);
}

// generatedAt (or its importedAt fallback) is not guaranteed unique - two
// snapshots can legitimately share the same value (same-second imports,
// or an addon export whose in-game clock didn't tick between them).
// Array.prototype.sort is stable, so a comparator that returns 0 for tied
// keys preserves the *input* array's relative order for that pair - and
// the input here (SqliteSnapshotStore.listSnapshots) is newest-first, not
// oldest-first, so an unbroken tie would silently reverse that pair's
// chronology (and therefore every directional delta the transition
// reports). `id` is the snapshots table's AUTOINCREMENT primary key: an
// existing, already-persisted signal that is unique per row and strictly
// increasing in true insertion order, so it's an exact, transitive
// tie-breaker - no new persisted field needed.
function compareSnapshotsChronologically(a: StoredSnapshot, b: StoredSnapshot): number {
  const byObservedTime = snapshotSortKey(a) - snapshotSortKey(b);
  if (byObservedTime !== 0) return byObservedTime;
  return a.id - b.id;
}

function toHistoryEntry(parsed: ParsedSnapshot, importedAt: number): SnapshotHistoryEntry {
  return {
    generatedAt: parsed.generatedAt,
    importedAt,
    level: parsed.character.level,
    moneyCopper: parsed.character.moneyCopper,
    xp: parsed.character.xp,
    xpMax: parsed.character.xpMax,
    playedSeconds: parsed.character.playedSeconds,
    levelPlayedSeconds: parsed.character.levelPlayedSeconds,
    zone: parsed.location.zone,
    subzone: parsed.location.subzone,
  };
}

function buildCharacterContext(identityKey: string, name: string, realm: string, snapshots: StoredSnapshot[]): CharacterContext {
  const chronological = [...snapshots].sort(compareSnapshotsChronologically);

  const snapshotHistory = chronological.map((s) => toHistoryEntry(s.parsed, s.importedAt));

  const transitions: AccountChangeSummary[] = [];
  for (let i = 1; i < chronological.length; i++) {
    const from = chronological[i - 1];
    const to = chronological[i];
    const diff = diffSnapshots(from.parsed, to.parsed);
    transitions.push(
      diffToChangeSummary(diff, {
        identityKey,
        characterName: name,
        importedAt: to.importedAt,
        observedAt: snapshotObservedAt(to.generatedAt, to.importedAt),
      }),
    );
  }

  const latest = chronological[chronological.length - 1];
  const trainer: CharacterTrainerCategoryContext[] = latest
    ? [...latest.parsed.trainer.categories]
        .sort((a, b) => a.category.localeCompare(b.category))
        .map((category) => ({
          category: category.category,
          status: category.status.state,
          name: category.name,
          summary: summarizeTrainerCategory(category),
        }))
    : [];

  return { identityKey, name, realm, snapshotHistory, transitions, trainer };
}

export function buildAccountContext(input: AccountContextInput): AccountContext {
  const { now, versionFacts, characterSnapshots } = input;

  const versions = {} as Record<WowVersion, VersionContext>;
  for (const version of WOW_VERSIONS) {
    const facts = versionFacts[version];
    const characters = [...facts.characters]
      .sort((a, b) => a.realm.localeCompare(b.realm) || a.name.localeCompare(b.name))
      .map((c) => buildCharacterContext(c.identityKey, c.name, c.realm, characterSnapshots.get(c.identityKey) ?? []));

    versions[version] = {
      version,
      aggregationScope: facts.aggregationScope,
      ...(facts.aggregationScope === "realm" ? { scopeNote: REALM_SCOPE_NOTE } : {}),
      facts,
      characters,
    };
  }

  return {
    schemaVersion: ACCOUNT_CONTEXT_SCHEMA_VERSION,
    generatedAt: now,
    currency: CURRENCY_CONVENTION,
    versions,
  };
}
