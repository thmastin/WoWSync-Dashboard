// Parsing of the addon's additive `[ITEM METADATA]` block (GearExport a94288e): the exact six-column contract, `?` as
// UNKNOWN (never 0 / false), `yes` / `no` kept distinct, malformed known values REJECTED (never coerced), duplicate
// base ids rejected, and every legacy export still parsing exactly as before. The parser only records what the export
// said: no expansion name is derived here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWowSyncExport, WowSyncParseError } from "../src/parser.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { METADATA_HEADER, renderExport, renderItemMetadata } from "./sharedStorageExports.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${dir}${path}`, "utf8");
const T = "\t";

/** Inserts a section block (or replaces the block) just before [END], the way the addon appends it. */
const withBlock = (text: string, block: string) => text.replace(/\n*\[END\]\s*$/, `\n\n${block}\n\n[END]\n`);
const block = (...rows: string[]) => ["[ITEM METADATA]", METADATA_HEADER, ...rows].join("\n");
const row = (...cols: string[]) => cols.join(T);
const parseBlock = (...rows: string[]) => parseWowSyncExport(renderExport({ name: "Virek", generated: 1_790_000_000, itemMetadata: block(...rows) }));
const rejects = (label: string, ...rows: string[]) =>
  assert.throws(() => parseBlock(...rows), (e) => e instanceof WowSyncParseError, label);

test("the exact producer contract parses: Mote of Light and the four other live Retail rows", () => {
  const parsed = parseBlock(
    row("89112", "7", "10", "0", "4", "yes"),
    row("187707", "7", "10", "0", "8", "yes"),
    row("202071", "15", "0", "0", "9", "no"),
    row("210931", "7", "7", "0", "10", "yes"),
    row("236949", "7", "11", "0", "11", "yes"),
  );
  assert.deepEqual(parsed.itemMetadata?.rows, [
    { baseItemId: 89112, classId: 7, subclassId: 10, bindType: 0, expansionId: 4, isCraftingReagent: true },
    { baseItemId: 187707, classId: 7, subclassId: 10, bindType: 0, expansionId: 8, isCraftingReagent: true },
    { baseItemId: 202071, classId: 15, subclassId: 0, bindType: 0, expansionId: 9, isCraftingReagent: false },
    { baseItemId: 210931, classId: 7, subclassId: 7, bindType: 0, expansionId: 10, isCraftingReagent: true },
    { baseItemId: 236949, classId: 7, subclassId: 11, bindType: 0, expansionId: 11, isCraftingReagent: true },
  ]);
});

test("'?' is UNKNOWN (undefined) per facet, and 0 / no are real known values distinct from it", () => {
  const [unknown, zeros] = parseBlock(row("100", "?", "?", "?", "?", "?"), row("200", "0", "0", "0", "0", "no")).itemMetadata!.rows;
  assert.deepEqual(unknown, { baseItemId: 100, classId: undefined, subclassId: undefined, bindType: undefined, expansionId: undefined, isCraftingReagent: undefined });
  assert.equal(zeros.classId, 0);
  assert.equal(zeros.bindType, 0);
  assert.equal(zeros.expansionId, 0, "a raw 0 is kept as the number 0 - it is not reinterpreted");
  assert.equal(zeros.isCraftingReagent, false);
  assert.notEqual(zeros.isCraftingReagent, unknown.isCraftingReagent, "no is not UNKNOWN");
  // A partly known row (the addon fills class/subclass from GetItemInfoInstant while full info is unavailable).
  const partial = parseBlock(row("300", "7", "11", "?", "?", "?")).itemMetadata!.rows[0];
  assert.equal(partial.classId, 7);
  assert.equal(partial.subclassId, 11);
  assert.equal(partial.bindType, undefined);
  assert.equal(partial.expansionId, undefined);
  assert.equal(partial.isCraftingReagent, undefined);
});

