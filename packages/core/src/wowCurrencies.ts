// Retail currencies (the game's Currency tab), as GearExport captures them in the STRUCTURED SavedVariables section
// WoWSyncDB.characters[guid].sections.currencies. That section is never part of the WOWSYNC v1 text export: the
// bridge (import:saved / watch:saved) sends it next to the text, and the store attaches it to the snapshot the text
// became. This module is pure - validation of the section as sent, the "is it carried over?" rule, and the
// character / account read models built from stored rows. Storage lives in sqliteStore.ts.
//
// Truth rules (the same unknown-is-not-zero convention as gold in accountFacts / accountContext):
//  - A field the game did not report is null, never 0.
//  - A character whose currency list was never read is UNKNOWN - never "no currencies" and never zero.
//  - A read list that does not contain a currency says "not listed", which is not a quantity either.
//  - Account-wide currencies (isAccountWide) are one balance shared by the account: reported once, never summed.
//  - Character-scoped totals only ever sum KNOWN quantities and always travel with their contributor counts; the
//    total is omitted entirely when nothing is known.

import type { VersionOrUnknown } from "./types.ts";

export const CURRENCIES_SCHEMA = "currencies-1" as const;
/** The only `data.formatVersion` GearExport writes today. A different version is refused rather than misread. */
export const CURRENCY_FORMAT_VERSION = 1;
/** Far more than the game's Currency tab holds; a section larger than this is not what GearExport writes. */
export const MAX_CURRENCY_ENTRIES = 5000;

export type CurrencyState = "OBSERVED" | "LAST_SEEN" | "UNKNOWN";

/** Every field of one GearExport currency entry. Absent in the section = null here (never 0 / false). */
export interface CurrencyValues {
  currencyID: number;
  name: string | null;
  header: string | null;
  subHeader: string | null;
  listOrder: number | null;
  iconFileID: number | null;
  quantity: number | null;
  maxQuantity: number | null;
  quantityEarnedThisWeek: number | null;
  maxWeeklyQuantity: number | null;
  canEarnPerWeek: boolean | null;
  totalEarned: number | null;
  useTotalEarnedForMaxQty: boolean | null;
  isAccountWide: boolean | null;
  isAccountTransferable: boolean | null;
  transferPercentage: number | null;
}

/** A validated currencies section, ready to store. */
export interface CurrencySectionInput {
  /** Section `observedAt`: when the list was last read (unix seconds). */
  observedAt: number | null;
  listRead: boolean;
  completeness: string | null;
  formatVersion: number | null;
  listSize: number | null;
  listFilter: string | null;
  coverage: string | null;
  /** Set by GearExport when its most recent refresh failed and the data kept is an older read. */
  lastAttemptError: string | null;
  entries: CurrencyValues[];
  /** Entries refused (no valid currencyID, or a repeated currencyID). Counted, never guessed at. */
  droppedEntries: number;
}

export type CurrencySectionSkipReason = "not-a-table" | "no-data" | "list-not-read" | "unsupported-format" | "too-many-entries" | "unsupported-version";

export type NormalizedCurrencySection = { ok: true; section: CurrencySectionInput } | { ok: false; reason: CurrencySectionSkipReason };

/** Why a stored section is shown as LAST_SEEN even though it is attached to a snapshot. */
export type CurrencyCarryReason = "refresh-failed" | "predates-previous-export" | "no-observed-time";

/** What an import did with the currencies section that came with it. Absent from ImportResult when none came. */
export interface CurrencyImportOutcome {
  /**
   * stored         - attached to the newly imported snapshot
   * attached       - the export text was a duplicate; the section was attached to the existing snapshot (which had none)
   * already-stored - the snapshot already had a currencies section; nothing changed
   * skipped        - the section was not stored (see reason); the text import itself is unaffected
   */
  outcome: "stored" | "attached" | "already-stored" | "skipped";
  reason?: CurrencySectionSkipReason;
  snapshotId?: number;
  rows?: number;
  droppedEntries?: number;
  observedAt?: number | null;
  /** True when the section is older than this snapshot's own session: reads show it as LAST_SEEN with its date. */
  carried?: boolean;
  carriedReason?: CurrencyCarryReason;
}

