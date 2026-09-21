// Explicit OWNER-SCOPED shared-storage deletion (checkpoint C3).
//
// The decided semantics:
//   character deletion   -> shared observations AND provenance survive (a character is only a carrier);
//   owner deletion       -> that owner's whole journal history (observations + provenance) is removed,
//                           atomically, only when the caller names the owner;
//   new evidence         -> a later import may recreate the owner normally (no permanent tombstone);
//   stored old snapshots -> must NEVER resurrect deleted history (the backfill cutoff).
// The resurrection tests are the rigorous part: they distinguish "an old snapshot already sitting in the
// database" (must stay deleted) from "an export imported after the deletion" (is new evidence).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLlmContext } from "../src/llmContext.ts";
import { SharedStorageIntegrityError, guildOwner, warbandOwner, type SharedStorageOwner } from "../src/sharedStorage.ts";
import { BIG_ID, guild, warband } from "./sharedStorageBuilders.ts";
import { NARROW, NOW, T, VIREK_1, VIREK_2, VIREK_KEY, WARBAND_KEY, WIDE, mats, normalized, withHarness, type Harness } from "./sharedStorageHarness.ts";

const WB = warbandOwner();
const GX = guildOwner("111");
const GY = guildOwner("222");
const KEY_X = "retail::guild::111";
const KEY_Y = "retail::guild::222";

/**
 * Three owners with several carriers:
 *   Warband  (obs at T)        carried by Alpha (live) and Bravo (replay)      -> 1 observation, 2 sources
 *   Guild X  (obs at T)        carried by Alpha (live) and Bravo (replay)      -> 1 observation, 2 sources
 *   Guild Y  (obs at T + 800)  carried by Charlie                              -> 1 observation, 1 source
 */
function seed(h: Harness) {
  h.imp({ name: "Alpha", realm: "Cairne", generated: T + 10, warband: warband({ observedAt: T, items: mats() }), guild: guild({ clubId: "111", name: "Guild X", observedAt: T, tabs: WIDE }) });
  h.imp({ name: "Bravo", realm: "Thrall", generated: T + 500, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }), guild: guild({ clubId: "111", name: "Guild X", observedAt: T, state: "LAST_SEEN", tabs: WIDE }) });
  h.imp({ name: "Charlie", realm: "Cairne", generated: T + 900, guild: guild({ clubId: "222", name: "Guild Y", observedAt: T + 800, tabs: NARROW }) });
}

const table = (h: Harness, sql: string) => JSON.stringify(h.all(sql));
const snapshotRows = (h: Harness) => table(h, "SELECT * FROM snapshots ORDER BY id");
const characterRows = (h: Harness) => table(h, "SELECT * FROM characters ORDER BY id");
const clearRows = (h: Harness) =>
  h.all<{ owner_key: string; cleared_through_snapshot_id: number }>("SELECT owner_key, cleared_through_snapshot_id FROM shared_owner_clears ORDER BY owner_key").map((r) => ({ ...r }));
const orphanSources = (h: Harness) => Number((h.all<{ n: number }>("SELECT COUNT(*) AS n FROM shared_observation_sources WHERE observation_id NOT IN (SELECT id FROM shared_observations)")[0]).n);
const ownerRows = (h: Harness, key: string) => Number(h.all<{ n: number }>("SELECT COUNT(*) AS n FROM shared_observations WHERE owner_key = ?", key)[0].n);

// --- deleting one owner --------------------------------------------------------------------------------------

test("[SYNTHETIC] deleting the installation-local Warband removes its observations and provenance, and reports exactly what went", () =>
  withHarness((h) => {
    seed(h);
    assert.deepEqual(h.counts(), { characters: 3, snapshots: 3, observations: 3, sources: 5 });
    const result = h.store.deleteSharedStorageOwner(WB);
    assert.deepEqual(result, { ownerKey: WARBAND_KEY, existed: true, observationsDeleted: 1, sourcesDeleted: 2 });
    assert.deepEqual(h.counts(), { characters: 3, snapshots: 3, observations: 2, sources: 3 });
    assert.equal(ownerRows(h, WARBAND_KEY), 0);
    assert.equal(orphanSources(h), 0, "no provenance row is left pointing at a deleted observation");
    assert.equal(h.store.projectSharedStorage().warband, undefined, "no projection: never observed, not empty");
    assert.equal([...h.store.loadSharedJournal().entries.values()].some((e) => e.observation.ownerKey === WARBAND_KEY), false);
  }));

