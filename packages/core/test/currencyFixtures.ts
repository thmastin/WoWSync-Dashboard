// Retail currencies in the exact M1 shape GearExport persists as WoWSyncDB.characters[guid].sections.currencies
// (WoWSyncCore S.Commit envelope + WoWSyncCollectors currencies data). Synthetic values; shared by the core and
// server tests. `currencySectionLua` is the same section as WoW writes it to SavedVariables (Lua, array rows with
// "-- [n]" comments), `currencySection` its plain-JSON form (what the bridge sends after converting the Lua tables).

export interface CurrencyEntrySpec {
  currencyID: number;
  listOrder: number;
  header?: string;
  subHeader?: string;
  name?: string;
  iconFileID?: number;
  quantity?: number;
  maxQuantity?: number;
  quantityEarnedThisWeek?: number;
  maxWeeklyQuantity?: number;
  canEarnPerWeek?: boolean;
  totalEarned?: number;
  useTotalEarnedForMaxQty?: boolean;
  isAccountWide?: boolean;
  isAccountTransferable?: boolean;
  transferPercentage?: number;
}

/** A Retail character's read currency list. Absent fields are OMITTED (as GearExport does), never 0. */
export const RETAIL_CURRENCIES: CurrencyEntrySpec[] = [
  {
    currencyID: 3008,
    listOrder: 1,
    header: "The War Within",
    name: "Valorstones",
    iconFileID: 5868902,
    quantity: 1540,
    maxQuantity: 2000,
    canEarnPerWeek: false,
    useTotalEarnedForMaxQty: false,
    isAccountWide: false,
    isAccountTransferable: true,
    transferPercentage: 90,
  },
  {
    currencyID: 2803,
    listOrder: 2,
    header: "The War Within",
    subHeader: "Delves",
    name: "Undercoin",
    iconFileID: 2032600,
    quantity: 3200,
    maxQuantity: 0,
    canEarnPerWeek: false,
    useTotalEarnedForMaxQty: false,
    isAccountWide: true,
    isAccountTransferable: false,
  },
  // A real zero (the game reported 0) - must stay 0, distinct from an absent field.
  {
    currencyID: 3028,
    listOrder: 3,
    header: "The War Within",
    subHeader: "Delves",
    name: "Restored Coffer Key",
    iconFileID: 4622270,
    quantity: 0,
    canEarnPerWeek: false,
    isAccountWide: false,
    isAccountTransferable: false,
  },
  {
    currencyID: 3290,
    listOrder: 4,
    header: "The War Within",
    subHeader: "Season 3",
    name: "Gilded Ethereal Crest",
    iconFileID: 6215560,
    quantity: 45,
    maxQuantity: 360,
    quantityEarnedThisWeek: 45,
    maxWeeklyQuantity: 90,
    canEarnPerWeek: true,
    totalEarned: 300,
    useTotalEarnedForMaxQty: true,
    isAccountWide: false,
    isAccountTransferable: false,
  },
  // Sparse row: only the always-written fields plus a name (GearExport omits what the game did not report).
  { currencyID: 1166, listOrder: 5, header: "Miscellaneous", name: "Timewarped Badge" },
];

export interface CurrencySectionSpec {
  observedAt: number;
  entries?: CurrencyEntrySpec[];
  completeness?: string;
  lastAttemptError?: string;
  listRead?: boolean;
  formatVersion?: number;
}

/** The section envelope as plain JSON (what the bridge sends). */
export function currencySection(spec: CurrencySectionSpec): Record<string, unknown> {
  const entries = spec.entries ?? RETAIL_CURRENCIES;
  const out: Record<string, unknown> = {
    data: {
      listRead: spec.listRead ?? true,
      formatVersion: spec.formatVersion ?? 1,
      listSize: entries.length + 3,
      listFilter: 0,
      currencies: entries.map((e) => ({ ...e })),
      coverage: "Retail C_CurrencyInfo currency list with every header expanded; discovered currencies only",
    },
    observedAt: spec.observedAt,
    changedAt: spec.observedAt,
    revision: 1,
    completeness: spec.completeness ?? "complete",
    source: "client",
    capture: 1,
  };
  if (spec.lastAttemptError !== undefined) {
    out.lastAttemptAt = spec.observedAt + 60;
    out.lastAttemptError = spec.lastAttemptError;
  }
  return out;
}

const luaValue = (v: unknown): string => (typeof v === "string" ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : String(v));

/** The same section as WoW writes it inside `["sections"] = { ... }` (key/value order is WoW's, i.e. arbitrary). */
export function currencySectionLua(spec: CurrencySectionSpec): string {
  const entries = spec.entries ?? RETAIL_CURRENCIES;
  const lines = ['["currencies"] = {', '["data"] = {', '["currencies"] = {'];
  entries.forEach((e, i) => {
    lines.push("{");
    for (const [k, v] of Object.entries(e)) lines.push(`["${k}"] = ${luaValue(v)},`);
    lines.push(`}, -- [${i + 1}]`);
  });
  lines.push(
    "},",
    `["listSize"] = ${entries.length + 3},`,
    `["formatVersion"] = ${spec.formatVersion ?? 1},`,
    `["listRead"] = ${spec.listRead ?? true},`,
    '["listFilter"] = 0,',
    '["coverage"] = "Retail C_CurrencyInfo currency list with every header expanded; discovered currencies only",',
    "},",
    `["observedAt"] = ${spec.observedAt},`,
    `["changedAt"] = ${spec.observedAt},`,
    '["revision"] = 1,',
    `["completeness"] = "${spec.completeness ?? "complete"}",`,
    '["source"] = "client",',
    '["capture"] = 1,',
  );
  if (spec.lastAttemptError !== undefined) lines.push(`["lastAttemptAt"] = ${spec.observedAt + 60},`, `["lastAttemptError"] = ${luaValue(spec.lastAttemptError)},`);
  lines.push("},");
  return lines.join("\r\n");
}