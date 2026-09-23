import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountChangeSummary, AccountFacts, CharacterFacts, RealmGroup } from "../src/types.ts";
import { RECENT_CHANGES_DISPLAY_CAP, capRecentChangesAfterScope, scopeFacts } from "../src/scopedFacts.ts";

const NOW = 1_700_000_000;

function change(over: Partial<AccountChangeSummary> & Pick<AccountChangeSummary, "identityKey" | "characterName" | "observedAt">): AccountChangeSummary {
  return {
    importedAt: over.observedAt ?? NOW,
    levelChanged: true,
    fromLevel: 10,
    toLevel: 11,
    professionChanged: false,
    equipmentChanged: false,
    inventoryChanged: false,
    locationChanged: false,
    trainerUnlocked: false,
    ...over,
  };
}

function char(over: Partial<CharacterFacts> & Pick<CharacterFacts, "identityKey" | "name" | "realm">): CharacterFacts {
  return {
    snapshotCount: 2,
    freshness: "recent",
    bankStatus: "UNKNOWN",
    professionsObservationStatus: "UNKNOWN",
    bagsStatus: "UNKNOWN",
    ...over,
  };
}

const emptyGold = {
  totalKnownCopper: 0,
  charactersWithKnownGold: 0,
  charactersWithUnknownGold: 0,
  staleCharactersWithKnownGold: 0,
  byCharacter: [] as AccountFacts["gold"]["byCharacter"],
  largestRecentChanges: [] as AccountFacts["gold"]["largestRecentChanges"],
};
const emptyPlaytime = {
  totalKnownPlayedSeconds: 0,
  charactersWithKnownPlaytime: 0,
  staleCharactersWithKnownPlaytime: 0,
  byCharacter: [] as AccountFacts["playtime"]["byCharacter"],
};
const emptyProgression = {
  byCharacter: [] as AccountFacts["progression"]["byCharacter"],
  recentLevelUps: [] as AccountFacts["progression"]["recentLevelUps"],
};
const emptyProfessions = {
  byCharacter: [] as AccountFacts["professions"]["byCharacter"],
  coverage: [] as AccountFacts["professions"]["coverage"],
};
const emptyInventory = {
  items: [] as AccountFacts["inventory"]["items"],
  unknownBank: [] as AccountFacts["inventory"]["unknownBank"],
  unknownBags: [] as AccountFacts["inventory"]["unknownBags"],
  hasUnknownStorage: false,
};

function realmGroup(realm: string, characters: CharacterFacts[]): RealmGroup {
  return {
    realm,
    characterCount: characters.length,
    characters,
    gold: emptyGold,
    playtime: emptyPlaytime,
    progression: emptyProgression,
    professions: emptyProfessions,
    inventory: emptyInventory,
  };
}

function facts(over: Partial<AccountFacts> & Pick<AccountFacts, "aggregationScope" | "recentChanges" | "realms" | "characters">): AccountFacts {
  return {
    version: "tbc-anniversary",
    generatedAt: NOW,
    characterCount: over.characters.length,
    gold: emptyGold,
    playtime: emptyPlaytime,
    progression: emptyProgression,
    professions: emptyProfessions,
    inventory: emptyInventory,
    freshness: {
      recentCharacters: over.characters.length,
      staleCharacters: 0,
      unknownCharacters: 0,
      byCharacter: over.characters.map((c) => ({
        identityKey: c.identityKey,
        name: c.name,
        freshness: c.freshness,
        lastObservedAt: c.lastObservedAt,
      })),
    },
    ...over,
  };
}

test("capRecentChangesAfterScope keeps newest-first order and defaults to 20", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i, observedAt: NOW - i }));
  const capped = capRecentChangesAfterScope(rows);
  assert.equal(capped.length, RECENT_CHANGES_DISPLAY_CAP);
  assert.deepEqual(capped.map((r) => r.id), Array.from({ length: 20 }, (_, i) => i));
  assert.equal(capRecentChangesAfterScope(rows, 5).length, 5);
  assert.equal(capRecentChangesAfterScope(rows.slice(0, 3)).length, 3);
});

test("scopeFacts filters by realm then caps: a realm-B change outside version-wide top-20 still appears", () => {
  const realmAChars = Array.from({ length: 21 }, (_, i) =>
    char({ identityKey: `tbc-anniversary::Faerlina::Dom${i}`, name: `Dom${i}`, realm: "Faerlina" }),
  );
  const quiet = char({ identityKey: "tbc-anniversary::Grobbulus::Quiet", name: "Quiet", realm: "Grobbulus" });

  // Newest-first version-wide list: 21 Faerlina rows, then Quiet (would be dropped by a pre-scope cap of 20).
  const recentChanges = [
    ...realmAChars.map((c, i) => change({ identityKey: c.identityKey, characterName: c.name, observedAt: NOW - i })),
    change({ identityKey: quiet.identityKey, characterName: "Quiet", observedAt: NOW - 1000 }),
  ];
  assert.equal(recentChanges.length, 22);
  assert.equal(capRecentChangesAfterScope(recentChanges).some((c) => c.characterName === "Quiet"), false);

  const f = facts({
    aggregationScope: "realm",
    characters: [...realmAChars, quiet],
    realms: [realmGroup("Faerlina", realmAChars), realmGroup("Grobbulus", [quiet])],
    recentChanges,
  });

  const scopedB = scopeFacts(f, "Grobbulus");
  assert.equal(scopedB.isRealmScoped, true);
  assert.equal(scopedB.scopeLabel, "Grobbulus");
  assert.equal(scopedB.recentChanges.length, 1);
  assert.equal(scopedB.recentChanges[0].characterName, "Quiet");

  const scopedA = scopeFacts(f, "Faerlina");
  assert.equal(scopedA.recentChanges.length, RECENT_CHANGES_DISPLAY_CAP);
  assert.equal(scopedA.recentChanges.every((c) => c.identityKey.includes("Faerlina")), true);
  assert.equal(scopedA.recentChanges.some((c) => c.characterName === "Quiet"), false);
});

test("account-wide scope also caps recentChanges at 20 for display consistency", () => {
  const characters = Array.from({ length: 25 }, (_, i) =>
    char({ identityKey: `retail::Area52::R${i}`, name: `R${i}`, realm: "Area52" }),
  );
  const recentChanges = characters.map((c, i) =>
    change({ identityKey: c.identityKey, characterName: c.name, observedAt: NOW - i }),
  );
  const f = facts({
    version: "retail",
    aggregationScope: "account-wide",
    characters,
    realms: [],
    recentChanges,
  });
  const scoped = scopeFacts(f, null);
  assert.equal(scoped.isRealmScoped, false);
  assert.equal(scoped.recentChanges.length, RECENT_CHANGES_DISPLAY_CAP);
  assert.equal(scoped.recentChanges[0].characterName, "R0");
  assert.equal(scoped.recentChanges[19].characterName, "R19");
});
