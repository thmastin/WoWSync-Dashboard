// Shared-storage journal PERSISTENCE and import integration (checkpoint C2).
//
// C1 (sharedStorage.ts) owns every rule; these tests prove the SQLite layer persists exactly what
// the domain decided, that a journal read back is the pure model (deep-equal), and that the
// storage is truly owner-scoped:
//   - the snapshot and its admitted observations are stored together or not at all;
//   - replays/duplicates/out-of-order arrivals never change the reconciled state;
//   - deleting a character (transport) never deletes a shared observation or its provenance;
//   - an existing database is backfilled idempotently, without touching its snapshots;
//   - AccountFacts / AccountContext / LlmContext / diffs still exclude shared storage.
// Exports are rendered to real WOWSYNC text (sharedStorageExports.ts) so the parser is exercised too.
// Every test pins the wall clock after all export times so imported_at is deterministic.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { snapshotObservedAt } from "../src/chronology.ts";
import { buildLlmContext } from "../src/llmContext.ts";
import {
  EMPTY_JOURNAL,
  SHARED_CONTENT_HASH_VERSION,
  SharedStorageIntegrityError,
  projectJournal,
  recordExport,
  sharedObservationHashMatches,
} from "../src/sharedStorage.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { BIG_ID, guild, warband, type TabSpec } from "./sharedStorageBuilders.ts";
import { renderExport, renderGuild, renderWarband, type ExportSpec } from "./sharedStorageExports.ts";
import { CLOCK_MS, NOW, T, VIREK_1, VIREK_2, VIREK_KEY, WARBAND_KEY, WIDE, NARROW, mats, normalized, withHarness, type Harness } from "./sharedStorageHarness.ts";

// --- the renderer is faithful (so the tests below mean something) ------------------------------------------

test("[SYNTHETIC] the export renderer round-trips: parse(render(section)) admits to the same observation as the section itself", async () => {
  const { parseWowSyncExport } = await import("../src/parser.ts");
  const { admitSection } = await import("../src/sharedStorage.ts");
  const from = { snapshotId: 1, sourceIdentityKey: "k", sourceName: "N", sourceRealm: "R", exportObservedAt: T + 100 };
  const sections = [
    warband({ observedAt: T, items: mats() }),
    warband({ observedAt: T, state: "LAST_SEEN", items: [], purchasedTabs: 2 }),
    guild({ observedAt: T, tabs: WIDE }),
    guild({ observedAt: T, completeness: "partial", tabs: [{ id: 1, name: "A", items: [["X", 1]] }, { id: 2, name: "B", state: "UNKNOWN" }, { id: 3, name: "C", state: "INACCESSIBLE" }] }),
    guild({ observedAt: T, clubId: "1.8014398509482e+16", tabs: NARROW }),
    guild({ observedAt: T, tabs: [{ id: 1, name: "Empty Tab" }] }),
  ];
  for (const section of sections) {
    const rendered = section.ownerScope === "GUILD" ? renderExport({ name: "N", generated: T + 100, guild: section }) : renderExport({ name: "N", generated: T + 100, warband: section });
    const parsed = parseWowSyncExport(rendered);
    const reparsed = section.ownerScope === "GUILD" ? parsed.guildBank! : parsed.accountBank!;
    const direct = admitSection(section, from);
    const viaText = admitSection(reparsed, from);
    assert.ok(direct.admitted && viaText.admitted);
    assert.equal(viaText.observation.identity, direct.observation.identity);
  }
  assert.equal(renderWarband(warband({ observedAt: T })).startsWith("[ACCOUNT BANK]"), true);
  assert.equal(renderGuild(guild({ observedAt: T, tabs: WIDE })).startsWith("[GUILD BANK]"), true);
});

// --- warband: first arrivals ---------------------------------------------------------------------------------

test("[SYNTHETIC] a first Warband observation is persisted, and the import reports it", () =>
  withHarness((h) => {
    const result = h.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }) });
    assert.deepEqual(result.sharedStorage, [
      { section: "accountBank", outcome: "recorded", ownerKey: WARBAND_KEY, becameCurrent: true, informative: true },
      { section: "guildBank", outcome: "skipped", reason: "unknown-state" },
    ]);
    assert.deepEqual(h.counts(), { characters: 1, snapshots: 1, observations: 1, sources: 1 });

    const [row] = h.all<Record<string, unknown>>("SELECT * FROM shared_observations");
    assert.equal(row.owner_key, WARBAND_KEY);
    assert.equal(row.owner_kind, "warband");
    assert.equal(row.claimed_observed_at, T);
    assert.equal(row.completeness, "complete");
    assert.equal(row.hash_version, SHARED_CONTENT_HASH_VERSION);
    assert.deepEqual(JSON.parse(row.owner_json as string), { kind: "warband", version: "retail", account: { kind: "installation-local" } });

    const projection = h.store.projectSharedStorage();
    assert.equal(projection.warband!.current!.effectiveObservedAt, T);
    assert.deepEqual(projection.warband!.current!.content.items.map((i) => i.name), ["Linen Cloth"]);
    assert.equal(projection.guilds.length, 0);
  }));

