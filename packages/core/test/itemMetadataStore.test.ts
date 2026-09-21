// Item metadata persistence and reconciliation: a separate, game-version-scoped evidence store. KNOWN may fill
// UNKNOWN, UNKNOWN never overwrites known, identical values replay cleanly in any order, and conflicting KNOWN values are
// exposed as a conflict - never resolved by "latest wins". Metadata is enrichment: it never changes a snapshot, a
// shared-storage observation, or any hash, and never disappears when a character is deleted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { itemIdFromItemRef } from "../src/itemMetadata.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { renderBags, renderExport, type MetadataRowSpec } from "./sharedStorageExports.ts";
import { guild, warband } from "./sharedStorageBuilders.ts";
import { withHarness } from "./sharedStorageHarness.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");

const MOTE_OF_LIGHT_REF = "item:236949::::::::85:253:::::::::";
const MOTE: MetadataRowSpec = { id: 236949, classId: 7, subclassId: 11, bindType: 0, expansionId: 11, reagent: true };
const T0 = 1_790_000_000;

const bagsWith = (...rows: Array<[string, string, number]>) => ({
  status: { state: "OBSERVED" as const, completeness: "complete", observedAt: T0 },
  containers: [{ id: 0, capacity: 16, free: 16 - rows.length, family: "0", bagRef: "-" }],
  freeSlots: 16 - rows.length,
  totalSlots: 16,
  itemsKnownEmpty: false,
  items: rows.map(([itemRef, name, qty]) => ({ itemRef, name, qty, bound: "no", vendorEachCopper: 2000 })),
});

const view = (store: SqliteSnapshotStore, id: number, version: "retail" | "classic-era" = "retail") => store.listItemMetadata(version).find((v) => v.baseItemId === id);

test("importing an export with [ITEM METADATA] records game-client evidence; Mote of Light resolves as a Midnight crafting reagent", () => {
  withHarness((h) => {
    h.imp({ name: "Virek", generated: T0, itemMetadata: [MOTE] });
    const mote = view(h.store, 236949)!;
    assert.deepEqual(mote.classId, { state: "KNOWN", value: 7, sources: ["game-client"] });
    assert.deepEqual(mote.subclassId, { state: "KNOWN", value: 11, sources: ["game-client"] });
    assert.deepEqual(mote.bindType, { state: "KNOWN", value: 0, sources: ["game-client"] });
    assert.deepEqual(mote.expansionId, { state: "KNOWN", value: 11, sources: ["game-client"] });
    assert.deepEqual(mote.craftingReagent, { state: "KNOWN", value: true, sources: ["game-client"] });
    assert.equal(mote.expansion.state, "KNOWN");
    assert.equal(mote.expansion.text, "Midnight");
    // provenance is stored, keyed by the game version the export's client established
    const evidence = h.store.loadItemEvidence("retail");
    assert.equal(evidence.length, 5);
    assert.ok(evidence.every((e) => e.gameVersion === "retail" && e.source === "game-client" && e.firstSeenAt === T0 && e.lastSeenAt === T0));
    assert.ok(evidence.every((e) => e.clientBuilds.length === 1 && e.clientBuilds[0] === "69875"));
  });
});

test("an item with no evidence is simply absent: every facet is UNKNOWN, never empty / 0 / false", () => {
  withHarness((h) => {
    h.imp({ name: "Virek", generated: T0, itemMetadata: [MOTE] });
    assert.equal(view(h.store, 999999), undefined);
    assert.deepEqual(h.store.listItemMetadata("classic-era"), []);
    assert.deepEqual(h.store.listItemMetadata("unknown-version"), []);
  });
});

test("an export without the section (a legacy export) records nothing and behaves exactly as before", () => {
  withHarness((h) => {
    h.imp({ name: "Virek", generated: T0 });
    assert.deepEqual(h.store.listItemMetadata("retail"), []);
    assert.deepEqual(h.store.loadItemEvidence("retail"), []);
    assert.equal(Number((h.raw.prepare("SELECT COUNT(*) AS n FROM item_metadata_evidence").get() as { n: number }).n), 0);
  });
});

