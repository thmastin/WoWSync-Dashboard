// Shared-storage reconciliation: the pure domain module (checkpoint C1).
//
// Test labels follow the fixture convention: [REAL] uses the sanitized real Virek exports,
// [DERIVED] edits a real export, [SYNTHETIC] builds sections directly. Import-ORDER
// independence has its own file (sharedStorageOrder.test.ts).
//
// What is pinned here:
//   - ownership: Warband = installation-local account scope (NOT a Battle.net id), Guild =
//     opaque GuildClubID text, character storage never enters this module;
//   - observation identity = "this owner, at this claimed time, with this content and
//     completeness" - NOT the carrier state, the carrying export, or SnapshotVisit;
//   - UNKNOWN never erases; LAST_SEEN replays never manufacture observations;
//   - selection never splices observations, never lets a partial/informationless capture
//     displace a complete informative one, and stays DERIVED.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWowSyncExport } from "../src/parser.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildLlmContext } from "../src/llmContext.ts";
import { snapshotObservedAt } from "../src/chronology.ts";
import { BIG_ID, admit, admitAll, carrier, guild, itemRow, warband, type TabSpec } from "./sharedStorageBuilders.ts";
import {
  EMPTY_JOURNAL,
  admitExport,
  admitSection,
  guildOwner,
  isSharedStorageOwner,
  ownerKey,
  projectJournal,
  projectOwnerFromJournal,
  recordExport,
  warbandOwner,
  type CarrierExport,
  type StorageOwner,
} from "../src/sharedStorage.ts";
import type { AccountBankSection, GuildBankSection } from "../src/types.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const VIREK_1 = readFileSync(`${dir}sanitized/virek-warband-last-seen-1789965184.wowsync.txt`, "utf8");
const VIREK_2 = readFileSync(`${dir}sanitized/virek-warband-last-seen-1789965777.wowsync.txt`, "utf8");
const EZALLER_DERIVED = readFileSync(`${dir}derived/ezaller-shared-storage-1789478317.wowsync.txt`, "utf8");

const GX = guildOwner(BIG_ID);

// --- 1. owner identity ---------------------------------------------------------------------------------

test("[SYNTHETIC] the Warband owner is an explicit INSTALLATION-LOCAL account scope, not an account id", () => {
  const owner = warbandOwner();
  assert.deepEqual(owner, { kind: "warband", version: "retail", account: { kind: "installation-local" } });
  assert.equal(ownerKey(owner), "retail::warband::local");
  // Every Warband observation is admitted under that same undifferentiated scope: two exports can never be told apart by "account".
  const admitted = admitSection(warband({ observedAt: 1000 }), carrier(1, 1010));
  assert.ok(admitted.admitted);
  assert.deepEqual(admitted.observation.owner, owner);
  const other = admitSection(warband({ observedAt: 1000 }), carrier(2, 1010, "Someone", "Elsewhere"));
  assert.ok(other.admitted);
  assert.equal(other.observation.ownerKey, admitted.observation.ownerKey);
});

test("[SYNTHETIC] the guild owner key is the opaque GuildClubID text: never numeric, never case-folded", () => {
  // Sanity: as JS numbers these two distinct ids are the SAME value, so any numeric handling would collide them.
  assert.equal(Number("18014398509481985"), Number("18014398509481984"));
  assert.notEqual(ownerKey(guildOwner("18014398509481985")), ownerKey(guildOwner("18014398509481984")));
  assert.equal(ownerKey(guildOwner("18014398509481985")), "retail::guild::18014398509481985");
  // Text that merely LOOKS like scientific notation is just text (and is not equal to its numeric expansion).
  assert.equal(ownerKey(guildOwner("1.8014398509482e+16")), "retail::guild::1.8014398509482e+16");
  assert.notEqual(ownerKey(guildOwner("1.8014398509482e+16")), ownerKey(guildOwner("18014398509482000")));
  assert.notEqual(ownerKey(guildOwner("abc")), ownerKey(guildOwner("ABC")));
  // A guild id containing the key separator cannot collide with another owner kind.
  assert.notEqual(ownerKey(guildOwner("local")), ownerKey(warbandOwner()));
});

test("[SYNTHETIC] a >2^53 and a scientific-notation-looking club id are admitted verbatim as opaque owners", () => {
  for (const id of [BIG_ID, "1.8014398509482e+16", "0018014398509481985"]) {
    const admitted = admitSection(guild({ clubId: id, observedAt: 1000, tabs: [{ id: 1, name: "T", items: [["A", 1]] }] }), carrier(1, 1010));
    assert.ok(admitted.admitted);
    assert.equal(admitted.observation.owner.kind === "guild" && admitted.observation.owner.guildClubId, id);
    assert.equal(admitted.observation.ownerKey, `retail::guild::${id}`);
  }
  // Only surrounding whitespace is normalized.
  const padded = admitSection(guild({ clubId: `  ${BIG_ID}\t`, observedAt: 1000, tabs: [{ id: 1, name: "T", items: [["A", 1]] }] }), carrier(1, 1010));
  assert.ok(padded.admitted);
  assert.equal(padded.observation.ownerKey, ownerKey(GX));
});

test("[SYNTHETIC] two guilds never collide; each has its own projection", () => {
  const journal = admitAll([
    [guild({ clubId: "111", observedAt: 1000, tabs: [{ id: 1, name: "X", items: [["Only in X", 1]] }] }), carrier(1, 1010)],
    [guild({ clubId: "222", observedAt: 2000, tabs: [{ id: 1, name: "Y", items: [["Only in Y", 1]] }] }), carrier(2, 2010)],
  ]);
  const { guilds, warband: w } = projectJournal(journal);
  assert.equal(w, undefined);
  assert.deepEqual(guilds.map((g) => g.ownerKey), ["retail::guild::111", "retail::guild::222"]);
  assert.deepEqual(guilds[0].current?.content.items.map((i) => i.name), ["Only in X"]);
  assert.deepEqual(guilds[1].current?.content.items.map((i) => i.name), ["Only in Y"]);
});