test("[SYNTHETIC] deleting a guild removes its observations and provenance", () =>
  withHarness((h) => {
    seed(h);
    const result = h.store.deleteSharedStorageOwner(GX);
    assert.deepEqual(result, { ownerKey: KEY_X, existed: true, observationsDeleted: 1, sourcesDeleted: 2 });
    assert.deepEqual(h.counts(), { characters: 3, snapshots: 3, observations: 2, sources: 3 });
    assert.equal(ownerRows(h, KEY_X), 0);
    assert.equal(orphanSources(h), 0);
    assert.deepEqual(h.store.projectSharedStorage().guilds.map((g) => g.ownerKey), [KEY_Y]);
  }));

test("[SYNTHETIC] deleting Guild X leaves Guild Y and the Warband exactly as they were", () =>
  withHarness((h) => {
    seed(h);
    const before = h.store.projectSharedStorage();
    h.store.deleteSharedStorageOwner(GX);
    const after = h.store.projectSharedStorage();
    assert.deepStrictEqual(after.warband, before.warband);
    assert.deepStrictEqual(after.guilds, before.guilds.filter((g) => g.ownerKey === KEY_Y));
  }));

test("[SYNTHETIC] deleting a guild leaves the Warband; deleting the Warband leaves every guild", () =>
  withHarness((h) => {
    seed(h);
    const before = h.store.projectSharedStorage();
    h.store.deleteSharedStorageOwner(GY);
    assert.deepStrictEqual(h.store.projectSharedStorage().warband, before.warband);
    h.store.deleteSharedStorageOwner(WB);
    assert.deepStrictEqual(h.store.projectSharedStorage().guilds, before.guilds.filter((g) => g.ownerKey === KEY_X));
    assert.equal(h.store.projectSharedStorage().warband, undefined);
  }));

test("[SYNTHETIC] deleting an owner that has no history is a deterministic no-op: nothing changes and nothing is recorded", () =>
  withHarness((h) => {
    const empty = h.store.deleteSharedStorageOwner(WB);
    assert.deepEqual(empty, { ownerKey: WARBAND_KEY, existed: false, observationsDeleted: 0, sourcesDeleted: 0 });
    seed(h);
    const before = JSON.stringify([h.counts(), h.store.projectSharedStorage()]);
    assert.deepEqual(h.store.deleteSharedStorageOwner(guildOwner("999")), { ownerKey: "retail::guild::999", existed: false, observationsDeleted: 0, sourcesDeleted: 0 });
    assert.equal(JSON.stringify([h.counts(), h.store.projectSharedStorage()]), before);
    assert.deepEqual(clearRows(h), [], "a no-op leaves no cutoff behind");

    // Deleting the same owner twice: the second call is that no-op and does not touch the cutoff.
    h.store.deleteSharedStorageOwner(WB);
    const cutoff = JSON.stringify(clearRows(h));
    assert.equal(h.store.deleteSharedStorageOwner(WB).existed, false);
    assert.equal(JSON.stringify(clearRows(h)), cutoff);
  }));