test("an all-UNKNOWN row stores nothing (UNKNOWN is absence of evidence, not a value)", () => {
  withHarness((h) => {
    h.imp({ name: "Virek", generated: T0, itemMetadata: [{ id: 236949 }, { id: 5 }] });
    assert.deepEqual(h.store.loadItemEvidence("retail"), []);
    assert.deepEqual(h.store.listItemMetadata("retail"), []);
  });
});

test("0 and 'no' are stored as KNOWN values, distinct from UNKNOWN", () => {
  withHarness((h) => {
    h.imp({ name: "Virek", generated: T0, itemMetadata: [{ id: 202071, classId: 15, subclassId: 0, bindType: 0, expansionId: 9, reagent: false }] });
    const elemental = view(h.store, 202071)!;
    assert.deepEqual(elemental.subclassId, { state: "KNOWN", value: 0, sources: ["game-client"] });
    assert.deepEqual(elemental.bindType, { state: "KNOWN", value: 0, sources: ["game-client"] });
    assert.deepEqual(elemental.craftingReagent, { state: "KNOWN", value: false, sources: ["game-client"] });
    assert.equal(elemental.expansion.text, "Dragonflight");
  });
});

test("identity is (game version, base item id): the same base id in another product never mixes, and Retail's labels never apply to it", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    // Hearthstone 6948 exists in Classic Era and Retail; the two clients report different things.
    store.importSnapshot(renderExport({ name: "Virek", generated: T0, itemMetadata: [{ id: 6948, classId: 15, subclassId: 0, bindType: 1, expansionId: 0, reagent: false }] }));
    const era = buildWowSyncExport({ character: { name: "Bromrik", realm: "Defias Pillager" } }).replace(
      /\n\n\[END\]\s*$/,
      `\n\n[ITEM METADATA]\nbaseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent\n6948\t15\t0\t1\t11\t?\n\n[END]\n`,
    );
    const imported = store.importSnapshot(era);
    assert.equal(imported.character.version, "classic-era", "the fixture routes to Classic Era");

    const retail = store.listItemMetadata("retail").find((v) => v.baseItemId === 6948)!;
    const classic = store.listItemMetadata("classic-era").find((v) => v.baseItemId === 6948)!;
    assert.deepEqual(retail.expansionId, { state: "KNOWN", value: 0, sources: ["game-client"] });
    assert.deepEqual(classic.expansionId, { state: "KNOWN", value: 11, sources: ["game-client"] });
    // Client value 11 is "Midnight" in Retail's evidence-backed table only; Classic Era has no table.
    assert.deepEqual(classic.expansion, { state: "UNMAPPED", rawValue: 11, text: "Expansion unknown (client value 11)" });
    assert.equal(store.loadItemEvidence("retail").every((e) => e.gameVersion === "retail"), true);
    assert.equal(store.loadItemEvidence("classic-era").every((e) => e.gameVersion === "classic-era"), true);
    // Neither product sees the other's evidence, so nothing was reported as a conflict.
    assert.equal(retail.expansionId.state, "KNOWN");
    assert.equal(classic.expansionId.state, "KNOWN");
  } finally {
    store.close();
  }
});

test("a client that cannot be routed to a game version records no metadata (there is no scope to key it by)", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const text = buildWowSyncExport({ character: { name: "Odd", realm: "Nowhere" } })
      .replace(/Client: [^\n]*/, "Client: 4.4.0 build 1")
      .replace(/\n\n\[END\]\s*$/, `\n\n[ITEM METADATA]\nbaseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent\n5\t7\t11\t0\t11\tyes\n\n[END]\n`);
    const result = store.importSnapshot(text);
    assert.equal(result.character.version, "unknown-version");
    assert.deepEqual(store.listItemMetadata("unknown-version"), []);
    assert.equal(store.loadItemEvidence("retail").length + store.loadItemEvidence("classic-era").length, 0);
  } finally {
    store.close();
  }
});