test("[SYNTHETIC] LAST_SEEN as the FIRST arrival is persisted as a real observation at its original time, with the carrier state kept as provenance", () =>
  withHarness((h) => {
    const result = h.imp({ name: "Alpha", generated: T + 900, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }) });
    assert.equal(result.sharedStorage[0].outcome, "recorded");
    assert.equal(result.sharedStorage[0].becameCurrent, true);
    const [source] = h.all<Record<string, unknown>>("SELECT * FROM shared_observation_sources");
    assert.equal(source.carrier_state, "LAST_SEEN");
    assert.equal(source.export_observed_at, T + 900);
    const current = h.store.projectSharedStorage().warband!.current!;
    assert.equal(current.effectiveObservedAt, T, "the observation time, not the export time");
    assert.equal(current.liveAtExport, false);
  }));

test("[REAL] the two Virek LAST_SEEN exports persist as ONE Warband observation with TWO provenance sources", () =>
  withHarness((h) => {
    const first = h.store.importSnapshot(VIREK_1);
    const second = h.store.importSnapshot(VIREK_2);
    assert.deepEqual(first.sharedStorage.map((s) => [s.section, s.outcome, s.becameCurrent]), [["accountBank", "recorded", true], ["guildBank", "skipped", undefined]]);
    assert.deepEqual(second.sharedStorage.map((s) => [s.section, s.outcome, s.becameCurrent]), [["accountBank", "source-added", false], ["guildBank", "skipped", undefined]]);
    assert.deepEqual(h.counts(), { characters: 1, snapshots: 2, observations: 1, sources: 2 });

    const w = h.store.projectSharedStorage().warband!;
    assert.equal(w.observationCount.total, 1);
    assert.equal(w.current!.effectiveObservedAt, 1789965174);
    assert.equal(w.current!.content.items.length, 98);
    assert.deepEqual(w.current!.carrierStates, ["LAST_SEEN"]);
    assert.deepEqual(
      w.current!.sources.map((s) => [s.snapshotId, s.exportObservedAt, s.snapshotVisit, s.visitedNpc, s.visitedZone, s.sourceName, s.sourceRealm, s.sourceIdentityKey]),
      [
        [first.snapshot.id, 1789965184, 1789965173, "Elana", "Silvermoon City", "Virek", "Cairne", VIREK_KEY],
        [second.snapshot.id, 1789965777, 1789965173, "Elana", "Silvermoon City", "Virek", "Cairne", VIREK_KEY],
      ],
    );
  }));

test("[SYNTHETIC] OBSERVED then a LAST_SEEN replay: one observation, two sources, carrier states preserved", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, state: "OBSERVED", items: mats() }) });
    const replay = h.imp({ name: "Alpha", generated: T + 4000, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }) });
    assert.equal(replay.sharedStorage[0].outcome, "source-added");
    assert.equal(replay.sharedStorage[0].becameCurrent, false);
    assert.deepEqual(h.counts(), { characters: 1, snapshots: 2, observations: 1, sources: 2 });
    const current = h.store.projectSharedStorage().warband!.current!;
    assert.deepEqual(current.carrierStates, ["LAST_SEEN", "OBSERVED"]);
    assert.equal(current.liveAtExport, true);
    assert.equal(current.effectiveObservedAt, T);
  }));

test("[SYNTHETIC] LAST_SEEN first, then the OBSERVED export of the same record arrives (older export imported later): still one observation", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 4000, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }) });
    const late = h.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, state: "OBSERVED", items: mats() }) });
    assert.equal(late.sharedStorage[0].outcome, "source-added");
    assert.deepEqual(h.counts(), { characters: 1, snapshots: 2, observations: 1, sources: 2 });
    const current = h.store.projectSharedStorage().warband!.current!;
    assert.deepEqual(current.carrierStates, ["LAST_SEEN", "OBSERVED"]);
    assert.equal(current.liveAtExport, true);
    assert.equal(current.effectiveObservedAt, T);
  }));

test("[SYNTHETIC] several characters carrying the same Warband observation are sources of ONE observation", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", realm: "Cairne", generated: T + 10, warband: warband({ observedAt: T, items: mats() }) });
    h.imp({ name: "Bravo", realm: "Thrall", generated: T + 500, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }) });
    h.imp({ name: "Charlie", realm: "Cairne", generated: T + 900, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }) });
    assert.deepEqual(h.counts(), { characters: 3, snapshots: 3, observations: 1, sources: 3 });
    const w = h.store.projectSharedStorage().warband!;
    assert.deepEqual(w.current!.sourceCharacterKeys, ["retail::cairne::alpha", "retail::cairne::charlie", "retail::thrall::bravo"]);
    assert.deepEqual(w.current!.sources.map((s) => s.sourceName), ["Alpha", "Bravo", "Charlie"]);
  }));

test("[SYNTHETIC] out-of-order import: an older observation imported later is recorded but is not current", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 2010, warband: warband({ observedAt: T + 2000, items: [["Newer", 1]] }) });
    const late = h.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: [["Older", 1]] }) });
    assert.deepEqual(late.sharedStorage[0], { section: "accountBank", outcome: "recorded", ownerKey: WARBAND_KEY, becameCurrent: false, informative: true });
    const w = h.store.projectSharedStorage().warband!;
    assert.deepEqual(w.current!.content.items.map((i) => i.name), ["Newer"]);
    assert.equal(w.observationCount.total, 2);
  }));

test("[SYNTHETIC] an exact duplicate export changes nothing: no second snapshot, observation or source", () =>
  withHarness((h) => {
    const spec: ExportSpec = { name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }), guild: guild({ observedAt: T, tabs: WIDE }) };
    h.imp(spec);
    const before = h.counts();
    const again = h.store.importSnapshot(renderExport(spec).replace(/\n/g, "\r\n")); // copy/paste line endings
    assert.equal(again.isDuplicate, true);
    assert.deepEqual(again.sharedStorage, []);
    assert.deepEqual(h.counts(), before);
  }));

