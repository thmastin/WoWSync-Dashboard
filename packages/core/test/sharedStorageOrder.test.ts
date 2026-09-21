// Shared-storage reconciliation: import-ORDER independence (checkpoint C1).
//
// The projection is a pure function of the SET of admitted (observation, source) pairs, so
// no arrival order, duplicate delivery, or interleaved UNKNOWN export may change it. This
// file proves that exhaustively for two 7-export corpora (every one of the 5,040 orders each)
// and by seeded random shuffles (with duplicates and skipped exports mixed in) for a larger
// mixed corpus. The corpora deliberately contain the hard cases: replays from several
// carriers, a partial newer than a complete, a clamped future claim, an informationless
// capture, a same-second conflict, narrower-later guild permissions, and two guilds.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_JOURNAL,
  addToJournal,
  admitSection,
  projectJournal,
  recordExport,
  type CarrierExport,
  type SharedJournal,
} from "../src/sharedStorage.ts";
import type { AccountBankSection, GuildBankSection } from "../src/types.ts";
import { carrier, guild, warband, type TabSpec } from "./sharedStorageBuilders.ts";

type Section = AccountBankSection | GuildBankSection;
type Delivery = readonly [Section, CarrierExport];

const ALL_TABS: TabSpec[] = [
  { id: 1, name: "Materials", items: [["Linen Cloth", 40]] },
  { id: 2, name: "Consumables", items: [["Health Potion", 10]] },
  { id: 3, name: "Officers", items: [["Officer Sword", 1]] },
  { id: 4, name: "Raid", items: [["Raid Flask", 20]] },
];
const NARROW = (qty: number): TabSpec[] => [
  { id: 1, name: "Materials", items: [["Linen Cloth", qty]] },
  { id: 2, name: "Consumables", items: [["Health Potion", 10]] },
  { id: 3, name: "Officers", state: "INACCESSIBLE" },
  { id: 4, name: "Raid", state: "INACCESSIBLE" },
];

const unknownWarband: AccountBankSection = { status: { state: "UNKNOWN", reason: "Not observed" }, ownerScope: "ACCOUNT_WARBAND", containers: [], itemsKnownEmpty: false, items: [] };
const unknownGuild: GuildBankSection = { status: { state: "UNKNOWN", reason: "Not observed" }, ownerScope: "GUILD", tabs: [], containers: [], itemsKnownEmpty: false, items: [] };

// --- corpora -------------------------------------------------------------------------------------

const A = (id: number, at: number) => carrier(id, at, "Alpha", "Cairne");
const B = (id: number, at: number) => carrier(id, at, "Bravo", "Thrall");
const C = (id: number, at: number) => carrier(id, at, "Charlie", "Cairne");

/** Warband: an observation delivered live and twice as replays, a newer one, a newer partial, and a duplicate. */
const WARBAND_CORPUS: Delivery[] = [
  [warband({ observedAt: 1000, state: "OBSERVED", items: [["Old stock", 1]] }), A(1, 1010)],
  [warband({ observedAt: 1000, state: "LAST_SEEN", items: [["Old stock", 1]], snapshotVisit: 5, status: { refreshIssue: "timed out" } }), A(2, 1500)],
  [warband({ observedAt: 1000, state: "LAST_SEEN", items: [["Old stock", 1]] }), B(3, 2000)],
  [warband({ observedAt: 1800, items: [["New stock", 2]] }), B(4, 1810)],
  [warband({ observedAt: 2500, completeness: "partial", items: [["Partial stock", 3]] }), A(5, 2510)],
  [unknownWarband, C(6, 3000)],
  [warband({ observedAt: 1000, state: "LAST_SEEN", items: [["Old stock", 1]] }), B(3, 2000)], // exact duplicate of delivery 3
];

/** Guild X: wide permissions, then narrower ones (two carriers, same second, different content), a future claim, an informationless capture, an unattributable one, a duplicate. */
const GUILD_CORPUS: Delivery[] = [
  [guild({ observedAt: 1100, tabs: ALL_TABS }), A(1, 1110)],
  [guild({ observedAt: 2200, tabs: NARROW(45) }), B(2, 2210)],
  [guild({ observedAt: 2200, tabs: NARROW(46) }), C(3, 2215)], // same second, different content: a conflict
  [guild({ observedAt: 9000, tabs: NARROW(99) }), B(4, 2150)], // claimed after its own export: clamped to 2150
  [guild({ observedAt: 2600, tabs: [{ id: 1, name: "Materials", state: "INACCESSIBLE" }, { id: 2, name: "Consumables", state: "INACCESSIBLE" }] }), B(5, 2610)],
  [guild({ clubId: null, observedAt: 2400, tabs: NARROW(1) }), A(6, 2410)], // no club id: skipped
  [guild({ observedAt: 1100, tabs: ALL_TABS }), A(1, 1110)], // exact duplicate of delivery 1
];

/** Everything at once, plus a second guild and an UNKNOWN guild. */
const MIXED_CORPUS: Delivery[] = [
  ...WARBAND_CORPUS,
  ...GUILD_CORPUS.map(([section, from]) => [section, { ...from, snapshotId: from.snapshotId + 100 }] as const),
  [guild({ clubId: "222", name: "Other Guild", observedAt: 1300, tabs: [{ id: 1, name: "Bank", items: [["Other item", 1]] }] }), A(201, 1310)],
  [guild({ clubId: "222", name: "Other Guild", observedAt: 1300, tabs: [{ id: 1, name: "Bank", items: [["Other item", 1]] }], state: "LAST_SEEN" }), B(202, 5000)],
  [unknownGuild, C(203, 6000)],
];

// --- machinery ----------------------------------------------------------------------------------

