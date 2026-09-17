// WoW's copper/silver/gold currency formatting. Deterministic, pure, and
// the single implementation shared by the web UI (packages/web/src/format.ts
// re-exports these) and the LLM-facing projection (llmContext.ts) — moved
// here from packages/web so neither duplicates the conversion (100 copper =
// 1 silver, 100 silver = 1 gold, i.e. 10,000 copper = 1 gold).

export function formatCopper(copper: number | undefined): string {
  if (copper === undefined) return "?";
  const negative = copper < 0;
  const abs = Math.abs(copper);
  const gold = Math.floor(abs / 10000);
  const silver = Math.floor((abs % 10000) / 100);
  const bronze = abs % 100;
  const parts: string[] = [];
  if (gold > 0) parts.push(`${gold}g`);
  if (silver > 0 || gold > 0) parts.push(`${silver}s`);
  parts.push(`${bronze}c`);
  return (negative ? "-" : "") + parts.join(" ");
}

export function formatCopperDelta(delta: number | undefined): string {
  if (delta === undefined) return "";
  if (delta === 0) return "±0c";
  return (delta > 0 ? "+" : "") + formatCopper(delta);
}