test("[SYNTHETIC] UNKNOWN shared sections after known ones erase nothing and add nothing", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }), guild: guild({ observedAt: T, tabs: WIDE }) });
    const before = normalized(h.store.projectSharedStorage());
    const counts = h.counts();
    const later = h.imp({ name: "Alpha", generated: T + 9000, level: 5 }); // both shared sections UNKNOWN, as the addon renders never-observed banks
    assert.deepEqual(later.sharedStorage.map((s) => [s.section, s.outcome, s.reason]), [["accountBank", "skipped", "unknown-state"], ["guildBank", "skipped", "unknown-state"]]);
    assert.deepEqual(h.counts(), { ...counts, snapshots: counts.snapshots + 1 });
    assert.equal(normalized(h.store.projectSharedStorage()), before);
  }));

test("[SYNTHETIC] unanchored and unattributable sections stay in the snapshot but never create observations", () =>
  withHarness((h) => {
    const unanchored = warband({ observedAt: T, items: mats() });
    unanchored.status.observedAt = undefined;
    const noId = guild({ clubId: null, observedAt: T, tabs: WIDE });
    const result = h.imp({ name: "Alpha", generated: T + 10, warband: unanchored, guild: noId });
    assert.deepEqual(result.sharedStorage.map((s) => [s.section, s.outcome, s.reason]), [["accountBank", "skipped", "unanchored"], ["guildBank", "skipped", "unattributable"]]);
    assert.deepEqual(h.counts(), { characters: 1, snapshots: 1, observations: 0, sources: 0 });
    // The snapshot itself still carries both sections exactly as parsed (the transitional character-page view is unchanged).
    assert.equal(result.snapshot.parsed.accountBank?.status.state, "OBSERVED");
    assert.equal(result.snapshot.parsed.guildBank?.guildName, "Fixture Guild");
    assert.equal(h.store.projectSharedStorage().warband, undefined, "never observed is not empty: there is simply no owner state");
  }));

// --- guild ------------------------------------------------------------------------------------------------------

test("[SYNTHETIC] a Guild observation persists keyed by GuildClubID, with name, tabs, items and provenance", () =>
  withHarness((h) => {
    const result = h.imp({ name: "Alpha", generated: T + 10, guild: guild({ observedAt: T, name: "Fixture Guild", tabs: WIDE }) });
    assert.deepEqual(result.sharedStorage.map((s) => [s.section, s.outcome, s.ownerKey]), [["accountBank", "skipped", undefined], ["guildBank", "recorded", `retail::guild::${BIG_ID}`]]);
    const g = h.store.projectSharedStorage().guilds[0];
    assert.equal(g.current!.content.guildName, "Fixture Guild");
    assert.deepEqual(g.current!.content.tabs.map((t) => [t.id, t.name, t.viewable, t.state]), [[1, "Materials", true, "OBSERVED"], [2, "Consumables", true, "OBSERVED"], [3, "Officers", true, "OBSERVED"], [4, "Raid", true, "OBSERVED"]]);
    assert.equal(g.current!.content.items.length, 4);
    assert.deepEqual(g.current!.sources.map((s) => [s.sourceName, s.carrierState]), [["Alpha", "OBSERVED"]]);
    assert.equal(g.owner.kind === "guild" && g.owner.guildClubId, BIG_ID);
  }));

test("[SYNTHETIC] the same guild from two characters reconciles into one owner; a newer differing observation wins", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, guild: guild({ observedAt: T, tabs: WIDE }) });
    h.imp({ name: "Bravo", realm: "Thrall", generated: T + 700, guild: guild({ observedAt: T, state: "LAST_SEEN", tabs: WIDE }) });
    assert.deepEqual(h.counts(), { characters: 2, snapshots: 2, observations: 1, sources: 2 });
    h.imp({ name: "Bravo", realm: "Thrall", generated: T + 3010, level: 2, guild: guild({ observedAt: T + 3000, tabs: [{ id: 1, name: "Materials", items: [["Linen Cloth", 99]] }] }) });
    const guilds = h.store.projectSharedStorage().guilds;
    assert.equal(guilds.length, 1);
    assert.equal(guilds[0].observationCount.total, 2);
    assert.equal(guilds[0].current!.content.items[0].qty, 99);
    assert.deepEqual(guilds[0].current!.sourceCharacterKeys, ["retail::thrall::bravo"]);
  }));

test("[SYNTHETIC] two different guilds are separate owners that never touch each other", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, guild: guild({ clubId: "111", name: "Guild X", observedAt: T, tabs: [{ id: 1, name: "A", items: [["X item", 1]] }] }) });
    const before = normalized(h.store.projectSharedStorage());
    h.imp({ name: "Alpha", generated: T + 2010, level: 2, guild: guild({ clubId: "222", name: "Guild Y", observedAt: T + 2000, tabs: [{ id: 1, name: "A", items: [["Y item", 1]] }] }) }); // same character joins another guild
    const projection = h.store.projectSharedStorage();
    assert.deepEqual(projection.guilds.map((g) => g.ownerKey), ["retail::guild::111", "retail::guild::222"]);
    assert.deepEqual(JSON.parse(normalized({ guilds: [projection.guilds[0]] })).guilds, JSON.parse(before).guilds, "guild X is unchanged by the character moving to guild Y");
  }));