test("[DERIVED] character storage stays character-owned: [BANK] is never admitted, and only shared sections are", () => {
  const parsed = parseWowSyncExport(EZALLER_DERIVED);
  assert.equal(parsed.bank.status.state, "OBSERVED");
  assert.ok(parsed.bank.items.some((i) => i.name === "Wool Cloth"));
  const admissions = admitExport(parsed, carrier(1, 1789478317, "Ezaller", "Kel'Thuzad"));
  assert.deepEqual(admissions.map((a) => a.section), ["accountBank", "guildBank"]);
  for (const a of admissions) {
    assert.ok(a.admitted);
    assert.equal(JSON.stringify(a.observation.content).includes("Wool Cloth"), false, "the character bank's item must not appear in a shared observation");
  }
  const owner: StorageOwner = { kind: "character", identityKey: "retail::kel'thuzad::ezaller" };
  assert.equal(isSharedStorageOwner(owner), false);
  assert.equal(isSharedStorageOwner(warbandOwner()), true);
  assert.equal(isSharedStorageOwner(GX), true);
});

// --- 2. admission rules --------------------------------------------------------------------------------

test("[SYNTHETIC] UNKNOWN is never admitted: not for Warband, not for Guild, and the journal is left untouched", () => {
  const unknownWarband: AccountBankSection = { status: { state: "UNKNOWN", reason: "Not observed" }, ownerScope: "ACCOUNT_WARBAND", containers: [], itemsKnownEmpty: false, items: [] };
  const unknownGuild: GuildBankSection = { status: { state: "UNKNOWN", reason: "Not observed" }, ownerScope: "GUILD", tabs: [], containers: [], itemsKnownEmpty: false, items: [] };
  assert.deepEqual(admitSection(unknownWarband, carrier(1, 1000)), { admitted: false, section: "accountBank", reason: "unknown-state" });
  assert.deepEqual(admitSection(unknownGuild, carrier(1, 1000)), { admitted: false, section: "guildBank", reason: "unknown-state" });
  const result = recordExport(EMPTY_JOURNAL, { accountBank: unknownWarband, guildBank: unknownGuild }, carrier(1, 1000));
  assert.equal(result.journal, EMPTY_JOURNAL);
  assert.deepEqual(result.sections.map((s) => [s.section, s.outcome, s.reason]), [
    ["accountBank", "skipped", "unknown-state"],
    ["guildBank", "skipped", "unknown-state"],
  ]);
});

test("[SYNTHETIC] a guild section without a usable GuildClubID is unattributable, never guessed from the guild name", () => {
  for (const clubId of [null, "", "   "]) {
    const admission = admitSection(guild({ clubId, name: "Fixture Guild", observedAt: 1000, tabs: [{ id: 1, name: "T", items: [["A", 1]] }] }), carrier(1, 1010));
    assert.deepEqual(admission, { admitted: false, section: "guildBank", reason: "unattributable" });
  }
});

test("[SYNTHETIC] a section with no usable observation time is unanchored (it cannot be ordered), never assigned the export time", () => {
  for (const observedAt of [undefined, 0, -5, 1.5, Number.NaN]) {
    const w = warband({ observedAt: 1000 });
    w.status.observedAt = observedAt;
    assert.deepEqual(admitSection(w, carrier(1, 1010)), { admitted: false, section: "accountBank", reason: "unanchored" }, String(observedAt));
  }
});

test("[SYNTHETIC] completeness is 'complete' only when explicitly so; anything else is conservatively partial", () => {
  const kinds = new Map<string | undefined, string>();
  for (const completeness of ["complete", "partial", undefined, "COMPLETE", "mostly"]) {
    const w = warband({ observedAt: 1000 });
    w.status.completeness = completeness;
    const admission = admitSection(w, carrier(1, 1010));
    assert.ok(admission.admitted);
    kinds.set(completeness, admission.observation.completeness);
  }
  assert.deepEqual([...kinds], [["complete", "complete"], ["partial", "partial"], [undefined, "partial"], ["COMPLETE", "partial"], ["mostly", "partial"]]);
});

test("[SYNTHETIC] admission does not mutate its input (frozen sections are accepted)", () => {
  const frozen = warband({ observedAt: 1000 });
  const deepFreeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      for (const child of Object.values(v)) deepFreeze(child);
      Object.freeze(v);
    }
  };
  deepFreeze(frozen);
  assert.doesNotThrow(() => admitSection(frozen, carrier(1, 1010)));
  const g = guild({ observedAt: 1000, tabs: [{ id: 1, name: "T", items: [["A", 1]] }] });
  deepFreeze(g);
  assert.doesNotThrow(() => admitSection(g, carrier(1, 1010)));
});

test("[SYNTHETIC] an invalid carrier export time is a programming error, not a silent default", () => {
  assert.throws(() => admitSection(warband({ observedAt: 1000 }), carrier(1, 0)), TypeError);
});

// --- 3. canonical content / identity -------------------------------------------------------------------------

function idOf(section: AccountBankSection | GuildBankSection, from = carrier(1, 5000)): string {
  const a = admitSection(section, from);
  assert.ok(a.admitted);
  return a.observation.identity;
}

test("[SYNTHETIC] the content hash is independent of row order (items, tabs, containers)", () => {
  const g = guild({ observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["Alpha", 1], ["Beta", 2]] }, { id: 2, name: "B", items: [["Gamma", 3]] }] });
  const shuffled: GuildBankSection = { ...g, items: [...g.items].reverse(), tabs: [...g.tabs].reverse(), containers: [...g.containers].reverse() };
  assert.equal(idOf(g), idOf(shuffled));
});

test("[SYNTHETIC] transport-only noise never changes identity: carrier state, SnapshotVisit, visit metadata, Pending, RefreshIssue, CoverageNote, Coverage prose", () => {
  const base = guild({ observedAt: 1000, state: "OBSERVED", tabs: [{ id: 1, name: "A", items: [["Alpha", 1]] }] });
  const noisy: GuildBankSection = {
    ...base,
    coverage: "A different addon build words this differently",
    snapshotVisit: 424242,
    status: {
      ...base.status,
      state: "LAST_SEEN",
      lastVisit: 7,
      visitedNPC: "Someone Else",
      visitedZone: "Elsewhere",
      visitStatus: "Closed before capture settled",
      pending: true,
      refreshIssue: "Guild Bank query response timed out",
      coverageNote: "some note",
    },
  };
  assert.equal(idOf(noisy, carrier(99, 9000, "Other", "Realm")), idOf(base));
});