// --- validation ----------------------------------------------------------------------------------------

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
/** listFilter / coverage / completeness are labels; a number or boolean label is kept as its text. */
const label = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "boolean" ? String(v) : null;

/** One entry, field by field: a missing or wrongly typed field is null. Undefined when it has no usable currencyID. */
export function normalizeCurrencyEntry(raw: unknown): CurrencyValues | undefined {
  if (!isPlain(raw)) return undefined;
  const id = raw.currencyID;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return undefined;
  return {
    currencyID: id,
    name: str(raw.name),
    header: str(raw.header),
    subHeader: str(raw.subHeader),
    listOrder: num(raw.listOrder),
    iconFileID: num(raw.iconFileID),
    quantity: num(raw.quantity),
    maxQuantity: num(raw.maxQuantity),
    quantityEarnedThisWeek: num(raw.quantityEarnedThisWeek),
    maxWeeklyQuantity: num(raw.maxWeeklyQuantity),
    canEarnPerWeek: bool(raw.canEarnPerWeek),
    totalEarned: num(raw.totalEarned),
    useTotalEarnedForMaxQty: bool(raw.useTotalEarnedForMaxQty),
    isAccountWide: bool(raw.isAccountWide),
    isAccountTransferable: bool(raw.isAccountTransferable),
    transferPercentage: num(raw.transferPercentage),
  };
}

/**
 * Validates the section envelope exactly as GearExport persists it ({ data = { listRead, formatVersion, currencies = {...} },
 * observedAt, completeness, lastAttemptError, ... }, converted from Lua to plain JSON). Only a section whose list was
 * actually read is storable; anything else is a skip with a reason - never an empty (zero) list.
 */
export function normalizeCurrencySection(input: unknown): NormalizedCurrencySection {
  if (!isPlain(input)) return { ok: false, reason: "not-a-table" };
  const data = input.data;
  if (!isPlain(data)) return { ok: false, reason: "no-data" };
  if (data.listRead !== true) return { ok: false, reason: "list-not-read" };
  const formatVersion = num(data.formatVersion);
  if (formatVersion !== CURRENCY_FORMAT_VERSION) return { ok: false, reason: "unsupported-format" };
  const rawList: unknown[] = Array.isArray(data.currencies) ? data.currencies : isPlain(data.currencies) ? Object.values(data.currencies) : [];
  if (rawList.length > MAX_CURRENCY_ENTRIES) return { ok: false, reason: "too-many-entries" };
  const entries: CurrencyValues[] = [];
  const seen = new Set<number>();
  let droppedEntries = 0;
  for (const raw of rawList) {
    const entry = normalizeCurrencyEntry(raw);
    if (!entry || seen.has(entry.currencyID)) {
      droppedEntries++;
      continue;
    }
    seen.add(entry.currencyID);
    entries.push(entry);
  }
  return {
    ok: true,
    section: {
      observedAt: num(input.observedAt),
      listRead: true,
      completeness: label(input.completeness),
      formatVersion,
      listSize: num(data.listSize),
      listFilter: label(data.listFilter),
      coverage: label(data.coverage),
      lastAttemptError: str(input.lastAttemptError),
      entries,
      droppedEntries,
    },
  };
}

/**
 * Is a section OLDER than the snapshot it arrived with? GearExport reads currencies at login and on every change,
 * and writes the text export at logout/reload, so a fresh list is normally a little older than the export's Generated
 * time - that alone does not make it stale. A section is carried (shown as LAST_SEEN with its own date) when:
 *  - GearExport recorded that its latest refresh failed (lastAttemptError): the list kept is an older read;
 *  - it has no observedAt at all (it cannot be dated to this session); or
 *  - it is older than this snapshot's capture AND no newer than the character's previous export: it was already
 *    known when that earlier export was written, so it was not re-read in this snapshot's session.
 */
