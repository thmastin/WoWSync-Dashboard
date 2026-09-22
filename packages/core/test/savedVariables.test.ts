// The SavedVariables reader is a DATA reader: it must understand what WoW writes, reject everything else loudly, and never
// evaluate anything. These tests pin the accepted shape, the exact string decoding (the export text depends on it), the
// rejections, and that hostile-looking input is just text or an error - never run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SavedVariablesParseError, isLuaTable, luaGet, parseSavedVariables, type LuaValue } from "../src/savedVariables.ts";

const plain = (v: LuaValue | undefined): unknown => (v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), plain(x)])) : v);
const parse = (text: string, only?: string[]) => parseSavedVariables(text, only ? { only } : {});
const fails = (text: string, message?: RegExp, only?: string[]) => assert.throws(() => parse(text, only), (e) => e instanceof SavedVariablesParseError && (message ? message.test(e.message) : true), text.slice(0, 60));

test("reads the shape WoW writes: CRLF, string and numeric keys, nested tables, booleans, nil, floats, negatives", () => {
  const text = [
    "",
    "GearExportDB = {",
    '["exports"] = {',
    "},",
    "}",
    "WoWSyncDB = {",
    '["schemaVersion"] = 1,',
    '["ratio"] = 12.77777767181397,',
    '["neg"] = -3,',
    '["exp"] = 1.5e+3,',
    '["flag"] = true,',
    '["off"] = false,',
    '["gone"] = nil,',
    '["list"] = {',
    '"a",',
    '"b",',
    "},",
    '[7] = {',
    '["deep"] = { ["x"] = { ["y"] = 1 } },',
    "},",
    "}",
    "",
  ].join("\r\n");
  const vars = parse(text);
  assert.deepEqual(plain(vars.GearExportDB), { exports: {} });
  assert.deepEqual(plain(vars.WoWSyncDB), {
    schemaVersion: 1,
    ratio: 12.77777767181397,
    neg: -3,
    exp: 1500,
    flag: true,
    off: false,
    gone: null,
    list: { 1: "a", 2: "b" },
    7: { deep: { x: { y: 1 } } },
  });
  assert.equal(luaGet(vars.WoWSyncDB, "schemaVersion"), 1);
  assert.equal(isLuaTable(luaGet(vars.WoWSyncDB, "list")), true);
  assert.equal(luaGet(vars.WoWSyncDB, "missing"), undefined);
});

test("string decoding is exact: \\n, \\\\, \\\", raw tabs, \\r, \\t, \\ddd and a trailing newline all round-trip", () => {
  const original = 'WOWSYNC v1\n\nName: A\tB\\C "quoted"\r\nend\n';
  const encoded = original.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  assert.equal(luaGet(parse(`X = { ["t"] = "${encoded}" }`).X, "t"), original);
  // tabs written as escapes decode to the same tab
  assert.equal(luaGet(parse('X = { ["t"] = "a\\tb\\065\\10c\\9" }').X, "t"), "a\tbA\nc\t");
  // a backslash-newline is a newline, single quotes work, other simple escapes decode
  assert.equal(luaGet(parse("X = { [1] = 'it\\'s\\\nok\\a' }").X, 1), "it's\nok\x07");
});

test("only the requested top-level variables are read; the others are skipped without being interpreted", () => {
  const text = 'Legacy = { ["a"] = { "x", ["s"] = "has } and { braces \\" inside" }, [1] = -5, ["t"] = true }\nWoWSyncDB = { ["v"] = 1 }\n';
  const vars = parse(text, ["WoWSyncDB"]);
  assert.deepEqual(Object.keys(vars), ["WoWSyncDB"]);
  assert.deepEqual(plain(vars.WoWSyncDB), { v: 1 });
  // A skipped variable is still lexed: a truncated or non-data one is an error, not silently ignored.
  fails('Legacy = { ["a"] = "unterminated\nWoWSyncDB = {}', /Unescaped line break|Unterminated/, ["WoWSyncDB"]);
  fails("Legacy = { evil() }\nWoWSyncDB = {}", /Unexpected identifier "evil"/, ["WoWSyncDB"]);
  fails("Legacy = { [1] = 1\nWoWSyncDB = {}", /Unexpected end|Unexpected identifier|Expected/, ["WoWSyncDB"]);
});

test("comments are skipped; a block comment is refused", () => {
  assert.deepEqual(plain(parse('X = { -- note\n["a"] = 1, -- [1]\n}\n').X), { a: 1 });
  fails("--[[ hidden ]]\nX = {}", /Block comments/);
});