test("[SYNTHETIC] SnapshotVisit does NOT participate in identity: the same observation replayed with a different visit is still one observation, and each carrier keeps its own visit", () => {
  const first = warband({ observedAt: 1000, snapshotVisit: 990 });
  const replay = warband({ observedAt: 1000, snapshotVisit: 12345, state: "LAST_SEEN" });
  const a = admit(EMPTY_JOURNAL, first, carrier(1, 1010));
  const b = admit(a.journal, replay, carrier(2, 2000));
  assert.equal(b.outcome, "new-source");
  const projection = projectJournal(b.journal).warband!;
  assert.equal(projection.observationCount.total, 1);
  assert.deepEqual(projection.current!.sources.map((s) => s.snapshotVisit), [990, 12345]);
});

test("[SYNTHETIC] every genuinely semantic difference DOES change identity", () => {
  const base = guild({ observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["Alpha", 1]] }, { id: 2, name: "B", state: "INACCESSIBLE" }] });
  const baseId = idOf(base);
  const changed: Array<[string, GuildBankSection]> = [
    ["item qty", { ...base, items: [{ ...base.items[0], qty: 2 }] }],
    ["item name", { ...base, items: [{ ...base.items[0], name: "Alpha II" }] }],
    ["item binding", { ...base, items: [{ ...base.items[0], bound: "yes" }] }],
    ["vendor value", { ...base, items: [{ ...base.items[0], vendorEachCopper: 11 }] }],
    ["extra item", { ...base, items: [...base.items, itemRow("Extra", 1)] }],
    ["tab name", { ...base, tabs: [{ ...base.tabs[0], name: "A2" }, base.tabs[1]] }],
    ["tab state", { ...base, tabs: [base.tabs[0], { ...base.tabs[1], state: "UNKNOWN" }] }],
    ["tab viewable", { ...base, tabs: [base.tabs[0], { ...base.tabs[1], viewable: true }] }],
    ["tab note", { ...base, tabs: [{ ...base.tabs[0], note: "why" }, base.tabs[1]] }],
    ["guild name", { ...base, guildName: "Renamed Guild" }],
    ["completeness", { ...base, status: { ...base.status, completeness: "partial" } }],
    ["container free", { ...base, containers: [{ ...base.containers[0], free: 1 }] }],
    ["free slots", { ...base, freeSlots: 1 }],
    ["known-empty flag", { ...base, itemsKnownEmpty: !base.itemsKnownEmpty }],
    ["claimed time", { ...base, status: { ...base.status, observedAt: 1001 } }],
  ];
  const seen = new Set([baseId]);
  for (const [label, section] of changed) {
    const id = idOf(section);
    assert.equal(seen.has(id), false, `${label} must produce a different observation identity`);
    seen.add(id);
  }
  assert.equal(idOf(warband({ observedAt: 1000, purchasedTabs: 1 })) === idOf(warband({ observedAt: 1000, purchasedTabs: 2 })), false, "Warband purchased tabs");
  // Different owners never share an identity even with identical content and time.
  assert.notEqual(idOf(guild({ clubId: "1", observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["Alpha", 1]] }] })), idOf(guild({ clubId: "2", observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["Alpha", 1]] }] })));
});

test("[SYNTHETIC] re-capturing the SAME content later is a new observation (it confirms the state at a later time)", () => {
  const journal = admitAll([
    [warband({ observedAt: 1000 }), carrier(1, 1010)],
    [warband({ observedAt: 2000 }), carrier(2, 2010)],
  ]);
  const projection = projectJournal(journal).warband!;
  assert.equal(projection.observationCount.total, 2);
  assert.equal(projection.current!.effectiveObservedAt, 2000);
  assert.equal(projection.conflict, undefined, "identical content at different times is not a conflict");
});

// --- 4. journal: duplicates, replay, carriers, provenance -----------------------------------------------------

test("[SYNTHETIC] duplicate admission is idempotent and returns the very same journal", () => {
  const first = admit(EMPTY_JOURNAL, warband({ observedAt: 1000 }), carrier(1, 1010));
  assert.equal(first.outcome, "new-observation");
  const again = admit(first.journal, warband({ observedAt: 1000 }), carrier(1, 1010));
  assert.equal(again.outcome, "already-known");
  assert.equal(again.journal, first.journal);
});

test("[SYNTHETIC] one observation, several carrying exports: each is a source of the SAME observation", () => {
  let journal = admit(EMPTY_JOURNAL, warband({ observedAt: 1000 }), carrier(1, 1010)).journal;
  for (const [id, at] of [[2, 1500], [3, 2500]] as const) {
    const result = admit(journal, warband({ observedAt: 1000, state: "LAST_SEEN" }), carrier(id, at));
    assert.equal(result.outcome, "new-source");
    journal = result.journal;
  }
  const projection = projectJournal(journal).warband!;
  assert.equal(projection.observationCount.total, 1);
  assert.deepEqual(projection.current!.sources.map((s) => s.snapshotId), [1, 2, 3]);
});

test("[SYNTHETIC] OBSERVED and LAST_SEEN carriers of the same record resolve to ONE observation; the carrier state is provenance only", () => {
  const journal = admitAll([
    [warband({ observedAt: 1000, state: "OBSERVED" }), carrier(1, 1010)],
    [warband({ observedAt: 1000, state: "LAST_SEEN" }), carrier(2, 1900)],
  ]);
  const p = projectJournal(journal).warband!;
  assert.equal(p.observationCount.total, 1);
  assert.deepEqual(p.current!.carrierStates, ["LAST_SEEN", "OBSERVED"]);
  assert.equal(p.current!.liveAtExport, true);
  assert.equal(p.basis, "DERIVED");
});