export function currencyCarryReason(
  sectionObservedAt: number | null,
  snapshotObservedAt: number,
  previousSnapshotObservedAt: number | undefined,
  lastAttemptError: string | null,
): CurrencyCarryReason | undefined {
  if (lastAttemptError !== null && lastAttemptError.length > 0) return "refresh-failed";
  if (sectionObservedAt === null) return "no-observed-time";
  if (sectionObservedAt < snapshotObservedAt && previousSnapshotObservedAt !== undefined && sectionObservedAt <= previousSnapshotObservedAt) {
    return "predates-previous-export";
  }
  return undefined;
}

// --- read models ---------------------------------------------------------------------------------------

export interface CurrencyCharacterRef {
  identityKey: string;
  name: string;
  realm: string;
  version: VersionOrUnknown;
}

/** A stored section's metadata (no entries), as the store reads it. */
export interface StoredCurrencySectionMeta {
  snapshotId: number;
  /** The owning snapshot's observation time (chronology.ts snapshotObservedAt). */
  snapshotObservedAt: number;
  observedAt: number | null;
  listRead: boolean;
  completeness: string | null;
  formatVersion: number | null;
  listSize: number | null;
  listFilter: string | null;
  coverage: string | null;
  carried: boolean;
  carriedReason: CurrencyCarryReason | null;
  lastAttemptError: string | null;
  entryCount: number;
}

export type CurrencyLastSeenReason = CurrencyCarryReason | "latest-snapshot-has-no-currency-section";

export interface CurrencySectionPick {
  state: Exclude<CurrencyState, "UNKNOWN">;
  section: StoredCurrencySectionMeta;
  lastSeenReason?: CurrencyLastSeenReason;
}

/**
 * Which stored section describes the character now. The most recently READ list wins (section observedAt, then the
 * newer snapshot). It is OBSERVED only when it belongs to the character's latest snapshot and is not carried;
 * otherwise LAST_SEEN with its date. Undefined (UNKNOWN) when the character never exported a read currency list.
 */
export function pickCurrencySection(latestSnapshotId: number | undefined, sections: readonly StoredCurrencySectionMeta[]): CurrencySectionPick | undefined {
  const read = sections.filter((s) => s.listRead);
  if (read.length === 0) return undefined;
  const best = [...read].sort(
    (a, b) => (b.observedAt ?? -Infinity) - (a.observedAt ?? -Infinity) || b.snapshotObservedAt - a.snapshotObservedAt || b.snapshotId - a.snapshotId,
  )[0];
  if (best.snapshotId === latestSnapshotId && !best.carried) return { state: "OBSERVED", section: best };
  return {
    state: "LAST_SEEN",
    section: best,
    lastSeenReason: best.carried ? (best.carriedReason ?? "predates-previous-export") : "latest-snapshot-has-no-currency-section",
  };
}

export interface CharacterCurrencies {
  schema: typeof CURRENCIES_SCHEMA;
  character: CurrencyCharacterRef;
  state: CurrencyState;
  /** When the list was read (section observedAt); null for UNKNOWN (and for an undatable carried list). */
  observedAt: number | null;
  /** The snapshot the list is attached to; null for UNKNOWN. */
  snapshotId: number | null;
  /** Why the list is LAST_SEEN rather than OBSERVED; null otherwise. */
  lastSeenReason: CurrencyLastSeenReason | null;
  completeness: string | null;
  formatVersion: number | null;
  listSize: number | null;
  coverage: string | null;
  /** Every currency in the read list, in the game's list order. Null when UNKNOWN - never an empty "zero" list. */
  currencies: CurrencyValues[] | null;
}

const byListOrder = (a: CurrencyValues, b: CurrencyValues) =>
  (a.listOrder ?? Number.MAX_SAFE_INTEGER) - (b.listOrder ?? Number.MAX_SAFE_INTEGER) || a.currencyID - b.currencyID;

export function characterCurrenciesView(character: CurrencyCharacterRef, pick: CurrencySectionPick | undefined, entries: readonly CurrencyValues[]): CharacterCurrencies {
  if (!pick) {
    return {
      schema: CURRENCIES_SCHEMA,
      character,
      state: "UNKNOWN",
      observedAt: null,
      snapshotId: null,
      lastSeenReason: null,
      completeness: null,
      formatVersion: null,
      listSize: null,
      coverage: null,
      currencies: null,
    };
  }
  const s = pick.section;
  return {
    schema: CURRENCIES_SCHEMA,
    character,
    state: pick.state,
    observedAt: s.observedAt,
    snapshotId: s.snapshotId,
    lastSeenReason: pick.lastSeenReason ?? null,
    completeness: s.completeness,
    formatVersion: s.formatVersion,
    listSize: s.listSize,
    coverage: s.coverage,
    currencies: [...entries].sort(byListOrder),
  };
}