test("[SYNTHETIC] a malformed owner is rejected before anything is touched (no silent match-nothing)", () =>
  withHarness((h) => {
    seed(h);
    const before = JSON.stringify([h.counts(), clearRows(h)]);
    for (const bad of [guildOwner(""), guildOwner("  111"), guildOwner("111 "), guildOwner("\t")]) {
      assert.throws(() => h.store.deleteSharedStorageOwner(bad), TypeError, JSON.stringify(bad));
    }
    assert.throws(() => h.store.deleteSharedStorageOwner({ kind: "character", identityKey: "x" } as unknown as SharedStorageOwner), TypeError);
    assert.throws(() => h.store.deleteSharedStorageOwner({ kind: "warband", version: "retail", account: { kind: "some-account" } } as unknown as SharedStorageOwner), TypeError);
    assert.throws(() => h.store.deleteSharedStorageOwner(null as unknown as SharedStorageOwner), TypeError);
    assert.equal(JSON.stringify([h.counts(), clearRows(h)]), before);
  }));

test("[SYNTHETIC] GuildClubID above 2^53 is matched as opaque text: deleting one id never touches a sibling that is the same JS number", () =>
  withHarness((h) => {
    const sibling = "18014398509481984";
    assert.equal(Number(BIG_ID), Number(sibling));
    h.imp({ name: "Alpha", generated: T + 10, guild: guild({ clubId: BIG_ID, observedAt: T, tabs: WIDE }) });
    h.imp({ name: "Alpha", generated: T + 20, level: 2, guild: guild({ clubId: sibling, observedAt: T + 5, tabs: NARROW }) });
    assert.equal(h.store.projectSharedStorage().guilds.length, 2);
    const result = h.store.deleteSharedStorageOwner(guildOwner(BIG_ID));
    assert.deepEqual(result, { ownerKey: `retail::guild::${BIG_ID}`, existed: true, observationsDeleted: 1, sourcesDeleted: 1 });
    assert.deepEqual(h.store.projectSharedStorage().guilds.map((g) => g.ownerKey), [`retail::guild::${sibling}`]);
    assert.deepEqual(clearRows(h).map((r) => r.owner_key), [`retail::guild::${BIG_ID}`]);
  }));

// --- what it does NOT touch ------------------------------------------------------------------------------------

test("[SYNTHETIC] owner deletion never modifies characters or snapshots: the carried copy stays exactly as delivered", () =>
  withHarness((h) => {
    seed(h);
    const snapshots = snapshotRows(h);
    const characters = characterRows(h);
    h.store.deleteSharedStorageOwner(WB);
    h.store.deleteSharedStorageOwner(GX);
    assert.equal(snapshotRows(h), snapshots, "snapshots byte-identical (raw_text and parsed_json included)");
    assert.equal(characterRows(h), characters);
    // The transitional character-page copy still shows what each export carried.
    const alpha = h.store.listSnapshots("retail::cairne::alpha")[0];
    assert.equal(alpha.parsed.accountBank?.status.state, "OBSERVED");
    assert.equal(alpha.parsed.guildBank?.guildName, "Guild X");
  }));

test("[SYNTHETIC] character deletion KEEPS shared observations and provenance; explicit owner deletion REMOVES them (the distinction)", () =>
  withHarness((h) => {
    seed(h);
    const before = h.store.projectSharedStorage();

    // Character deletion: nothing about shared storage changes, not even the deleted carrier's provenance.
    assert.ok(h.store.deleteCharacter("retail::cairne::alpha"));
    assert.deepEqual(h.counts(), { characters: 2, snapshots: 2, observations: 3, sources: 5 });
    assert.deepStrictEqual(h.store.projectSharedStorage(), before);
    assert.deepEqual(clearRows(h), [], "character deletion records no cutoff");
    assert.deepEqual(h.store.projectSharedStorage().warband!.current!.sources.map((s) => s.sourceName), ["Alpha", "Bravo"]);

    // Explicit owner deletion: the owner's observations AND every provenance row (including the deleted character's) go.
    const result = h.store.deleteSharedStorageOwner(WB);
    assert.deepEqual([result.observationsDeleted, result.sourcesDeleted], [1, 2]);
    assert.deepEqual(h.counts(), { characters: 2, snapshots: 2, observations: 2, sources: 3 });
    assert.equal(h.store.projectSharedStorage().warband, undefined);
    // ...while the other owners still show Alpha as a source, although Alpha the character is gone.
    assert.deepEqual(h.store.projectSharedStorage().guilds.find((g) => g.ownerKey === KEY_X)!.current!.sources.map((s) => s.sourceName), ["Alpha", "Bravo"]);
  }));