test("known fills UNKNOWN: a later export that knows more completes an earlier partial one", () => {
  withHarness((h) => {
    h.imp({ name: "Virek", generated: T0, itemMetadata: [{ id: 236949, classId: 7, subclassId: 11 }] }); // instant tuple only
    const early = view(h.store, 236949)!;
    assert.equal(early.classId.state, "KNOWN");
    assert.deepEqual(early.expansionId, { state: "UNKNOWN" });
    assert.deepEqual(early.craftingReagent, { state: "UNKNOWN" });
    assert.equal(early.expansion.text, "Expansion unknown");

    h.imp({ name: "Virek", generated: T0 + 60, level: 85, itemMetadata: [MOTE] }); // full info arrived
    const full = view(h.store, 236949)!;
    assert.deepEqual(full.expansionId, { state: "KNOWN", value: 11, sources: ["game-client"] });
    assert.deepEqual(full.craftingReagent, { state: "KNOWN", value: true, sources: ["game-client"] });
    assert.equal(full.expansion.text, "Midnight");
  });
});

test("UNKNOWN never overwrites known: a later, less-informed export leaves every known facet intact", () => {
  withHarness((h) => {
    h.imp({ name: "Virek", generated: T0, itemMetadata: [MOTE] });
    const before = JSON.stringify(h.store.loadItemEvidence("retail"));
    h.imp({ name: "Virek", generated: T0 + 60, level: 85, itemMetadata: [{ id: 236949 }] }); // client had not cached it this time
    h.imp({ name: "Virek", generated: T0 + 120, level: 86, itemMetadata: [{ id: 236949, classId: 7 }] });
    const after = h.store.loadItemEvidence("retail");
    assert.equal(after.length, 5);
    const view2 = view(h.store, 236949)!;
    assert.equal(view2.expansion.text, "Midnight");
    assert.deepEqual(view2.craftingReagent, { state: "KNOWN", value: true, sources: ["game-client"] });
    // Only provenance widened (the class value was seen again); nothing known was lost or changed.
    assert.deepEqual(after.map((e) => [e.facet, e.value]), JSON.parse(before).map((e: { facet: string; value: number }) => [e.facet, e.value]));
  });
});

test("replay is idempotent: the same export twice, and the same values in a new export, add no rows and only widen provenance", () => {
  withHarness((h) => {
    const spec = { name: "Virek", generated: T0, itemMetadata: [MOTE] };
    const first = h.imp(spec);
    const dup = h.imp(spec);
    assert.equal(dup.isDuplicate, true);
    assert.equal(h.store.loadItemEvidence("retail").length, 5);

    const second = h.imp({ name: "Virek", generated: T0 + 3600, level: 85, itemMetadata: [MOTE], build: "70000" });
    assert.equal(second.isDuplicate, false);
    const evidence = h.store.loadItemEvidence("retail");
    assert.equal(evidence.length, 5, "same values: no new evidence rows");
    assert.ok(evidence.every((e) => e.firstSeenAt === T0 && e.lastSeenAt === T0 + 3600));
    assert.ok(evidence.every((e) => e.clientBuilds.join() === "69875,70000"));
    assert.equal(first.snapshot.id === second.snapshot.id, false);
    assert.equal(view(h.store, 236949)!.expansion.text, "Midnight");
  });
});

test("import order does not matter: the same exports in either order leave identical evidence", () => {
  const a = { name: "Virek", generated: T0, itemMetadata: [MOTE, { id: 5, classId: 2 }] };
  const b = { name: "Virek", generated: T0 + 100, level: 85, build: "70000", itemMetadata: [{ ...MOTE, subclassId: undefined }, { id: 5, classId: 2, bindType: 1 }] };
  const run = (order: Array<typeof a | typeof b>) => {
    const s = new SqliteSnapshotStore(":memory:");
    try {
      for (const spec of order) s.importSnapshot(renderExport(spec));
      return JSON.stringify(s.loadItemEvidence("retail"));
    } finally {
      s.close();
    }
  };
  assert.equal(run([a, b]), run([b, a]));
});

