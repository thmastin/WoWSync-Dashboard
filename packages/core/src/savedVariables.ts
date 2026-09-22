// A DATA-ONLY reader for WoW SavedVariables files (the Lua tables an addon's SavedVariables are written as).
//
// This never evaluates anything. It is a small recursive-descent reader for exactly the shape WoW's serializer writes:
//
//   Name = { ["key"] = value, [1] = value, ... }
//
// where a value is a string, a number, true / false / nil, or another table (bare `value,` array items are accepted
// too). Anything else - a function call, an identifier used as a value, an operator, concatenation, a long-bracket
// string, a `function` - is REJECTED with a position, so a SavedVariables file that has been tampered with (or is
// simply not what we expect) can neither run code nor be half-read. There is no interpreter and no `eval`.
//
// Malformed or truncated input (a file caught mid-write) fails loudly: it is never returned partially.
//
// Only the top-level variables named in `only` are read into values; every other top-level assignment is skipped
// lexically (string- and comment-aware, brace-balanced), so unrelated or legacy tables can never break the reader.

export class SavedVariablesParseError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = "SavedVariablesParseError";
    this.line = line;
    this.column = column;
  }
}

/** A Lua value as a SavedVariables file can express it. `nil` is `null`; a table is a Map (Lua keys may be strings, numbers or booleans). */
export type LuaValue = string | number | boolean | null | LuaTable;
export type LuaKey = string | number | boolean;
export type LuaTable = Map<LuaKey, LuaValue>;