test("[SYNTHETIC] a newer UNKNOWN, partial or inaccessible section never deletes anything, and a character changing guild deletes nothing", () =>
  withHarness((h) => {
    seed(h);
    const before = h.store.projectSharedStorage();
    const counts = h.counts();
    h.imp({ name: "Alpha", realm: "Cairne", generated: T + 5000, level: 2 }); // both sections UNKNOWN
    h.imp({ name: "Alpha", realm: "Cairne", generated: T + 6000, level: 3, guild: guild({ clubId: "111", name: "Guild X", observedAt: T + 5900, completeness: "partial", tabs: [{ id: 1, name: "Materials", items: [["Linen Cloth", 1]] }, { id: 2, name: "Consumables", state: "UNKNOWN" }] }) });
    h.imp({ name: "Alpha", realm: "Cairne", generated: T + 7000, level: 4, guild: guild({ clubId: "111", name: "Guild X", observedAt: T + 6900, tabs: [{ id: 1, name: "Materials", state: "INACCESSIBLE" }] }) });
    h.imp({ name: "Alpha", realm: "Cairne", generated: T + 8000, level: 5, guild: guild({ clubId: "333", name: "New Guild", observedAt: T + 7900, tabs: NARROW }) }); // moved to another guild
    assert.equal(ownerRows(h, KEY_X), 3, "Guild X keeps its original observation and gains the partial and the informationless one");
    assert.equal(ownerRows(h, WARBAND_KEY), 1);
    assert.equal(ownerRows(h, "retail::guild::333"), 1, "the new guild is simply another owner");
    assert.equal(h.counts().observations, counts.observations + 3);
    assert.deepStrictEqual(h.store.projectSharedStorage().warband, before.warband);
    assert.equal(h.store.projectSharedStorage().guilds.find((g) => g.ownerKey === KEY_X)!.current!.content.tabs.length, 4, "and Guild X's current state is still the original complete observation");
    assert.deepEqual(clearRows(h), []);
  }));

test("[SYNTHETIC] shared storage still stays out of AccountFacts, totals, search, diffs, AccountContext and the LLM context: owner deletion changes none of them", () =>
  withHarness((h) => {
    seed(h);
    const world = () => {
      const context = h.store.buildAccountContext(NOW);
      return JSON.stringify({ facts: h.store.buildAccountFacts("retail", NOW), llm: buildLlmContext(context), versions: h.store.listVersions(), changes: h.store.recentChanges("retail").map((c) => c.diff) });
    };
    const before = world();
    h.store.deleteSharedStorageOwner(WB);
    h.store.deleteSharedStorageOwner(GX);
    h.store.deleteSharedStorageOwner(GY);
    assert.equal(world(), before, "byte-identical: no consumer ever read the journal");
    for (const shared of ["Linen Cloth", "Officer Sword", "Guild X", "Guild Y"]) assert.equal(before.includes(shared), false, shared);
  }));

// --- new evidence recreates the owner --------------------------------------------------------------------------

test("[SYNTHETIC] a NEW export after deletion recreates the owner normally, from only the evidence now imported", () =>
  withHarness((h) => {
    seed(h);
    h.store.deleteSharedStorageOwner(WB);
    assert.equal(h.store.projectSharedStorage().warband, undefined);

    const fresh = h.imp({ name: "Delta", realm: "Cairne", generated: T + 9010, warband: warband({ observedAt: T + 9000, items: [["Fresh stock", 7]] }) });
    assert.deepEqual(fresh.sharedStorage[0], { section: "accountBank", outcome: "recorded", ownerKey: WARBAND_KEY, becameCurrent: true, informative: true });
    const w = h.store.projectSharedStorage().warband!;
    assert.equal(w.observationCount.total, 1, "the deleted history did not come back");
    assert.deepEqual(w.current!.content.items.map((i) => i.name), ["Fresh stock"]);
    assert.deepEqual(w.current!.sources.map((s) => s.sourceName), ["Delta"]);
    // There is no tombstone: the cutoff row exists only to limit backfill.
    assert.equal(clearRows(h).length, 1);
  }));