test("[SYNTHETIC] LAST_SEEN as the FIRST Dashboard arrival is a real observation at its ORIGINAL time (not the export's)", () => {
  const journal = admitAll([[warband({ observedAt: 1000, state: "LAST_SEEN" }), carrier(1, 1900)]]);
  const p = projectJournal(journal).warband!;
  assert.equal(p.current!.effectiveObservedAt, 1000, "observed at the claimed time, not at the later export time");
  assert.equal(p.current!.liveAtExport, false, "no carrier saw it live");
  assert.deepEqual(p.current!.carrierStates, ["LAST_SEEN"]);
});

test("[SYNTHETIC] T1 observe / T2 replay / T3 replay by another character: no T2 or T3 observation is ever manufactured", () => {
  const T1 = 1000;
  const journal = admitAll([
    [warband({ observedAt: T1, state: "OBSERVED" }), carrier(1, T1 + 10, "Alpha", "Cairne")],
    [warband({ observedAt: T1, state: "LAST_SEEN" }), carrier(2, T1 + 4000, "Alpha", "Cairne")],
    [warband({ observedAt: T1, state: "LAST_SEEN" }), carrier(3, T1 + 9000, "Bravo", "Thrall")],
  ]);
  const p = projectJournal(journal).warband!;
  assert.equal(p.observationCount.total, 1);
  assert.equal(p.current!.effectiveObservedAt, T1);
  assert.equal(p.current!.sources.length, 3);
  assert.deepEqual(p.current!.sourceCharacterKeys, ["retail::cairne::alpha", "retail::thrall::bravo"]);
});

test("[SYNTHETIC] sources keep the carrying character's historical label as plain text, with no live reference (deletion-safe provenance)", () => {
  const journal = admitAll([[warband({ observedAt: 1000 }), carrier(1, 1010, "Virek", "Cairne")]]);
  const source = projectJournal(journal).warband!.current!.sources[0];
  assert.equal(source.sourceName, "Virek");
  assert.equal(source.sourceRealm, "Cairne");
  assert.equal(source.sourceIdentityKey, "retail::cairne::virek");
  assert.equal("characterId" in source, false, "a source must not depend on a character row that can be deleted");
});

// --- 5. real Virek fixtures ----------------------------------------------------------------------------------

test("[REAL] the two Virek LAST_SEEN exports are ONE Warband observation with two sources (replay never manufactures observations)", () => {
  const p1 = parseWowSyncExport(VIREK_1);
  const p2 = parseWowSyncExport(VIREK_2);
  // What the fixtures actually are: both carriers say LAST_SEEN, same observed time and visit, different export times.
  for (const p of [p1, p2]) {
    assert.equal(p.accountBank!.status.state, "LAST_SEEN");
    assert.equal(p.accountBank!.status.observedAt, 1789965174);
    assert.equal(p.accountBank!.snapshotVisit, 1789965173);
    assert.equal(p.accountBank!.items.length, 98);
    assert.equal(p.guildBank!.status.state, "UNKNOWN");
  }
  assert.equal(p1.generatedAt, 1789965184);
  assert.equal(p2.generatedAt, 1789965777);

  const c1 = carrier(1, p1.generatedAt!);
  const c2 = carrier(2, p2.generatedAt!);
  const first = recordExport(EMPTY_JOURNAL, p1, c1);
  assert.deepEqual(first.sections.map((s) => [s.section, s.outcome, s.becameCurrent]), [["accountBank", "new-observation", true], ["guildBank", "skipped", undefined]]);
  const second = recordExport(first.journal, p2, c2);
  assert.deepEqual(second.sections.map((s) => [s.section, s.outcome, s.becameCurrent]), [["accountBank", "new-source", false], ["guildBank", "skipped", undefined]]);

  const w = projectJournal(second.journal).warband!;
  assert.equal(w.observationCount.total, 1);
  assert.equal(w.current!.effectiveObservedAt, 1789965174, "the observation time, not either export time");
  assert.equal(w.current!.completeness, "complete");
  assert.deepEqual(w.current!.carrierStates, ["LAST_SEEN"]);
  assert.equal(w.current!.liveAtExport, false);
  assert.equal(w.current!.content.items.length, 98);
  assert.equal(w.current!.content.purchasedTabs, 1);
  assert.deepEqual(w.current!.coverage.observedContainerIds, [12]);
  assert.deepEqual(w.current!.sources.map((s) => [s.snapshotId, s.exportObservedAt, s.snapshotVisit, s.visitedNpc, s.sourceName]), [
    [1, 1789965184, 1789965173, "Elana", "Virek"],
    [2, 1789965777, 1789965173, "Elana", "Virek"],
  ]);
  assert.equal(projectJournal(second.journal).guilds.length, 0, "an UNKNOWN [GUILD BANK] creates no guild owner");

  // Reverse arrival order: identical projection.
  const reversed = recordExport(recordExport(EMPTY_JOURNAL, p2, c2).journal, p1, c1).journal;
  assert.equal(JSON.stringify(projectJournal(reversed)), JSON.stringify(projectJournal(second.journal)));
  // Re-importing either export again changes nothing.
  assert.equal(recordExport(second.journal, p1, c1).journal, second.journal);
});

test("[DERIVED] the real Virek observation delivered OBSERVED first and LAST_SEEN later is still one observation (only the carrier state differs)", () => {
  const liveText = VIREK_1.replace("State: LAST_SEEN; complete; observed=1789965174", "State: OBSERVED; complete; observed=1789965174");
  assert.notEqual(liveText, VIREK_1);
  const live = parseWowSyncExport(liveText);
  const replayed = parseWowSyncExport(VIREK_2);
  const journal = recordExport(recordExport(EMPTY_JOURNAL, live, carrier(1, 1789965184)).journal, replayed, carrier(2, 1789965777, "Someone", "Thrall")).journal;
  const w = projectJournal(journal).warband!;
  assert.equal(w.observationCount.total, 1);
  assert.deepEqual(w.current!.carrierStates, ["LAST_SEEN", "OBSERVED"]);
  assert.equal(w.current!.liveAtExport, true);
  assert.deepEqual(w.current!.sourceCharacterKeys, ["retail::cairne::virek", "retail::thrall::someone"]);
});

