// Shared-storage reconciliation, END TO END (milestone closeout): the real Virek exports and rendered guild
// exports go through the real importer and journal, out of the real HTTP API, and into the web app's actual
// presentation logic - with deletion, recreation and damage exercised through the same path. Each layer is
// tested on its own elsewhere; this proves they still describe one consistent system: what the server says is
// exactly what the UI wording is built to say, and the UI's own delete decision matches the server's contract.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, mock, test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../src/net.ts";
import { ApiError } from "../../web/src/api.ts";
import {
  EMPTY_HEADLINE,
  REAPPEARANCE_WARNING,
  contentsState,
  describeCapacity,
  describeCarriage,
  describeContents,
  describeIntegrityFailure,
  describeOwnerDeletion,
  describeProvenance,
  describeTiming,
  isEmptyShared,
  isOwnerDeletionConfirmed,
  itemSummary,
  orderedOwners,
  ownerHeading,
  ownerNotices,
  performOwnerDelete,
} from "../../web/src/sharedStorage.ts";
import type { SharedOwnerIdentity, SharedStorageResponse } from "../../web/src/types.ts";
import { BIG_ID, guild, warband } from "../../core/test/sharedStorageBuilders.ts";
import { renderExport, type ExportSpec } from "../../core/test/sharedStorageExports.ts";
import { NARROW, T, VIREK_1, VIREK_2, WIDE, mats } from "../../core/test/sharedStorageHarness.ts";

before(() => mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 }));
after(() => mock.timers.reset());

const NOW = 1_789_970_000; // a few hours after the real Warband observation