test("[SYNTHETIC] GuildClubID text is preserved exactly through storage: above 2^53 and scientific-notation-looking", () =>
  withHarness((h) => {
    for (const [i, id] of [BIG_ID, "18014398509481984", "1.8014398509482e+16"].entries()) {
      h.imp({ name: "Alpha", generated: T + 10 + i, level: i + 1, guild: guild({ clubId: id, observedAt: T + i, tabs: [{ id: 1, name: "A", items: [["X", 1]] }] }) });
    }
    const keys = h.all<{ owner_key: string }>("SELECT owner_key FROM shared_observations ORDER BY id").map((r) => r.owner_key);
    assert.deepEqual(keys, [`retail::guild::${BIG_ID}`, "retail::guild::18014398509481984", "retail::guild::1.8014398509482e+16"]);
    assert.equal(h.store.projectSharedStorage().guilds.length, 3, "three distinct owners, although two ids are the same JS number");
  }));

test("[SYNTHETIC] a PARTIAL guild observation persists as partial; a newer partial never replaces an older complete one", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, guild: guild({ observedAt: T, tabs: [{ id: 1, name: "A", items: [["Complete item", 1]] }] }) });
    h.imp({ name: "Alpha", generated: T + 3010, level: 2, guild: guild({ observedAt: T + 3000, completeness: "partial", status: { coverageNote: "Guild Bank query response timed out" }, tabs: [{ id: 1, name: "A", items: [["Partial item", 1]] }, { id: 2, name: "B", state: "UNKNOWN" }] }) });
    assert.deepEqual(h.all<{ completeness: string }>("SELECT completeness FROM shared_observations ORDER BY id").map((r) => r.completeness), ["complete", "partial"]);
    const g = h.store.projectSharedStorage().guilds[0];
    assert.deepEqual(g.current!.content.items.map((i) => i.name), ["Complete item"]);
    assert.equal(g.latestPartial!.completeness, "partial");
    assert.deepEqual(g.latestPartial!.coverage.unconfirmedTabs, [2]);
    assert.equal(g.latestPartial!.sources[0].coverageNote, "Guild Bank query response timed out", "the carrier's coverage note is kept as provenance");
  }));

test("[SYNTHETIC] INACCESSIBLE and UNKNOWN tabs are preserved through storage, never turned into empty tabs", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, guild: guild({ observedAt: T, tabs: NARROW }) });
    const g = h.store.projectSharedStorage().guilds[0];
    assert.deepEqual(g.current!.content.tabs.filter((t) => t.state === "INACCESSIBLE").map((t) => [t.id, t.viewable]), [[3, false], [4, false]]);
    assert.deepEqual(g.current!.coverage, { observedTabs: [1, 2], inaccessibleTabs: [3, 4], unconfirmedTabs: [], unidentifiedTabs: 0, observedContainerIds: [1, 2] });
    assert.equal(g.current!.content.itemsKnownEmpty, false);
  }));

test("[SYNTHETIC] a newer NARROWER guild observation does not destroy the older broader one, and nothing is spliced", () =>
  withHarness((h) => {
    h.imp({ name: "Officer", generated: T + 10, guild: guild({ observedAt: T, tabs: WIDE }) });
    h.imp({ name: "Member", generated: T + 2010, guild: guild({ observedAt: T + 2000, tabs: NARROW }) });
    const g = h.store.projectSharedStorage().guilds[0];
    assert.equal(g.current!.effectiveObservedAt, T + 2000);
    assert.deepEqual(g.current!.content.items.map((i) => i.name).sort(), ["Health Potion", "Linen Cloth"]);
    assert.equal(g.broaderCoverageEarlier!.effectiveObservedAt, T);
    assert.deepEqual(g.broaderCoverageEarlier!.coverage.observedTabs, [1, 2, 3, 4]);
    assert.equal(g.observationCount.total, 2);
  }));

// --- the persisted journal IS the pure model ------------------------------------------------------------------

/** A varied corpus: replays across carriers, both owners, partial, informationless, a same-second conflict. */
function corpus(): ExportSpec[] {
  return [
    { name: "Alpha", generated: T + 1010, warband: warband({ observedAt: T + 1000, items: [["Old stock", 1]] }), guild: guild({ observedAt: T + 1000, tabs: WIDE }) },
    { name: "Bravo", realm: "Thrall", generated: T + 2000, warband: warband({ observedAt: T + 1000, state: "LAST_SEEN", items: [["Old stock", 1]] }) },
    { name: "Bravo", realm: "Thrall", generated: T + 2210, level: 2, warband: warband({ observedAt: T + 2200, items: [["New stock", 2]] }), guild: guild({ observedAt: T + 2200, tabs: NARROW }) },
    { name: "Charlie", generated: T + 2300, warband: warband({ observedAt: T + 2250, completeness: "partial", items: [["Partial stock", 3]] }), guild: guild({ clubId: "222", name: "Other Guild", observedAt: T + 1300, tabs: [{ id: 1, name: "Bank", items: [["Other item", 1]] }] }) },
    { name: "Alpha", generated: T + 2400, level: 2, guild: guild({ observedAt: T + 2200, state: "LAST_SEEN", tabs: NARROW }) },
  ];
}

