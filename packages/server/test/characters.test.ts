// HTTP-level tests for Forever version support and the character-deletion
// endpoint. Real Forever/TBC fixtures (shared with the core tests) are
// imported through the real POST /api/import route, and every assertion goes
// through the real HTTP API - including the derived views (account facts,
// account context, recent changes) that must reflect a deletion on their
// own, with nothing to invalidate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { createApp } from "../src/app.ts";
import { readSavedExports } from "../src/importSaved.ts";

const fixtures = fileURLToPath(new URL("../../core/test/fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${fixtures}${path}`, "utf8");

const HALLO = "forever::classic beta pvp 2::hallo emberstone";
const VOODAN = "tbc-anniversary::dreamscythe::voodan";
const TORAHN = "tbc-anniversary::dreamscythe::torahn";

async function withApp(run: (api: Api) => Promise<void>, seedStore?: (store: SqliteSnapshotStore) => void) {
  const store = new SqliteSnapshotStore(":memory:");
  seedStore?.(store);
  const app = createApp(store, 0);
  const server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api: Api = {
    base,
    async get(path) {
      const res = await fetch(base + path);
      return { status: res.status, body: await res.json() };
    },
    async import(file) {
      const res = await fetch(base + "/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: read(file) }),
      });
      return { status: res.status, body: await res.json() };
    },
    async importCapture(payload) {
      const res = await fetch(base + "/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      return { status: res.status, body: await res.json() };
    },
    async del(identityKey, body, rawBody) {
      const res = await fetch(`${base}/api/characters/${encodeURIComponent(identityKey)}`, {
        method: "DELETE",
        headers: body !== undefined || rawBody !== undefined ? { "Content-Type": "application/json" } : {},
        body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed as Record<string, any> };
    },
  };
  try {
    await run(api);
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
    store.close();
  }
}

interface Api {
  base: string;
  get(path: string): Promise<{ status: number; body: any }>;
  import(file: string): Promise<{ status: number; body: any }>;
  importCapture(payload: unknown): Promise<{ status: number; body: any }>;
  del(identityKey: string, body?: unknown, rawBody?: string): Promise<{ status: number; body: Record<string, any> }>;
}

async function seed(api: Api) {
  for (const f of [
    "tbc-anniversary/voodan-1789484723.wowsync.txt",
    "tbc-anniversary/voodan-1789492666.wowsync.txt",
    "tbc-anniversary/torahn-1789492498.wowsync.txt",
    "forever/hallo-1789693144.wowsync.txt",
    "forever/hallo-1789731867.wowsync.txt",
  ]) {
    const r = await api.import(f);
    assert.equal(r.status, 200, `importing ${f}`);
  }
}

// --- Forever over the API -----------------------------------------------------------------

test("[REAL] a Forever export imports through POST /api/import as a Forever character", async () => {
  await withApp(async (api) => {
    const r = await api.import("forever/hallo-1789731867.wowsync.txt");
    assert.equal(r.status, 200);
    assert.equal(r.body.result.character.version, "forever");
    assert.equal(r.body.result.character.identityKey, HALLO);
    assert.equal(r.body.result.character.latestMoneyCopper, 291);
  });
});

test("Forever observation REST route preserves the build guard for older captures", async () => {
  await withApp(async (api) => {
    await api.import("forever/hallo-1789731867.wowsync.txt");
    const response = await api.get(`/api/characters/${encodeURIComponent(HALLO)}/forever-gear-observation`);
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "FOUND");
    assert.equal(response.body.value.data, undefined);
    assert.match(response.body.value.provenance.reason, /build 70291 \/ interface 16001/);
  });
});

test("Forever potential equipment candidates reach REST and AccountContext with eligibility and upgrade UNKNOWN", async () => {
  const generatedAt = 1_791_509_781;
  const itemString = "item:1777:3:5";
  const text = buildWowSyncExport({ generatedAt, character: { name: "Gearcheck", realm: "Forever Realm", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" }, equipment: { slots: [] }, bags: { containers: [{ id: 0, capacity: 1, items: [{ itemRef: itemString, name: "Observed item", qty: 1 }] }] }, bank: { unknown: true } });
  await withApp(async (api) => {
    const key = "forever::forever realm::gearcheck";
    const rest = await api.get(`/api/characters/${encodeURIComponent(key)}/forever-gear-observation`);
    assert.equal(rest.body.value.data.evaluationCandidates.state, "OBSERVED");
    assert.equal(rest.body.value.data.evaluationCandidates.items[0].itemRef, itemString);
    assert.equal(rest.body.value.data.evaluationCandidates.items[0].eligibility, "UNKNOWN");
    assert.equal(rest.body.value.data.evaluationCandidates.items[0].upgradeStatus, "UNKNOWN");
    assert.equal(rest.body.value.data.bank.state, "UNKNOWN");
    const context = await api.get("/api/account-context");
    const accountView = context.body.versions.forever.characters.find((character: any) => character.identityKey === key).foreverGearObservation;
    assert.deepEqual(accountView.value, rest.body.value, "AccountContext reuses the REST read model result");
    assert.equal(context.body.versions.retail.characters.some((character: any) => character.identityKey === key), false);
  }, (store) => store.importSnapshot(text, { foreverGearObservation: {
    clientProfile: "Forever:1.60.1:70291:16001", name: "Gearcheck", realm: "Forever Realm", generatedAt, sourceCharacterGuid: "Player-GEARCHECK",
    equipment: { observedAt: generatedAt, completeness: "complete", data: { slots: {} } },
    bags: { observedAt: generatedAt, completeness: "complete", data: { containers: [{ id: 0, slots: { "1": { itemID: 1777, itemString, count: 1, name: "Observed item" } } }] } },
    itemEvidence: { observedAt: generatedAt, completeness: "complete", source: "Forever item API capture", data: { sourceSections: { bags: { observedAt: generatedAt, state: "complete" } }, items: [{ itemID: 1777, itemString,
      itemInfoInstant: { api: "C_Item.GetItemInfoInstant", state: "OBSERVED_VALUE", input: { itemString }, returns: [1777, "Armor", "Cloth", "INVTYPE_CHEST"].map((value) => ({ observation: { state: "OBSERVED", type: typeof value, value } })) },
      isEquippableItem: { api: "C_Item.IsEquippableItem", state: "OBSERVED_VALUE", returns: [{ observation: { state: "OBSERVED", type: "boolean", value: true } }] },
    }] } },
  } }));
});

test("Forever allocation route exposes separate evidence-gated decisions without cross-version leakage", async () => {
  const generatedAt = 1_791_549_000;
  const itemString = "item:2901::::::::8:1485::14:::::::";
  const text = buildWowSyncExport({ generatedAt, character: { name: "Allocator", realm: "Forever Realm", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001", class: "HUNTER", level: 8 }, bags: { containers: [] }, bank: { unknown: true } });
  await withApp(async (api) => {
    const key = "forever::forever realm::allocator";
    const response = await api.get(`/api/characters/${encodeURIComponent(key)}/forever-gear-allocation`);
    assert.equal(response.status, 200);
    const view = response.body.value.data;
    assert.equal(view.version, "forever");
    assert.equal(view.recipient.class.value, "HUNTER");
    assert.equal(view.recipient.level.value, 8);
    assert.equal(view.scope.accountMembership, "UNKNOWN");
    assert.equal(view.assessments.length, 1);
    assert.equal(view.assessments[0].candidate.itemRef, itemString);
    assert.equal(view.assessments[0].source.name, "Allocator");
    assert.equal(view.assessments[0].eligibility, "UNKNOWN");
    assert.equal(view.assessments[0].suitability, "UNKNOWN");
    assert.equal(view.assessments[0].upgradeStatus, "UNKNOWN");
    assert.equal(view.assessments[0].transferability, "UNKNOWN");
    assert.equal(view.assessments[0].allocationPriority, "UNRANKED");
    assert.equal(view.assessments[0].decision, "NO_RECOMMENDATION");
    assert.equal(view.assessments[0].candidate.binding.value, true);
    assert.ok(view.allocationPlan.length > 0);
    assert.ok(view.allocationPlan.every((entry: any) => entry.item.itemRef?.startsWith("item:") && entry.recipient.identityKey), "REST includes exact-variant plan rows with recipient identity");
    assert.match(view.scope.reason, /WoW account ID/);
    assert.match(view.assessments[0].missingEvidence.join(" "), /class\/item restriction evidence/);
    const account = await api.get("/api/account-context");
    const characterContext = account.body.versions.forever.characters.find((character: any) => character.identityKey === key);
    assert.deepEqual(characterContext.foreverGearAllocation.value.data, view, "AccountContext carries the same canonical allocation read model");
    assert.deepEqual(characterContext.foreverGearAllocation.value.data.allocationPlan, view.allocationPlan, "REST and AccountContext expose the identical allocation plan");
    const retailKey = encodeURIComponent("retail::forever realm::allocator");
    assert.equal((await api.get(`/api/characters/${retailKey}/forever-gear-allocation`)).body.code, "VERSION_NOT_SUPPORTED");
  }, (store) => {
    store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name: "Allocator", realm: "Forever Realm", clientFamily: "Retail", clientVersion: "12.1.0" } }));
    store.importSnapshot(text, { foreverGearObservation: {
    clientProfile: "Forever:1.60.1:70291:16001", name: "Allocator", realm: "Forever Realm", generatedAt, sourceCharacterGuid: "Player-ALLOCATOR",
    equipment: { observedAt: generatedAt, completeness: "complete", data: { slots: {} } },
    bags: { observedAt: generatedAt, completeness: "complete", data: { containers: [{ id: 0, slots: { "7": { itemID: 2901, itemString, count: 1, bound: true, bindingState: "OBSERVED_TRUE" } } }] } },
    bank: { observedAt: generatedAt, completeness: "unknown", data: {} },
    itemEvidence: { observedAt: generatedAt, completeness: "complete", source: "fixture API evidence", data: { sourceSections: { bags: { observedAt: generatedAt, state: "complete" } }, items: [{ itemID: 2901, itemString,
      itemInfoInstant: { api: "C_Item.GetItemInfoInstant", state: "OBSERVED_VALUE", input: { itemString }, returns: [2901, "Weapon", "Miscellaneous", "INVTYPE_WEAPONMAINHAND"].map((value) => ({ observation: { state: "OBSERVED", type: typeof value, value } })) },
      isEquippableItem: { api: "C_Item.IsEquippableItem", state: "OBSERVED_VALUE", returns: [{ observation: { state: "OBSERVED", type: "boolean", value: true } }] } }] } },
    } });
  });
});

const liveForeverSavedVariables = process.env.WOWSYNC_FOREVER_LIVE_SAVED_VARIABLES;
test("[LIVE REGRESSION] Hallo/Fizzwick 70291 mail-test captures stay evidence-qualified across REST and AccountContext", { skip: !liveForeverSavedVariables && "Set WOWSYNC_FOREVER_LIVE_SAVED_VARIABLES to the read-only Forever GearExport.lua capture." }, async () => {
  const saved = readSavedExports(liveForeverSavedVariables!);
  const hallo = saved.find((entry) => entry.name === "Hallo" && entry.realm === "Classic Beta PvP 2") as any;
  const fizzwick = saved.find((entry) => entry.name === "Fizzwick" && entry.realm === "Classic Beta PvP 2") as any;
  assert.ok(hallo?.text && hallo.foreverGearObservation, "the real capture contains Hallo's saved export and Forever 70291 sidecar");
  assert.ok(fizzwick?.text && fizzwick.foreverGearObservation, "the real capture contains Fizzwick's saved export and Forever 70291 sidecar");
  assert.equal(hallo.sourceCharacterGuid, "Player-4613-007ED867");
  assert.equal(fizzwick.sourceCharacterGuid, "Player-4613-00B0888B");
  assert.equal(hallo.foreverGearObservation.clientProfile, "Forever:1.60.1:70291:16001");
  assert.equal(fizzwick.foreverGearObservation.clientProfile, "Forever:1.60.1:70291:16001");
  assert.equal(fizzwick.foreverGearObservation.bags.completeness, "complete");
  const miningPickRef = "item:2901::::::::4:1482::14:::::::";
  assert.doesNotMatch(hallo.text, /item:2901[^\n]*\tMining Pick\t1\t/, "Hallo's current export no longer lists the Mining Pick in carried inventory");
  assert.match(fizzwick.text, new RegExp(`${miningPickRef}\\tMining Pick\\t1\\tno`), "Fizzwick's current export observes one unbound Mining Pick in carried inventory");
  const pick = fizzwick.foreverGearObservation.itemEvidence?.data?.items?.find((item: any) => item.itemString === miningPickRef);
  assert.ok(pick, "the exact received itemString has a current raw item API observation");
  assert.equal(pick.playerCanUseItem.returns[0].observation.value, true);
  assert.equal(pick.isEquippableItem.returns[0].observation.value, true);
  assert.equal(pick.itemInfoInstant.returns[1].observation.value, "Weapon");
  assert.equal(pick.itemInfoInstant.returns[2].observation.value, "Miscellaneous");
  assert.equal(pick.itemInfoInstant.returns[3].observation.value, "INVTYPE_WEAPONMAINHAND");
  assert.equal(pick.itemInfo.returns[4].observation.value, 1, "the live GetItemInfo tuple reports required level 1");
  assert.equal(pick.bindingEvidence.itemInfoBindType.observation.value, 0);
  assert.equal(pick.bindingEvidence.isItemBindToAccount.returns[0].observation.value, false);
  assert.equal(pick.bindingEvidence.isItemBindToAccountUntilEquip.returns[0].observation.value, false);
  assert.equal(pick.itemStats.table.entries[0].observation.value, 1.5);
  const pickDelta = fizzwick.foreverGearObservation.itemEvidence.data.statDeltaComparisons.comparisons.find((row: any) =>
    row.input?.equippedItemString === "item:35::::::::4:1482::75:::::::" && row.input?.candidateItemString === miningPickRef);
  assert.ok(pickDelta, "the capture includes a direct candidate-versus-equipped GetItemStatDelta call for Fizzwick");
  const dpsDelta = pickDelta.table.entries.find((entry: any) => entry.key === "ITEM_MOD_DAMAGE_PER_SECOND_SHORT");
  assert.ok(Math.abs(dpsDelta.observation.value - (1.5 - 1.379310369491577)) < 1e-9, "the observed delta is candidate DPS minus equipped DPS");
  await withApp(async (api) => {
    const imported = await api.importCapture({ text: hallo.text, foreverGearObservation: hallo.foreverGearObservation });
    assert.equal(imported.status, 200);
    const otherImport = await api.importCapture({ text: fizzwick.text, foreverGearObservation: fizzwick.foreverGearObservation });
    assert.equal(otherImport.status, 200);
    const identities = ["forever::classic beta pvp 2::hallo", "forever::classic beta pvp 2::fizzwick"];
    const allocations = new Map<string, any>();
    for (const key of identities) {
      const allocationResponse = await api.get(`/api/characters/${encodeURIComponent(key)}/forever-gear-allocation`);
      assert.equal(allocationResponse.status, 200);
      allocations.set(key, allocationResponse.body.value.data);
      const allocation = allocationResponse.body.value.data;
      assert.equal(allocation.version, "forever");
      assert.equal(allocation.scope.accountMembership, "UNKNOWN");
      assert.ok(allocation.candidateSources.every((source: any) => source.bank.state === "UNKNOWN"));
      assert.ok(allocation.assessments.every((row: any) => row.transferability === "UNKNOWN" || row.source.identityKey === row.recipient.identityKey));
    }
    const halloPlan = allocations.get(identities[0]).allocationPlan;
    const fizzwickPlan = allocations.get(identities[1]).allocationPlan;
    const crossScreen = halloPlan.find((row: any) => row.item.itemRef === miningPickRef && row.source.identityKey === identities[1] && row.recipient.identityKey === identities[0]);
    assert.ok(crossScreen, "the exact observed item can be screened against Hallo");
    assert.equal(crossScreen.disposition, "INSUFFICIENT_EVIDENCE");
    assert.equal(crossScreen.evidence.transferability, "UNKNOWN");
    assert.equal(crossScreen.comparison.upgradeStatus, "UNKNOWN", "a lower recorded DPS result is not promoted into an overall upgrade verdict");
    const fizzwickAssessment = allocations.get(identities[1]).assessments.find((row: any) => row.candidate.itemRef === miningPickRef);
    assert.equal(fizzwickAssessment.playerApiSignal, "TRUE");
    assert.equal(fizzwickAssessment.eligibility, "UNKNOWN", "raw use/equippable signals do not erase unresolved weapon proficiency");
    assert.equal(fizzwickAssessment.upgradeStatus, "UNKNOWN");
    assert.equal(fizzwickAssessment.decision, "NO_RECOMMENDATION");
    assert.equal(fizzwickAssessment.statDeltaCalibrations.length, 1, "the exact captured stat-delta pair is carried into evaluation");
    const pickRecipients = allocations.get(identities[1]).recipientEvaluations.find((row: any) => row.itemRef === miningPickRef).recipients;
    assert.equal(pickRecipients.find((row: any) => row.identityKey === identities[1]).transferability, "UNKNOWN", "source-local possession does not imply a transferability result");
    assert.equal(pickRecipients.find((row: any) => row.identityKey === identities[0]).transferability, "UNKNOWN", "cross-character transferability remains unknown despite the observed earlier mail test");
    assert.ok(fizzwickPlan.some((row: any) => row.item.itemRef === miningPickRef && row.disposition === "INSUFFICIENT_EVIDENCE"));
    const account = await api.get("/api/account-context");
    for (const key of identities) {
      const character = account.body.versions.forever.characters.find((entry: any) => entry.identityKey === key);
      assert.deepEqual(character.foreverGearAllocation.value.data, allocations.get(key), "the current real capture yields the same plan through REST and AccountContext");
    }
  });
});

test("[REAL] /api/versions lists Forever with a label, and its own totals", async () => {
  await withApp(async (api) => {
    await seed(api);
    const { body } = await api.get("/api/versions");
    assert.deepEqual(
      body.versions.map((v: { version: string }) => v.version),
      ["classic-era", "tbc-anniversary", "retail", "forever", "unknown-version"],
    );
    assert.equal(body.labels["forever"], "Forever");
    const forever = body.versions.find((v: { version: string }) => v.version === "forever");
    assert.equal(forever.characterCount, 1);
    assert.equal(forever.totalMoneyCopper, 291);
    assert.equal(body.versions.find((v: { version: string }) => v.version === "classic-era").characterCount, 0);
  });
});

test("[REAL] the version-scoped routes accept 'forever' and return only Forever data", async () => {
  await withApp(async (api) => {
    await seed(api);
    const chars = await api.get("/api/versions/forever/characters");
    assert.equal(chars.status, 200);
    assert.deepEqual(chars.body.characters.map((c: { name: string }) => c.name), ["Hallo Emberstone"]);

    const facts = await api.get("/api/versions/forever/account-facts");
    assert.equal(facts.status, 200);
    assert.equal(facts.body.facts.version, "forever");
    assert.equal(facts.body.facts.aggregationScope, "realm");
    assert.equal(facts.body.facts.realms[0].realm, "Classic Beta PvP 2");

    const changes = await api.get("/api/versions/forever/recent-changes");
    assert.equal(changes.status, 200);
    assert.equal(changes.body.changes[0].identityKey, HALLO);

    assert.equal((await api.get("/api/versions/not-a-version/characters")).status, 400);
  });
});

test("[REAL] /api/account-context includes forever alongside the other versions", async () => {
  await withApp(async (api) => {
    await seed(api);
    const { body } = await api.get("/api/account-context?now=1789740000");
    assert.deepEqual(Object.keys(body.versions), ["classic-era", "tbc-anniversary", "retail", "forever"]);
    assert.equal(body.versions.forever.characters[0].name, "Hallo Emberstone");
    assert.equal(body.versions.forever.facts.gold.totalKnownCopper, 291);
    assert.equal(body.versions["tbc-anniversary"].characters.length, 2);
  });
});

// --- Deletion -------------------------------------------------------------------------------

test("[REAL] DELETE with a matching confirmation removes the character and its whole history, and derived views follow", async () => {
  await withApp(async (api) => {
    await seed(api);
    assert.equal((await api.get("/api/versions/tbc-anniversary/recent-changes")).body.changes.length, 1);

    const res = await api.del(VOODAN, { confirmIdentityKey: VOODAN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.deleted, {
      identityKey: VOODAN,
      version: "tbc-anniversary",
      realm: "Dreamscythe",
      name: "Voodan",
      snapshotsDeleted: 2,
    });

    assert.equal((await api.get(`/api/characters/${encodeURIComponent(VOODAN)}`)).status, 404);
    assert.deepEqual((await api.get(`/api/characters/${encodeURIComponent(VOODAN)}/snapshots`)).body.snapshots, []);
    assert.deepEqual(
      (await api.get("/api/versions/tbc-anniversary/characters")).body.characters.map((c: { name: string }) => c.name),
      ["Torahn"],
    );
    assert.deepEqual((await api.get("/api/versions/tbc-anniversary/recent-changes")).body.changes, []);
    const facts = (await api.get("/api/versions/tbc-anniversary/account-facts")).body.facts;
    assert.equal(facts.characterCount, 1);
    assert.equal(facts.gold.byCharacter.some((g: { name: string }) => g.name === "Voodan"), false);
    const ctx = await api.get("/api/account-context");
    assert.equal(JSON.stringify(ctx.body).includes("Voodan"), false);
    assert.equal(
      (await api.get("/api/versions")).body.versions.find((v: { version: string }) => v.version === "tbc-anniversary").characterCount,
      1,
    );
  });
});

test("[REAL] deleting a Forever character leaves other versions untouched (version isolation over HTTP)", async () => {
  await withApp(async (api) => {
    await seed(api);
    const before = (await api.get("/api/versions/tbc-anniversary/account-facts")).body.facts;
    const res = await api.del(HALLO, { confirmIdentityKey: HALLO });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted.snapshotsDeleted, 2);
    assert.equal(res.body.deleted.version, "forever");

    assert.equal((await api.get("/api/versions/forever/account-facts")).body.facts.characterCount, 0);
    const after = (await api.get("/api/versions/tbc-anniversary/account-facts")).body.facts;
    // generatedAt is the wall clock; everything else must be identical.
    assert.deepEqual({ ...after, generatedAt: 0 }, { ...before, generatedAt: 0 });
  });
});

test("DELETE without a body, with a non-string confirmation, or with an empty confirmation is rejected (400) and deletes nothing", async () => {
  await withApp(async (api) => {
    await seed(api);
    for (const attempt of [
      await api.del(VOODAN),
      await api.del(VOODAN, {}),
      await api.del(VOODAN, { confirmIdentityKey: "" }),
      await api.del(VOODAN, { confirmIdentityKey: 42 }),
      await api.del(VOODAN, { confirmIdentityKey: null }),
      await api.del(VOODAN, { confirmIdentityKey: [VOODAN] }),
      await api.del(VOODAN, { confirmIdentityKey: { key: VOODAN } }),
      await api.del(VOODAN, { confirm: VOODAN }), // wrong field name
      await api.del(VOODAN, [VOODAN]),
    ]) {
      assert.equal(attempt.status, 400, JSON.stringify(attempt.body));
      assert.match(String(attempt.body.error), /confirm/i);
    }
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(VOODAN)}`)).body.character.snapshotCount, 2);
  });
});

test("DELETE with malformed JSON is rejected (400) and deletes nothing", async () => {
  await withApp(async (api) => {
    await seed(api);
    for (const raw of ["{ this is not json", "null", '"just a string"']) {
      const res = await api.del(VOODAN, undefined, raw);
      assert.equal(res.status, 400, raw);
      assert.match(String(res.body.error), /JSON/, "reported as a JSON error, not an HTML page");
    }
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(VOODAN)}`)).status, 200);
  });
});

