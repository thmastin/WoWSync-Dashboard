// Presentation rules for the Shared Storage surface (checkpoint C5). Pure, so the trust wording is
// unit-tested instead of living inside JSX. Everything here reads the C4 API document
// (GET /api/shared-storage) and decides how to SAY it; nothing here reconciles anything.
//
// The rules the wording enforces:
//   - a shared storage belongs to its OWNER (the Warband, or one guild), never to the character whose
//     export carried it; provenance says which exports carried it, not whose bank it is;
//   - ONE underlying observation can be carried by many exports: N exports never mean N observations;
//   - "Derived" means the Dashboard chose which observation is current; the observation itself is real evidence;
//   - freshness is the AGE of the observation; "last seen" describes how the carrying exports related to it.
//     "Recent" + "last seen" is not a contradiction and the wording says so;
//   - UNKNOWN is never "empty": an inaccessible or unconfirmed tab, or no informative observation at all, is
//     "contents unknown"; "empty" is only ever claimed for an observation that scanned tabs and found nothing;
//   - a newer partial, an earlier broader, or a conflicting observation is SURFACED, never merged or hidden;
//   - the item list is aggregated: the observation does not record which tab held an item, so none is implied.
import { RECENT_THRESHOLD_SECONDS } from "@wowsync-dashboard/core/freshness.ts";
import { ApiError, describeApiError, sharedStorageIntegrityDetails } from "./api.ts";
import { formatAbsoluteTime, formatAgeSeconds, freshnessLabel } from "./format.ts";
import { describeGuildTab, type TabDescription } from "./guildBank.ts";
import type {
  CarrierState,
  SharedObservationView,
  SharedOwnerIdentity,
  SharedOwnerView,
  SharedProvenanceView,
  SharedStorageIntegrityErrorBody,
  SharedStorageResponse,
} from "./types.ts";

type FormatTime = (unixSeconds: number | undefined) => string;

/** The sentence every deletion surface must carry. Not "permanent", not "forget forever": a later export may add it back. */
export const REAPPEARANCE_WARNING = "Clears stored shared-storage history. A later WoWSync export may add it again.";

/** What the "Derived" tag means: the Dashboard picked the current observation; the observation itself is real evidence. */
export const DERIVED_EXPLANATION =
  "Derived: the Dashboard reconciled every stored observation of this storage and chose the current one. The observation itself is real, observed evidence.";

// --- the character page: what an export CARRIED --------------------------------------------------------------------

export const CARRIED_WARBAND_TITLE = "Warband Bank carried by this export";
export const CARRIED_GUILD_TITLE = "Guild Bank carried by this export";
export const CARRIED_WARBAND_NOTE =
  "This export carried an observation of the account-level Warband Bank. It is historical evidence from this export, not this character's bank; the reconciled Warband Bank is in Shared Storage.";
export const CARRIED_GUILD_NOTE =
  "This export carried an observation of a guild-level Guild Bank. It is historical evidence from this export, not this character's bank; the reconciled Guild Bank is in Shared Storage.";
export const OPEN_SHARED_WARBAND = "View the reconciled Warband Bank →";
export const OPEN_SHARED_GUILD = "View the reconciled Guild Bank →";

// --- whole-page state -----------------------------------------------------------------------------------

export const EMPTY_HEADLINE = "No shared storage has been observed yet";
export const EMPTY_DETAIL =
  "The Warband Bank and Guild Banks appear here once a WoWSync export carries an observation of them (open the bank in game, then export). An unobserved bank is unknown, not empty.";

/** True when the API document holds no owner at all. */
export function isEmptyShared(response: SharedStorageResponse): boolean {
  return response.warband === null && response.guilds.length === 0;
}

/** Owners in display order: the Warband first, then guilds (the API already sorts those by owner key). */
export function orderedOwners(response: SharedStorageResponse): SharedOwnerView[] {
  return [...(response.warband ? [response.warband] : []), ...response.guilds];
}

// --- owner identity -----------------------------------------------------------------------------------------

export interface OwnerHeading {
  title: string;
  /** One plain line saying what kind of storage this is. */
  kindLabel: string;
  /** Technical identity, shown in a details section rather than as the headline. */
  technical: Array<{ label: string; value: string }>;
}