export interface AccountCurrencyCharacter {
  identityKey: string;
  name: string;
  realm: string;
  state: CurrencyState;
  observedAt: number | null;
  snapshotId: number | null;
}

export interface AccountCurrencyValue {
  identityKey: string;
  name: string;
  realm: string;
  /** The character's currency-list state. UNKNOWN: never exported a list (no value, never zero). */
  state: CurrencyState;
  observedAt: number | null;
  /** Whether the read list contained this currency; null when the list state is UNKNOWN. Not listed is not zero. */
  listed: boolean | null;
  /** The character's entry for this currency (all fields, absent = null); null when not listed or UNKNOWN. */
  currency: CurrencyValues | null;
}

export interface AccountWideCurrencyValue {
  quantity: number | null;
  maxQuantity: number | null;
  quantityEarnedThisWeek: number | null;
  maxWeeklyQuantity: number | null;
  totalEarned: number | null;
  /** The reading's list state (OBSERVED or LAST_SEEN). */
  state: Exclude<CurrencyState, "UNKNOWN">;
  observedAt: number | null;
  /** The character whose (most recent) reading this is. The balance is the account's, not this character's. */
  sourceIdentityKey: string;
}

export interface CharacterCurrencyTotals {
  /** Sum of KNOWN quantities only. Omitted when charactersWithKnownQuantity is 0 (a sum over nothing is unknown, not 0). */
  totalKnownQuantity?: number;
  charactersWithKnownQuantity: number;
  /** Listed characters whose quantity field was absent. They contribute nothing. */
  charactersListedWithoutQuantity: number;
  /** Characters whose read list did not contain the currency. Not zero - just not in their list. */
  charactersNotListed: number;
  /** Characters with no read currency list at all. Never counted as zero. */
  charactersUnknown: number;
  /** Known contributors whose list is LAST_SEEN (carried / older snapshot). Stated, never subtracted. */
  lastSeenCharactersWithKnownQuantity: number;
  /** Observation time of the oldest known contribution; omitted when nothing is known. */
  oldestKnownQuantityObservedAt?: number;
}

export interface AccountCurrency {
  currencyID: number;
  name: string | null;
  header: string | null;
  subHeader: string | null;
  iconFileID: number | null;
  listOrder: number | null;
  /** ACCOUNT: isAccountWide - one shared balance, reported once in `account`, never summed. CHARACTER: per-character balances. */
  /** UNKNOWN means captured ownership flags were absent or conflicted; no cross-character total is manufactured. */
  scope: "ACCOUNT" | "CHARACTER" | "UNKNOWN";
  /** ACCOUNT scope only: the most recent reading of the shared balance. Null for CHARACTER scope. */
  account: AccountWideCurrencyValue | null;
  /** CHARACTER scope only (known values only, see CharacterCurrencyTotals). Null for ACCOUNT scope. */
  totals: CharacterCurrencyTotals | null;
  /** Every character in the version, with its own value and state (including UNKNOWN and not-listed ones). */
  characters: AccountCurrencyValue[];
}

export interface AccountCurrencies {
  schema: typeof CURRENCIES_SCHEMA;
  version: VersionOrUnknown;
  characters: AccountCurrencyCharacter[];
  currencies: AccountCurrency[];
}

const rank = (c: CharacterCurrencies) => c.observedAt ?? -Infinity;