test("[SYNTHETIC] after recreation the usual idempotency and provenance rules apply again", () =>
  withHarness((h) => {
    seed(h);
    h.store.deleteSharedStorageOwner(WB);
    const spec = { name: "Delta", realm: "Cairne", generated: T + 9010, warband: warband({ observedAt: T + 9000, items: [["Fresh stock", 7]] }) };
    h.imp(spec);
    const after = h.counts();
    const dup = h.imp(spec);
    assert.equal(dup.isDuplicate, true);
    assert.deepEqual(h.counts(), after, "an exact duplicate adds nothing");
    const replay = h.imp({ name: "Echo", realm: "Thrall", generated: T + 9500, warband: warband({ observedAt: T + 9000, state: "LAST_SEEN", items: [["Fresh stock", 7]] }) });
    assert.equal(replay.sharedStorage[0].outcome, "source-added");
    assert.equal(h.store.projectSharedStorage().warband!.current!.sources.length, 2);
    assert.equal(h.store.projectSharedStorage().warband!.observationCount.total, 1);
  }));

test("[REAL] after deleting the Virek Warband, a NEW export replaying the same observation recreates it with ONE source (the new export), not the two old ones", () =>
  withHarness((h) => {
    const first = h.store.importSnapshot(VIREK_1);
    const second = h.store.importSnapshot(VIREK_2);
    assert.equal(h.store.projectSharedStorage().warband!.current!.sources.length, 2);
    h.store.deleteSharedStorageOwner(WB);

    // The addon still holds the record, so a later /wowsync replays it (a genuinely new export).
    const later = VIREK_2.replaceAll("1789965777", "1789969999");
    assert.notEqual(later, VIREK_2);
    const third = h.store.importSnapshot(later);
    assert.equal(third.sharedStorage[0].outcome, "recorded");

    const w = h.store.projectSharedStorage().warband!;
    assert.equal(w.current!.effectiveObservedAt, 1789965174, "the original observation time, not advanced");
    assert.deepEqual(w.current!.sources.map((s) => s.snapshotId), [third.snapshot.id]);
    assert.equal(w.current!.sources.some((s) => s.snapshotId === first.snapshot.id || s.snapshotId === second.snapshot.id), false);
    assert.deepEqual(w.current!.carrierStates, ["LAST_SEEN"], "never relabelled");
  }));

// --- NO resurrection from stored snapshots -----------------------------------------------------------------------------------

test("[REAL] an explicit backfill after deletion does NOT resurrect the Virek Warband, and says how many admissions it declined", () =>
  withHarness((h) => {
    h.store.importSnapshot(VIREK_1);
    h.store.importSnapshot(VIREK_2);
    h.store.deleteSharedStorageOwner(WB);
    const snapshots = snapshotRows(h);

    const run = h.store.backfillSharedStorage();
    assert.deepEqual(run, { snapshotsWithSharedSections: 2, observationsAdded: 0, sourcesAdded: 0, suppressedByDeletion: 2 });
    assert.deepEqual(h.counts(), { characters: 1, snapshots: 2, observations: 0, sources: 0 });
    assert.equal(h.store.projectSharedStorage().warband, undefined);
    assert.equal(snapshotRows(h), snapshots, "the snapshots that still carry the observation are untouched");
    assert.equal(h.store.listSnapshots(VIREK_KEY)[0].parsed.accountBank?.items.length, 98);
    // ...and it stays that way however often it runs.
    assert.deepEqual(h.store.backfillSharedStorage(), run);
    assert.equal(h.counts().observations, 0);
  }));