test("raw expansionID is preserved as a number and the parser derives no label of any kind", () => {
  for (const raw of ["0", "254", "6", "11", "9999"]) {
    const [r] = parseBlock(row("100", "7", "11", "0", raw, "yes")).itemMetadata!.rows;
    assert.equal(r.expansionId, Number(raw));
    assert.deepEqual(Object.keys(r).sort(), ["baseItemId", "bindType", "classId", "expansionId", "isCraftingReagent", "subclassId"]);
  }
});

test("an export with no [ITEM METADATA] section (every historical export) parses with no itemMetadata key", () => {
  for (const file of ["classic-era/bromrik-1789170870.wowsync.txt", "retail/ezaller-1789478317.wowsync.txt", "tbc-anniversary/voodan-1789484723.wowsync.txt", "sanitized/virek-warband-last-seen-1789965777.wowsync.txt"]) {
    const parsed = parseWowSyncExport(read(file));
    assert.equal("itemMetadata" in parsed, false, file);
  }
  assert.equal("itemMetadata" in parseWowSyncExport(buildWowSyncExport()), false);
});

test("adding the section changes nothing else in the parsed export: every existing item record is identical", () => {
  const plain = parseWowSyncExport(read("sanitized/virek-warband-last-seen-1789965777.wowsync.txt"));
  const enriched = parseWowSyncExport(read("derived/virek-warband-item-metadata-1789965777.wowsync.txt"));
  const { itemMetadata, raw: _rawA, ...restEnriched } = enriched;
  const { raw: _rawB, ...restPlain } = plain;
  assert.ok(itemMetadata);
  assert.deepEqual(restEnriched, restPlain);
  assert.equal(enriched.accountBank?.items.length, 98);
});

test("the derived real Virek fixture carries live values for exactly Mote of Harmony and Mote of Light; every other row is all-UNKNOWN", () => {
  const rows = parseWowSyncExport(read("derived/virek-warband-item-metadata-1789965777.wowsync.txt")).itemMetadata!.rows;
  assert.equal(rows.length, 98);
  assert.deepEqual(rows.map((r) => r.baseItemId), [...rows.map((r) => r.baseItemId)].sort((a, b) => a - b), "ascending, as the addon writes them");
  const known = rows.filter((r) => Object.entries(r).some(([k, v]) => k !== "baseItemId" && v !== undefined));
  assert.deepEqual(known.map((r) => r.baseItemId), [89112, 236949]);
  assert.deepEqual(known.find((r) => r.baseItemId === 236949), { baseItemId: 236949, classId: 7, subclassId: 11, bindType: 0, expansionId: 11, isCraftingReagent: true });
});

test("a header-only block is valid (an export that referenced no items) and yields no rows", () => {
  assert.deepEqual(parseBlock().itemMetadata, { rows: [] });
});

test("the section can sit anywhere among the sections, and row order is not meaningful", () => {
  const text = renderExport({ name: "Virek", generated: 1_790_000_000 });
  const middle = text.replace("[LOCATION]", `${renderItemMetadata([{ id: 200, classId: 7, expansionId: 11 }, { id: 100 }])}\n\n[LOCATION]`);
  assert.deepEqual(parseWowSyncExport(middle).itemMetadata!.rows.map((r) => r.baseItemId), [200, 100]);
});

test("a copy/paste that collapsed tabs to runs of spaces still parses (like every other section)", () => {
  const spaced = block("236949    7    11    0    11    yes").replace(METADATA_HEADER, METADATA_HEADER.replaceAll(T, "    "));
  const [r] = parseWowSyncExport(withBlock(renderExport({ name: "Virek", generated: 1 }), spaced)).itemMetadata!.rows;
  assert.equal(r.expansionId, 11);
  assert.equal(r.isCraftingReagent, true);
});