export function ownerHeading(owner: SharedOwnerIdentity): OwnerHeading {
  if (owner.kind === "warband") {
    return {
      title: "Warband Bank",
      kindLabel: "Account-level shared storage",
      technical: [
        { label: "Scope", value: "This Dashboard's local Retail account scope. It is not a Battle.net account id." },
        { label: "Owner key", value: owner.ownerKey },
      ],
    };
  }
  return {
    title: owner.guildName ?? "Guild Bank",
    kindLabel: owner.guildName ? "Guild Bank · guild-level shared storage" : "Guild Bank · guild name not recorded",
    technical: [
      { label: "GuildClubID", value: owner.guildClubId },
      { label: "Owner key", value: owner.ownerKey },
    ],
  };
}

// --- one observation ------------------------------------------------------------------------------------------

export interface TimingDescription {
  /** "Observed <time>": when the storage was actually looked at (not when any export was made). */
  observed: string;
  age: string;
  /** Labelled freshness by the Dashboard's single freshness rule. */
  freshness: "recent" | "stale" | "unknown";
  freshnessLabel: string;
  /** What "recent"/"stale" means, and that it is about the observation's age. */
  freshnessNote: string;
  /** Set only when the addon's claimed time was later than the export that carried it. */
  clampNote?: string;
}

export function describeTiming(view: SharedObservationView, formatTime: FormatTime = formatAbsoluteTime): TimingDescription {
  const days = Math.round(RECENT_THRESHOLD_SECONDS / 86400);
  const note =
    view.freshness === "recent"
      ? `Recent: this observation is at most ${days} days old.`
      : view.freshness === "stale"
        ? `Stale: this observation is more than ${days} days old, so the storage may have changed since.`
        : "Unknown age.";
  return {
    observed: `Observed ${formatTime(view.effectiveObservedAt)}`,
    age: formatAgeSeconds(view.ageSeconds),
    freshness: view.freshness,
    freshnessLabel: freshnessLabel(view.freshness),
    freshnessNote: `${note} Freshness is the age of the observation itself, whatever way it reached the Dashboard.`,
    clampNote: view.claimedAfterCarrier
      ? `The addon reported a later time (${formatTime(view.claimedObservedAt)}) than the export that carried it, so the export's time is used.`
      : undefined,
  };
}

export interface CarriageDescription {
  headline: string;
  detail: string;
}

/** How the carrying exports related to the observation. Not a statement about its age or trustworthiness. */
export function describeCarriage(view: SharedObservationView): CarriageDescription {
  if (view.liveAtExport) {
    return {
      headline: "Seen live by at least one export",
      detail: "At least one carrying export was made while this storage was open. Other exports may have replayed the stored record afterwards.",
    };
  }
  return {
    headline: "Carried by exports made afterwards (last seen)",
    detail:
      "Every carrying export was made after the storage was closed, so each replayed this stored record (\"last seen\"). That is normal: the observation was real when it was made and is only as old as its observed time says.",
  };
}

export interface CompletenessDescription {
  label: string;
  detail: string;
  partial: boolean;
}

export function describeCompleteness(view: SharedObservationView, ownerKind: SharedOwnerIdentity["kind"]): CompletenessDescription {
  if (view.completeness === "partial") {
    return {
      label: "Partial observation",
      partial: true,
      detail: "Some viewable tabs were not confirmed, so this lists only the tabs that were.",
    };
  }
  return {
    label: "Complete observation",
    partial: false,
    detail:
      ownerKind === "guild"
        ? "Every tab the observing character could view was scanned. Tabs it could not view are listed as inaccessible: their contents are unknown."
        : "Every purchased tab was scanned.",
  };
}

/** "98 of 98 slots occupied (0 free)"; a guild's figure covers only the scanned tabs. Undefined when nothing was scanned. */
export function describeCapacity(view: SharedObservationView, ownerKind: SharedOwnerIdentity["kind"]): string | undefined {
  const { totalSlots, freeSlots } = view.content;
  if (ownerKind === "guild" && (totalSlots === undefined || totalSlots === 0)) return "No tab was scanned, so no capacity is known.";
  if (totalSlots === undefined) return undefined;
  const scope = ownerKind === "guild" ? " in the scanned tabs" : "";
  if (freeSlots === undefined) return `${totalSlots} slots${scope} (free slots unknown)`;
  return `${totalSlots - freeSlots} of ${totalSlots} slots occupied${scope} (${freeSlots} free)`;
}