/** A real server on an ephemeral loopback port over a file database, plus the web client's route choice for deletes. */
async function withStack(run: (s: Stack) => Promise<void>) {
  const folder = mkdtempSync(join(tmpdir(), "wowsync-e2e-"));
  const file = join(folder, "e2e.sqlite");
  const store = new SqliteSnapshotStore(file);
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}) };
      const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  const stack: Stack = {
    file,
    store,
    call,
    imp: (spec) => call("POST", "/api/import", { text: typeof spec === "string" ? spec : renderExport(spec) }),
    shared: async () => (await call("GET", `/api/shared-storage?now=${NOW}`)).body as SharedStorageResponse,
    // What the web client (api.ts deleteSharedStorageOwner) does: route by the owner's kind, its key as the confirmation.
    deleteViaClientContract: async (owner) => {
      const path = owner.kind === "warband" ? "/api/shared-storage/warband" : `/api/shared-storage/guilds/${encodeURIComponent(owner.guildClubId)}`;
      const r = await call("DELETE", path, { confirmOwnerKey: owner.ownerKey });
      if (r.status >= 400) throw new ApiError(r.body.error, "http", r.status, r.body.code, r.body);
      return r.body;
    },
  };
  try {
    await run(stack);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

interface Stack {
  file: string;
  store: SqliteSnapshotStore;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  imp: (spec: ExportSpec | string) => Promise<{ status: number; body: any }>;
  shared: () => Promise<SharedStorageResponse>;
  deleteViaClientContract: (owner: SharedOwnerIdentity) => Promise<any>;
}

test("[REAL] the real Virek exports flow importer -> journal -> API -> UI wording as ONE Warband observation carried by TWO exports", async () => {
  await withStack(async (s) => {
    assert.equal((await s.imp(VIREK_1)).status, 200);
    assert.equal((await s.imp(VIREK_2)).status, 200);
    const doc = await s.shared();
    const owners = orderedOwners(doc);
    assert.equal(owners.length, 1, "exactly one owner although two exports carried it, and no guild");
    const w = owners[0];
    const v = w.current!;

    // what the API says
    assert.equal(w.basis, "DERIVED");
    assert.equal(w.observationCount.total, 1);
    assert.equal(v.effectiveObservedAt, 1789965174);
    assert.deepEqual(v.carrierStates, ["LAST_SEEN"]);
    assert.equal(v.liveAtExport, false);
    assert.equal(v.content.items.length, 98);

    // what the UI is built to say about exactly that document
    assert.equal(ownerHeading(w.owner).title, "Warband Bank");
    assert.equal(contentsState(v), "items");
    assert.match(itemSummary(v), /^98 distinct items/);
    assert.equal(describeCapacity(v, "warband"), "98 of 98 slots occupied (0 free)");
    const timing = describeTiming(v, (t) => `T${t}`);
    assert.equal(timing.observed, "Observed T1789965174", "the observation time, never an export time");
    assert.equal(timing.freshness, "recent");
    assert.match(describeCarriage(v).headline, /last seen/);
    const p = describeProvenance(v.provenance, (t) => `T${t}`);
    assert.equal(p.headline, "Seen in 2 exports from Virek · Cairne");
    assert.match(p.oneObservation, /One observation, carried by 2 exports/);
    assert.deepEqual(p.rows.map((r) => r.exportTime), ["T1789965777", "T1789965184"]);
    assert.deepEqual(ownerNotices(w), []);

    // the character's own snapshots still carry the historical evidence
    assert.equal(s.store.listSnapshots("retail::cairne::virek").length, 2);
    assert.equal(s.store.listSnapshots("retail::cairne::virek")[0].parsed.accountBank?.items.length, 98);
  });
});

test("[REAL] deleting the carrying character keeps the owner; the UI's own clear decision, sent by the web client's contract, removes it; a NEW export brings it back", async () => {
  await withStack(async (s) => {
    await s.imp(VIREK_1);
    await s.imp(VIREK_2);
    const before = await s.shared();

    // character deletion never touches shared truth
    assert.equal((await s.call("DELETE", "/api/characters/retail%3A%3Acairne%3A%3Avirek", { confirmIdentityKey: "retail::cairne::virek" })).status, 200);
    assert.deepEqual(await s.shared(), before);

    // the UI's confirmation for the owner it was shown, then the client contract
    const owner = orderedOwners(before)[0].owner;
    const target = describeOwnerDeletion(owner);
    assert.equal(isOwnerDeletionConfirmed("Warband", target), true);
    assert.ok(target.warning === REAPPEARANCE_WARNING);
    const outcome = await performOwnerDelete(owner, (o) => s.deleteViaClientContract(o));
    assert.deepEqual(outcome, { kind: "deleted", observationsDeleted: 1, sourcesDeleted: 2 });
    assert.equal(isEmptyShared(await s.shared()), true);
    assert.match(EMPTY_HEADLINE, /No shared storage has been observed yet/);

    // deleting again is the server's own "already gone" (a 404 with its stable code)
    assert.equal((await performOwnerDelete(owner, (o) => s.deleteViaClientContract(o))).kind, "already-gone");

    // genuinely new evidence recreates it, from that export alone
    await s.imp(VIREK_2.replaceAll("1789965777", "1789969999"));
    const again = orderedOwners(await s.shared())[0];
    assert.equal(again.current!.provenance.totalSources, 1);
    assert.equal(again.current!.effectiveObservedAt, 1789965174);
    assert.equal(again.observationCount.total, 1);
  });
});

test("restricted-guild story end to end: narrower later coverage, a newer partial and a conflict are all surfaced by the UI logic, never merged, and inaccessible tabs are never empty", async () => {
  await withStack(async (s) => {
    const g = (over: object, tabs = WIDE) => guild({ clubId: BIG_ID, name: "Restricted Guild", ...over, tabs } as Parameters<typeof guild>[0]);
    await s.imp({ name: "Officer", generated: T + 10, guild: g({ observedAt: T }) });
    await s.imp({ name: "Member", realm: "Thrall", generated: T + 2010, guild: g({ observedAt: T + 2000 }, NARROW) });
    await s.imp({ name: "Member", realm: "Thrall", generated: T + 3010, level: 2, guild: g({ observedAt: T + 3000, completeness: "partial" }, [{ id: 1, name: "Materials", items: [["Linen Cloth", 1]] }, { id: 2, name: "Consumables", state: "UNKNOWN" }, ...NARROW.slice(2)]) });
    await s.imp({ name: "A", generated: T + 4010, level: 3, guild: guild({ clubId: "222", name: "Conflict Guild", observedAt: T + 4000, tabs: [{ id: 1, name: "Bank", items: [["Rune Thread", 10]] }] }) });
    await s.imp({ name: "B", generated: T + 4010, level: 4, guild: guild({ clubId: "222", name: "Conflict Guild", observedAt: T + 4000, tabs: [{ id: 1, name: "Bank", items: [["Rune Thread", 14]] }] }) });
    await s.imp({ name: "Locked", generated: T + 5010, level: 5, guild: guild({ clubId: "333", name: "Locked Guild", observedAt: T + 5000, tabs: [{ id: 1, name: "Bank", state: "INACCESSIBLE" }] }) });

    const guilds = orderedOwners(await s.shared());
    const byName = Object.fromEntries(guilds.map((o) => [ownerHeading(o.owner).title, o]));

    const restricted = byName["Restricted Guild"];
    assert.equal(restricted.owner.kind === "guild" && restricted.owner.guildClubId, BIG_ID, "the opaque id is exact");
    assert.deepEqual(ownerNotices(restricted).map((n) => n.kind), ["newer-partial", "broader-earlier"]);
    assert.equal(restricted.current!.effectiveObservedAt, T + 2000, "the newer NARROWER complete observation stays current");
    assert.ok(!restricted.current!.content.items.some((i) => i.name === "Officer Sword"), "nothing from the broader observation is spliced in");
    assert.deepEqual(restricted.current!.coverage.inaccessibleTabs, [3, 4]);
    assert.ok(restricted.broaderCoverageEarlier!.content.items.some((i) => i.name === "Officer Sword"));

    assert.deepEqual(ownerNotices(byName["Conflict Guild"]).map((n) => n.kind), ["conflict"]);

    const locked = byName["Locked Guild"];
    assert.equal(locked.current, null);
    assert.equal(contentsState(locked.current), "unknown");
    assert.equal(describeContents(locked.current), "Contents unknown", "unknown, never empty");
    assert.deepEqual(ownerNotices(locked).map((n) => n.kind), ["contents-unknown"]);
  });
});

test("damage end to end: a corrupt owner fails loudly through the API, the UI logic names it, and its recovery action clears it through the same client contract", async () => {
  await withStack(async (s) => {
    await s.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }), guild: guild({ clubId: "111", name: "Healthy Guild", observedAt: T, tabs: WIDE }) });
    const raw = new DatabaseSync(s.file);
    raw.exec("UPDATE shared_observations SET content_json = '{not json' WHERE owner_key = 'retail::warband::local'");
    raw.close();

    const failed = await s.call("GET", `/api/shared-storage?now=${NOW}`);
    assert.equal(failed.status, 500);
    assert.equal(failed.body.code, "SHARED_STORAGE_INTEGRITY");
    const error = new ApiError(failed.body.error, "http", 500, failed.body.code, failed.body);
    const failure = describeIntegrityFailure(error)!;
    assert.deepEqual(failure.damaged.map((d) => d.label), ["Warband Bank"], "the healthy guild is not blamed and not silently shown either");

    const recovery = failure.damaged[0].owner!;
    assert.equal((await performOwnerDelete(recovery, (o) => s.deleteViaClientContract(o))).kind, "deleted");
    const healed = await s.shared();
    assert.equal(healed.warband, null);
    assert.deepEqual(healed.guilds.map((o) => o.owner.ownerKey), ["retail::guild::111"], "the healthy guild is intact");
  });
});
