// Shared-storage reconciliation: the PURE domain model (checkpoint C1).
//
// Warband and Guild storage are not owned by the character whose export happened to
// deliver them. This module separates the two ideas:
//
//   OWNER       who the storage belongs to (the Warband, or one guild). Never a character.
//   OBSERVATION one immutable fact: "this owner's storage looked like THIS at time T".
//   SOURCE      provenance: which export (and which character's label) carried it.
//
// State is a journal of observations plus provenance. The "current" state of an owner is
// NOT stored: it is DERIVED on demand by `projectOwner` from the journal alone, so the
// result cannot depend on the order in which exports arrived (tests permute it).
//
// Nothing here touches SQLite, the importer, the API, the web app, or any existing
// projection (AccountFacts / AccountContext / LlmContext / diffs). Character storage
// ([BANK]) is never admitted: it stays character-owned and outside this module.
//
// Trust rules this module enforces:
//   - UNKNOWN is not evidence: it is never journaled, so it can never erase anything.
//   - LAST_SEEN is a REPLAY of an earlier observation, not a new one. The observation's
//     identity ignores the carrier state, so an OBSERVED export and any number of
//     LAST_SEEN exports of the same record are one observation with several sources.
//   - A newer partial or informationless capture never displaces an older informative
//     complete one.
//   - A projection is DERIVED. It selects ONE underlying observation (each keeps its own
//     time and coverage); it never splices observations together, and it never claims
//     to be OBSERVED.
import { createHash } from "node:crypto";
import type {
  AccountBankSection,
  ContainerRecord,
  GuildBankSection,
  GuildBankTab,
  InventoryItemRecord,
  ParsedSnapshot,
} from "./types.ts";

// --- Owners --------------------------------------------------------------------------------------

/**
 * Which "account" a Warband belongs to.
 *
 * `installation-local` means: THIS Dashboard installation's single, undifferentiated
 * Retail account scope. It is NOT a Blizzard/Battle.net account id, and no account id is
 * inferred from anything. WOWSYNC exports carry no verified account identifier, so if two
 * Battle.net accounts were imported into one Dashboard their Warbands could not be told
 * apart (they would be reconciled as one). That is a known, accepted limitation; a stable
 * discriminator has to come from the addon (deferred question).
 *
 * The extension point: when a real discriminator exists, add a variant here (for example
 * `{ kind: "account"; id: string }`). `ownerKey` is an exhaustive switch, so the compiler
 * then points at every place that must handle it; the reconciliation itself does not change.
 */
export type AccountScope = { readonly kind: "installation-local" };

export const INSTALLATION_LOCAL_ACCOUNT: AccountScope = Object.freeze({ kind: "installation-local" });

/** A character's own bank. Character-owned and OUTSIDE shared reconciliation; listed only so the ownership model is complete in one place. */
export interface CharacterStorageOwner {
  readonly kind: "character";
  readonly identityKey: string;
}

export interface WarbandOwner {
  readonly kind: "warband";
  readonly version: "retail";
  readonly account: AccountScope;
}

export interface GuildOwner {
  readonly kind: "guild";
  readonly version: "retail";
  /**
   * The addon's `GuildClubID` text, opaque. Never parsed as a number (values can exceed
   * 2^53 and two distinct IDs can be the same JS number), never case-folded, and a
   * scientific-notation-looking value is just a string. Only surrounding whitespace is trimmed.
   */
  readonly guildClubId: string;
}

export type SharedStorageOwner = WarbandOwner | GuildOwner;
export type StorageOwner = CharacterStorageOwner | SharedStorageOwner;

export function isSharedStorageOwner(owner: StorageOwner): owner is SharedStorageOwner {
  return owner.kind === "warband" || owner.kind === "guild";
}

/** The Warband of this installation's local (undifferentiated) Retail account scope. */
export function warbandOwner(account: AccountScope = INSTALLATION_LOCAL_ACCOUNT): WarbandOwner {
  return { kind: "warband", version: "retail", account };
}