export type ContentsState = "unknown" | "empty" | "items";

/** What can honestly be said about the contents. `null` = the owner has no informative observation at all. */
export function contentsState(view: SharedObservationView | null): ContentsState {
  if (view === null || !view.informative) return "unknown";
  if (view.content.items.length === 0) return view.content.itemsKnownEmpty ? "empty" : "unknown";
  return "items";
}

export function describeContents(view: SharedObservationView | null): string {
  switch (contentsState(view)) {
    case "unknown":
      return "Contents unknown";
    case "empty":
      return "Observed empty: every scanned tab was found empty.";
    case "items":
      return itemSummary(view as SharedObservationView);
  }
}

export interface ItemRow {
  name: string;
  qty?: number;
  bound?: string;
  vendorEachCopper?: number;
  itemRef?: string;
}

/** Distinct item entries (rows are aggregated across tabs) and, only when every quantity is known, the total. */
export function itemSummary(view: SharedObservationView): string {
  const rows = view.content.items;
  const distinct = `${rows.length} distinct item${rows.length === 1 ? "" : "s"}`;
  const known = rows.every((r) => r.qty !== undefined);
  return known ? `${distinct} · ${rows.reduce((n, r) => n + (r.qty ?? 0), 0)} total quantity` : `${distinct} (some quantities unknown)`;
}

/** Item rows sorted by name (then item reference), unnamed items last. Unknown fields stay undefined. Never merges rows. */
export function itemRows(view: SharedObservationView): ItemRow[] {
  return view.content.items
    .map((i) => ({ name: i.name ?? i.itemRef ?? "Unknown item", qty: i.qty, bound: i.bound, vendorEachCopper: i.vendorEachCopper, itemRef: i.itemRef, named: i.name !== undefined }))
    .sort((a, b) => Number(b.named) - Number(a.named) || a.name.localeCompare(b.name) || (a.itemRef ?? "").localeCompare(b.itemRef ?? ""))
    .map(({ named: _named, ...row }) => row);
}

/** "1 item" / "98 items"; with a filter "3 of 98 items". */
export function itemCountLabel(shown: number, total: number, filtering: boolean): string {
  const noun = (n: number) => `${n} item${n === 1 ? "" : "s"}`;
  return filtering ? `${shown} of ${noun(total)}` : noun(total);
}

/** Case-insensitive name filter for the item table. An empty filter keeps everything. */
export function filterItemRows(rows: ItemRow[], query: string): ItemRow[] {
  const q = query.trim().toLowerCase();
  return q === "" ? rows : rows.filter((r) => r.name.toLowerCase().includes(q));
}

// --- guild tabs and coverage ------------------------------------------------------------------------------------------

export interface TabRow {
  key: string;
  name: string;
  description: TabDescription;
}

/** One row per guild tab, worded by the existing tab rules: inaccessible and unconfirmed tabs are "contents unknown", never empty. */
export function tabRows(view: SharedObservationView): TabRow[] {
  return view.content.tabs.map((tab, i) => ({ key: `${tab.id ?? "tab"}-${i}`, name: tab.name ?? `Tab ${tab.id ?? "?"}`, description: describeGuildTab(tab) }));
}

const ids = (list: number[]) => list.join(", ");

/** Plain-language coverage lines. Empty for a Warband (it has no per-tab coverage in the current format). */
export function describeCoverage(view: SharedObservationView, ownerKind: SharedOwnerIdentity["kind"]): string[] {
  if (ownerKind === "warband") return [];
  const c = view.coverage;
  const lines: string[] = [];
  lines.push(c.observedTabs.length > 0 ? `Observed tabs: ${ids(c.observedTabs)}` : "No tab was observed.");
  if (c.inaccessibleTabs.length > 0) lines.push(`Inaccessible to the observing character: ${ids(c.inaccessibleTabs)} (contents unknown, not empty)`);
  if (c.unconfirmedTabs.length > 0) lines.push(`Not confirmed: ${ids(c.unconfirmedTabs)} (contents unknown, not empty)`);
  if (c.unidentifiedTabs > 0) lines.push(`${c.unidentifiedTabs} tab${c.unidentifiedTabs === 1 ? "" : "s"} could not be identified.`);
  return lines;
}

