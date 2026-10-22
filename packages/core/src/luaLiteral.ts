// Data-only reader for Lua table literals (as used by QuestieDB's generated data files).
// Accepts tables, strings, numbers, booleans and nil, with positional and [key]/name keys.
// It never evaluates code: anything else is a parse error.

export type LuaValue = string | number | boolean | null | LuaTable;
/** Positional entries keep their Lua index (1-based) as numeric keys, so nil holes are preserved. */
export interface LuaTable { [key: string]: LuaValue }

export class LuaLiteralError extends Error {}

export function parseLuaLiteral(source: string, start = 0): { value: LuaValue; end: number } {
  let i = start;
  const n = source.length;
  const skip = () => {
    while (i < n) {
      const c = source.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) { i += 1; continue; }
      if (source.startsWith("--", i)) {
        if (source.startsWith("--[[", i)) { const close = source.indexOf("]]", i + 4); i = close < 0 ? n : close + 2; }
        else { const nl = source.indexOf("\n", i); i = nl < 0 ? n : nl + 1; }
        continue;
      }
      break;
    }
  };
  const fail = (message: string): never => { throw new LuaLiteralError(`${message} at offset ${i}`); };
  const readString = (): string => {
    const quote = source[i];
    i += 1;
    let out = "";
    while (i < n) {
      const c = source[i];
      if (c === quote) { i += 1; return out; }
      if (c === "\\") {
        const next = source[i + 1];
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "\"": "\"", "'": "'", "\n": "\n" };
        if (next in map) { out += map[next]; i += 2; continue; }
        const digits = /^\d{1,3}/.exec(source.slice(i + 1, i + 4));
        if (digits) { out += String.fromCharCode(Number(digits[0])); i += 1 + digits[0].length; continue; }
        fail("unsupported escape");
      }
      out += c;
      i += 1;
    }
    return fail("unterminated string");
  };
  const readValue = (): LuaValue => {
    skip();
    const c = source[i];
    if (c === "{") return readTable();
    if (c === "\"" || c === "'") return readString();
    if (source.startsWith("nil", i)) { i += 3; return null; }
    if (source.startsWith("true", i)) { i += 4; return true; }
    if (source.startsWith("false", i)) { i += 5; return false; }
    const number = /^-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+)/.exec(source.slice(i, i + 40));
    if (number) { i += number[0].length; return Number(number[0]); }
    return fail("unexpected token");
  };
  const readTable = (): LuaTable => {
    i += 1;
    const table: LuaTable = {};
    let position = 1;
    for (;;) {
      skip();
      if (source[i] === "}") { i += 1; return table; }
      if (source[i] === "[" && source[i + 1] !== "[") {
        i += 1;
        const key = readValue();
        skip();
        if (source[i] !== "]") fail("expected ]");
        i += 1;
        skip();
        if (source[i] !== "=") fail("expected =");
        i += 1;
        const value = readValue();
        if (value !== null) table[String(key)] = value;
      } else {
        const name = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(source.slice(i, i + 80));
        if (name) {
          i += name[0].length;
          const value = readValue();
          if (value !== null) table[name[0].replace(/\s*=$/, "")] = value;
        } else {
          const value = readValue();
          if (value !== null) table[String(position)] = value;
          position += 1;
        }
      }
      skip();
      if (source[i] === "," || source[i] === ";") { i += 1; continue; }
      if (source[i] === "}") continue;
      fail("expected , or }");
    }
  };
  const value = readValue();
  return { value, end: i };
}

/** Reads `<marker> [[return { ... }]]` blocks such as QuestieDB.questData. */
export function parseQuestieDataBlock(file: string, marker: string): LuaTable {
  const at = file.indexOf(marker);
  if (at < 0) throw new LuaLiteralError(`marker ${marker} not found`);
  const open = file.indexOf("return", at);
  const brace = file.indexOf("{", open);
  const { value } = parseLuaLiteral(file, brace);
  if (!value || typeof value !== "object") throw new LuaLiteralError("data block is not a table");
  return value;
}

/** Positional Lua array (1-based keys) to a JS array; nil holes become undefined. */
export function luaArray(value: LuaValue | undefined): LuaValue[] {
  if (!value || typeof value !== "object") return [];
  const keys = Object.keys(value).filter((key) => /^\d+$/.test(key)).map(Number);
  const max = keys.length ? Math.max(...keys) : 0;
  const out: LuaValue[] = [];
  for (let index = 1; index <= max; index += 1) out.push((value as LuaTable)[String(index)] ?? null);
  return out;
}
