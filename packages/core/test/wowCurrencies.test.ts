// Retail currencies: validation of GearExport's structured section (M1 shape), storage with snapshots, and the
// OBSERVED / LAST_SEEN / UNKNOWN read models. Unknown is never zero; absent fields stay null; account-wide
// currencies are reported once and never summed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildAccountCurrencies, characterCurrenciesView, currencyCarryReason, normalizeCurrencySection } from "../src/wowCurrencies.ts";
import { luaToPlain, parseSavedVariables } from "../src/savedVariables.ts";
import { RETAIL_CURRENCIES, currencySection, currencySectionLua } from "./currencyFixtures.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const RETAIL = { clientVersion: "12.1.0", clientFamily: "Retail", interface: "120100" };
const T0 = 1_789_000_000;
const retailExport = (name: string, generatedAt: number, moneyCopper = 1000) =>
  buildWowSyncExport({ generatedAt, character: { name, realm: "Cairne", level: 80, moneyCopper, ...RETAIL } });
const key = (name: string) => `retail::cairne::${name.toLowerCase()}`;

function withStore(run: (store: SqliteSnapshotStore) => void) {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    run(store);
  } finally {
    store.close();
  }
}

// --- validation ----------------------------------------------------------------------------------------

test("normalizeCurrencySection keeps every M1 field and leaves absent fields null (never 0)", () => {
  const n = normalizeCurrencySection(currencySection({ observedAt: T0 }));
  assert.equal(n.ok, true);
  if (!n.ok) return;
  const s = n.section;
  assert.equal(s.listRead, true);
  assert.equal(s.formatVersion, 1);
  assert.equal(s.observedAt, T0);
  assert.equal(s.completeness, "complete");
  assert.equal(s.listFilter, "0");
  assert.equal(s.entries.length, RETAIL_CURRENCIES.length);
  assert.equal(s.droppedEntries, 0);
  const crest = s.entries.find((e) => e.currencyID === 3290)!;
  assert.deepEqual(crest, {
    currencyID: 3290,
    name: "Gilded Ethereal Crest",
    header: "The War Within",
    subHeader: "Season 3",
    listOrder: 4,
    iconFileID: 6215560,
    quantity: 45,
    maxQuantity: 360,
    quantityEarnedThisWeek: 45,
    maxWeeklyQuantity: 90,
    canEarnPerWeek: true,
    totalEarned: 300,
    useTotalEarnedForMaxQty: true,
    isAccountWide: false,
    isAccountTransferable: false,
    transferPercentage: null,
  });
  const badge = s.entries.find((e) => e.currencyID === 1166)!;
  assert.equal(badge.quantity, null);
  assert.equal(badge.maxQuantity, null);
  assert.equal(badge.isAccountWide, null);
  assert.equal(badge.subHeader, null);
  // A real zero reported by the game stays a zero.
  assert.equal(s.entries.find((e) => e.currencyID === 3028)!.quantity, 0);
});

test("normalizeCurrencySection refuses unread lists and bad entries instead of guessing", () => {
  assert.deepEqual(normalizeCurrencySection("nope"), { ok: false, reason: "not-a-table" });
  assert.deepEqual(normalizeCurrencySection({ completeness: "unknown", lastAttemptError: "Currency list APIs unavailable" }), { ok: false, reason: "no-data" });
  assert.deepEqual(normalizeCurrencySection(currencySection({ observedAt: T0, listRead: false })), { ok: false, reason: "list-not-read" });
  assert.deepEqual(normalizeCurrencySection(currencySection({ observedAt: T0, formatVersion: 2 })), { ok: false, reason: "unsupported-format" });

  const section = currencySection({ observedAt: T0 });
  const data = section.data as { currencies: unknown[] };
  data.currencies.push({ listOrder: 9, name: "no id" }, { currencyID: -4 }, { currencyID: 3008, quantity: 1 }, { currencyID: 77, quantity: "12", isAccountWide: 1 });
  const n = normalizeCurrencySection(section);
  assert.equal(n.ok, true);
  if (!n.ok) return;
  assert.equal(n.section.droppedEntries, 3, "no id, a non-positive id and a repeated id are dropped and counted");
  assert.equal(n.section.entries.find((e) => e.currencyID === 3008)!.quantity, 1540, "the first occurrence wins");
  const odd = n.section.entries.find((e) => e.currencyID === 77)!;
  assert.equal(odd.quantity, null, "a wrongly typed field is null, not coerced");
  assert.equal(odd.isAccountWide, null);
});