test("[REAL] a restart does not resurrect it either, and neither does losing the backfill marker (the automatic backfill re-runs but honors the deletion)", () =>
  withHarness((h) => {
    h.store.importSnapshot(VIREK_1);
    h.store.importSnapshot(VIREK_2);
    h.store.deleteSharedStorageOwner(WB);

    h.reopen();
    assert.equal(h.store.projectSharedStorage().warband, undefined, "plain restart");
    assert.deepEqual(clearRows(h).map((r) => r.owner_key), [WARBAND_KEY], "the cutoff is persisted");

    h.reopen(() => h.raw.exec("DELETE FROM store_meta")); // marker lost: the constructor's automatic backfill runs again
    assert.equal(h.all<{ value: string }>("SELECT value FROM store_meta WHERE key = 'shared_storage_backfill'")[0].value, "1", "the marker is restored by that run");
    assert.equal(h.store.projectSharedStorage().warband, undefined, "marker lost + restart");
    assert.equal(h.counts().observations, 0);
  }));

test("[SYNTHETIC] the cutoff is per owner: other owners are still repaired by backfill, the deleted one is not", () =>
  withHarness((h) => {
    seed(h);
    h.store.deleteSharedStorageOwner(WB);
    // Damage Guild Y's journal (simulating a partially populated journal); the Warband stays deleted.
    h.raw.exec(`DELETE FROM shared_observation_sources WHERE observation_id IN (SELECT id FROM shared_observations WHERE owner_key = '${KEY_Y}')`);
    h.raw.exec(`DELETE FROM shared_observations WHERE owner_key = '${KEY_Y}'`);
    assert.equal(h.store.projectSharedStorage().guilds.some((g) => g.ownerKey === KEY_Y), false);

    const run = h.store.backfillSharedStorage();
    assert.equal(run.observationsAdded, 1, "Guild Y is restored from its stored snapshot");
    assert.equal(run.suppressedByDeletion, 2, "the Warband admissions from Alpha's and Bravo's stored snapshots are declined");
    assert.equal(h.store.projectSharedStorage().warband, undefined);
    assert.deepEqual(h.store.projectSharedStorage().guilds.map((g) => g.ownerKey), [KEY_X, KEY_Y]);
  }));

test("[REAL] the cutoff is the highest snapshot id EVER allocated: it still holds when the carrying snapshots (and character) were deleted first, and later imports are new evidence", () =>
  withHarness((h) => {
    const a = h.store.importSnapshot(VIREK_1);
    const b = h.store.importSnapshot(VIREK_2);
    h.store.deleteCharacter(VIREK_KEY); // snapshots are gone; the journal keeps the observation
    assert.equal(h.counts().snapshots, 0);
    assert.equal(h.counts().observations, 1);

    h.store.deleteSharedStorageOwner(WB);
    assert.deepEqual(clearRows(h), [{ owner_key: WARBAND_KEY, cleared_through_snapshot_id: Math.max(a.snapshot.id, b.snapshot.id) }], "MAX(id) over snapshots would have been 0 here");

    const again = h.store.importSnapshot(VIREK_2.replaceAll("1789965777", "1789969999"));
    assert.ok(again.snapshot.id > b.snapshot.id, "ids are never reused, so this is above the cutoff");
    assert.equal(again.sharedStorage[0].outcome, "recorded");
    assert.equal(h.store.projectSharedStorage().warband!.current!.sources.length, 1);
    assert.deepEqual(h.store.backfillSharedStorage(), { snapshotsWithSharedSections: 1, observationsAdded: 0, sourcesAdded: 0, suppressedByDeletion: 0 });
  }));

test("[SYNTHETIC] deleting twice raises the cutoff: evidence imported between the two deletions is not resurrected by a later backfill either", () =>
  withHarness((h) => {
    seed(h);
    h.store.deleteSharedStorageOwner(WB);
    const middle = h.imp({ name: "Delta", generated: T + 9010, warband: warband({ observedAt: T + 9000, items: [["Middle stock", 1]] }) });
    h.store.deleteSharedStorageOwner(WB);
    assert.equal(clearRows(h).find((r) => r.owner_key === WARBAND_KEY)!.cleared_through_snapshot_id, middle.snapshot.id);
    const run = h.store.backfillSharedStorage();
    assert.equal(run.suppressedByDeletion, 3, "Alpha's, Bravo's and Delta's stored Warband admissions are all declined");
    assert.equal(h.store.projectSharedStorage().warband, undefined);
  }));