export function guildOwner(guildClubId: string): GuildOwner {
  return { kind: "guild", version: "retail", guildClubId };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled shared-storage owner: ${JSON.stringify(value)}`);
}

/**
 * Serialized owner key. `retail::warband::local` is an internal key for the
 * installation-local scope, not an account id.
 */
export function ownerKey(owner: SharedStorageOwner): string {
  switch (owner.kind) {
    case "warband": {
      const account = owner.account;
      switch (account.kind) {
        case "installation-local":
          return `${owner.version}::warband::local`;
        default:
          return assertNever(account.kind);
      }
    }
    case "guild":
      return `${owner.version}::guild::${owner.guildClubId}`;
    default:
      return assertNever(owner);
  }
}

// --- Observations and provenance -----------------------------------------------------------------

export type SharedSectionName = "accountBank" | "guildBank";
/** How the CARRYING export rendered the section. Provenance only; never part of an observation's identity. */
export type CarrierState = "OBSERVED" | "LAST_SEEN";
export type Completeness = "complete" | "partial";

/**
 * What the persistence layer will later know about the export that carried a section.
 * The labels are HISTORICAL provenance text ("who delivered this"), deliberately not a
 * reference to a live character record: deleting the character must not delete, or
 * dangle, a shared observation (a character is a transporter, not an owner).
 */
export interface CarrierExport {
  /** Identifies the carrying export; (observation, snapshotId) is the provenance key. */
  snapshotId: number;
  sourceIdentityKey: string;
  sourceName: string;
  sourceRealm: string;
  /** When the carrying export's game state existed (chronology.ts `snapshotObservedAt`). A ceiling for the section's own observation time. */
  exportObservedAt: number;
}

/**
 * Semantic content of one observation: exactly the fields that are hashed. Arrays are in
 * canonical order. Transport noise (visit metadata, refresh/pending flags, coverage prose,
 * carrier state) is NOT here; it lives on the sources.
 */
export interface SharedContent {
  guildName?: string;
  /** Warband: purchased tab count. */
  purchasedTabs?: number;
  /** Guild only; empty for Warband. Tab ids/names/permissions/states as the observer saw them. */
  tabs: GuildBankTab[];
  containers: ContainerRecord[];
  freeSlots?: number;
  totalSlots?: number;
  itemsKnownEmpty: boolean;
  items: InventoryItemRecord[];
}

/** One immutable observation. Identity is the OBSERVATION, not any export of it. */
export interface SharedObservation {
  /** See `observationIdentity`. */
  identity: string;
  ownerKey: string;
  owner: SharedStorageOwner;
  /** `observed=` exactly as the addon claimed it. */
  claimedObservedAt: number;
  completeness: Completeness;
  content: SharedContent;
  contentHash: string;
}

/** Provenance: one carrying export of an observation. */
export interface SharedObservationSource {
  snapshotId: number;
  carrierState: CarrierState;
  exportObservedAt: number;
  sourceIdentityKey: string;
  sourceName: string;
  sourceRealm: string;
  /** Carrier metadata that legitimately differs between exports of one observation. */
  snapshotVisit?: number;
  lastVisit?: number;
  visitedNpc?: string;
  visitedZone?: string;
  coverageNote?: string;
  refreshIssue?: string;
  pending?: boolean;
}

// --- Canonicalization and identity ---------------------------------------------------------------

const CONTENT_HASH_VERSION = 1;

/** JSON with sorted object keys; undefined becomes null. Deterministic for equal structures. */
function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sortedByJson<T>(values: readonly T[]): T[] {
  return values
    .map((value) => ({ value, key: canonicalJson(value) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** A detached, canonically ordered, frozen copy of the semantic content of a shared section. */
function canonicalContent(section: AccountBankSection | GuildBankSection): SharedContent {
  const guild = section.ownerScope === "GUILD" ? (section as GuildBankSection) : undefined;
  const content: SharedContent = {
    guildName: guild?.guildName,
    purchasedTabs: guild ? undefined : section.purchasedBankTabs,
    tabs: sortedByJson(
      (guild?.tabs ?? []).map((tab) => ({ id: tab.id, name: tab.name, viewable: tab.viewable, state: tab.state, note: tab.note })),
    ),
    containers: sortedByJson(
      section.containers.map((c) => ({ id: c.id, storage: c.storage, capacity: c.capacity, free: c.free, family: c.family, bagRef: c.bagRef })),
    ),
    freeSlots: section.freeSlots,
    totalSlots: section.totalSlots,
    itemsKnownEmpty: section.itemsKnownEmpty,
    items: sortedByJson(
      section.items.map((i) => ({ itemRef: i.itemRef, name: i.name, qty: i.qty, bound: i.bound, vendorEachCopper: i.vendorEachCopper })),
    ),
  };
  return deepFreeze(content);
}

/**
 * Hash of an observation's meaning. INCLUDED: content kind, completeness, guild name,
 * purchased tabs, every tab (id, name, viewable, state, note), every container, slot
 * totals, known-empty flag, every item row. EXCLUDED (transport/presentation noise that
 * can differ between exports of one observation): carrier state, SnapshotVisit, LastVisit /
 * VisitedNPC / VisitedZone / VisitStatus, Pending, RefreshIssue (the addon rewrites it
 * on a stored record without re-observing), CoverageNote, the Coverage prose line, the
 * owner (part of the identity, not the content), and every export/character field.
 */
export function hashSharedContent(kind: SharedStorageOwner["kind"], completeness: Completeness, content: SharedContent): string {
  return createHash("sha256")
    .update(canonicalJson({ v: CONTENT_HASH_VERSION, kind, completeness, ...content }))
    .digest("hex");
}

/**
 * The semantic identity of an observation: "this owner's storage, observed at this time,
 * with this content and completeness". It deliberately excludes the carrier state, the
 * carrying export, and SnapshotVisit (see `hashSharedContent`).
 */
export function observationIdentity(ownerKeyText: string, claimedObservedAt: number, contentHash: string): string {
  return JSON.stringify([ownerKeyText, claimedObservedAt, contentHash]);
}

// --- Admission -----------------------------------------------------------------------------------

export type SkipReason =
  /** State: UNKNOWN. Not evidence of anything. */
  | "unknown-state"
  /** No usable owner identity (a guild section without a GuildClubID). */
  | "unattributable"
  /** No usable observation time, so it cannot be ordered. */
  | "unanchored"
  | "unsupported-state";

export type Admission =
  | { admitted: true; section: SharedSectionName; observation: SharedObservation; source: SharedObservationSource }
  | { admitted: false; section: SharedSectionName; reason: SkipReason };

function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Decides whether one parsed shared section is admissible as an observation and, if so,
 * builds it. Pure: does not mutate the section and copies everything it keeps.
 */
export function admitSection(section: AccountBankSection | GuildBankSection, carrier: CarrierExport): Admission {
  const name: SharedSectionName = section.ownerScope === "GUILD" ? "guildBank" : "accountBank";
  if (!isUnixSeconds(carrier.exportObservedAt)) throw new TypeError("CarrierExport.exportObservedAt must be positive Unix seconds");

  const status = section.status;
  if (status.state === "UNKNOWN") return { admitted: false, section: name, reason: "unknown-state" };
  if (status.state !== "OBSERVED" && status.state !== "LAST_SEEN") return { admitted: false, section: name, reason: "unsupported-state" };

  let owner: SharedStorageOwner;
  if (section.ownerScope === "GUILD") {
    const id = (section as GuildBankSection).guildClubId?.trim();
    if (!id) return { admitted: false, section: name, reason: "unattributable" };
    owner = guildOwner(id);
  } else {
    owner = warbandOwner();
  }

  const claimedObservedAt = status.observedAt;
  if (!isUnixSeconds(claimedObservedAt)) return { admitted: false, section: name, reason: "unanchored" };

  // Anything other than an explicit "complete" is treated as partial: never grant completeness by default.
  const completeness: Completeness = status.completeness === "complete" ? "complete" : "partial";
  const content = canonicalContent(section);
  const contentHash = hashSharedContent(owner.kind, completeness, content);
  const key = ownerKey(owner);

  const observation: SharedObservation = {
    identity: observationIdentity(key, claimedObservedAt, contentHash),
    ownerKey: key,
    owner,
    claimedObservedAt,
    completeness,
    content,
    contentHash,
  };
  const source: SharedObservationSource = {
    snapshotId: carrier.snapshotId,
    carrierState: status.state,
    exportObservedAt: carrier.exportObservedAt,
    sourceIdentityKey: carrier.sourceIdentityKey,
    sourceName: carrier.sourceName,
    sourceRealm: carrier.sourceRealm,
    snapshotVisit: section.snapshotVisit,
    lastVisit: status.lastVisit,
    visitedNpc: status.visitedNPC,
    visitedZone: status.visitedZone,
    coverageNote: status.coverageNote,
    refreshIssue: status.refreshIssue,
    pending: status.pending,
  };
  return { admitted: true, section: name, observation: deepFreeze(observation), source: deepFreeze(source) };
}

/** Admission for every shared section an export carries. Character storage (`bank`) is never looked at. */
export function admitExport(parsed: Pick<ParsedSnapshot, "accountBank" | "guildBank">, carrier: CarrierExport): Admission[] {
  const results: Admission[] = [];
  if (parsed.accountBank) results.push(admitSection(parsed.accountBank, carrier));
  if (parsed.guildBank) results.push(admitSection(parsed.guildBank, carrier));
  return results;
}

// --- The journal ---------------------------------------------------------------------------------

export interface JournalEntry {
  readonly observation: SharedObservation;
  /** Keyed by snapshotId: an export is recorded as a source of an observation at most once. */
  readonly sources: ReadonlyMap<number, SharedObservationSource>;
}

/** An immutable, order-insensitive set of observations with their provenance. */
export interface SharedJournal {
  readonly entries: ReadonlyMap<string, JournalEntry>;
}

export const EMPTY_JOURNAL: SharedJournal = Object.freeze({ entries: new Map<string, JournalEntry>() });

export type AdmitOutcome = "new-observation" | "new-source" | "already-known";

/**
 * Adds an admitted observation + source. Idempotent: the same export delivering the same
 * observation again changes nothing (returns the same journal object).
 */
export function addToJournal(
  journal: SharedJournal,
  observation: SharedObservation,
  source: SharedObservationSource,
): { journal: SharedJournal; outcome: AdmitOutcome } {
  const existing = journal.entries.get(observation.identity);
  if (existing?.sources.has(source.snapshotId)) return { journal, outcome: "already-known" };
  const entries = new Map(journal.entries);
  if (existing) {
    entries.set(observation.identity, { observation: existing.observation, sources: new Map(existing.sources).set(source.snapshotId, source) });
    return { journal: { entries }, outcome: "new-source" };
  }
  entries.set(observation.identity, { observation, sources: new Map([[source.snapshotId, source]]) });
  return { journal: { entries }, outcome: "new-observation" };
}

export interface RecordedSection {
  section: SharedSectionName;
  outcome: AdmitOutcome | "skipped";
  reason?: SkipReason;
  ownerKey?: string;
  identity?: string;
  /** True when this call made the observation its owner's CURRENT one (it was not before). */
  becameCurrent?: boolean;
}

/** Records every shared section of one export. Skipped sections change nothing (UNKNOWN never erases). */
export function recordExport(
  journal: SharedJournal,
  parsed: Pick<ParsedSnapshot, "accountBank" | "guildBank">,
  carrier: CarrierExport,
): { journal: SharedJournal; sections: RecordedSection[] } {
  let current = journal;
  const sections: RecordedSection[] = [];
  for (const admission of admitExport(parsed, carrier)) {
    if (!admission.admitted) {
      sections.push({ section: admission.section, outcome: "skipped", reason: admission.reason });
      continue;
    }
    const before = projectOwnerFromJournal(current, admission.observation.owner)?.current?.identity;
    const added = addToJournal(current, admission.observation, admission.source);
    current = added.journal;
    const after = projectOwnerFromJournal(current, admission.observation.owner)?.current?.identity;
    sections.push({
      section: admission.section,
      outcome: added.outcome,
      ownerKey: admission.observation.ownerKey,
      identity: admission.observation.identity,
      becameCurrent: after === admission.observation.identity && before !== after,
    });
  }
  return { journal: current, sections };
}

// --- Projection ----------------------------------------------------------------------------------

/** What an observation actually covered. Tab ids are per-guild ordinals, so they are comparable across observations. */
export interface ObservationCoverage {
  /** Guild tabs whose contents were observed. */
  observedTabs: number[];
  /** Guild tabs the observing character could not view: contents UNKNOWN, never empty. */
  inaccessibleTabs: number[];
  /** Guild tabs that were viewable but not confirmed (UNKNOWN or any unrecognized state): contents UNKNOWN. */
  unconfirmedTabs: number[];
  /** Tab rows that carried no usable id (cannot be compared across observations). */
  unidentifiedTabs: number;
  /** Container ids that were scanned (guild container ids are tab ids; Warband ids are account-bank container ids). */
  observedContainerIds: number[];
}

export interface ProjectedObservation {
  identity: string;
  ownerKey: string;
  claimedObservedAt: number;
  /** min(claimed, every carrying export's own observation time): a section cannot be observed after the export that carries it. */
  effectiveObservedAt: number;
  /** True when the claimed time was later than a carrying export, so it was clamped. */
  claimedAfterCarrier: boolean;
  completeness: Completeness;
  /** False when nothing was actually scanned (e.g. every guild tab inaccessible): can never be the current state. */
  informative: boolean;
  content: SharedContent;
  contentHash: string;
  coverage: ObservationCoverage;
  /** Provenance, sorted by (exportObservedAt, snapshotId). */
  sources: SharedObservationSource[];
  /** Distinct carrier states seen, sorted. A replay is `LAST_SEEN`; it is not a new observation. */
  carrierStates: CarrierState[];
  /** True if at least one carrying export rendered it as OBSERVED (the bank was open when that export was made). */
  liveAtExport: boolean;
  /** Distinct carrying characters (identity keys), sorted. */
  sourceCharacterKeys: string[];
}

export interface OwnerProjection {
  /** Always DERIVED: a selection over observations, never itself an observation. */
  basis: "DERIVED";
  owner: SharedStorageOwner;
  ownerKey: string;
  /**
   * The newest informative COMPLETE observation, else the newest informative partial one.
   * Undefined if the owner has no informative observation at all.
   */
  current?: ProjectedObservation;
  /** A newer informative PARTIAL observation than a complete `current`. Never merged into it. */
  latestPartial?: ProjectedObservation;
  /**
   * Guild only. The newest OLDER complete observation that observed strictly more tabs than
   * `current` (e.g. a character with wider permissions). Reported separately; never spliced in.
   */
  broaderCoverageEarlier?: ProjectedObservation;
  /** Two or more observations with DIFFERENT content share the top effective time; `current` is picked by a fixed rule and the rest are listed. */
  conflict?: { effectiveObservedAt: number; others: ProjectedObservation[] };
  observationCount: { total: number; complete: number; partial: number; informationless: number };
}

function compareNewestFirst(a: ProjectedObservation, b: ProjectedObservation): number {
  return (
    b.effectiveObservedAt - a.effectiveObservedAt ||
    b.claimedObservedAt - a.claimedObservedAt ||
    (a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0) ||
    (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0)
  );
}

function coverageOf(content: SharedContent): ObservationCoverage {
  const observedTabs: number[] = [];
  const inaccessibleTabs: number[] = [];
  const unconfirmedTabs: number[] = [];
  let unidentifiedTabs = 0;
  for (const tab of content.tabs) {
    if (tab.id === undefined) {
      unidentifiedTabs++;
    } else if (tab.state === "OBSERVED") {
      observedTabs.push(tab.id);
    } else if (tab.state === "INACCESSIBLE") {
      inaccessibleTabs.push(tab.id);
    } else {
      unconfirmedTabs.push(tab.id);
    }
  }
  const byNumber = (a: number, b: number) => a - b;
  return {
    observedTabs: observedTabs.sort(byNumber),
    inaccessibleTabs: inaccessibleTabs.sort(byNumber),
    unconfirmedTabs: unconfirmedTabs.sort(byNumber),
    unidentifiedTabs,
    observedContainerIds: content.containers.map((c) => c.id).sort(byNumber),
  };
}

function project(entry: JournalEntry): ProjectedObservation {
  const { observation } = entry;
  const sources = [...entry.sources.values()].sort((a, b) => a.exportObservedAt - b.exportObservedAt || a.snapshotId - b.snapshotId);
  const effectiveObservedAt = Math.min(observation.claimedObservedAt, ...sources.map((s) => s.exportObservedAt));
  const content = observation.content;
  return {
    identity: observation.identity,
    ownerKey: observation.ownerKey,
    claimedObservedAt: observation.claimedObservedAt,
    effectiveObservedAt,
    claimedAfterCarrier: observation.claimedObservedAt > effectiveObservedAt,
    completeness: observation.completeness,
    // Something was actually scanned. "Items: EMPTY" with no scanned container is not evidence of an empty bank.
    informative: content.containers.length > 0 || content.items.length > 0,
    content,
    contentHash: observation.contentHash,
    coverage: coverageOf(content),
    sources,
    carrierStates: [...new Set(sources.map((s) => s.carrierState))].sort(),
    liveAtExport: sources.some((s) => s.carrierState === "OBSERVED"),
    sourceCharacterKeys: [...new Set(sources.map((s) => s.sourceIdentityKey))].sort(),
  };
}

function isStrictSuperset(larger: readonly number[], smaller: readonly number[]): boolean {
  if (larger.length <= smaller.length) return false;
  const set = new Set(larger);
  return smaller.every((id) => set.has(id));
}

/** Pure selection over one owner's journal entries. Order of `entries` is irrelevant. */
export function projectOwner(owner: SharedStorageOwner, entries: readonly JournalEntry[]): OwnerProjection | undefined {
  const key = ownerKey(owner);
  const own = entries.filter((e) => e.observation.ownerKey === key);
  if (own.length === 0) return undefined;

  const projected = own.map(project).sort(compareNewestFirst);
  const informative = projected.filter((p) => p.informative);
  const complete = informative.filter((p) => p.completeness === "complete");
  const partial = informative.filter((p) => p.completeness === "partial");

  const pool = complete.length > 0 ? complete : partial;
  const current = pool[0];

  const latestPartial = current && current.completeness === "complete" ? partial.find((p) => compareNewestFirst(p, current) < 0) : undefined;

  let broaderCoverageEarlier: ProjectedObservation | undefined;
  if (current && owner.kind === "guild" && current.coverage.observedTabs.length > 0) {
    broaderCoverageEarlier = complete.find(
      (p) => compareNewestFirst(current, p) < 0 && isStrictSuperset(p.coverage.observedTabs, current.coverage.observedTabs),
    );
  }

  let conflict: OwnerProjection["conflict"];
  if (current) {
    const others = pool.filter((p) => p !== current && p.effectiveObservedAt === current.effectiveObservedAt && p.contentHash !== current.contentHash);
    if (others.length > 0) conflict = { effectiveObservedAt: current.effectiveObservedAt, others };
  }

  return {
    basis: "DERIVED",
    owner,
    ownerKey: key,
    current,
    latestPartial,
    broaderCoverageEarlier,
    conflict,
    observationCount: {
      total: projected.length,
      complete: projected.filter((p) => p.completeness === "complete").length,
      partial: projected.filter((p) => p.completeness === "partial").length,
      informationless: projected.length - informative.length,
    },
  };
}

export function projectOwnerFromJournal(journal: SharedJournal, owner: SharedStorageOwner): OwnerProjection | undefined {
  return projectOwner(owner, [...journal.entries.values()]);
}

export interface SharedStorageProjection {
  /** Absent when the Warband has no observation in the journal (never observed, which is not "empty"). */
  warband?: OwnerProjection;
  /** One per guild that has at least one observation, sorted by owner key. */
  guilds: OwnerProjection[];
}

/** Every owner in the journal. Independent per owner: one guild never affects another, and neither affects the Warband. */
export function projectJournal(journal: SharedJournal): SharedStorageProjection {
  const owners = new Map<string, SharedStorageOwner>();
  for (const entry of journal.entries.values()) owners.set(entry.observation.ownerKey, entry.observation.owner);
  const all = [...owners.values()];
  const entries = [...journal.entries.values()];
  const projections = all
    .map((owner) => projectOwner(owner, entries))
    .filter((p): p is OwnerProjection => p !== undefined)
    .sort((a, b) => (a.ownerKey < b.ownerKey ? -1 : a.ownerKey > b.ownerKey ? 1 : 0));
  return {
    warband: projections.find((p) => p.owner.kind === "warband"),
    guilds: projections.filter((p) => p.owner.kind === "guild"),
  };
}