/** One line: "1 observed · 2 inaccessible", for the notice text. */
export function coverageSummary(view: SharedObservationView): string {
  const c = view.coverage;
  const parts = [`${c.observedTabs.length} tab${c.observedTabs.length === 1 ? "" : "s"} observed`];
  if (c.inaccessibleTabs.length > 0) parts.push(`${c.inaccessibleTabs.length} inaccessible`);
  if (c.unconfirmedTabs.length > 0) parts.push(`${c.unconfirmedTabs.length} not confirmed`);
  return parts.join(" · ");
}

export const AGGREGATED_ITEMS_NOTE = "Items are listed together: an observation does not record which tab held each item.";

// --- provenance ---------------------------------------------------------------------------------------------------------

export interface ProvenanceRow {
  key: string;
  character: string;
  carrier: string;
  exportTime: string;
  visit?: string;
}

export interface ProvenanceDescription {
  /** "Seen in 2 exports from Virek · Cairne". */
  headline: string;
  /** Reinforces one observation / many exports. */
  oneObservation: string;
  rows: ProvenanceRow[];
  /** Set only when more sources exist than are listed. */
  truncation?: string;
  /** What provenance does and does not say. */
  note: string;
}

const CARRIER_LABEL: Record<CarrierState, string> = {
  OBSERVED: "Storage open at export",
  LAST_SEEN: "Replayed (last seen)",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describeProvenance(p: SharedProvenanceView, formatTime: FormatTime = formatAbsoluteTime): ProvenanceDescription {
  const first = p.sources[0];
  const label = first ? `${first.characterName} · ${first.characterRealm}` : "an unknown character";
  const headline =
    p.totalCharacters <= 1
      ? `Seen in ${plural(p.totalSources, "export")} from ${label}`
      : `Seen in ${plural(p.totalSources, "export")} from ${p.totalCharacters} characters, most recently ${label}`;
  return {
    headline,
    oneObservation: `One observation, carried by ${plural(p.totalSources, "export")}. ${p.totalSources === 1 ? "" : "The exports are not separate observations."}`.trim(),
    rows: p.sources.map((s, i) => ({
      key: `${s.characterIdentityKey}-${s.exportObservedAt}-${i}`,
      character: `${s.characterName} · ${s.characterRealm}`,
      carrier: CARRIER_LABEL[s.carrierState],
      exportTime: formatTime(s.exportObservedAt),
      visit: [s.visitedNpc, s.visitedZone].filter((x): x is string => x !== undefined).join(", ") || undefined,
    })),
    truncation: p.truncated ? `Showing the newest ${p.sources.length} of ${p.totalSources} exports.` : undefined,
    note: "Provenance names the characters whose exports carried this observation. It does not say which character opened the bank, and a carrying character may since have been deleted from this Dashboard.",
  };
}

// --- notices: things to surface, never hide or merge ------------------------------------------------------------------------------

export interface Notice {
  kind: "contents-unknown" | "newer-partial" | "broader-earlier" | "conflict";
  title: string;
  text: string;
  /** The observation(s) the reader can open to inspect, each clearly labelled as what it is. */
  observations: Array<{ label: string; view: SharedObservationView }>;
}

export function ownerNotices(owner: SharedOwnerView, formatTime: FormatTime = formatAbsoluteTime): Notice[] {
  const notices: Notice[] = [];
  if (contentsState(owner.current) === "unknown") {
    notices.push({
      kind: "contents-unknown",
      title: "Nothing readable was observed",
      text:
        owner.current === null
          ? "Every observation of this storage was recorded with no tab whose contents could be read (for example, all tabs were inaccessible to the observing character). That is not the same as empty."
          : "The current observation did not confirm any contents. That is not the same as empty.",
      observations: [],
    });
  }
  if (owner.latestPartial) {
    notices.push({
      kind: "newer-partial",
      title: "Newer partial observation available",
      text: `A partial observation from ${formatTime(owner.latestPartial.effectiveObservedAt)} (${coverageSummary(owner.latestPartial)}) is newer than the complete one shown. The complete observation remains the primary contents view; the partial one is never merged into it.`,
      observations: [{ label: "Newer partial observation", view: owner.latestPartial }],
    });
  }
  if (owner.broaderCoverageEarlier) {
    notices.push({
      kind: "broader-earlier",
      title: "An earlier observation had broader tab visibility",
      text: `An observation from ${formatTime(owner.broaderCoverageEarlier.effectiveObservedAt)} covered more tabs (${coverageSummary(owner.broaderCoverageEarlier)}) than the current one (${owner.current ? coverageSummary(owner.current) : "none"}). Its contents are not combined with the current ones: they may have changed since.`,
      observations: [{ label: "Earlier observation with broader coverage", view: owner.broaderCoverageEarlier }],
    });
  }
  if (owner.conflict) {
    notices.push({
      kind: "conflict",
      title: "Conflicting observations were recorded for the same time",
      text: `${owner.conflict.others.length + 1} observations with different contents share the observed time ${formatTime(owner.conflict.effectiveObservedAt)}. The Dashboard shows one by a fixed rule; it cannot tell which is correct.`,
      observations: owner.conflict.others.map((view, i) => ({ label: `Conflicting observation ${i + 1}`, view })),
    });
  }
  return notices;
}

// --- deletion -------------------------------------------------------------------------------------------------------------------------

export interface OwnerDeletionTarget {
  owner: SharedOwnerIdentity;
  /** The exact text the user must type to enable the delete button. */
  requiredText: string;
  title: string;
  summary: Array<{ label: string; value: string }>;
  warning: string;
  consequences: string[];
}

/**
 * The confirmation for clearing ONE owner's stored history. Typed confirmation mirrors the character delete:
 * "Warband" for the Warband, the exact GuildClubID for a guild (identity is the id, never the display name).
 */
export function describeOwnerDeletion(owner: SharedOwnerIdentity): OwnerDeletionTarget {
  const common = [
    "Your characters and their imported snapshots are not touched, and a character page may still show what an old export carried.",
    "Only this storage's stored observations and their provenance are cleared.",
  ];
  if (owner.kind === "warband") {
    return {
      owner,
      requiredText: "Warband",
      title: "Clear stored Warband history?",
      summary: [
        { label: "Storage", value: "Warband Bank" },
        { label: "Scope", value: "This Dashboard's local Retail account scope" },
      ],
      warning: REAPPEARANCE_WARNING,
      consequences: common,
    };
  }
  return {
    owner,
    requiredText: owner.guildClubId,
    title: "Clear stored guild history?",
    summary: [
      { label: "Guild", value: owner.guildName ?? "Name not recorded" },
      { label: "GuildClubID", value: owner.guildClubId },
    ],
    warning: REAPPEARANCE_WARNING,
    consequences: [...common, "The guild is identified by its GuildClubID, not by its name."],
  };
}

/** True only when `typed` is exactly the required text (surrounding whitespace from pasting is ignored). */
export function isOwnerDeletionConfirmed(typed: string, target: OwnerDeletionTarget): boolean {
  return target.requiredText.length > 0 && typed.trim() === target.requiredText;
}

export type OwnerDeleteOutcome =
  | { kind: "deleted"; observationsDeleted: number; sourcesDeleted: number }
  | { kind: "already-gone"; message: string }
  | { kind: "failed"; message: string };

/**
 * What a delete request MEANT. Only the server's own 404 with code SHARED_OWNER_NOT_FOUND is "already gone"; any
 * other failure is a failure. A lost request/reply may or may not have deleted, and says so.
 */
export async function performOwnerDelete(
  owner: SharedOwnerIdentity,
  deleteFn: (owner: SharedOwnerIdentity) => Promise<{ deleted?: { owner?: { ownerKey?: unknown }; observationsDeleted?: unknown; sourcesDeleted?: unknown } }>,
): Promise<OwnerDeleteOutcome> {
  try {
    const reply = await deleteFn(owner);
    if (reply?.deleted?.owner?.ownerKey !== owner.ownerKey) {
      return { kind: "failed", message: "The server's reply did not confirm that this storage's history was cleared. Nothing was assumed - check the Shared Storage view." };
    }
    return {
      kind: "deleted",
      observationsDeleted: typeof reply.deleted.observationsDeleted === "number" ? reply.deleted.observationsDeleted : 0,
      sourcesDeleted: typeof reply.deleted.sourcesDeleted === "number" ? reply.deleted.sourcesDeleted : 0,
    };
  } catch (err) {
    if (err instanceof ApiError && err.kind === "http" && err.status === 404 && err.code === "SHARED_OWNER_NOT_FOUND") {
      return { kind: "already-gone", message: "This storage's history was already cleared - this action removed nothing." };
    }
    if (err instanceof ApiError && err.kind !== "http") {
      return { kind: "failed", message: `Could not confirm that the history was cleared - it may or may not have been, so check the Shared Storage view. (${describeApiError(err)})` };
    }
    return { kind: "failed", message: `Not cleared: ${describeApiError(err)}` };
  }
}

/** The status line shown after a delete request finished (cleared, or found already cleared). */
export function describeDeletionResult(owner: SharedOwnerIdentity, outcome: Extract<OwnerDeleteOutcome, { kind: "deleted" | "already-gone" }>): string {
  const name = owner.kind === "warband" ? "the Warband Bank" : (owner.guildName ?? `guild ${owner.guildClubId}`);
  if (outcome.kind === "already-gone") return `The stored history for ${name} was already cleared; nothing was removed.`;
  const obs = `${outcome.observationsDeleted} observation${outcome.observationsDeleted === 1 ? "" : "s"}`;
  const exports = `${outcome.sourcesDeleted} carrying export${outcome.sourcesDeleted === 1 ? "" : "s"}`;
  return `Cleared stored history for ${name} (${obs}, ${exports}). A later WoWSync export may add it again.`;
}

// --- load failures ------------------------------------------------------------------------------------------------------------------

export interface DamagedOwner {
  ownerKey: string;
  /** Present only when the owner could be identified safely; it is what the recovery action deletes. */
  owner?: SharedOwnerIdentity;
  label: string;
}

export interface IntegrityFailure {
  heading: string;
  explanation: string;
  damaged: DamagedOwner[];
  recovery: string;
}

/** Damaged owners are listed Warband first, then guilds, then any owner that could not be identified. */
const rank = (kind: "warband" | "guild" | undefined): number => (kind === "warband" ? 0 : kind === "guild" ? 1 : 2);

/** The integrity failure a load error carries, ready to render; undefined for every other kind of failure. */
export function describeIntegrityFailure(error: unknown): IntegrityFailure | undefined {
  const details: SharedStorageIntegrityErrorBody | undefined = sharedStorageIntegrityDetails(error);
  if (!details) return undefined;
  return {
    heading: "Stored shared-storage data failed integrity validation",
    explanation:
      "Nothing was skipped or guessed, so no shared storage is shown until the damaged data is dealt with. Your characters and their snapshots are not affected.",
    damaged: [...details.damagedOwners].sort((a, b) => rank(a.kind) - rank(b.kind) || a.ownerKey.localeCompare(b.ownerKey)).map((d): DamagedOwner => {
      if (d.kind === "warband") return { ownerKey: d.ownerKey, label: "Warband Bank", owner: { kind: "warband", ownerKey: d.ownerKey, accountScope: "installation-local" } };
      if (d.kind === "guild" && d.guildClubId !== undefined) {
        return { ownerKey: d.ownerKey, label: `Guild ${d.guildClubId}`, owner: { kind: "guild", ownerKey: d.ownerKey, guildClubId: d.guildClubId } };
      }
      return { ownerKey: d.ownerKey, label: `Unrecognized owner (${d.ownerKey})` };
    }),
    recovery: `Clearing a damaged owner's stored history removes only that owner's stored data. ${REAPPEARANCE_WARNING}`,
  };
}