test("[SYNTHETIC] importing an already-stored export again is a duplicate: it is NOT new evidence and does not recreate a deleted owner", () =>
  withHarness((h) => {
    h.store.importSnapshot(VIREK_1);
    h.store.deleteSharedStorageOwner(WB);
    const again = h.store.importSnapshot(VIREK_1);
    assert.equal(again.isDuplicate, true);
    assert.deepEqual(again.sharedStorage, []);
    assert.equal(h.store.projectSharedStorage().warband, undefined);
  }));

test("[SYNTHETIC] WHY a cutoff exists: a plain row delete (no cutoff) IS undone by backfill, so the store's own deletion must record one", () =>
  withHarness((h) => {
    h.store.importSnapshot(VIREK_1);
    h.store.importSnapshot(VIREK_2);
    h.raw.exec("DELETE FROM shared_observation_sources; DELETE FROM shared_observations;"); // what deletion would be WITHOUT the cutoff
    assert.equal(h.store.projectSharedStorage().warband, undefined);
    const run = h.store.backfillSharedStorage();
    assert.deepEqual([run.observationsAdded, run.sourcesAdded], [1, 2]);
    assert.ok(h.store.projectSharedStorage().warband, "resurrected from stored snapshots");
  }));

// --- backfill and marker semantics still correct -----------------------------------------------------------------------

test("[SYNTHETIC] backfill stays idempotent with deletions present, and never modifies the cutoffs or the marker unexpectedly", () =>
  withHarness((h) => {
    seed(h);
    h.store.deleteSharedStorageOwner(GX);
    const rows = () => table(h, "SELECT * FROM shared_observations ORDER BY id") + table(h, "SELECT * FROM shared_observation_sources ORDER BY observation_id, snapshot_id");
    const snapshot = { rows: rows(), clears: JSON.stringify(clearRows(h)), meta: table(h, "SELECT * FROM store_meta") };
    const first = h.store.backfillSharedStorage();
    const second = h.store.backfillSharedStorage();
    assert.deepEqual(first, second);
    assert.deepEqual([first.observationsAdded, first.sourcesAdded], [0, 0]);
    assert.equal(rows(), snapshot.rows);
    assert.equal(JSON.stringify(clearRows(h)), snapshot.clears);
    assert.equal(table(h, "SELECT * FROM store_meta"), snapshot.meta);
  }));

test("[SYNTHETIC] the backfill marker is untouched by owner deletion and still gates the automatic run", () =>
  withHarness((h) => {
    seed(h);
    const marker = table(h, "SELECT * FROM store_meta");
    h.store.deleteSharedStorageOwner(WB);
    assert.equal(table(h, "SELECT * FROM store_meta"), marker);
    // With the marker present a restart does not rescan: damage to a NON-deleted owner is not silently repaired at open...
    h.raw.exec(`DELETE FROM shared_observation_sources WHERE observation_id IN (SELECT id FROM shared_observations WHERE owner_key = '${KEY_Y}')`);
    h.reopen();
    assert.equal(h.all<{ n: number }>("SELECT COUNT(*) AS n FROM shared_observation_sources s JOIN shared_observations o ON o.id = s.observation_id WHERE o.owner_key = ?", KEY_Y)[0].n, 0);
    // ...only an explicit backfill (or a lost marker) does that.
    assert.equal(h.store.backfillSharedStorage().sourcesAdded, 1);
  }));

// --- atomicity ------------------------------------------------------------------------------------------------------

