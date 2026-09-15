// Derives a single "current scope" view from AccountFacts: either one
// realm (Classic Era/TBC Anniversary) or the whole account (Retail/
// unknown-version). Keeps the view components (AccountOverview,
// AccountEconomy, CharactersGrid) agnostic to realm-partitioning — they
// just render whatever ScopedFacts they're handed.
import type { AccountFacts, FreshnessSummary } from "./types.ts";

export interface ScopedFacts {
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
      scopeLabel: "Account-wide",
      isRealmScoped: false,
      availableRealms: [],
      characters: facts.characters,
      gold: facts.gold,
      playtime: facts.playtime,
      progression: facts.progression,
      professions: facts.professions,
      inventory: facts.inventory,
      recentChanges: facts.recentChanges,
      freshness: facts.freshness,
    };
  }

  const realm = facts.realms.find((r) => r.realm === selectedRealm) ?? facts.realms[0];
  const realmIdentityKeys = new Set(realm.characters.map((c) => c.identityKey));
  const freshnessByCharacter = facts.freshness.byCharacter.filter((c) => realmIdentityKeys.has(c.identityKey));

  return {
    scopeLabel: realm.realm,
    isRealmScoped: true,
    availableRealms: facts.realms.map((r) => r.realm),
    characters: realm.characters,
    gold: realm.gold,
    playtime: realm.playtime,
    progression: realm.progression,
    professions: realm.professions,
    inventory: realm.inventory,
    recentChanges: facts.recentChanges.filter((c) => realmIdentityKeys.has(c.identityKey)),
    freshness: {
      recentCharacters: freshnessByCharacter.filter((c) => c.freshness === "recent").length,
      staleCharacters: freshnessByCharacter.filter((c) => c.freshness === "stale").length,
      unknownCharacters: freshnessByCharacter.filter((c) => c.freshness === "unknown").length,
      byCharacter: freshnessByCharacter,
    },
  };
}