function bigCorpus(): ExportSpec[] {
  return [
    ...corpus(),
    { name: "Delta", generated: T + 2500, guild: guild({ observedAt: T + 2450, completeness: "partial", tabs: [{ id: 1, name: "Materials", items: [["Partial thing", 1]] }, { id: 2, name: "Consumables", state: "UNKNOWN" }] }) },
    { name: "Echo", generated: T + 2700, guild: guild({ observedAt: T + 2600, tabs: [{ id: 1, name: "Materials", state: "INACCESSIBLE" }, { id: 2, name: "Consumables", state: "INACCESSIBLE" }] }) },
    { name: "Foxtrot", generated: T + 2710, guild: guild({ observedAt: T + 2200, tabs: [{ id: 1, name: "Materials", items: [["Linen Cloth", 46]] }, { id: 2, name: "Consumables", items: [["Health Potion", 10]] }, { id: 3, name: "Officers", state: "INACCESSIBLE" }, { id: 4, name: "Raid", state: "INACCESSIBLE" }] }) },
  ];
}

test("[SYNTHETIC] the persisted journal round-trips into the pure C1 model: the store's projection deep-equals a pure recomputation", () =>
  withHarness((h) => {
    for (const spec of bigCorpus()) h.imp(spec);
    const fromStore = h.store.projectSharedStorage();

    // Recompute purely from the stored snapshots, in the OPPOSITE order, with C1 alone.
    const characters = new Map(h.store.listCharacters("retail").map((c) => [c.id, c]));
    let journal = EMPTY_JOURNAL;
    const snapshots = h.store.listCharacters("retail").flatMap((c) => h.store.listSnapshots(c.identityKey)).sort((a, b) => b.id - a.id);
    for (const s of snapshots) {
      const c = characters.get(s.characterId)!;
      journal = recordExport(journal, s.parsed, {
        snapshotId: s.id,
        sourceIdentityKey: c.identityKey,
        sourceName: c.name,
        sourceRealm: c.realm,
        exportObservedAt: snapshotObservedAt(s.generatedAt, s.importedAt),
      }).journal;
    }
    assert.deepStrictEqual(fromStore, projectJournal(journal));
    assert.ok(fromStore.warband && fromStore.guilds.length === 2);
  }));

test("[SYNTHETIC] the content-hash VERSION is persisted per observation and reconstructed; every stored hash re-verifies", () =>
  withHarness((h) => {
    for (const spec of corpus()) h.imp(spec);
    const rows = h.all<{ hash_version: number }>("SELECT hash_version FROM shared_observations");
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.hash_version === SHARED_CONTENT_HASH_VERSION));

    const journal = h.store.loadSharedJournal();
    for (const { observation } of journal.entries.values()) {
      assert.equal(observation.hashVersion, SHARED_CONTENT_HASH_VERSION);
      assert.equal(sharedObservationHashMatches(observation), true, "the stored content still hashes to the stored hash");
    }
    assert.ok(h.store.projectSharedStorage().warband!.current!.contentHashVersion === SHARED_CONTENT_HASH_VERSION);
  }));

test("[SYNTHETIC] an observation stored under ANOTHER hash version still loads (its hash is just unverifiable), so a future re-hash migration is possible", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }) });
    h.raw.exec("UPDATE shared_observations SET hash_version = 2");
    const [entry] = [...h.store.loadSharedJournal().entries.values()];
    assert.equal(entry.observation.hashVersion, 2);
    assert.equal(sharedObservationHashMatches(entry.observation), undefined);
    assert.equal(h.store.projectSharedStorage().warband!.current!.contentHashVersion, 2);
  }));

test("[SYNTHETIC] a corrupt journal row is reported loudly (integrity error), never silently skipped or guessed", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }) });
    h.raw.exec("UPDATE shared_observations SET content_json = '{not json'");
    assert.throws(() => h.store.loadSharedJournal(), SharedStorageIntegrityError);
  }));

test("[SYNTHETIC] schema: the journal tables reference neither characters nor snapshots (only sources -> observations)", () =>
  withHarness((h) => {
    const fks = (table: string) => h.all<{ table: string }>(`SELECT "table" FROM pragma_foreign_key_list('${table}')`).map((r) => r.table);
    assert.deepEqual(fks("shared_observations"), []);
    assert.deepEqual(fks("shared_observation_sources"), ["shared_observations"]);
    const columns = h.all<{ name: string }>("SELECT name FROM pragma_table_info('shared_observations')").map((r) => r.name);
    assert.ok(columns.includes("hash_version") && columns.includes("owner_json") && columns.includes("owner_key"));
    assert.equal(h.all<{ value: string }>("SELECT value FROM store_meta WHERE key = 'shared_storage_backfill'")[0].value, "1");
  }));

// --- character deletion -----------------------------------------------------------------------------------------

test("[REAL] deleting the only carrying character leaves the Warband observation and its provenance label intact", () =>
  withHarness((h) => {
    const first = h.store.importSnapshot(VIREK_1);
    const second = h.store.importSnapshot(VIREK_2);
    const before = h.store.projectSharedStorage();
    const rowsBefore = h.all("SELECT * FROM shared_observations");
    const sourcesBefore = h.all("SELECT * FROM shared_observation_sources");

    const deleted = h.store.deleteCharacter(VIREK_KEY)!;
    assert.equal(deleted.snapshotsDeleted, 2);
    assert.equal(h.store.getCharacter(VIREK_KEY), undefined);
    assert.equal(h.store.getSnapshot(first.snapshot.id), undefined);
    assert.equal(h.store.getSnapshot(second.snapshot.id), undefined);

    assert.deepEqual(h.counts(), { characters: 0, snapshots: 0, observations: 1, sources: 2 });
    assert.deepEqual(h.all("SELECT * FROM shared_observations"), rowsBefore);
    assert.deepEqual(h.all("SELECT * FROM shared_observation_sources"), sourcesBefore);
    // Same projection, historical label included, although the character and both snapshots are gone.
    assert.deepStrictEqual(h.store.projectSharedStorage(), before);
    const source = h.store.projectSharedStorage().warband!.current!.sources[0];
    assert.deepEqual([source.sourceName, source.sourceRealm, source.sourceIdentityKey, source.snapshotId], ["Virek", "Cairne", VIREK_KEY, first.snapshot.id]);
  }));