test("[REAL] the journal is independent of the character store: deleting the carrying character leaves the observation and its provenance label intact", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const imported = store.importSnapshot(VIREK_1);
    const parsed = imported.snapshot.parsed;
    const from: CarrierExport = {
      snapshotId: imported.snapshot.id,
      sourceIdentityKey: imported.character.identityKey,
      sourceName: imported.character.name,
      sourceRealm: imported.character.realm,
      exportObservedAt: snapshotObservedAt(imported.snapshot.generatedAt, imported.snapshot.importedAt),
    };
    const { journal } = recordExport(EMPTY_JOURNAL, parsed, from);
    const before = JSON.stringify(projectJournal(journal));

    assert.ok(store.deleteCharacter(imported.character.identityKey));
    assert.equal(store.getCharacter(imported.character.identityKey), undefined);

    // Character deletion is not a shared-storage operation: nothing about the journal or projection changes.
    assert.equal(JSON.stringify(projectJournal(journal)), before);
    const source = projectJournal(journal).warband!.current!.sources[0];
    assert.equal(source.sourceName, "Virek");
    assert.equal(source.sourceRealm, "Cairne");
  } finally {
    store.close();
  }
});

// --- 6. selection --------------------------------------------------------------------------------------------

test("[SYNTHETIC] a newer complete observation beats an older complete one, in either arrival order", () => {
  const older: [AccountBankSection, CarrierExport] = [warband({ observedAt: 1000, items: [["Old", 1]] }), carrier(1, 1010)];
  const newer: [AccountBankSection, CarrierExport] = [warband({ observedAt: 2000, items: [["New", 1]] }), carrier(2, 2010)];
  for (const order of [[older, newer], [newer, older]]) {
    const p = projectJournal(admitAll(order)).warband!;
    assert.deepEqual(p.current!.content.items.map((i) => i.name), ["New"]);
    assert.equal(p.observationCount.total, 2);
  }
});

test("[SYNTHETIC] an OLDER observation arriving later never becomes current", () => {
  let journal = admit(EMPTY_JOURNAL, warband({ observedAt: 5000, items: [["Fresh", 1]] }), carrier(1, 5010)).journal;
  const late = recordExport(journal, { accountBank: warband({ observedAt: 100, items: [["Ancient", 1]] }) }, carrier(2, 6000));
  assert.equal(late.sections[0].becameCurrent, false);
  journal = late.journal;
  assert.deepEqual(projectJournal(journal).warband!.current!.content.items.map((i) => i.name), ["Fresh"]);
});

test("[SYNTHETIC] UNKNOWN after OBSERVED changes nothing: prior knowledge is kept, and the journal object is untouched", () => {
  const journal = admit(EMPTY_JOURNAL, warband({ observedAt: 1000 }), carrier(1, 1010)).journal;
  const unknown: AccountBankSection = { status: { state: "UNKNOWN", reason: "Not observed" }, ownerScope: "ACCOUNT_WARBAND", containers: [], itemsKnownEmpty: false, items: [] };
  const after = recordExport(journal, { accountBank: unknown }, carrier(2, 9000));
  assert.equal(after.journal, journal);
  assert.equal(JSON.stringify(projectJournal(after.journal)), JSON.stringify(projectJournal(journal)));
  assert.equal(projectJournal(after.journal).warband!.current!.effectiveObservedAt, 1000);
});

test("[SYNTHETIC] a newer PARTIAL never displaces an older complete one; it is exposed separately and never merged", () => {
  const journal = admitAll([
    [guild({ observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["Complete item", 1]] }] }), carrier(1, 1010)],
    [guild({ observedAt: 3000, completeness: "partial", tabs: [{ id: 1, name: "A", items: [["Partial item", 1]] }, { id: 2, name: "B", state: "UNKNOWN" }] }), carrier(2, 3010)],
  ]);
  const p = projectJournal(journal).guilds[0];
  assert.equal(p.current!.completeness, "complete");
  assert.deepEqual(p.current!.content.items.map((i) => i.name), ["Complete item"]);
  assert.equal(p.latestPartial!.completeness, "partial");
  assert.equal(p.latestPartial!.effectiveObservedAt, 3000);
  assert.deepEqual(p.latestPartial!.content.items.map((i) => i.name), ["Partial item"]);
  assert.deepEqual(p.latestPartial!.coverage.unconfirmedTabs, [2], "the partial's own unconfirmed tab is preserved as unconfirmed");
});

test("[SYNTHETIC] a partial OLDER than the complete is not reported as 'latest partial'", () => {
  const journal = admitAll([
    [guild({ observedAt: 1000, completeness: "partial", tabs: [{ id: 1, name: "A", items: [["P", 1]] }] }), carrier(1, 1010)],
    [guild({ observedAt: 2000, tabs: [{ id: 1, name: "A", items: [["C", 1]] }] }), carrier(2, 2010)],
  ]);
  const p = projectJournal(journal).guilds[0];
  assert.equal(p.current!.completeness, "complete");
  assert.equal(p.latestPartial, undefined);
});

test("[SYNTHETIC] with no complete observation, the newest partial is current and is labelled partial", () => {
  const journal = admitAll([
    [guild({ observedAt: 1000, completeness: "partial", tabs: [{ id: 1, name: "A", items: [["Older", 1]] }] }), carrier(1, 1010)],
    [guild({ observedAt: 2000, completeness: "partial", tabs: [{ id: 1, name: "A", items: [["Newer", 1]] }] }), carrier(2, 2010)],
  ]);
  const p = projectJournal(journal).guilds[0];
  assert.equal(p.current!.completeness, "partial");
  assert.deepEqual(p.current!.content.items.map((i) => i.name), ["Newer"]);
  assert.equal(p.latestPartial, undefined, "no complete `current` to be newer than");
});

