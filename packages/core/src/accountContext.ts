// AccountContext: a single, deterministic, LLM-readable snapshot of the
// whole dashboard (all three known WoW versions) for hand-off to an
// external LLM conversation. This is explicitly NOT a second
// implementation of account logic — it is a thin, pure assembly layer
// over things that already exist:
//
//   - AccountFacts (one per version, embedded wholesale — already
//     realm-scoped for Classic Era/TBC Anniversary, account-wide for
//     Retail, already carries gold/playtime/professions/inventory/
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
import { diffSnapshots } from "./diff.ts";
import { summarizeTrainerCategory, type TrainerCategorySummary } from "./trainerSummary.ts";
import type { ParsedSnapshot, SectionState, WowVersion } from "./types.ts";
import type { StoredSnapshot } from "./store.ts";

export const ACCOUNT_CONTEXT_SCHEMA_VERSION = "1";

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
  /** The full, authoritative AccountFacts for this version — embedded wholesale, not re-derived. */
  facts: AccountFacts;
  /** Per-character history/trainer detail AccountFacts itself doesn't carry (it only has "latest + one diff"). Same character set and order as facts.characters. */
  characters: CharacterContext[];
}

export interface AccountContext {
  schemaVersion: typeof ACCOUNT_CONTEXT_SCHEMA_VERSION;
  generatedAt: number;
  versions: Record<WowVersion, VersionContext>;
}

export interface AccountContextInput {
  now: number;
  /** One AccountFacts per known WoW version (classic-era, tbc-anniversary, retail) — already built via SqliteSnapshotStore.buildAccountFacts. */
  versionFacts: Record<WowVersion, AccountFacts>;
  /** Every stored snapshot for every character appearing in any versionFacts, keyed by identityKey. Newest-first or any order — sorted internally. */
  characterSnapshots: Map<string, StoredSnapshot[]>;
}

function snapshotSortKey(s: StoredSnapshot): number {
  return s.generatedAt ?? s.importedAt;
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
  const chronological = [...snapshots].sort((a, b) => snapshotSortKey(a) - snapshotSortKey(b));

  const snapshotHistory = chronological.map((s) => toHistoryEntry(s.parsed, s.importedAt));

  const transitions: AccountChangeSummary[] = [];
  for (let i = 1; i < chronological.length; i++) {
    const from = chronological[i - 1];
    const to = chronological[i];
    const diff = diffSnapshots(from.parsed, to.parsed);
    transitions.push(diffToChangeSummary(diff, { identityKey, characterName: name, importedAt: to.importedAt }));
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
  const order: WowVersion[] = ["classic-era", "tbc-anniversary", "retail"];
  for (const version of order) {
    const facts = versionFacts[version];
    const characters = [...facts.characters]
      .sort((a, b) => a.realm.localeCompare(b.realm) || a.name.localeCompare(b.name))
      .map((c) => buildCharacterContext(c.identityKey, c.name, c.realm, characterSnapshots.get(c.identityKey) ?? []));

    versions[version] = {
      version,
      aggregationScope: facts.aggregationScope,
      facts,
      characters,
    };
  }

  return {
    schemaVersion: ACCOUNT_CONTEXT_SCHEMA_VERSION,
    generatedAt: now,
    versions,
  };
}