test("[SYNTHETIC] deleting one of several carrying characters preserves every observation and every source, including the deleted one's", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", realm: "Cairne", generated: T + 10, warband: warband({ observedAt: T, items: mats() }), guild: guild({ observedAt: T, tabs: WIDE }) });
    h.imp({ name: "Bravo", realm: "Thrall", generated: T + 500, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }), guild: guild({ observedAt: T, state: "LAST_SEEN", tabs: WIDE }) });
    h.imp({ name: "Bravo", realm: "Thrall", generated: T + 2510, level: 2, warband: warband({ observedAt: T + 2500, items: [["Newer", 1]] }) });
    const before = h.store.projectSharedStorage();
    const counts = h.counts();

    assert.ok(h.store.deleteCharacter("retail::thrall::bravo"));
    assert.deepEqual(h.counts(), { ...counts, characters: 1, snapshots: 1 });
    assert.deepStrictEqual(h.store.projectSharedStorage(), before);
    const guildSources = h.store.projectSharedStorage().guilds[0].current!.sources.map((s) => s.sourceName);
    assert.deepEqual(guildSources, ["Alpha", "Bravo"], "the deleted carrier stays in provenance");
    // The remaining character is untouched and can keep contributing.
    h.imp({ name: "Alpha", realm: "Cairne", generated: T + 4000, level: 3, warband: warband({ observedAt: T + 2500, state: "LAST_SEEN", items: [["Newer", 1]] }) });
    // An existing observation gains the replay as a source: Bravo's live one (kept although Bravo is deleted) + Alpha's replay.
    assert.deepEqual(h.store.projectSharedStorage().warband!.current!.sources.map((s) => s.sourceName), ["Bravo", "Alpha"]);
  }));

test("[SYNTHETIC] re-importing a deleted character adds a NEW source to the surviving observation (snapshot ids are never reused)", () =>
  withHarness((h) => {
    const spec: ExportSpec = { name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }) };
    const first = h.imp(spec);
    h.store.deleteCharacter("retail::cairne::alpha");
    const again = h.imp(spec);
    assert.notEqual(again.snapshot.id, first.snapshot.id, "a new snapshot row gets a new id");
    assert.equal(again.sharedStorage[0].outcome, "source-added");
    assert.deepEqual(h.counts(), { characters: 1, snapshots: 1, observations: 1, sources: 2 });
  }));

// --- backfill -----------------------------------------------------------------------------------------------------

function dropJournal(h: Harness) {
  h.raw.exec("DROP TABLE shared_observation_sources; DROP TABLE shared_observations; DROP TABLE store_meta;");
}

test("[REAL] opening a database that predates the journal backfills it: the Virek pair becomes ONE observation and TWO sources", () =>
  withHarness((h) => {
    const first = h.store.importSnapshot(VIREK_1);
    const second = h.store.importSnapshot(VIREK_2);
    const expected = h.store.projectSharedStorage();
    const snapshotsBefore = h.all("SELECT id, raw_text, parsed_json FROM snapshots ORDER BY id");

    // Simulate a pre-C2 database: same snapshots, no journal tables, no marker.
    h.reopen(() => dropJournal(h));

    assert.deepEqual(h.counts(), { characters: 1, snapshots: 2, observations: 1, sources: 2 });
    assert.deepStrictEqual(h.store.projectSharedStorage(), expected);
    const w = h.store.projectSharedStorage().warband!;
    assert.deepEqual(w.current!.sources.map((s) => s.snapshotId), [first.snapshot.id, second.snapshot.id]);
    assert.deepEqual(w.current!.carrierStates, ["LAST_SEEN"], "LAST_SEEN is never relabelled OBSERVED");
    assert.equal(w.current!.effectiveObservedAt, 1789965174, "the original observation time is not advanced");
    // Existing snapshots are not modified.
    assert.deepEqual(h.all("SELECT id, raw_text, parsed_json FROM snapshots ORDER BY id"), snapshotsBefore);
  }));

test("[SYNTHETIC] backfill of a varied database reproduces exactly what import-time recording produced", () =>
  withHarness((h) => {
    for (const spec of bigCorpus()) h.imp(spec);
    const expected = h.store.projectSharedStorage();
    const expectedObservations = h.all("SELECT identity, owner_key, claimed_observed_at, completeness, content_hash, hash_version, content_json FROM shared_observations ORDER BY identity");
    h.reopen(() => dropJournal(h));
    assert.deepStrictEqual(h.store.projectSharedStorage(), expected);
    assert.deepEqual(h.all("SELECT identity, owner_key, claimed_observed_at, completeness, content_hash, hash_version, content_json FROM shared_observations ORDER BY identity"), expectedObservations);
  }));