test("[SYNTHETIC] an informationless 'complete' capture (every tab inaccessible) never erases a useful older observation", () => {
  const journal = admitAll([
    [guild({ observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["Useful", 1]] }] }), carrier(1, 1010)],
    [guild({ observedAt: 5000, tabs: [{ id: 1, name: "A", state: "INACCESSIBLE" }, { id: 2, name: "B", state: "INACCESSIBLE" }] }), carrier(2, 5010)],
  ]);
  const p = projectJournal(journal).guilds[0];
  assert.equal(p.current!.effectiveObservedAt, 1000);
  assert.deepEqual(p.current!.content.items.map((i) => i.name), ["Useful"]);
  assert.deepEqual(p.observationCount, { total: 2, complete: 2, partial: 0, informationless: 1 });
});

test("[SYNTHETIC] when only informationless observations exist there is NO current state (unknown, not empty)", () => {
  const journal = admitAll([[guild({ observedAt: 1000, tabs: [{ id: 1, name: "A", state: "INACCESSIBLE" }] }), carrier(1, 1010)]]);
  const p = projectJournal(journal).guilds[0];
  assert.equal(p.current, undefined);
  assert.equal(p.observationCount.informationless, 1);
});

test("[SYNTHETIC] a genuinely empty observed tab IS informative (known empty is evidence; inaccessible is not)", () => {
  const journal = admitAll([[guild({ observedAt: 1000, tabs: [{ id: 1, name: "Empty Tab" }] }), carrier(1, 1010)]]);
  const p = projectJournal(journal).guilds[0];
  assert.ok(p.current);
  assert.equal(p.current!.content.itemsKnownEmpty, true);
  assert.deepEqual(p.current!.coverage.observedTabs, [1]);
});

// --- 7. time: ties, conflicts, clamping ----------------------------------------------------------------------

test("[SYNTHETIC] same timestamp AND same content from two carriers is one observation, not a conflict", () => {
  const journal = admitAll([
    [warband({ observedAt: 1000 }), carrier(1, 1010, "A", "Cairne")],
    [warband({ observedAt: 1000 }), carrier(2, 1020, "B", "Thrall")],
  ]);
  const p = projectJournal(journal).warband!;
  assert.equal(p.observationCount.total, 1);
  assert.equal(p.conflict, undefined);
  assert.equal(p.current!.sources.length, 2);
});

test("[SYNTHETIC] same timestamp with DIFFERENT content is a reported conflict; the winner is a fixed content rule, not arrival order", () => {
  const a: [AccountBankSection, CarrierExport] = [warband({ observedAt: 1000, items: [["Alpha", 1]] }), carrier(1, 1010, "A")];
  const b: [AccountBankSection, CarrierExport] = [warband({ observedAt: 1000, items: [["Beta", 1]] }), carrier(2, 1010, "B")];
  const forward = projectJournal(admitAll([a, b])).warband!;
  const backward = projectJournal(admitAll([b, a])).warband!;
  assert.equal(forward.conflict!.effectiveObservedAt, 1000);
  assert.equal(forward.conflict!.others.length, 1);
  assert.equal(forward.current!.contentHash, backward.current!.contentHash);
  assert.equal(JSON.stringify(forward), JSON.stringify(backward));
  // Winner is the smaller content hash: verify against the rule directly.
  const hashes = [forward.current!.contentHash, forward.conflict!.others[0].contentHash];
  assert.equal(forward.current!.contentHash, [...hashes].sort()[0]);
});

test("[SYNTHETIC] an observation claimed AFTER its carrying export is clamped to that export's time, and later exports cannot raise it", () => {
  const claimedFuture = warband({ observedAt: 9000, items: [["Future claim", 1]] });
  let journal = admit(EMPTY_JOURNAL, claimedFuture, carrier(1, 1500)).journal;
  let p = projectJournal(journal).warband!;
  assert.equal(p.current!.claimedObservedAt, 9000);
  assert.equal(p.current!.effectiveObservedAt, 1500);
  assert.equal(p.current!.claimedAfterCarrier, true);
  // A later replay from an export made at 20000 cannot lift it: min() over every carrier.
  journal = admit(journal, warband({ observedAt: 9000, items: [["Future claim", 1]], state: "LAST_SEEN" }), carrier(2, 20000)).journal;
  p = projectJournal(journal).warband!;
  assert.equal(p.current!.effectiveObservedAt, 1500);
  // ...and it does not outrank a genuinely newer observation.
  journal = admit(journal, warband({ observedAt: 1800, items: [["Real newer", 1]] }), carrier(3, 1810)).journal;
  assert.deepEqual(projectJournal(journal).warband!.current!.content.items.map((i) => i.name), ["Real newer"]);
});

test("[SYNTHETIC] two observations clamped to the same effective time with the same content are not a conflict; the later CLAIM is preferred deterministically", () => {
  const journal = admitAll([
    [warband({ observedAt: 7000 }), carrier(1, 1500)],
    [warband({ observedAt: 8000 }), carrier(2, 1500)],
  ]);
  const p = projectJournal(journal).warband!;
  assert.equal(p.observationCount.total, 2);
  assert.equal(p.conflict, undefined);
  assert.equal(p.current!.claimedObservedAt, 8000);
});

// --- 8. Guild: coverage, permissions, renames, membership ---------------------------------------------------

const ALL_TABS: TabSpec[] = [
  { id: 1, name: "Materials", items: [["Linen Cloth", 40]] },
  { id: 2, name: "Consumables", items: [["Health Potion", 10]] },
  { id: 3, name: "Officers", items: [["Officer Sword", 1]] },
  { id: 4, name: "Raid", items: [["Raid Flask", 20]] },
];
const NARROW_TABS: TabSpec[] = [
  { id: 1, name: "Materials", items: [["Linen Cloth", 45]] },
  { id: 2, name: "Consumables", items: [["Health Potion", 10]] },
  { id: 3, name: "Officers", state: "INACCESSIBLE" },
  { id: 4, name: "Raid", state: "INACCESSIBLE" },
];