export interface ParseLuaOptions {
  /** The top-level variable names to read. Others are skipped. Omit to read every top-level variable. */
  only?: readonly string[];
  /** Deepest table nesting accepted (guards the recursion). Real files are shallow. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 64;
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const SIMPLE_ESCAPES: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "'": "'" };

class Reader {
  private pos = 0;
  private readonly src: string;
  private readonly maxDepth: number;
  constructor(src: string, maxDepth: number) {
    this.src = src;
    this.maxDepth = maxDepth;
  }

  private fail(message: string, at = this.pos): never {
    let line = 1;
    let column = 1;
    for (let i = 0; i < at && i < this.src.length; i++) {
      if (this.src[i] === "\n") {
        line++;
        column = 1;
      } else column++;
    }
    throw new SavedVariablesParseError(message, line, column);
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  /** Skips whitespace and `--` line comments. A `--[[` block comment is not something WoW writes: rejected, not skipped. */
  skipTrivia(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        this.pos++;
      } else if (c === "-" && this.src[this.pos + 1] === "-") {
        if (this.src[this.pos + 2] === "[" && (this.src[this.pos + 3] === "[" || this.src[this.pos + 3] === "=")) {
          this.fail("Block comments are not supported");
        }
        while (!this.atEnd() && this.src[this.pos] !== "\n") this.pos++;
      } else return;
    }
  }

  /** Reads every top-level `Name = value`. */
  readTopLevel(only: readonly string[] | undefined): Record<string, LuaValue> {
    const out: Record<string, LuaValue> = {};
    this.skipTrivia();
    while (!this.atEnd()) {
      const start = this.pos;
      const name = this.readIdentifier();
      if (name === undefined) this.fail("Expected a variable name at the start of a top-level assignment");
      this.skipTrivia();
      if (this.src[this.pos] !== "=") this.fail(`Expected "=" after ${name}`);
      this.pos++;
      this.skipTrivia();
      if (only && !only.includes(name)) {
        this.skipValue(0);
      } else {
        if (Object.prototype.hasOwnProperty.call(out, name)) this.fail(`${name} is assigned more than once`, start);
        out[name] = this.readValue(0);
      }
      this.skipTrivia();
      if (this.src[this.pos] === ";") {
        this.pos++;
        this.skipTrivia();
      }
    }
    return out;
  }

  private readIdentifier(): string | undefined {
    if (this.atEnd() || !IDENT_START.test(this.src[this.pos])) return undefined;
    const start = this.pos;
    while (!this.atEnd() && IDENT_PART.test(this.src[this.pos])) this.pos++;
    return this.src.slice(start, this.pos);
  }

  private readValue(depth: number): LuaValue {
    this.skipTrivia();
    const c = this.src[this.pos];
    if (c === undefined) this.fail("Unexpected end of file (was the file caught while WoW was writing it?)");
    if (c === "{") return this.readTable(depth + 1);
    if (c === '"' || c === "'") return this.readString();
    if (c === "-" || (c >= "0" && c <= "9")) return this.readNumber();
    const word = this.readIdentifier();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "nil") return null;
    if (word !== undefined) this.fail(`Unexpected identifier "${word}": only data (strings, numbers, booleans, nil, tables) is accepted`, this.pos - word.length);
    this.fail(`Unexpected character ${JSON.stringify(c)}: only data is accepted`);
  }

  private readTable(depth: number): LuaTable {
    if (depth > this.maxDepth) this.fail(`Tables are nested deeper than ${this.maxDepth} levels`);
    this.pos++; // {
    const table: LuaTable = new Map();
    let arrayIndex = 1;
    for (;;) {
      this.skipTrivia();
      const c = this.src[this.pos];
      if (c === undefined) this.fail("Unexpected end of file inside a table (was the file caught while WoW was writing it?)");
      if (c === "}") {
        this.pos++;
        return table;
      }
      if (c === "[" && this.src[this.pos + 1] !== "[" && this.src[this.pos + 1] !== "=") {
        this.pos++;
        this.skipTrivia();
        const keyValue = this.readValue(depth);
        if (keyValue === null || typeof keyValue === "object") this.fail("A table key must be a string, number or boolean");
        this.skipTrivia();
        if (this.src[this.pos] !== "]") this.fail('Expected "]" after a table key');
        this.pos++;
        this.skipTrivia();
        if (this.src[this.pos] !== "=") this.fail('Expected "=" after a table key');
        this.pos++;
        table.set(keyValue, this.readValue(depth));
      } else if (c === "[") {
        this.fail("Long-bracket strings are not supported");
      } else if (IDENT_START.test(c) && this.isNamedField()) {
        const name = this.readIdentifier()!;
        this.skipTrivia();
        this.pos++; // =
        table.set(name, this.readValue(depth));
      } else {
        table.set(arrayIndex++, this.readValue(depth));
      }
      this.skipTrivia();
      const sep = this.src[this.pos];
      if (sep === undefined) this.fail("Unexpected end of file inside a table (was the file caught while WoW was writing it?)");
      if (sep === "," || sep === ";") this.pos++;
      else if (sep !== "}") this.fail('Expected "," or "}" after a table entry');
    }
  }

  /** True when the identifier at the cursor is a `name = value` field (not the start of a value like `true`). */
  private isNamedField(): boolean {
    let p = this.pos;
    while (p < this.src.length && IDENT_PART.test(this.src[p])) p++;
    while (p < this.src.length && /[ \t\r\n]/.test(this.src[p])) p++;
    return this.src[p] === "=" && this.src[p + 1] !== "=";
  }

  private readString(): string {
    const quote = this.src[this.pos];
    const start = this.pos;
    this.pos++;
    let out = "";
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) this.fail("Unterminated string (was the file caught while WoW was writing it?)", start);
      if (c === quote) {
        this.pos++;
        return out;
      }
      if (c === "\n" || c === "\r") this.fail("Unescaped line break inside a string", start);
      if (c !== "\\") {
        out += c;
        this.pos++;
        continue;
      }
      const e = this.src[this.pos + 1];
      if (e === undefined) this.fail("Unterminated string escape", start);
      if (e in SIMPLE_ESCAPES) {
        out += SIMPLE_ESCAPES[e];
        this.pos += 2;
      } else if (e === "\n") {
        out += "\n";
        this.pos += 2;
      } else if (e === "\r") {
        out += "\n";
        this.pos += this.src[this.pos + 2] === "\n" ? 3 : 2;
      } else if (e >= "0" && e <= "9") {
        let digits = e;
        let p = this.pos + 2;
        while (digits.length < 3 && this.src[p] >= "0" && this.src[p] <= "9") digits += this.src[p++];
        const code = Number(digits);
        if (code > 127) this.fail(`Unsupported byte escape \\${digits} (only ASCII escapes are accepted)`);
        out += String.fromCharCode(code);
        this.pos = p;
      } else {
        this.fail(`Unsupported string escape \\${e}`);
      }
    }
  }

  private readNumber(): number {
    const start = this.pos;
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.src.slice(this.pos, this.pos + 64));
    if (!m) this.fail("Malformed number");
    // Anything glued to a number (0x10, 12abc, 1..2) is not a plain decimal.
    const after = this.src[start + m[0].length];
    if (after !== undefined && (IDENT_PART.test(after) || after === ".")) this.fail("Malformed number");
    const value = Number(m[0]);
    if (!Number.isFinite(value)) this.fail("Number is out of range");
    this.pos = start + m[0].length;
    return value;
  }

  /** Skips one value without building it: string- and comment-aware and brace-balanced. Anything it cannot tell is a plain value is an error. */
  private skipValue(depth: number): void {
    this.skipTrivia();
    const c = this.src[this.pos];
    if (c === undefined) this.fail("Unexpected end of file (was the file caught while WoW was writing it?)");
    if (c === "{") {
      if (depth + 1 > this.maxDepth) this.fail(`Tables are nested deeper than ${this.maxDepth} levels`);
      this.pos++;
      for (;;) {
        this.skipTrivia();
        const d = this.src[this.pos];
        if (d === undefined) this.fail("Unexpected end of file inside a table (was the file caught while WoW was writing it?)");
        if (d === "}") {
          this.pos++;
          return;
        }
        if (d === "," || d === ";" || d === "=" || d === "[" || d === "]") {
          this.pos++;
        } else if (d === "{" || d === '"' || d === "'" || d === "-" || (d >= "0" && d <= "9")) {
          this.skipValue(depth + 1);
        } else if (IDENT_START.test(d)) {
          const word = this.readIdentifier()!;
          this.skipTrivia();
          // a bare word is either a `name =` field key or a true/false/nil value; nothing else is data
          if (this.src[this.pos] !== "=" && word !== "true" && word !== "false" && word !== "nil") {
            this.fail(`Unexpected identifier "${word}": only data is accepted`, this.pos - word.length);
          }
        } else {
          this.fail(`Unexpected character ${JSON.stringify(d)}: only data is accepted`);
        }
      }
    }
    this.readValue(depth);
  }
}

/** Reads the SavedVariables text into `{ VariableName: value }`. Throws `SavedVariablesParseError` on anything that is not plain data. */
export function parseSavedVariables(text: string, options: ParseLuaOptions = {}): Record<string, LuaValue> {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return new Reader(src, options.maxDepth ?? DEFAULT_MAX_DEPTH).readTopLevel(options.only);
}

/** Convenience accessors for walking a parsed table. */
export function luaGet(table: LuaValue | undefined, key: LuaKey): LuaValue | undefined {
  return table instanceof Map ? table.get(key) : undefined;
}
export const isLuaTable = (value: LuaValue | undefined): value is LuaTable => value instanceof Map;