test("[SYNTHETIC] backfill is idempotent: a second run adds nothing and changes no row", () =>
  withHarness((h) => {
    for (const spec of corpus()) h.imp(spec);
    const rows = () => JSON.stringify([h.all("SELECT * FROM shared_observations ORDER BY id"), h.all("SELECT * FROM shared_observation_sources ORDER BY observation_id, snapshot_id")]);
    const snapshots = JSON.stringify(h.all("SELECT * FROM snapshots ORDER BY id"));
    const before = rows();
    const run = h.store.backfillSharedStorage();
    assert.equal(run.snapshotsWithSharedSections, 5);
    assert.equal(run.observationsAdded, 0);
    assert.equal(run.sourcesAdded, 0);
    assert.equal(h.store.backfillSharedStorage().sourcesAdded, 0);
    assert.equal(rows(), before);
    assert.equal(JSON.stringify(h.all("SELECT * FROM snapshots ORDER BY id")), snapshots);
  }));

test("[SYNTHETIC] backfill repairs a PARTIALLY populated journal without duplicating what is present", () =>
  withHarness((h) => {
    for (const spec of bigCorpus()) h.imp(spec);
    const expected = normalized(h.store.projectSharedStorage());
    const total = h.counts();

    // Remove one whole observation (with its sources) and one source of another.
    const victims = h.all<{ id: number }>("SELECT id FROM shared_observations ORDER BY id");
    h.raw.exec(`DELETE FROM shared_observation_sources WHERE observation_id = ${victims[0].id}; DELETE FROM shared_observations WHERE id = ${victims[0].id};`);
    const someSource = h.all<{ observation_id: number; snapshot_id: number }>("SELECT observation_id, snapshot_id FROM shared_observation_sources LIMIT 1")[0];
    h.raw.exec(`DELETE FROM shared_observation_sources WHERE observation_id = ${someSource.observation_id} AND snapshot_id = ${someSource.snapshot_id}`);
    assert.notDeepEqual(h.counts(), total);

    // A reopen does NOT rescan (the marker says it already ran); an explicit backfill repairs.
    h.reopen();
    assert.notDeepEqual(h.counts(), total);
    const repaired = h.store.backfillSharedStorage();
    assert.ok(repaired.sourcesAdded >= 2);
    assert.deepEqual(h.counts(), total);
    assert.equal(normalized(h.store.projectSharedStorage()), expected);
  }));

test("[SYNTHETIC] backfill after a character was deleted does not resurrect or remove anything (the journal is the only copy)", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }) });
    h.imp({ name: "Bravo", realm: "Thrall", generated: T + 20, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }) });
    h.store.deleteCharacter("retail::cairne::alpha");
    const before = h.counts();
    const run = h.store.backfillSharedStorage();
    assert.deepEqual([run.observationsAdded, run.sourcesAdded], [0, 0]);
    assert.deepEqual(h.counts(), before);
    assert.equal(h.store.projectSharedStorage().warband!.current!.sources.length, 2, "Alpha's provenance survives even though Alpha's snapshot is gone");
  }));

// --- atomicity ------------------------------------------------------------------------------------------------------

test("[SYNTHETIC] the snapshot and its shared observations are stored together: a journal write failure rolls back the WHOLE import", () =>
  withHarness((h) => {
    h.raw.exec(`CREATE TRIGGER veto BEFORE INSERT ON shared_observation_sources
                BEGIN SELECT RAISE(ABORT, 'journal write vetoed'); END;`);
    const spec: ExportSpec = { name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }) };
    assert.throws(() => h.imp(spec), /journal write vetoed/);
    assert.deepEqual(h.counts(), { characters: 0, snapshots: 0, observations: 0, sources: 0 }, "no character, no snapshot, no observation");

    // The store is still usable and, once the veto is gone, the very same export imports normally (it was never stored).
    h.raw.exec("DROP TRIGGER veto");
    const ok = h.imp(spec);
    assert.equal(ok.isDuplicate, false);
    assert.deepEqual(h.counts(), { characters: 1, snapshots: 1, observations: 1, sources: 1 });
  }));

test("[SYNTHETIC] a failing observation write also rolls back a snapshot added to an EXISTING character", () =>
  withHarness((h) => {
    h.imp({ name: "Alpha", generated: T + 10, level: 1 });
    const before = h.counts();
    h.raw.exec(`CREATE TRIGGER veto BEFORE INSERT ON shared_observations BEGIN SELECT RAISE(ABORT, 'observation write vetoed'); END;`);
    assert.throws(() => h.imp({ name: "Alpha", generated: T + 20, level: 2, warband: warband({ observedAt: T + 15, items: mats() }) }), /observation write vetoed/);
    assert.deepEqual(h.counts(), before);
    assert.equal(h.store.getCharacter("retail::cairne::alpha")!.snapshotCount, 1);
  }));

// --- order independence at the persistence level ---------------------------------------------------------------------