test("the Lua section as WoW writes it converts to the same plain JSON the bridge sends", () => {
  const lua = `WoWSyncDB = {\r\n["x"] = {\r\n${currencySectionLua({ observedAt: T0 })}\r\n},\r\n}\r\n`;
  const parsed = parseSavedVariables(lua, { only: ["WoWSyncDB"] });
  const table = (parsed.WoWSyncDB as Map<string, any>).get("x").get("currencies");
  const plain = luaToPlain(table) as Record<string, any>;
  assert.ok(Array.isArray(plain.data.currencies));
  const fromLua = normalizeCurrencySection(plain);
  const fromJson = normalizeCurrencySection(currencySection({ observedAt: T0 }));
  assert.deepEqual(fromLua, fromJson);
});

test("currencyCarryReason: a list read during this snapshot's session is fresh even though it predates Generated", () => {
  // Read at login (T0 + 100), export written at logout (T0 + 3600); previous export at T0.
  assert.equal(currencyCarryReason(T0 + 100, T0 + 3600, T0, null), undefined);
  // First export ever: nothing proves it is carried.
  assert.equal(currencyCarryReason(T0 - 5000, T0, undefined, null), undefined);
  // Already known when the previous export was written: carried from an older session.
  assert.equal(currencyCarryReason(T0 - 10, T0 + 3600, T0, null), "predates-previous-export");
  assert.equal(currencyCarryReason(T0, T0 + 3600, T0, null), "predates-previous-export");
  // GearExport says its latest refresh failed.
  assert.equal(currencyCarryReason(T0 + 100, T0 + 3600, T0, "Currency list unavailable"), "refresh-failed");
  assert.equal(currencyCarryReason(null, T0 + 3600, T0, null), "no-observed-time");
});

// --- storage + per-character state ----------------------------------------------------------------------

test("OBSERVED: a Retail snapshot with an M1 currencies section stores one row per currency, absent fields NULL", () => {
  withStore((store) => {
    const result = store.importSnapshot(retailExport("Virek", T0 + 3600), { currencies: currencySection({ observedAt: T0 + 100 }) });
    assert.equal(result.isDuplicate, false);
    assert.equal(result.currencies?.outcome, "stored");
    assert.equal(result.currencies?.rows, RETAIL_CURRENCIES.length);
    assert.equal(result.currencies?.carried, false);

    const view = store.getCharacterCurrencies(key("Virek"))!;
    assert.equal(view.schema, "currencies-1");
    assert.equal(view.state, "OBSERVED");
    assert.equal(view.observedAt, T0 + 100);
    assert.equal(view.snapshotId, result.snapshot.id);
    assert.equal(view.lastSeenReason, null);
    assert.equal(view.formatVersion, 1);
    assert.equal(view.completeness, "complete");
    assert.deepEqual(view.currencies!.map((c) => c.currencyID), [3008, 2803, 3028, 3290, 1166], "list order");
    const valor = view.currencies![0];
    assert.equal(valor.quantity, 1540);
    assert.equal(valor.transferPercentage, 90);
    assert.equal(valor.isAccountTransferable, true);
    assert.equal(valor.quantityEarnedThisWeek, null);
    assert.equal(valor.totalEarned, null);
    const badge = view.currencies!.find((c) => c.currencyID === 1166)!;
    for (const field of ["quantity", "maxQuantity", "iconFileID", "canEarnPerWeek", "isAccountWide", "transferPercentage", "subHeader"] as const) {
      assert.equal(badge[field], null, `${field} stays null`);
    }
    assert.equal(view.currencies!.find((c) => c.currencyID === 3028)!.quantity, 0, "a real zero stays zero");
    assert.equal(view.currencies!.find((c) => c.currencyID === 2803)!.maxQuantity, 0);
  });
});

