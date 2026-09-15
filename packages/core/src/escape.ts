// Reverses WoWSyncRender.lua's Text() escaping: backslash, tab, CR, LF are
// escaped as \\, \t, \r, \n (two-character sequences) in exported values.

export function unescapeValue(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === "\\") {
        result += "\\";
        i++;
        continue;
      }
      if (next === "t") {
        result += "\t";
        i++;
        continue;
      }
      if (next === "r") {
        result += "\r";
        i++;
        continue;
      }
      if (next === "n") {
        result += "\n";
        i++;
        continue;
      }
    }
    result += ch;
  }
  return result;
}

/** `?` means unknown; anything else is a real (unescaped) value. */
export function fieldValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === "?") return undefined;
  return unescapeValue(raw);
}

export function fieldNumber(raw: string | undefined): number | undefined {
  const text = fieldValue(raw);
  if (text === undefined) return undefined;
  const num = Number(text);
  return Number.isFinite(num) ? num : undefined;
}