/** Deliver one export section the way the importer will: skipped sections change nothing. */
function deliver(journal: SharedJournal, [section, from]: Delivery): SharedJournal {
  const key = section.ownerScope === "GUILD" ? "guildBank" : "accountBank";
  return recordExport(journal, { [key]: section }, from).journal;
}

function project(order: readonly Delivery[]): string {
  return JSON.stringify(projectJournal(order.reduce(deliver, EMPTY_JOURNAL)));
}

/** Heap's algorithm: every permutation of `items`. */
function* permutations<T>(items: readonly T[]): Generator<T[]> {
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

/** A small deterministic PRNG (mulberry32) so the shuffle test is reproducible. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- the corpora produce non-trivial answers (so agreement below is not vacuous) --------------------

test("[SYNTHETIC] the Warband corpus resolves as expected: the newer complete is current, the newer partial is exposed, replays add sources only", () => {
  const journal = WARBAND_CORPUS.reduce(deliver, EMPTY_JOURNAL);
  const w = projectJournal(journal).warband!;
  assert.deepEqual(w.current!.content.items.map((i) => i.name), ["New stock"]);
  assert.deepEqual(w.latestPartial!.content.items.map((i) => i.name), ["Partial stock"]);
  assert.deepEqual(w.observationCount, { total: 3, complete: 2, partial: 1, informationless: 0 });
  assert.equal(w.conflict, undefined);
});

test("[SYNTHETIC] the guild corpus resolves as expected: a conflict at the newest usable second, the wide earlier observation exposed, clamped and informationless captures inert", () => {
  const journal = GUILD_CORPUS.reduce(deliver, EMPTY_JOURNAL);
  const { guilds } = projectJournal(journal);
  assert.equal(guilds.length, 1);
  const g = guilds[0];
  assert.equal(g.current!.effectiveObservedAt, 2200);
  assert.equal(g.conflict!.others.length, 1);
  assert.deepEqual(g.broaderCoverageEarlier!.coverage.observedTabs, [1, 2, 3, 4]);
  assert.equal(g.observationCount.informationless, 1);
  assert.equal(g.observationCount.total, 5, "wide + two same-second + clamped future + informationless (the unattributable one is not journaled)");
});

// --- exhaustive orders --------------------------------------------------------------------------

for (const [label, corpus] of [["Warband", WARBAND_CORPUS], ["Guild", GUILD_CORPUS]] as const) {
  test(`[SYNTHETIC] ${label} corpus: all ${corpus.length}! = 5,040 arrival orders produce a byte-identical projection`, () => {
    const reference = project(corpus);
    let count = 0;
    for (const order of permutations(corpus)) {
      count++;
      assert.equal(project(order), reference, `order ${count} diverged`);
    }
    assert.equal(count, 5040);
  });
}

// --- randomized orders over the mixed corpus ----------------------------------------------------

test("[SYNTHETIC] mixed corpus: 500 seeded random arrival orders (including every delivery repeated) produce an identical projection", () => {
  const reference = project(MIXED_CORPUS);
  const random = rng(20260921);
  for (let run = 0; run < 500; run++) {
    // Every delivery appears once, plus a random subset appears again (duplicate delivery).
    const repeats = MIXED_CORPUS.filter(() => random() < 0.5);
    const order = shuffled([...MIXED_CORPUS, ...repeats], random);
    assert.equal(project(order), reference, `run ${run} diverged`);
  }
});

test("[SYNTHETIC] UNKNOWN exports interleaved anywhere never change the projection", () => {
  const reference = project(MIXED_CORPUS);
  const random = rng(7);
  for (let run = 0; run < 100; run++) {
    const noise: Delivery[] = [
      [unknownWarband, A(300 + run, 7000)],
      [unknownGuild, B(400 + run, 7000)],
    ];
    assert.equal(project(shuffled([...MIXED_CORPUS, ...noise], random)), reference);
  }
});

// --- idempotence / independence -----------------------------------------------------------------

test("[SYNTHETIC] re-delivering the whole corpus a second time is a no-op on the journal itself", () => {
  const once = MIXED_CORPUS.reduce(deliver, EMPTY_JOURNAL);
  const twice = MIXED_CORPUS.reduce(deliver, once);
  assert.equal(twice, once, "every second delivery is 'already-known', so the very same journal object comes back");
});

test("[SYNTHETIC] owners are independent: removing every delivery of one owner leaves every other owner's projection unchanged", () => {
  const full = projectJournal(MIXED_CORPUS.reduce(deliver, EMPTY_JOURNAL));
  const withoutOther = MIXED_CORPUS.filter(([section]) => !(section.ownerScope === "GUILD" && section.guildClubId === "222"));
  const partial = projectJournal(withoutOther.reduce(deliver, EMPTY_JOURNAL));
  assert.equal(partial.guilds.some((g) => g.ownerKey === "retail::guild::222"), false);
  assert.equal(JSON.stringify(partial.warband), JSON.stringify(full.warband));
  const idOf = (p: typeof full) => p.guilds.filter((g) => g.ownerKey !== "retail::guild::222").map((g) => JSON.stringify(g));
  assert.deepEqual(idOf(partial), idOf(full));
});

test("[SYNTHETIC] the same admission recorded through addToJournal directly and through recordExport agree", () => {
  const direct = WARBAND_CORPUS.reduce<SharedJournal>((journal, [section, from]) => {
    const admission = admitSection(section, from);
    return admission.admitted ? addToJournal(journal, admission.observation, admission.source).journal : journal;
  }, EMPTY_JOURNAL);
  assert.equal(JSON.stringify(projectJournal(direct)), project(WARBAND_CORPUS));
});