test("malformed KNOWN values are rejected, never coerced to a number, 0 or false", () => {
  for (const bad of ["-1", "1.5", "abc", "1e3", "0x10", "", " 7", "7 ", "+7", "07", "٣", "true", "NaN", "Infinity", "9007199254740993"]) {
    for (const [column, make] of [
      ["classID", (v: string) => row("100", v, "0", "0", "0", "no")],
      ["subclassID", (v: string) => row("100", "0", v, "0", "0", "no")],
      ["bindType", (v: string) => row("100", "0", "0", v, "0", "no")],
      ["expansionID", (v: string) => row("100", "0", "0", "0", v, "no")],
    ] as const) {
      rejects(`${column} = ${JSON.stringify(bad)}`, make(bad));
    }
  }
});

test("isCraftingReagent accepts only yes / no / ?", () => {
  for (const bad of ["true", "false", "1", "0", "YES", "Yes", "No", "y", "", "unknown"]) rejects(`reagent ${JSON.stringify(bad)}`, row("100", "7", "11", "0", "11", bad));
  for (const good of ["yes", "no", "?"]) assert.doesNotThrow(() => parseBlock(row("100", "7", "11", "0", "11", good)));
});

test("baseItemID must be a positive canonical integer", () => {
  for (const bad of ["0", "-5", "1.0", "abc", "?", "", "00100", "item:100", "9007199254740993"]) rejects(`baseItemID ${JSON.stringify(bad)}`, row(bad, "7", "11", "0", "11", "yes"));
});

test("a duplicate base item id in one section is rejected (the addon writes exactly one row per id)", () => {
  assert.throws(() => parseBlock(row("236949", "7", "11", "0", "11", "yes"), row("236949", "?", "?", "?", "?", "?")), /Duplicate \[ITEM METADATA\] row for baseItemID 236949/);
  // Even when the repeat is identical, or is the same id spelled with different unknowns.
  assert.throws(() => parseBlock(row("5", "?", "?", "?", "?", "?"), row("5", "?", "?", "?", "?", "?")), /Duplicate/);
});

test("the exact six-column contract: wrong width or a wrong / missing / reordered header is rejected", () => {
  rejects("five columns", row("100", "7", "11", "0", "11"));
  rejects("seven columns", row("100", "7", "11", "0", "11", "yes", "extra"));
  rejects("one column", "100");
  const noHeader = ["[ITEM METADATA]", row("100", "7", "11", "0", "11", "yes")].join("\n");
  assert.throws(() => parseWowSyncExport(renderExport({ name: "V", generated: 1, itemMetadata: noHeader })), /must start with the column row/);
  const reordered = ["[ITEM METADATA]", row("baseItemID", "subclassID", "classID", "bindType", "expansionID", "isCraftingReagent")].join("\n");
  assert.throws(() => parseWowSyncExport(renderExport({ name: "V", generated: 1, itemMetadata: reordered })), /must start with the column row/);
  const renamed = ["[ITEM METADATA]", METADATA_HEADER.replace("expansionID", "expansion")].join("\n");
  assert.throws(() => parseWowSyncExport(renderExport({ name: "V", generated: 1, itemMetadata: renamed })), /must start with the column row/);
  assert.throws(() => parseWowSyncExport(renderExport({ name: "V", generated: 1, itemMetadata: "[ITEM METADATA]" })), /must start with the column row/);
});

test("a repeated [ITEM METADATA] section is rejected like any duplicate section", () => {
  const text = withBlock(withBlock(renderExport({ name: "V", generated: 1 }), block()), block());
  assert.throws(() => parseWowSyncExport(text), /Duplicate section "\[ITEM METADATA\]"/);
});

test("other unrecognized sections are still rejected: only [ITEM METADATA] was added", () => {
  const text = withBlock(renderExport({ name: "V", generated: 1 }), "[ITEM FLAVOR]\nx");
  assert.throws(() => parseWowSyncExport(text), /Unknown section "\[ITEM FLAVOR\]"/);
});
