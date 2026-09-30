import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const NOW = 1_700_000_000;

test("known spells and trainer evidence are bounded, snapshot-scoped, and preserve capture states", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const older = store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 20, character: { name: "Learner", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" }, spells: { coverage: "Active player spellbook", entries: [{ spellID: 10, name: "Fireball", rank: "Rank 1" }] }, trainer: { categories: [{ category: "CLASS", state: "LAST_SEEN", observedAt: NOW - 100, visitedNPC: "Old Trainer", services: [{ spellID: 10, ability: "Fireball", rank: "Rank 1", status: "known" }, { ability: "Frostbolt", status: "available", requiredLevel: 2 }] }] } }));
    const latest = store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 10, character: { name: "Learner", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" }, spells: { coverage: "Active player spellbook", entries: [{ spellID: 10, name: "Fireball", rank: "Rank 1" }, { spellID: 11, name: "Frostbolt", rank: "Rank 1" }, { spellID: 12, name: "Arcane Intellect", rank: "" }] }, trainer: { categories: [{ category: "CLASS", name: "Current Trainer", services: [{ spellID: 10, ability: "Fireball", rank: "Rank 1", status: "known" }, { ability: "Frostbolt", status: "available", requiredLevel: 2 }, { ability: "Mystery", status: "vendor-special", requirements: "unclassified" }] }] } }));
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 10, character: { name: "Unknown", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" }, spells: { unknown: true }, trainer: { unknown: true } }));
    const read = new DashboardReadModel(store, () => NOW);
    const spells = read.getCharacterSpells({ version: "retail", name: "Learner", realm: "Cairne", query: "frost", limit: 1 });
    assert.equal(spells.status, "FOUND");
    if (spells.status === "FOUND") {
      assert.equal(spells.value.provenance.state, "OBSERVED");
      assert.equal(spells.value.data?.spells?.totalCount, 1);
      assert.equal(spells.value.data?.spells?.items[0]?.name, "Frostbolt");
      assert.equal(spells.value.data?.snapshot?.snapshotId, latest.snapshot.id);
      assert.match(spells.value.data?.coverage ?? "", /Active player spellbook/);
    }
    const oldSpells = read.getCharacterSpells({ version: "retail", name: "Learner", realm: "Cairne", snapshotId: older.snapshot.id });
    assert.equal(oldSpells.status, "FOUND");
    if (oldSpells.status === "FOUND") assert.equal(oldSpells.value.data?.spells?.totalCount, 1);
    const trainer = read.getCharacterTrainer({ version: "retail", name: "Learner", realm: "Cairne", status: "available" });
    assert.equal(trainer.status, "FOUND");
    if (trainer.status === "FOUND") {
      assert.equal(trainer.value.data?.totalCount, 1);
      assert.equal(trainer.value.data?.services[0]?.statusAtVisit, "available");
      assert.equal(trainer.value.data?.categories[0]?.trainerName, "Current Trainer");
      assert.equal(trainer.value.data?.categories[0]?.statusCounts.other, 1);
    }
    const historicalTrainer = read.getCharacterTrainer({ version: "retail", name: "Learner", realm: "Cairne", snapshotId: older.snapshot.id });
    assert.equal(historicalTrainer.status, "FOUND");
    if (historicalTrainer.status === "FOUND") {
      assert.equal(historicalTrainer.value.data?.services[0]?.statusAtVisit, "known");
      assert.ok(historicalTrainer.value.data?.services.every((service) => service.categoryState === "LAST_SEEN"));
      assert.match(historicalTrainer.value.provenance.warning ?? "", /historical/i);
    }
    const unknown = read.getCharacterSpells({ version: "retail", name: "Unknown", realm: "Cairne" });
    assert.equal(unknown.status, "FOUND");
    if (unknown.status === "FOUND") {
      assert.equal(unknown.value.provenance.state, "UNKNOWN");
      assert.equal(unknown.value.data?.spells, undefined);
    }
    assert.throws(() => read.getCharacterTrainer({ version: "retail", name: "Unknown", realm: "Cairne", snapshotId: latest.snapshot.id }), /belong to the resolved character/);
    assert.equal(read.getCharacterSpells({ version: "classic-era", name: "Learner", realm: "Cairne" }).status, "NOT_FOUND");
    assert.equal(read.getCharacterSpells({ version: "retail", name: "Learner" }).status, "FOUND");
    assert.equal(read.getCharacterTrainer({ version: "retail", name: "Unknown", realm: "Cairne" }).status, "FOUND");
    const tooMany = read.getCharacterTrainer({ version: "retail", name: "Learner", realm: "Cairne", limit: 500 });
    assert.equal(tooMany.status, "FOUND");
    if (tooMany.status === "FOUND") assert.equal(tooMany.value.data?.limit, 100);
  } finally { store.close(); }
});

test("detailed currencies preserve account scope, per-character evidence, zero and realm boundaries", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const retail = (name: string, at: number) => store.importSnapshot(buildWowSyncExport({ generatedAt: at, character: { name, realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } }), { currencies: { observedAt: at, data: { listRead: true, formatVersion: 1, currencies: [
      { currencyID: 1, name: "Account Token", quantity: name === "One" ? 0 : 9, isAccountWide: true },
      { currencyID: 2, name: "Character Token", quantity: name === "One" ? 2 : 3, isAccountWide: false },
      { currencyID: 3, name: "Scope Unknown Token", quantity: 42, isAccountWide: null },
    ] } } });
    retail("One", NOW - 30);
    retail("Two", NOW - 20);
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 10, character: { name: "Unknown", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } }));
    const old = readFileSync(new URL("./fixtures/classic-era/bromrik-1789171621.wowsync.txt", import.meta.url), "utf8");
    store.importSnapshot(old);
    const read = new DashboardReadModel(store, () => NOW);
    const accounts = read.getAccountCurrencies({ version: "retail", query: "token", limit: 1, characterLimit: 1 });
    assert.equal(accounts.data?.aggregationScope, "account-wide");
    assert.equal(accounts.data?.coverage.unknownCharacters, 1);
    assert.equal(accounts.data?.currencies.totalCount, 3);
    assert.equal(accounts.data?.currencies.truncated, true);
    const accountCurrency = read.getAccountCurrencies({ version: "retail", currencyID: 1 });
    const accountToken = accountCurrency.data?.currencies.items[0];
    assert.equal(accountToken?.scope, "ACCOUNT");
    assert.equal(accountToken?.account?.quantity, 9, "account-wide balance is selected once, never summed");
    assert.equal(accountToken?.characterTotalCount, 3);
    const charCurrency = read.getAccountCurrencies({ version: "retail", currencyID: 2 });
    assert.equal(charCurrency.data?.currencies.items[0]?.scope, "CHARACTER");
    assert.equal(charCurrency.data?.currencies.items[0]?.totals?.totalKnownQuantity, 5);
    assert.equal(charCurrency.data?.currencies.items[0]?.totals?.charactersUnknown, 1);
    const unknownScope = read.getAccountCurrencies({ version: "retail", currencyID: 3 }).data?.currencies.items[0];
    assert.equal(unknownScope?.scope, "UNKNOWN");
    assert.equal(unknownScope?.totals, null);
    assert.equal(unknownScope?.account, null);
    const overviewCurrency = read.getAccountOverview({ version: "retail" }).data?.currencies;
    assert.equal(Array.isArray(overviewCurrency), false);
    if (overviewCurrency && !Array.isArray(overviewCurrency) && overviewCurrency.scope === "account-wide") {
      const unknownOverview = overviewCurrency.items.find((item) => item.currencyID === 3);
      assert.equal(unknownOverview?.scope, "UNKNOWN");
      assert.equal("quantity" in (unknownOverview ?? {}), false);
    }
    assert.equal(read.getAccountCurrencies({ version: "classic-era", realm: "Defias Pillager" }).data?.aggregationScope, "realm");
    assert.throws(() => read.getAccountCurrencies({ version: "classic-era" }), /realm is required/);
    assert.throws(() => read.getAccountCurrencies({ version: "retail", realm: "Cairne" }), /not supported for Retail/);
    assert.throws(() => read.getAccountCurrencies({ version: "classic-era", realm: "Other" }), /No characters exist/);
  } finally { store.close(); }
});

test("account changes page the existing AccountFacts meaningfully changed character records", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 20, character: { name: "Change", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 10, moneyCopper: 0 } }));
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 10, character: { name: "Change", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 11, moneyCopper: 500 } }));
    const read = new DashboardReadModel(store, () => NOW);
    const result = read.getAccountChanges({ version: "retail", limit: 1 });
    assert.equal(result.data?.totalCount, 1);
    assert.equal(result.data?.items.length, 1);
    assert.equal(result.data?.items[0]?.realm, "Cairne");
    assert.equal(result.data?.items[0]?.toLevel, 11);
    assert.equal(result.data?.items[0]?.goldDeltaCopper, 500);
    assert.equal(result.provenance.state, "DERIVED");
  } finally { store.close(); }
});