test("UNKNOWN: a character that never exported currency data has currencies null, never an empty or zero list", () => {
  withStore((store) => {
    const result = store.importSnapshot(retailExport("Nocurr", T0));
    assert.equal(result.currencies, undefined, "no section sent, no outcome");
    const view = store.getCharacterCurrencies(key("Nocurr"))!;
    assert.equal(view.state, "UNKNOWN");
    assert.equal(view.currencies, null);
    assert.equal(view.observedAt, null);
    assert.equal(view.snapshotId, null);
    assert.equal(store.getCharacterCurrencies("retail::cairne::nobody"), undefined);

    // An unread section (attempt failed, no data) is not storable: still UNKNOWN.
    const r2 = store.importSnapshot(retailExport("Nocurr", T0 + 50), { currencies: { completeness: "unknown", lastAttemptError: "Currency list APIs unavailable" } });
    assert.deepEqual(r2.currencies, { outcome: "skipped", reason: "no-data", snapshotId: r2.snapshot.id });
    assert.equal(store.getCharacterCurrencies(key("Nocurr"))!.state, "UNKNOWN");
  });
});

test("LAST_SEEN: the latest snapshot has no currencies section, so the older list is shown with its date", () => {
  withStore((store) => {
    const first = store.importSnapshot(retailExport("Virek", T0), { currencies: currencySection({ observedAt: T0 - 60 }) });
    store.importSnapshot(retailExport("Virek", T0 + 7200, 2000));
    const view = store.getCharacterCurrencies(key("Virek"))!;
    assert.equal(view.state, "LAST_SEEN");
    assert.equal(view.lastSeenReason, "latest-snapshot-has-no-currency-section");
    assert.equal(view.observedAt, T0 - 60);
    assert.equal(view.snapshotId, first.snapshot.id);
    assert.equal(view.currencies!.length, RETAIL_CURRENCIES.length);
  });
});

test("LAST_SEEN: a section older than the snapshot's own session is stored but marked carried", () => {
  withStore((store) => {
    store.importSnapshot(retailExport("Virek", T0), { currencies: currencySection({ observedAt: T0 - 60 }) });
    // The next export carries the SAME old list (not re-read this session: observedAt <= previous export).
    const second = store.importSnapshot(retailExport("Virek", T0 + 7200, 2000), { currencies: currencySection({ observedAt: T0 - 60 }) });
    assert.equal(second.currencies?.outcome, "stored");
    assert.equal(second.currencies?.carried, true);
    assert.equal(second.currencies?.carriedReason, "predates-previous-export");
    const view = store.getCharacterCurrencies(key("Virek"))!;
    assert.equal(view.state, "LAST_SEEN");
    assert.equal(view.lastSeenReason, "predates-previous-export");
    assert.equal(view.observedAt, T0 - 60);

    // A later export with a list re-read in its own session is OBSERVED again.
    const third = store.importSnapshot(retailExport("Virek", T0 + 20000, 3000), { currencies: currencySection({ observedAt: T0 + 15000 }) });
    assert.equal(third.currencies?.carried, false);
    const fresh = store.getCharacterCurrencies(key("Virek"))!;
    assert.equal(fresh.state, "OBSERVED");
    assert.equal(fresh.snapshotId, third.snapshot.id);
  });
});

test("LAST_SEEN: GearExport's failed refresh (lastAttemptError) marks the kept list carried", () => {
  withStore((store) => {
    const r = store.importSnapshot(retailExport("Virek", T0), { currencies: currencySection({ observedAt: T0 - 60, lastAttemptError: "Currency list unavailable" }) });
    assert.equal(r.currencies?.carriedReason, "refresh-failed");
    const view = store.getCharacterCurrencies(key("Virek"))!;
    assert.equal(view.state, "LAST_SEEN");
    assert.equal(view.lastSeenReason, "refresh-failed");
    assert.equal(view.observedAt, T0 - 60);
  });
});

test("a duplicate export may attach a currencies section once; the snapshot itself is unchanged", () => {
  withStore((store) => {
    const text = retailExport("Virek", T0 + 3600);
    const first = store.importSnapshot(text);
    assert.equal(store.getCharacterCurrencies(key("Virek"))!.state, "UNKNOWN");
    const again = store.importSnapshot(text, { currencies: currencySection({ observedAt: T0 + 100 }) });
    assert.equal(again.isDuplicate, true);
    assert.equal(again.snapshot.id, first.snapshot.id);
    assert.equal(again.character.snapshotCount, 1);
    assert.equal(again.currencies?.outcome, "attached");
    assert.equal(again.currencies?.rows, RETAIL_CURRENCIES.length);
    assert.equal(store.getCharacterCurrencies(key("Virek"))!.state, "OBSERVED");
    const third = store.importSnapshot(text, { currencies: currencySection({ observedAt: T0 + 200 }) });
    assert.equal(third.currencies?.outcome, "already-stored");
    assert.equal(store.getCharacterCurrencies(key("Virek"))!.observedAt, T0 + 100, "the stored section is not replaced");
  });
});

