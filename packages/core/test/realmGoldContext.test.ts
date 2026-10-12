// Gold context respects each version's economic scope.
//
// Classic Era / TBC Anniversary / Forever are realm-partitioned: realms share
// no economy, so the payload for those versions carries gold PER REALM and
// deliberately no version-wide total the model could mistake for one balance.
// Retail is account-wide: one total. Versions never contribute to each other.
// The canonical AccountContext (developer export) keeps both views but says,
// in-band, which one to use.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { REALM_SCOPE_NOTE } from "../src/accountContext.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");
const NOW = 1_790_000_000;
const ERA = { clientVersion: "1.15.9", clientBuild: "69547" };
const FOREVER = { clientVersion: "1.60.1", clientBuild: "69913", clientFamily: "Forever", interface: "16001" };
const RETAIL = { clientVersion: "12.1.0", clientBuild: "69814", clientFamily: "Retail", interface: "120100" };

function exp(client: object, name: string, realm: string, moneyCopper?: number, gen = NOW - 100) {
  return buildWowSyncExport({ generatedAt: gen, character: { name, realm, moneyCopper, ...client } });
}

// --- The canonical AccountContext (developer export) ------------------------------------------

test("[SYNTHETIC] the canonical export tells its reader, in-band, that realm-partitioned totals are derived cross-realm sums", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(exp(ERA, "Alpha", "Firemaw", 100));
    const ctx = store.buildAccountContext(NOW);
    assert.equal(ctx.versions["classic-era"].scopeNote, REALM_SCOPE_NOTE);
    assert.equal(ctx.versions["tbc-anniversary"].scopeNote, REALM_SCOPE_NOTE);
    assert.equal(ctx.versions["forever"].scopeNote, REALM_SCOPE_NOTE);
    assert.equal("scopeNote" in ctx.versions["retail"], false, "Retail is account-wide: no such caveat");
    assert.match(REALM_SCOPE_NOTE, /facts\.realms\[\]/);
    assert.match(REALM_SCOPE_NOTE, /never present a cross-realm sum as one account balance/);
    // Both views are still present for consumers that need them.
    assert.equal(ctx.versions["classic-era"].facts.gold.totalKnownCopper, 100);
    assert.equal(ctx.versions["classic-era"].facts.realms[0].gold.totalKnownCopper, 100);
  } finally {
    store.close();
  }
});

test("the currency convention documents that a total over zero observed values is unknown, not zero", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const { currency } = store.buildAccountContext(NOW);
    assert.match(currency.note, /sum over nothing observed/);
    assert.match(currency.note, /NOT zero gold/);
    assert.match(currency.note, /never gold/, "the pre-existing copper convention is intact");
  } finally {
    store.close();
  }
});
