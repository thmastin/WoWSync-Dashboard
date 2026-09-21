// The pure pieces C4 added around the shared-storage domain: the API serializer (freshness, bounded
// provenance, omission of unknowns), the guild display name on the projection, strict owner-key parsing,
// and the integrity error that names every damaged owner. (The HTTP behaviour is tested in the server package.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { RECENT_THRESHOLD_SECONDS } from "../src/freshness.ts";
import {
  EMPTY_JOURNAL,
  SharedStorageIntegrityError,
  guildOwner,
  ownerKey,
  parseOwnerKey,
  projectJournal,
  warbandOwner,
} from "../src/sharedStorage.ts";
import { SHARED_STORAGE_PROVENANCE_CAP, buildSharedStorageResponse, sharedOwnerIdentity } from "../src/sharedStorageApi.ts";
import { BIG_ID, admitAll, carrier, guild, warband } from "./sharedStorageBuilders.ts";
import { T, WIDE, mats, withHarness } from "./sharedStorageHarness.ts";

test("[SYNTHETIC] the empty journal serializes to the stable empty document", () => {
  assert.deepEqual(buildSharedStorageResponse(projectJournal(EMPTY_JOURNAL), 123), { schema: "shared-storage-1", asOf: 123, warband: null, guilds: [] });
});

test("[SYNTHETIC] age and freshness use the Dashboard's single freshness rule, relative to the given now; the observation is never 'live'", () => {
  const journal = admitAll([[warband({ observedAt: T, items: mats() }), carrier(1, T + 10)]]);
  const at = (now: number) => buildSharedStorageResponse(projectJournal(journal), now).warband!.current!;
  assert.deepEqual([at(T + 60).ageSeconds, at(T + 60).freshness], [60, "recent"]);
  assert.equal(at(T + RECENT_THRESHOLD_SECONDS).freshness, "recent");
  assert.equal(at(T + RECENT_THRESHOLD_SECONDS + 1).freshness, "stale");
  assert.deepEqual([at(T - 500).ageSeconds, at(T - 500).freshness], [0, "recent"], "a clock earlier than the observation never gives a negative age");
});

test("[SYNTHETIC] provenance is capped at the newest N exports with an exact total and a truncation flag; the cap is deterministic", () => {
  const items: Array<[ReturnType<typeof warband>, ReturnType<typeof carrier>]> = [];
  for (let i = 0; i < SHARED_STORAGE_PROVENANCE_CAP + 5; i++) items.push([warband({ observedAt: T, state: "LAST_SEEN", items: mats() }), carrier(i + 1, T + 100 + i, `C${i}`)]);
  const view = buildSharedStorageResponse(projectJournal(admitAll(items)), T + 9999).warband!.current!.provenance;
  assert.equal(view.totalSources, SHARED_STORAGE_PROVENANCE_CAP + 5);
  assert.equal(view.sources.length, SHARED_STORAGE_PROVENANCE_CAP);
  assert.equal(view.truncated, true);
  assert.equal(view.sources[0].exportObservedAt, T + 100 + SHARED_STORAGE_PROVENANCE_CAP + 4);
  const shuffled = buildSharedStorageResponse(projectJournal(admitAll([...items].reverse())), T + 9999).warband!.current!.provenance;
  assert.deepEqual(shuffled, view, "arrival order does not change the capped list");
  const under = buildSharedStorageResponse(projectJournal(admitAll(items.slice(0, 3))), T + 9999).warband!.current!.provenance;
  assert.deepEqual([under.totalSources, under.sources.length, under.truncated], [3, 3, false]);
});

test("[SYNTHETIC] serialization is pure and adds no reconciliation: the views are exactly the domain's selections", () => {
  const journal = admitAll([
    [guild({ observedAt: T, tabs: WIDE }), carrier(1, T + 10)],
    [guild({ observedAt: T + 2000, tabs: [{ id: 1, name: "Materials", items: [["Linen Cloth", 45]] }, { id: 3, name: "Officers", state: "INACCESSIBLE" }] }), carrier(2, T + 2010)],
  ]);
  const projection = projectJournal(journal);
  const view = buildSharedStorageResponse(projection, T + 3000).guilds[0];
  assert.equal(view.current!.contentHash, projection.guilds[0].current!.contentHash);
  assert.equal(view.broaderCoverageEarlier!.contentHash, projection.guilds[0].broaderCoverageEarlier!.contentHash);
  assert.equal(view.basis, "DERIVED");
  assert.deepEqual(view.current!.coverage.inaccessibleTabs, [3]);
});

test("[SYNTHETIC] the guild display name is the NEWEST observation's name, even when no observation is informative; it is display data, never identity", () => {
  const journal = admitAll([
    [guild({ clubId: "111", name: "Old Name", observedAt: T, tabs: [{ id: 1, name: "A", items: [["X", 1]] }] }), carrier(1, T + 10)],
    [guild({ clubId: "111", name: "New Name", observedAt: T + 900, tabs: [{ id: 1, name: "A", state: "INACCESSIBLE" }] }), carrier(2, T + 910)],
  ]);
  const owner = projectJournal(journal).guilds[0];
  assert.equal(owner.current!.content.guildName, "Old Name", "the current (informative) observation still says the old name");
  assert.equal(owner.guildName, "New Name", "the newest observation of any kind carries the display name");
  const identity = sharedOwnerIdentity(owner.owner, owner.guildName);
  assert.deepEqual(identity, { kind: "guild", ownerKey: "retail::guild::111", guildClubId: "111", guildName: "New Name" });
  assert.equal(projectJournal(admitAll([[warband({ observedAt: T }), carrier(1, T + 10)]])).warband!.guildName, undefined);
});

test("[SYNTHETIC] the Warband identity says installation-local and is not an account id", () => {
  assert.deepEqual(sharedOwnerIdentity(warbandOwner()), { kind: "warband", ownerKey: "retail::warband::local", accountScope: "installation-local" });
});

test("[SYNTHETIC] parseOwnerKey inverts ownerKey strictly and never guesses", () => {
  for (const owner of [warbandOwner(), guildOwner("111"), guildOwner(BIG_ID), guildOwner("1.8014398509482e+16"), guildOwner("a::b")]) {
    assert.deepEqual(parseOwnerKey(ownerKey(owner)), owner);
  }
  for (const bad of ["", "retail::guild::", "retail::guild:: 1", "retail::guild::1 ", "retail::warband::other", "retail::warband::", "forever::guild::1", "retail::character::x", "garbage"]) {
    assert.equal(parseOwnerKey(bad), undefined, bad);
  }
});

test("[SYNTHETIC] a damaged journal raises ONE SharedStorageIntegrityError naming every damaged owner, even when the owner JSON is the damaged part", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }), guild: guild({ clubId: "111", observedAt: T, tabs: WIDE }) });
    h.imp({ name: "Alpha", generated: T + 20, level: 2, guild: guild({ clubId: "222", observedAt: T + 10, tabs: WIDE }) });
    h.raw.exec("UPDATE shared_observations SET content_json = '{bad' WHERE owner_key = 'retail::warband::local'");
    h.raw.exec("UPDATE shared_observations SET owner_json = 'zzz' WHERE owner_key = 'retail::guild::111'");
    try {
      h.store.loadSharedJournal();
      assert.fail("expected an integrity error");
    } catch (err) {
      assert.ok(err instanceof SharedStorageIntegrityError);
      assert.deepEqual(err.ownerKeys, ["retail::guild::111", "retail::warband::local"], "sorted; guild 222 is healthy and not listed");
      assert.match(err.message, /not valid/);
    }
  }));