test("conflicting KNOWN values are never resolved by 'latest wins': the facet is a CONFLICT, both values exposed, no label chosen", () => {
  withHarness((h) => {
    h.imp({ name: "Virek", generated: T0, itemMetadata: [{ id: 60224, classId: 7, subclassId: 10, expansionId: 0 }] });
    h.imp({ name: "Virek", generated: T0 + 3600, level: 85, build: "70000", itemMetadata: [{ id: 60224, classId: 7, subclassId: 10, expansionId: 3 }] });
    const item = view(h.store, 60224)!;
    // agreeing facets stay KNOWN
    assert.equal(item.classId.state, "KNOWN");
    assert.equal(item.subclassId.state, "KNOWN");
    // the disagreeing one is a conflict, with both raw values and where each was seen
    assert.deepEqual(item.expansionId, {
      state: "CONFLICT",
      values: [
        { value: 0, sources: ["game-client"], clientBuilds: ["69875"] },
        { value: 3, sources: ["game-client"], clientBuilds: ["70000"] },
      ],
    });
    assert.deepEqual(item.expansion, { state: "CONFLICT", rawValues: [0, 3], text: "Expansion unknown (conflicting client values 0, 3)" });
    // both pieces of evidence are kept
    assert.equal(h.store.loadItemEvidence("retail").filter((e) => e.facet === "expansionID").length, 2);
  });
});

test("a conflict looks the same whichever export arrived last", () => {
  const older = { name: "Virek", generated: T0, itemMetadata: [{ id: 60224, expansionId: 0 }] };
  const newer = { name: "Virek", generated: T0 + 3600, level: 85, build: "70000", itemMetadata: [{ id: 60224, expansionId: 3 }] };
  const resolve = (order: Array<typeof older>) => {
    const s = new SqliteSnapshotStore(":memory:");
    try {
      for (const spec of order) s.importSnapshot(renderExport(spec));
      return JSON.stringify(s.listItemMetadata("retail"));
    } finally {
      s.close();
    }
  };
  assert.equal(resolve([older, newer]), resolve([newer, older]));
  assert.match(resolve([older, newer]), /"state":"CONFLICT"/);
});

test("metadata never changes a snapshot: an older stored snapshot is byte-identical after later metadata arrives", () => {
  withHarness((h) => {
    const first = h.imp({ name: "Virek", generated: T0 });
    const stored = () => h.raw.prepare("SELECT raw_text, parsed_json FROM snapshots WHERE id = ?").get(first.snapshot.id) as { raw_text: string; parsed_json: string };
    const before = stored();
    h.imp({ name: "Virek", generated: T0 + 60, level: 85, itemMetadata: [MOTE] });
    assert.deepEqual(stored(), before);
    assert.equal("itemMetadata" in JSON.parse(before.parsed_json), false);
  });
});

test("metadata is never part of a shared-storage observation's identity or hash: with and without it, one observation", () => {
  withHarness((h) => {
    const wb = warband({ observedAt: T0 - 10, items: [["Mote of Light", 13], ["Linen Cloth", 5]] });
    h.imp({ name: "Virek", generated: T0, warband: wb });
    const plain = h.all<{ identity: string; content_hash: string; hash_version: number; content_json: string }>("SELECT identity, content_hash, hash_version, content_json FROM shared_observations");
    assert.equal(plain.length, 1);

    // Same Warband observation carried by an export that also carries item metadata: same observation, one more source.
    h.imp({ name: "Virek", generated: T0 + 60, level: 85, warband: wb, itemMetadata: [MOTE] });
    const enriched = h.all<{ identity: string; content_hash: string; hash_version: number; content_json: string }>("SELECT identity, content_hash, hash_version, content_json FROM shared_observations");
    assert.deepEqual(enriched, plain, "identity, content hash, hash version and stored content are unchanged");
    assert.equal(h.counts().observations, 1);
    assert.equal(h.counts().sources, 2);
    assert.ok(!plain[0].content_json.includes("expansion") && !plain[0].content_json.includes("classID"));
    assert.ok(h.store.projectSharedStorage().warband?.current, "the Warband still has its one current observation");
  });
});

