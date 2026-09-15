import type { VersionOrUnknown } from "./types.ts";

export const WOW_VERSIONS: VersionOrUnknown[] = ["classic-era", "tbc-anniversary", "retail"];

export const VERSION_LABELS: Record<string, string> = {
  "classic-era": "Classic Era",
  "tbc-anniversary": "TBC Anniversary",
  retail: "Retail",
  "unknown-version": "Unrouted",
};

export const VERSION_ACCENTS: Record<string, string> = {
  "classic-era": "#7fae4a",
  "tbc-anniversary": "#3aa5c9",
  retail: "#c8aa6e",
  "unknown-version": "#888",
};