test("code is never accepted: calls, identifiers as values, operators, concatenation, functions, long strings", () => {
  fails('X = os.execute("calc")', /Unexpected identifier "os"|Expected/);
  fails('X = { ["a"] = os.execute("calc") }', /Unexpected identifier "os"/);
  fails('X = { ["a"] = (function() return 1 end)() }', /Unexpected character "\("/);
  fails('X = { ["a"] = function() end }', /Unexpected identifier "function"/);
  fails('X = { ["a"] = "x" .. "y" }', /Expected "," or "}"/);
  fails('X = { ["a"] = 1 + 2 }', /Expected "," or "}"/);
  fails('X = { ["a"] = SomeGlobal }', /Unexpected identifier "SomeGlobal"/);
  fails('X = { [[long]] }', /Long-bracket/);
  fails('X = { ["a"] = [[long]] }', /Unexpected character "\["/);
  fails('X = dofile("evil.lua")', /Unexpected identifier "dofile"/);
  fails('X = { [os.exit()] = 1 }', /Unexpected identifier "os"/);
  fails("local X = {}", /Expected "="/);
  fails("X = {}\nprint('x')", /Expected "="/);
  fails("X = {} Y", /Expected "="/);
});

test("hostile content is inert: nothing is executed, and injection-looking strings are just strings", () => {
  const g = globalThis as Record<string, unknown>;
  g.__savedVariablesPwned = false;
  const attempts = [
    'X = { ["a"] = (function() end)() }',
    'X = os.execute("echo pwned")',
    'X = loadstring("globalThis.__savedVariablesPwned = true")()',
    'X = { ["a"] = "x"; os.exit(1) }',
  ];
  for (const a of attempts) assert.throws(() => parse(a), SavedVariablesParseError);
  const nasty = '"});globalThis.__savedVariablesPwned = true;//`${process.exit(1)}';
  const encoded = nasty.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  assert.equal(luaGet(parse(`X = { ["s"] = "${encoded}" }`).X, "s"), nasty);
  assert.equal(g.__savedVariablesPwned, false);
  delete g.__savedVariablesPwned;
});

test("malformed and truncated input fails loudly with a position, never partially", () => {
  fails('X = { ["a"] = 1', /Unexpected end of file inside a table/);
  fails('X = { ["a"] = "abc', /Unterminated string/);
  fails("X = {", /Unexpected end of file inside a table/);
  fails("X =", /Unexpected end of file/);
  fails("X", /Expected "="/);
  fails("= {}", /Expected a variable name/);
  fails('X = { ["a"] 1 }', /Expected "="/);
  fails('X = { ["a" = 1 }', /Expected "\]"/);
  fails('X = { [nil] = 1 }', /table key must be/);
  fails('X = { [{}] = 1 }', /table key must be/);
  fails('X = { "a" "b" }', /Expected "," or "}"/);
  fails('X = {}\nX = {}', /assigned more than once/);
  fails('X = { ["a"] = 1 }}', /Expected a variable name/);
  fails('X = { ["s"] = "bad \\q escape" }', /Unsupported string escape/);
  fails('X = { ["s"] = "\\300" }', /Unsupported byte escape/);
  fails('X = { ["s"] = "line\nbreak" }', /Unescaped line break/);
  fails("X = { 0x10 }", /Malformed number/);
  fails("X = { 12abc }", /Malformed number/);
  fails("X = { 1..2 }", /Malformed number/);
  fails("X = { 1e999 }", /out of range/);
  fails("X = { - }", /Malformed number/);
  const error = (() => {
    try {
      parse('X = {\r\n["a"] = 1,\r\n["b"] = ??\r\n}');
    } catch (e) {
      return e as SavedVariablesParseError;
    }
  })();
  assert.equal(error?.line, 3);
  assert.equal(error?.column > 1, true);
});

test("nesting is bounded so a hostile file cannot blow the stack", () => {
  const deep = (n: number) => `X = ${"{".repeat(n)}${"}".repeat(n)}`;
  assert.doesNotThrow(() => parse(deep(60)));
  fails(deep(200), /nested deeper/);
  fails(deep(200), /nested deeper/, ["Y"]); // also when the variable is skipped
});

test("a byte-order mark and an empty file are handled", () => {
  assert.deepEqual(plain(parse("﻿X = { }").X), {});
  assert.deepEqual(parse(""), {});
  assert.deepEqual(parse("\r\n\r\n"), {});
});

test("a realistic large table parses quickly", () => {
  const rows: string[] = [];
  for (let i = 0; i < 20000; i++) rows.push(`["k${i}"] = { ["v"] = ${i}.5, ["s"] = "value ${i}\\n", ["b"] = true },`);
  const started = Date.now();
  const vars = parse(`WoWSyncDB = {\r\n${rows.join("\r\n")}\r\n}`);
  assert.equal((vars.WoWSyncDB as Map<unknown, unknown>).size, 20000);
  assert.ok(Date.now() - started < 3000, "20k entries parse well under 3s");
});