test("[SYNTHETIC] narrower LATER guild permissions: the newer observation stays current; the earlier broader one is exposed separately and NOT spliced in", () => {
  const journal = admitAll([
    [guild({ observedAt: 1000, tabs: ALL_TABS }), carrier(1, 1010, "Officer", "Cairne")],
    [guild({ observedAt: 2000, tabs: NARROW_TABS }), carrier(2, 2010, "Member", "Cairne")],
  ]);
  const p = projectJournal(journal).guilds[0];

  assert.equal(p.basis, "DERIVED");
  assert.equal(p.current!.effectiveObservedAt, 2000);
  assert.deepEqual(p.current!.coverage.observedTabs, [1, 2]);
  assert.deepEqual(p.current!.coverage.inaccessibleTabs, [3, 4]);
  // Nothing from the broader observation is spliced into the current one.
  const names = p.current!.content.items.map((i) => i.name);
  assert.deepEqual(names.sort(), ["Health Potion", "Linen Cloth"]);
  assert.equal(names.includes("Officer Sword"), false);
  assert.equal(names.includes("Raid Flask"), false);
  assert.equal(p.current!.content.items.find((i) => i.name === "Linen Cloth")!.qty, 45, "the newer observation's own quantity, not the older 40");
  // The broader observation stays intact, with its own time and coverage.
  assert.equal(p.broaderCoverageEarlier!.effectiveObservedAt, 1000);
  assert.deepEqual(p.broaderCoverageEarlier!.coverage.observedTabs, [1, 2, 3, 4]);
  assert.equal(p.broaderCoverageEarlier!.content.items.find((i) => i.name === "Officer Sword")!.qty, 1);
  // The current observation is exactly what the narrower carrier observed (its hash equals a fresh admission of that section).
  const fresh = admitSection(guild({ observedAt: 2000, tabs: NARROW_TABS }), carrier(9, 9999));
  assert.ok(fresh.admitted);
  assert.equal(p.current!.contentHash, fresh.observation.contentHash);
});

test("[SYNTHETIC] broaderCoverageEarlier: none when the older observation is not strictly broader, when it is partial, or when the newer one grew a tab", () => {
  const cases: Array<[string, TabSpec[], string | undefined, TabSpec[]]> = [
    ["equal coverage", ALL_TABS, undefined, ALL_TABS],
    ["older narrower than newer", NARROW_TABS, undefined, ALL_TABS],
    // A guild purchased tab 5 after the older observation: the older one is not "broader" - it never knew that tab.
    ["newer bought another tab", ALL_TABS, undefined, [...ALL_TABS, { id: 5, name: "New", items: [["Fresh", 1]] }]],
    ["older broader but PARTIAL", ALL_TABS, "partial", NARROW_TABS],
  ];
  for (const [label, olderTabs, olderCompleteness, newerTabs] of cases) {
    const journal = admitAll([
      [guild({ observedAt: 1000, tabs: olderTabs, completeness: olderCompleteness }), carrier(1, 1010)],
      [guild({ observedAt: 2000, tabs: newerTabs }), carrier(2, 2010)],
    ]);
    assert.equal(projectJournal(journal).guilds[0].broaderCoverageEarlier, undefined, label);
  }
});

test("[SYNTHETIC] broaderCoverageEarlier is the NEWEST strictly-broader complete observation", () => {
  const journal = admitAll([
    [guild({ observedAt: 1000, tabs: ALL_TABS }), carrier(1, 1010)],
    [guild({ observedAt: 1500, tabs: ALL_TABS.slice(0, 3) }), carrier(2, 1510)],
    [guild({ observedAt: 2000, tabs: NARROW_TABS }), carrier(3, 2010)],
  ]);
  const p = projectJournal(journal).guilds[0];
  assert.equal(p.broaderCoverageEarlier!.effectiveObservedAt, 1500);
});

test("[SYNTHETIC] coverage distinguishes observed / inaccessible / unconfirmed tabs, and never treats inaccessible as empty", () => {
  const journal = admitAll([
    [guild({ observedAt: 1000, completeness: "partial", tabs: [{ id: 1, name: "A", items: [["X", 1]] }, { id: 2, name: "B", state: "UNKNOWN" }, { id: 3, name: "C", state: "INACCESSIBLE" }] }), carrier(1, 1010)],
  ]);
  const c = projectJournal(journal).guilds[0].current!.coverage;
  assert.deepEqual([c.observedTabs, c.unconfirmedTabs, c.inaccessibleTabs], [[1], [2], [3]]);
  assert.equal(projectJournal(journal).guilds[0].current!.content.itemsKnownEmpty, false);
});

test("[SYNTHETIC] a guild rename is display data: one owner, both observations kept, the newest name shown", () => {
  const journal = admitAll([
    [guild({ name: "Old Name", observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["X", 1]] }] }), carrier(1, 1010)],
    [guild({ name: "New Name", observedAt: 2000, tabs: [{ id: 1, name: "A", items: [["X", 1]] }] }), carrier(2, 2010)],
  ]);
  const { guilds } = projectJournal(journal);
  assert.equal(guilds.length, 1);
  assert.equal(guilds[0].current!.content.guildName, "New Name");
  assert.equal(guilds[0].observationCount.total, 2);
  assert.equal(guilds[0].conflict, undefined);
});

test("[SYNTHETIC] a tab rename is a new observation; the newest tab names are current and nothing conflicts", () => {
  const journal = admitAll([
    [guild({ observedAt: 1000, tabs: [{ id: 1, name: "Materials", items: [["X", 1]] }] }), carrier(1, 1010)],
    [guild({ observedAt: 2000, tabs: [{ id: 1, name: "Mats (renamed)", items: [["X", 1]] }] }), carrier(2, 2010)],
  ]);
  const p = projectJournal(journal).guilds[0];
  assert.equal(p.current!.content.tabs[0].name, "Mats (renamed)");
  assert.equal(p.observationCount.total, 2);
  assert.equal(p.conflict, undefined);
});

test("[SYNTHETIC] a tab rename observed at the SAME second as different content is reported as a conflict, not silently resolved", () => {
  const journal = admitAll([
    [guild({ observedAt: 1000, tabs: [{ id: 1, name: "Materials", items: [["X", 1]] }] }), carrier(1, 1010, "A")],
    [guild({ observedAt: 1000, tabs: [{ id: 1, name: "Renamed", items: [["X", 1]] }] }), carrier(2, 1010, "B")],
  ]);
  assert.ok(projectJournal(journal).guilds[0].conflict);
});

