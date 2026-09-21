// Presentation rules for the (transitional) Guild Bank card. Pure so the trust
// wording is unit-tested rather than living inside JSX.
//
//   UNKNOWN     -> "Never observed": nothing about the contents is known.
//   LAST_SEEN   -> a PRIOR observation, explicitly not current.
//   OBSERVED    -> observed at that time; a partial capture says so.
//   INACCESSIBLE tab -> contents UNKNOWN. Never "empty".
//   UNKNOWN tab      -> viewable but not confirmed; contents UNKNOWN.
//
// "Empty" is only ever claimed for tabs the addon actually scanned and found
// empty (itemsKnownEmpty), and even then only for the scanned tabs.
import { formatAbsoluteTime } from "./format.ts";
import type { GuildBankSection, GuildBankTab, SectionStatus } from "./types.ts";

export interface StateDescription {
  /** True only for a live OBSERVED capture. LAST_SEEN and UNKNOWN are never "current". */
  currentlyObserved: boolean;
  headline: string;
  detail?: string;
}

/** `formatTime` is injectable so the wording is deterministic in tests. */
export function describeGuildState(status: SectionStatus, formatTime: (unixSeconds: number | undefined) => string = formatAbsoluteTime): StateDescription {
  if (status.state === "UNKNOWN") {
    return {
      currentlyObserved: false,
      headline: "Never observed",
      detail: status.reason ? `Reason given by the addon: ${status.reason}` : undefined,
    };
  }
  if (status.state === "LAST_SEEN") {
    return {
      currentlyObserved: false,
      headline: "Last seen — not currently observed",
      detail: `From an earlier visit, last observed ${formatTime(status.observedAt)}. Its contents may have changed since.`,
    };
  }
  const partial = status.completeness !== undefined && status.completeness !== "complete";
  return {
    currentlyObserved: true,
    headline: `Observed ${formatTime(status.observedAt)}`,
    detail: partial
      ? `Partial capture (${status.completeness}): some viewable tabs were not confirmed, so what is listed covers only the confirmed tabs.${status.coverageNote ? ` ${status.coverageNote}` : ""}`
      : undefined,
  };
}

export type TabTone = "observed" | "unknown" | "inaccessible";

export interface TabDescription {
  label: string;
  tone: TabTone;
  detail?: string;
}

export function describeGuildTab(tab: GuildBankTab): TabDescription {
  switch (tab.state) {
    case "OBSERVED":
      return { label: "Observed", tone: "observed" };
    case "INACCESSIBLE":
      return {
        label: "Inaccessible",
        tone: "inaccessible",
        detail: "Not viewable by the observing character - its contents are unknown (not empty).",
      };
    case "UNKNOWN":
      return {
        label: "Not confirmed",
        tone: "unknown",
        detail: tab.note ? `Viewable but not confirmed (${tab.note}) - its contents are unknown.` : "Viewable but not confirmed - its contents are unknown.",
      };
    default:
      return {
        label: "Unknown state",
        tone: "unknown",
        detail: tab.state ? `The addon reported the tab state "${tab.state}", which this dashboard does not recognise - its contents are unknown.` : "No state reported - its contents are unknown.",
      };
  }
}

/** "3 free / 196 slots in the scanned tabs", or an honest statement that nothing was scanned. Never a number for an UNKNOWN bank. */
export function describeGuildCapacity(g: GuildBankSection): string | undefined {
  if (g.status.state === "UNKNOWN") return undefined;
  if (g.totalSlots === 0 || (g.totalSlots === undefined && g.freeSlots === undefined)) return "No tab was scanned, so no capacity is known.";
  const asOf = g.status.state === "LAST_SEEN" ? " (as of the last observation)" : "";
  return `${g.freeSlots ?? "?"} free / ${g.totalSlots ?? "?"} slots in the scanned tabs${asOf}`;
}

/** Caveats about what the listed contents do NOT cover. */
export function describeGuildCaveats(g: GuildBankSection): string[] {
  if (g.status.state === "UNKNOWN") return [];
  const out: string[] = [];
  const inaccessible = g.tabs.filter((t) => t.state === "INACCESSIBLE").length;
  const unconfirmed = g.tabs.filter((t) => t.state !== "OBSERVED" && t.state !== "INACCESSIBLE").length;
  if (inaccessible > 0) out.push(`${inaccessible} tab${inaccessible === 1 ? " is" : "s are"} inaccessible to the observing character: their contents are unknown.`);
  if (unconfirmed > 0) out.push(`${unconfirmed} tab${unconfirmed === 1 ? " was" : "s were"} not confirmed: their contents are unknown.`);
  return out;
}

/** What to say about the item list: known-empty only for scanned tabs that were actually observed empty. */
export function describeGuildContents(g: GuildBankSection): string {
  if (g.status.state === "UNKNOWN") return "Contents unknown.";
  const lastSeen = g.status.state === "LAST_SEEN";
  if (g.itemsKnownEmpty) return lastSeen ? "Every scanned tab was observed empty at the last observation." : "Every scanned tab was observed empty.";
  if (g.items.length === 0) return lastSeen ? "No item contents were recorded at the last observation." : "No item contents were observed.";
  const n = `${g.items.length} distinct item${g.items.length === 1 ? "" : "s"}`;
  const note = "aggregated across the scanned tabs; the source tab of an item is not recorded";
  return lastSeen ? `${n} were recorded at the last observation (${note}).` : `${n} observed (${note}).`;
}