test("sections that cannot be stored are skipped with a reason and never block the text import", () => {
  withStore((store) => {
    const bad = store.importSnapshot(retailExport("Virek", T0), { currencies: "garbage" });
    assert.equal(bad.isDuplicate, false);
    assert.equal(bad.currencies?.outcome, "skipped");
    assert.equal(bad.currencies?.reason, "not-a-table");
    const classic = store.importSnapshot(
      buildWowSyncExport({ character: { name: "Torahn", realm: "Faerlina", clientVersion: "2.5.6" } }),
      { currencies: currencySection({ observedAt: T0 }) },
    );
    assert.equal(classic.currencies?.outcome, "skipped");
    assert.equal(classic.currencies?.reason, "unsupported-version");
    assert.equal(store.getCharacterCurrencies(classic.character.identityKey)!.state, "UNKNOWN");
  });
});

// --- account view ---------------------------------------------------------------------------------------

test("account view: account-wide currencies are reported once and never summed; UNKNOWN is never zero", () => {
  withStore((store) => {
    store.importSnapshot(retailExport("Virek", T0 + 3600), { currencies: currencySection({ observedAt: T0 + 100 }) });
    const alt = RETAIL_CURRENCIES.filter((c) => c.currencyID !== 3290).map((c) =>
      c.currencyID === 2803 ? { ...c, quantity: 3350 } : c.currencyID === 3008 ? { ...c, quantity: 460 } : c,
    );
    store.importSnapshot(retailExport("Altria", T0 + 9000), { currencies: currencySection({ observedAt: T0 + 8000, entries: alt }) });
    store.importSnapshot(retailExport("Nocurr", T0 + 9500));

    const account = store.listVersionCurrencies("retail");
    assert.equal(account.schema, "currencies-1");
    assert.equal(account.version, "retail");
    assert.deepEqual(account.characters.map((c) => [c.name, c.state]), [["Altria", "OBSERVED"], ["Nocurr", "UNKNOWN"], ["Virek", "OBSERVED"]]);

    const undercoin = account.currencies.find((c) => c.currencyID === 2803)!;
    assert.equal(undercoin.scope, "ACCOUNT");
    assert.equal(undercoin.totals, null, "no total for an account-wide balance");
    assert.equal(undercoin.account!.quantity, 3350, "the most recent reading, reported once");
    assert.equal(undercoin.account!.sourceIdentityKey, key("Altria"));
    assert.equal(undercoin.account!.state, "OBSERVED");
    assert.ok(!JSON.stringify(undercoin).includes(String(3200 + 3350)), "never summed across characters");
    assert.deepEqual(undercoin.characters.map((c) => [c.name, c.state, c.listed, c.currency?.quantity ?? null]), [
      ["Altria", "OBSERVED", true, 3350],
      ["Nocurr", "UNKNOWN", null, null],
      ["Virek", "OBSERVED", true, 3200],
    ]);

    const valor = account.currencies.find((c) => c.currencyID === 3008)!;
    assert.equal(valor.scope, "CHARACTER");
    assert.equal(valor.account, null);
    assert.equal(valor.totals!.totalKnownQuantity, 1540 + 460);
    assert.equal(valor.totals!.charactersWithKnownQuantity, 2);
    assert.equal(valor.totals!.charactersUnknown, 1, "the UNKNOWN character is counted as unknown, not as zero");
    assert.equal(valor.totals!.oldestKnownQuantityObservedAt, T0 + 100);

    const crest = account.currencies.find((c) => c.currencyID === 3290)!;
    assert.equal(crest.totals!.charactersNotListed, 1, "Altria's read list lacks it: not listed, not zero");
    assert.equal(crest.totals!.totalKnownQuantity, 45);
    assert.equal(crest.characters.find((c) => c.name === "Altria")!.listed, false);
    assert.equal(crest.characters.find((c) => c.name === "Altria")!.currency, null);

    const badge = account.currencies.find((c) => c.currencyID === 1166)!;
    assert.equal(badge.totals!.charactersWithKnownQuantity, 0);
    assert.equal(badge.totals!.charactersListedWithoutQuantity, 2);
    assert.equal("totalKnownQuantity" in badge.totals!, false, "a sum over nothing is omitted, never 0");
    assert.equal("oldestKnownQuantityObservedAt" in badge.totals!, false);

    assert.deepEqual(account.currencies.map((c) => c.currencyID), [3008, 2803, 3028, 3290, 1166]);
  });
});