test("metadata is stored outside every table that observations use, and survives deleting the character that carried it", () => {
  withHarness((h) => {
    h.imp({ name: "Virek", generated: T0, itemMetadata: [MOTE] });
    const tables = h.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'item_metadata_evidence'")[0].sql;
    assert.ok(!/REFERENCES/i.test(tables), "no reference to characters or snapshots");
    const deleted = h.store.deleteCharacter("retail::cairne::virek");
    assert.equal(deleted?.snapshotsDeleted, 1);
    assert.equal(h.store.loadItemEvidence("retail").length, 5, "item facts are not owned by a character");
    assert.equal(view(h.store, 236949)!.expansion.text, "Midnight");
  });
});

test("metadata persists across a restart of the store", () => {
  withHarness((h) => {
    h.imp({ name: "Virek", generated: T0, itemMetadata: [MOTE] });
    h.reopen();
    assert.equal(view(h.store, 236949)!.expansion.text, "Midnight");
    assert.equal(h.store.loadItemEvidence("retail").length, 5);
  });
});

test("the derived real Virek fixture imports: its Mote of Light / Mote of Harmony resolve, and its 96 all-UNKNOWN rows store nothing", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const result = store.importSnapshot(read("derived/virek-warband-item-metadata-1789965777.wowsync.txt"));
    assert.equal(result.character.version, "retail");
    const views = store.listItemMetadata("retail");
    assert.deepEqual(views.map((v) => v.baseItemId), [89112, 236949]);
    assert.equal(views.find((v) => v.baseItemId === 89112)!.expansion.text, "Mists of Pandaria");
    assert.equal(views.find((v) => v.baseItemId === 236949)!.expansion.text, "Midnight");
  } finally {
    store.close();
  }
});

test("Mote of Light resolves identically wherever it appears: ordinary character bags and Warband storage (and a guild bank) use one metadata record", () => {
  withHarness((h) => {
    const wb = warband({ observedAt: T0 - 10, items: [["Mote of Light", 13]] });
    const gd = guild({ observedAt: T0 - 20, tabs: [{ id: 1, name: "Mats", items: [["Mote of Light", 4]] }] });
    const parsedWarbandRef = MOTE_OF_LIGHT_REF;
    // Real item refs (with the observing character's level embedded) in each store, all the same base item.
    wb.items[0].itemRef = parsedWarbandRef.replace(":85:", ":86:");
    gd.items[0].itemRef = parsedWarbandRef;
    const bags = bagsWith([MOTE_OF_LIGHT_REF, "Mote of Light", 13]);
    const text = renderExport({ name: "Virek", generated: T0, warband: wb, guild: gd, bags, itemMetadata: [MOTE] });
    assert.ok(text.includes(renderBags(bags)));
    const stored = h.store.importSnapshot(text).snapshot.parsed;

    const refs = [stored.bags.items[0].itemRef, stored.accountBank!.items[0].itemRef, stored.guildBank!.items[0].itemRef];
    assert.deepEqual(refs.map(itemIdFromItemRef), [236949, 236949, 236949], "one base id despite different embedded levels");
    const views = refs.map((r) => view(h.store, itemIdFromItemRef(r)!)!);
    assert.ok(views.every((v) => v === views[0] || JSON.stringify(v) === JSON.stringify(views[0])));
    assert.equal(views[0].craftingReagent.state === "KNOWN" && views[0].craftingReagent.value, true);
    assert.equal(views[0].expansion.text, "Midnight");
    // ...and it was not inferred from the name or the id: the same lookup for an unreported item says unknown.
    assert.equal(view(h.store, 236950), undefined);
  });
});