test("[SYNTHETIC] owner deletion is atomic: a failure while deleting observations rolls back the provenance deletion too", () =>
  withHarness((h) => {
    seed(h);
    const before = JSON.stringify([h.counts(), table(h, "SELECT * FROM shared_observation_sources ORDER BY observation_id, snapshot_id")]);
    h.raw.exec(`CREATE TRIGGER veto BEFORE DELETE ON shared_observations WHEN OLD.owner_key = '${WARBAND_KEY}' BEGIN SELECT RAISE(ABORT, 'delete vetoed'); END;`);
    assert.throws(() => h.store.deleteSharedStorageOwner(WB), /delete vetoed/);
    assert.equal(JSON.stringify([h.counts(), table(h, "SELECT * FROM shared_observation_sources ORDER BY observation_id, snapshot_id")]), before, "sources deleted earlier in the transaction were restored");
    assert.deepEqual(clearRows(h), []);
    assert.ok(h.store.projectSharedStorage().warband, "the owner is intact");

    // The store is still usable, and once the veto is gone the very same deletion works.
    h.raw.exec("DROP TRIGGER veto");
    assert.equal(h.store.deleteSharedStorageOwner(WB).existed, true);
  }));

test("[SYNTHETIC] owner deletion is atomic: if the cutoff cannot be recorded, nothing is deleted", () =>
  withHarness((h) => {
    seed(h);
    const before = h.counts();
    h.raw.exec("CREATE TRIGGER veto BEFORE INSERT ON shared_owner_clears BEGIN SELECT RAISE(ABORT, 'cutoff vetoed'); END;");
    assert.throws(() => h.store.deleteSharedStorageOwner(GX), /cutoff vetoed/);
    assert.deepEqual(h.counts(), before);
    assert.ok(h.store.projectSharedStorage().guilds.some((g) => g.ownerKey === KEY_X));
    h.raw.exec("DROP TRIGGER veto");
    assert.equal(h.store.deleteSharedStorageOwner(GX).observationsDeleted, 1);
  }));

// --- durability and failing loudly --------------------------------------------------------------------------------

test("[SYNTHETIC] deletion survives a restart: the owner stays absent, its cutoff persists, other owners are intact, and new evidence still recreates it", () =>
  withHarness((h) => {
    seed(h);
    const others = JSON.stringify(normalized({ guilds: h.store.projectSharedStorage().guilds.filter((g) => g.ownerKey !== KEY_X) }));
    h.store.deleteSharedStorageOwner(GX);
    h.reopen();
    assert.equal(h.store.projectSharedStorage().guilds.some((g) => g.ownerKey === KEY_X), false);
    assert.deepEqual(clearRows(h).map((r) => r.owner_key), [KEY_X]);
    assert.equal(JSON.stringify(normalized({ guilds: h.store.projectSharedStorage().guilds })), others);
    const recreated = h.imp({ name: "Delta", generated: T + 9010, guild: guild({ clubId: "111", name: "Guild X", observedAt: T + 9000, tabs: NARROW }) });
    assert.equal(recreated.sharedStorage[1].outcome, "recorded");
    assert.equal(h.store.projectSharedStorage().guilds.find((g) => g.ownerKey === KEY_X)!.observationCount.total, 1);
  }));

test("[SYNTHETIC] corruption still FAILS LOUDLY on read, but explicit owner deletion works on a corrupt owner (it never parses content), so it is a way to clear it", () =>
  withHarness((h) => {
    seed(h);
    h.raw.exec(`UPDATE shared_observations SET content_json = '{not json' WHERE owner_key = '${WARBAND_KEY}'`);
    assert.throws(() => h.store.loadSharedJournal(), SharedStorageIntegrityError);
    assert.throws(() => h.store.projectSharedStorage(), SharedStorageIntegrityError);

    const result = h.store.deleteSharedStorageOwner(WB);
    assert.deepEqual(result, { ownerKey: WARBAND_KEY, existed: true, observationsDeleted: 1, sourcesDeleted: 2 });
    assert.doesNotThrow(() => h.store.projectSharedStorage(), "with the corrupt owner removed the journal reads again");
    assert.equal(h.store.projectSharedStorage().warband, undefined);
  }));