/** The per-currencyID account view over every character's resolved list. Pure; `perCharacter` order is kept for rows. */
export function buildAccountCurrencies(version: VersionOrUnknown, perCharacter: readonly CharacterCurrencies[]): AccountCurrencies {
  const characters: AccountCurrencyCharacter[] = perCharacter.map((c) => ({
    identityKey: c.character.identityKey,
    name: c.character.name,
    realm: c.character.realm,
    state: c.state,
    observedAt: c.observedAt,
    snapshotId: c.snapshotId,
  }));

  // Every currency any read list contains; its descriptive fields come from the most recent reading.
  const ids = new Map<number, { entry: CurrencyValues; from: CharacterCurrencies }>();
  for (const c of perCharacter) {
    for (const entry of c.currencies ?? []) {
      const prior = ids.get(entry.currencyID);
      if (!prior || rank(c) > rank(prior.from)) ids.set(entry.currencyID, { entry, from: c });
    }
  }

  const currencies: AccountCurrency[] = [];
  for (const [currencyID, { entry: descriptor }] of ids) {
    const rows: AccountCurrencyValue[] = perCharacter.map((c) => {
      const mine = c.currencies?.find((e) => e.currencyID === currencyID) ?? null;
      return {
        identityKey: c.character.identityKey,
        name: c.character.name,
        realm: c.character.realm,
        state: c.state,
        observedAt: c.observedAt,
        listed: c.currencies === null ? null : mine !== null,
        currency: mine,
      };
    });
    const readings = perCharacter.flatMap((c) => {
      const mine = c.currencies?.find((e) => e.currencyID === currencyID);
      return mine ? [{ c, mine }] : [];
    });
    const scopeEvidence = new Set(readings.map((r) => r.mine.isAccountWide));
    const scope = scopeEvidence.size === 1 && scopeEvidence.has(true) ? "ACCOUNT" as const
      : scopeEvidence.size === 1 && scopeEvidence.has(false) ? "CHARACTER" as const
      : "UNKNOWN" as const;
    let account: AccountWideCurrencyValue | null = null;
    let totals: CharacterCurrencyTotals | null = null;
    if (scope === "ACCOUNT") {
      const latest = [...readings].sort((a, b) => rank(b.c) - rank(a.c) || (a.c.state === "OBSERVED" ? -1 : 0) - (b.c.state === "OBSERVED" ? -1 : 0))[0];
      account = {
        quantity: latest.mine.quantity,
        maxQuantity: latest.mine.maxQuantity,
        quantityEarnedThisWeek: latest.mine.quantityEarnedThisWeek,
        maxWeeklyQuantity: latest.mine.maxWeeklyQuantity,
        totalEarned: latest.mine.totalEarned,
        state: latest.c.state === "OBSERVED" ? "OBSERVED" : "LAST_SEEN",
        observedAt: latest.c.observedAt,
        sourceIdentityKey: latest.c.character.identityKey,
      };
    } else if (scope === "CHARACTER") {
      const known = readings.filter((r) => r.mine.quantity !== null);
      const observedTimes = known.map((r) => r.c.observedAt).filter((t): t is number => t !== null);
      totals = {
        charactersWithKnownQuantity: known.length,
        charactersListedWithoutQuantity: readings.length - known.length,
        charactersNotListed: rows.filter((r) => r.listed === false).length,
        charactersUnknown: rows.filter((r) => r.state === "UNKNOWN").length,
        lastSeenCharactersWithKnownQuantity: known.filter((r) => r.c.state === "LAST_SEEN").length,
      };
      if (known.length > 0) totals.totalKnownQuantity = known.reduce((sum, r) => sum + (r.mine.quantity as number), 0);
      if (observedTimes.length > 0) totals.oldestKnownQuantityObservedAt = Math.min(...observedTimes);
    }
    currencies.push({
      currencyID,
      name: descriptor.name,
      header: descriptor.header,
      subHeader: descriptor.subHeader,
      iconFileID: descriptor.iconFileID,
      listOrder: descriptor.listOrder,
      scope,
      account,
      totals,
      characters: rows,
    });
  }
  currencies.sort(
    (a, b) =>
      (a.listOrder ?? Number.MAX_SAFE_INTEGER) - (b.listOrder ?? Number.MAX_SAFE_INTEGER) || (a.name ?? "").localeCompare(b.name ?? "") || a.currencyID - b.currencyID,
  );
  return { schema: CURRENCIES_SCHEMA, version, characters, currencies };
}
