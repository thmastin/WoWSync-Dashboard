// Derives a single "current scope" view from AccountFacts: either one
// realm (Classic Era/TBC Anniversary) or the whole account (Retail/
// unknown-version). Keeps the view components (AccountOverview,
// AccountEconomy, CharactersGrid) agnostic to realm-partitioning -- they
// just render whatever ScopedFacts they're handed.
import type { AccountFacts, FreshnessSummary, VersionOrUnknown } from "./types.ts";

/** Overview display bound applied after realm (or account-wide) scoping. */
export const RECENT_CHANGES_DISPLAY_CAP = 20;

/**
 * Cap recent-changes for display after scope filtering.
 * Store/AccountFacts stay uncapped so a realm is not starved by other realms' newer rows.
 */
export function capRecentChangesAfterScope<T>(changes: readonly T[], limit: number = RECENT_CHANGES_DISPLAY_CAP): T[] {
  if (!(typeof limit === "number" && limit > 0)) return [...changes];
  return changes.length > limit ? changes.slice(0, limit) : [...changes];
}

export interface ScopedFacts {
  /** The facts' own generation time (unix seconds): the "now" every age in the UI is measured against, never the browser clock. */
  now: number;
  /** Game version these facts belong to (from AccountFacts.version). */
  version: VersionOrUnknown;
  scopeLabel: string;
  isRealmScoped: boolean;
  availableRealms: string[];
  characters: AccountFacts["characters"];
  gold: AccountFacts["gold"];
  playtime: AccountFacts["playtime"];
  progression: AccountFacts["progression"];
  professions: AccountFacts["professions"];
  inventory: AccountFacts["inventory"];
  recentChanges: AccountFacts["recentChanges"];
  freshness: FreshnessSummary;
}

export function scopeFacts(facts: AccountFacts, selectedRealm: string | null): ScopedFacts {
  if (facts.aggregationScope === "account-wide" || facts.realms.length === 0) {
    return {
      now: facts.generatedAt,
      version: facts.version,
      scopeLabel: "Account-wide",
      isRealmScoped: false,
      availableRealms: [],
      characters: facts.characters,
      gold: facts.gold,
      playtime: facts.playtime,
      progression: facts.progression,
      professions: facts.professions,
      inventory: facts.inventory,
      recentChanges: capRecentChangesAfterScope(facts.recentChanges),
      freshness: facts.freshness,
    };
  }

  const realm = facts.realms.find((r) => r.realm === selectedRealm) ?? facts.realms[0];
  const realmIdentityKeys = new Set(realm.characters.map((c) => c.identityKey));
  const freshnessByCharacter = facts.freshness.byCharacter.filter((c) => realmIdentityKeys.has(c.identityKey));

  return {
    now: facts.generatedAt,
    version: facts.version,
    scopeLabel: realm.realm,
    isRealmScoped: true,
    availableRealms: facts.realms.map((r) => r.realm),
    characters: realm.characters,
    gold: realm.gold,
    playtime: realm.playtime,
    progression: realm.progression,
    professions: realm.professions,
    inventory: realm.inventory,
    recentChanges: capRecentChangesAfterScope(
      facts.recentChanges.filter((c) => realmIdentityKeys.has(c.identityKey)),
    ),
    freshness: {
      recentCharacters: freshnessByCharacter.filter((c) => c.freshness === "recent").length,
      staleCharacters: freshnessByCharacter.filter((c) => c.freshness === "stale").length,
      unknownCharacters: freshnessByCharacter.filter((c) => c.freshness === "unknown").length,
      byCharacter: freshnessByCharacter,
    },
  };
}