test("DELETE whose confirmation names a different character is rejected (400) and deletes neither", async () => {
  await withApp(async (api) => {
    await seed(api);
    for (const wrong of [TORAHN, VOODAN.toUpperCase(), ` ${VOODAN}`, "voodan", HALLO]) {
      const res = await api.del(VOODAN, { confirmIdentityKey: wrong });
      assert.equal(res.status, 400, `confirmation ${JSON.stringify(wrong)}`);
      assert.match(String(res.body.error), /does not match/i);
    }
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(VOODAN)}`)).status, 200);
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(TORAHN)}`)).status, 200);
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(HALLO)}`)).status, 200);
  });
});

test("DELETE of a nonexistent or already-deleted character returns 404, and a repeat delete is safe", async () => {
  await withApp(async (api) => {
    await seed(api);
    const ghost = "tbc-anniversary::dreamscythe::nobody";
    const missing = await api.del(ghost, { confirmIdentityKey: ghost });
    assert.equal(missing.status, 404);
    assert.match(String(missing.body.error), /not found/i);

    assert.equal((await api.del(VOODAN, { confirmIdentityKey: VOODAN })).status, 200);
    const again = await api.del(VOODAN, { confirmIdentityKey: VOODAN });
    assert.equal(again.status, 404);
    // Nothing else was affected by the failed repeat.
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(TORAHN)}`)).body.character.snapshotCount, 1);
  });
});

test("DELETE has no bulk or wildcard form: pattern-shaped keys match nothing and delete nothing", async () => {
  await withApp(async (api) => {
    await seed(api);
    for (const pattern of ["%", "_", "tbc-anniversary::dreamscythe::%", "*", ".*"]) {
      const res = await api.del(pattern, { confirmIdentityKey: pattern });
      assert.equal(res.status, 404, `pattern ${pattern}`);
    }
    // The bare collection route does not accept DELETE at all.
    const bare = await fetch(`${api.base}/api/characters`, { method: "DELETE" });
    assert.notEqual(bare.status, 200);
    assert.equal((await api.get("/api/versions/tbc-anniversary/characters")).body.characters.length, 2);
    assert.equal((await api.get("/api/versions/forever/characters")).body.characters.length, 1);
  });
});

test("a deleted character can be imported again and starts fresh", async () => {
  await withApp(async (api) => {
    await seed(api);
    await api.del(HALLO, { confirmIdentityKey: HALLO });
    const again = await api.import("forever/hallo-1789731867.wowsync.txt");
    assert.equal(again.body.result.isFirstSnapshot, true);
    assert.equal(again.body.result.character.snapshotCount, 1);
  });
});