test("[SYNTHETIC] two characters in the same guild reconcile into ONE owner: same observation collapses, a newer one wins, provenance lists both", () => {
  const same = admitAll([
    [guild({ observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["X", 1]] }] }), carrier(1, 1010, "Alpha", "Cairne")],
    [guild({ observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["X", 1]] }], state: "LAST_SEEN" }), carrier(2, 4000, "Bravo", "Thrall")],
  ]);
  const p1 = projectJournal(same);
  assert.equal(p1.guilds.length, 1);
  assert.equal(p1.guilds[0].observationCount.total, 1);
  assert.deepEqual(p1.guilds[0].current!.sourceCharacterKeys, ["retail::cairne::alpha", "retail::thrall::bravo"]);

  const newer = admit(same, guild({ observedAt: 3000, tabs: [{ id: 1, name: "A", items: [["X", 9]] }] }), carrier(3, 3010, "Bravo", "Thrall")).journal;
  const p2 = projectJournal(newer).guilds[0];
  assert.equal(p2.current!.content.items[0].qty, 9);
  assert.deepEqual(p2.current!.sourceCharacterKeys, ["retail::thrall::bravo"]);
  assert.equal(p2.observationCount.total, 2);
});

test("[SYNTHETIC] a character changing guilds does not mutate the prior guild's owner state, and leaving a guild (UNKNOWN later) erases nothing", () => {
  const inX = guild({ clubId: "111", name: "Guild X", observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["X item", 3]] }] });
  const inY = guild({ clubId: "222", name: "Guild Y", observedAt: 2000, tabs: [{ id: 1, name: "A", items: [["Y item", 4]] }] });
  const left: GuildBankSection = { status: { state: "UNKNOWN", reason: "Not observed" }, ownerScope: "GUILD", tabs: [], containers: [], itemsKnownEmpty: false, items: [] };

  const afterX = admit(EMPTY_JOURNAL, inX, carrier(1, 1010)).journal;
  const xBefore = JSON.stringify(projectOwnerFromJournal(afterX, guildOwner("111")));

  const afterY = admit(afterX, inY, carrier(2, 2010)).journal; // same character, now in guild Y
  assert.equal(JSON.stringify(projectOwnerFromJournal(afterY, guildOwner("111"))), xBefore, "guild X is untouched by the character's move to Y");
  assert.deepEqual(projectOwnerFromJournal(afterY, guildOwner("222"))!.current!.content.items.map((i) => i.name), ["Y item"]);

  const afterLeaving = recordExport(afterY, { guildBank: left }, carrier(3, 3010)).journal; // same character, in no guild
  assert.equal(afterLeaving, afterY);
  assert.equal(JSON.stringify(projectOwnerFromJournal(afterLeaving, guildOwner("111"))), xBefore);
});

test("[SYNTHETIC] Warband and guilds are independent owners in one journal", () => {
  const journal = admitAll([
    [warband({ observedAt: 1000 }), carrier(1, 1010)],
    [guild({ clubId: "111", observedAt: 1000, tabs: [{ id: 1, name: "A", items: [["X", 1]] }] }), carrier(1, 1010)],
  ]);
  const projection = projectJournal(journal);
  assert.equal(projection.warband!.ownerKey, "retail::warband::local");
  assert.deepEqual(projection.guilds.map((g) => g.ownerKey), ["retail::guild::111"]);
});

// --- 9. becameCurrent -----------------------------------------------------------------------------------------

test("[SYNTHETIC] recordExport reports whether an admission made the observation the owner's current one", () => {
  let journal = EMPTY_JOURNAL;
  const steps: Array<[number, boolean]> = [[1000, true], [3000, true], [2000, false], [3000, false]];
  for (const [i, [observedAt, expected]] of steps.entries()) {
    const result = recordExport(journal, { accountBank: warband({ observedAt, items: [[`Item ${observedAt}`, 1]] }) }, carrier(i + 1, 4000 + i));
    assert.equal(result.sections[0].becameCurrent, expected, `step ${i}`);
    journal = result.journal;
  }
});

// --- 10. no side effects on existing behavior ------------------------------------------------------------------

test("[REAL] running shared-storage reconciliation changes nothing observable elsewhere: facts, context, LLM context and item aggregates exclude shared storage", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(VIREK_1);
    store.importSnapshot(VIREK_2);
    store.importSnapshot(EZALLER_DERIVED);
    const NOW = 1789990000;
    const snapshotOfWorld = () =>
      JSON.stringify({
        facts: store.buildAccountFacts("retail", NOW),
        context: store.buildAccountContext(NOW),
        llm: buildLlmContext(store.buildAccountContext(NOW)),
        versions: store.listVersions(),
      });
    const before = snapshotOfWorld();

    // Run the whole journal pipeline over every stored snapshot of every retail character.
    let journal = EMPTY_JOURNAL;
    for (const character of store.listCharacters("retail")) {
      for (const snapshot of store.listSnapshots(character.identityKey)) {
        journal = recordExport(journal, snapshot.parsed, {
          snapshotId: snapshot.id,
          sourceIdentityKey: character.identityKey,
          sourceName: character.name,
          sourceRealm: character.realm,
          exportObservedAt: snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt),
        }).journal;
      }
    }
    assert.ok(projectJournal(journal).warband, "the pipeline did run over real Warband data");
    assert.equal(projectJournal(journal).guilds.length, 1, "and over the derived guild");

    const after = snapshotOfWorld();
    assert.equal(after, before, "no existing projection depends on, or is altered by, the shared-storage module");
    for (const shared of ["Light Leather", "Ghost Iron Ore", "Silkweed", "Linen Cloth", "Copper Ore", "Netherweave Cloth", "Fixture Guild", BIG_ID]) {
      assert.equal(after.includes(shared), false, `${shared} (shared storage) must not reach facts / AccountContext / LlmContext`);
    }
    // Diffs ignore shared storage as well.
    assert.equal(store.recentChanges("retail").some((c) => c.diff.bankItems.length > 0 && c.characterName === "Virek"), false);
  } finally {
    store.close();
  }
});