function* permutations<T2>(items: readonly T2[]): Generator<T2[]> {
  const a = [...items];
  const c = new Array(a.length).fill(0);
  yield [...a];
  let i = 0;
  while (i < a.length) {
    if (c[i] < i) {
      const k = i % 2 === 0 ? 0 : c[i];
      [a[k], a[i]] = [a[i], a[k]];
      yield [...a];
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

function importAll(specs: readonly ExportSpec[]): { signature: string; tables: string } {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    for (const spec of specs) store.importSnapshot(renderExport(spec));
    const journal = store.loadSharedJournal();
    const tables = JSON.stringify([...journal.entries.values()].map((e) => [e.observation.identity, e.observation.hashVersion, e.observation.contentHash, e.sources.size]).sort());
    return { signature: normalized(projectJournal(journal)), tables };
  } finally {
    store.close();
  }
}

test("[SYNTHETIC] persistence-level order independence: all 120 arrival orders of five exports persist the same journal and projection", () => {
  mock.timers.enable({ apis: ["Date"], now: CLOCK_MS });
  try {
    const specs = corpus();
    const reference = importAll(specs);
    let orders = 0;
    for (const order of permutations(specs)) {
      orders++;
      const result = importAll(order);
      assert.equal(result.signature, reference.signature, `order ${orders}`);
      assert.equal(result.tables, reference.tables, `order ${orders} (rows)`);
    }
    assert.equal(orders, 120);
  } finally {
    mock.timers.reset();
  }
});

test("[SYNTHETIC] persistence-level order independence: 60 seeded shuffles of eight exports (partial, informationless, conflicting, replayed) agree", () => {
  mock.timers.enable({ apis: ["Date"], now: CLOCK_MS });
  try {
    const specs = bigCorpus();
    const reference = importAll(specs);
    let seed = 20260921;
    const random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    for (let run = 0; run < 60; run++) {
      const order = [...specs];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const result = importAll(order);
      assert.equal(result.signature, reference.signature, `shuffle ${run}`);
      assert.equal(result.tables, reference.tables, `shuffle ${run} (rows)`);
    }
    const expected = JSON.parse(reference.signature);
    assert.ok(expected.warband.latestPartial, "the corpus really contains a newer partial");
    assert.ok(expected.guilds[0].broader, "and a broader earlier guild observation");
  } finally {
    mock.timers.reset();
  }
});

// --- consumers unchanged ----------------------------------------------------------------------------------------------

test("[SYNTHETIC] shared storage is still EXCLUDED from AccountFacts, totals, search, diffs, AccountContext and the LLM context", () => {
  mock.timers.enable({ apis: ["Date"], now: CLOCK_MS });
  const withShared = new SqliteSnapshotStore(":memory:");
  const withoutShared = new SqliteSnapshotStore(":memory:");
  try {
    for (const spec of bigCorpus()) {
      withShared.importSnapshot(renderExport(spec));
      withoutShared.importSnapshot(renderExport({ ...spec, warband: undefined, guild: undefined })); // identical, but no shared sections at all
    }
    assert.ok(withShared.projectSharedStorage().warband, "the journal exists in one store");
    assert.equal(withoutShared.projectSharedStorage().warband, undefined, "and not the other");

    const world = (store: SqliteSnapshotStore) => {
      const context = store.buildAccountContext(NOW);
      return JSON.stringify({
        facts: store.buildAccountFacts("retail", NOW),
        llm: buildLlmContext(context),
        versions: store.listVersions(),
        changes: store.recentChanges("retail").map((c) => c.diff),
      });
    };
    assert.equal(world(withShared), world(withoutShared), "facts, LLM context, version summaries and diffs are byte-identical with and without shared storage");

    const serialized = JSON.stringify(withShared.buildAccountContext(NOW)) + world(withShared);
    for (const shared of ["Old stock", "New stock", "Partial stock", "Officer Sword", "Raid Flask", "Other item", "Fixture Guild", "Other Guild", BIG_ID]) {
      assert.equal(serialized.includes(shared), false, `${shared} must not reach any consumer`);
    }
  } finally {
    withShared.close();
    withoutShared.close();
    mock.timers.reset();
  }
});

// --- ImportResult compatibility ---------------------------------------------------------------------------------------

test("[SYNTHETIC] ImportResult stays backward compatible: every existing field keeps its meaning, and `sharedStorage` is purely additive", () =>
  withHarness((h) => {
    const plain = h.imp({ name: "Alpha", generated: T + 10, level: 1 });
    assert.deepEqual(Object.keys(plain).sort(), ["character", "diff", "isDuplicate", "isFirstSnapshot", "isLatest", "previousSnapshot", "sharedStorage", "snapshot"]);
    assert.equal(plain.isFirstSnapshot, true);
    assert.equal(plain.isDuplicate, false);
    assert.equal(plain.isLatest, true);
    assert.equal(plain.previousSnapshot, undefined);
    assert.equal(plain.diff, undefined);
    assert.deepEqual(plain.sharedStorage.map((s) => s.outcome), ["skipped", "skipped"], "an export with both sections UNKNOWN reports two skips");

    const second = h.imp({ name: "Alpha", generated: T + 20, level: 2, warband: warband({ observedAt: T + 15, items: mats() }) });
    assert.equal(second.isFirstSnapshot, false);
    assert.equal(second.isLatest, true);
    assert.equal(second.previousSnapshot?.id, plain.snapshot.id);
    assert.equal(second.diff?.level.delta, 1);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(second)), "the result serializes for the API");
    assert.equal(second.sharedStorage[0].outcome, "recorded");

    const older = h.imp({ name: "Alpha", generated: T + 5, level: 0, warband: warband({ observedAt: T + 4, items: [["Older", 1]] }) });
    assert.equal(older.isLatest, false, "existing chronology semantics are unchanged");
    assert.equal(older.sharedStorage[0].becameCurrent, false, "and the shared observation is older than the current one");
  }));

test("[SYNTHETIC] a recorded-but-informationless observation is reported as such (never 'became current')", () =>
  withHarness((h) => {
    const result = h.imp({ name: "Alpha", generated: T + 10, guild: guild({ observedAt: T, tabs: [{ id: 1, name: "A", state: "INACCESSIBLE" }] }) });
    assert.deepEqual(result.sharedStorage[1], { section: "guildBank", outcome: "recorded", ownerKey: `retail::guild::${BIG_ID}`, becameCurrent: false, informative: false });
    assert.equal(h.store.projectSharedStorage().guilds[0].current, undefined, "unknown, not empty");
  }));