test("account view: LAST_SEEN readings are stated as such, and a version with no lists has no currencies", () => {
  withStore((store) => {
    store.importSnapshot(retailExport("Virek", T0), { currencies: currencySection({ observedAt: T0 - 60 }) });
    store.importSnapshot(retailExport("Virek", T0 + 7200, 2000));
    const account = store.listVersionCurrencies("retail");
    const valor = account.currencies.find((c) => c.currencyID === 3008)!;
    assert.equal(valor.characters[0].state, "LAST_SEEN");
    assert.equal(valor.totals!.lastSeenCharactersWithKnownQuantity, 1);
    assert.equal(account.currencies.find((c) => c.currencyID === 2803)!.account!.state, "LAST_SEEN");

    const empty = store.listVersionCurrencies("classic-era");
    assert.deepEqual(empty.currencies, []);
  });
});

test("buildAccountCurrencies over only UNKNOWN characters yields no currencies and no totals", () => {
  const ref = { identityKey: "retail::r::a", name: "A", realm: "R", version: "retail" as const };
  const view = characterCurrenciesView(ref, undefined, []);
  const account = buildAccountCurrencies("retail", [view]);
  assert.deepEqual(account.currencies, []);
  assert.deepEqual(account.characters, [{ identityKey: ref.identityKey, name: "A", realm: "R", state: "UNKNOWN", observedAt: null, snapshotId: null }]);
});

// --- migration + deletion -------------------------------------------------------------------------------

test("the schema migration is additive: an existing database gains the tables and keeps its data", () => {
  const dir = mkdtempSync(join(tmpdir(), "wowsync-currencies-"));
  const file = join(dir, "db.sqlite");
  try {
    const before = new SqliteSnapshotStore(file);
    const imported = before.importSnapshot(retailExport("Virek", T0));
    before.close();
    // Simulate a database created before this change.
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE snapshot_currencies; DROP TABLE snapshot_currency_sections;");
    raw.close();

    const after = new SqliteSnapshotStore(file);
    try {
      assert.equal(after.getSnapshot(imported.snapshot.id)?.parsed.character.name, "Virek");
      assert.equal(after.getCharacterCurrencies(key("Virek"))!.state, "UNKNOWN");
      const r = after.importSnapshot(retailExport("Virek", T0), { currencies: currencySection({ observedAt: T0 - 5 }) });
      assert.equal(r.currencies?.outcome, "attached");
    } finally {
      after.close();
    }
    const check = new DatabaseSync(file);
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'snapshot_currenc%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    assert.deepEqual(tables, ["snapshot_currencies", "snapshot_currency_sections"]);
    const nullCount = check.prepare("SELECT COUNT(*) AS n FROM snapshot_currencies WHERE currency_id = 1166 AND quantity IS NULL AND max_quantity IS NULL AND is_account_wide IS NULL").get() as { n: number };
    assert.equal(nullCount.n, 1, "absent fields are stored as NULL");
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a character removes its currency rows too", () => {
  const dir = mkdtempSync(join(tmpdir(), "wowsync-currencies-"));
  const file = join(dir, "db.sqlite");
  try {
    const store = new SqliteSnapshotStore(file);
    store.importSnapshot(retailExport("Virek", T0), { currencies: currencySection({ observedAt: T0 - 5 }) });
    store.importSnapshot(retailExport("Altria", T0), { currencies: currencySection({ observedAt: T0 - 5 }) });
    assert.equal(store.deleteCharacter(key("Virek"))?.snapshotsDeleted, 1);
    assert.equal(store.getCharacterCurrencies(key("Virek")), undefined);
    store.close();
    const check = new DatabaseSync(file);
    const rows = check.prepare("SELECT COUNT(*) AS n FROM snapshot_currencies").get() as { n: number };
    const sections = check.prepare("SELECT COUNT(*) AS n FROM snapshot_currency_sections").get() as { n: number };
    check.close();
    assert.equal(rows.n, RETAIL_CURRENCIES.length, "only Altria's rows remain");
    assert.equal(sections.n, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});