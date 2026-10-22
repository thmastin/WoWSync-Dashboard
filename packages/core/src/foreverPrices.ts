// Forever Auction House prices from AHledger (https://ahledger.com), a crowd-sourced price service fed by
// players' own Auction House scans. Prices are EXTERNAL observations with a scan time and a market; they
// are never estimated, interpolated or presented as WoWSync's own scan. AHledger's terms require a
// credit link wherever the data is shown, so every evidence line carries it.

import { formatCopper } from "./currency.ts";

export const AHLEDGER_ATTRIBUTION = "Prices from AHledger (https://ahledger.com), crowd-sourced player scans";
/** A price older than this is shown as stale and not used to rank or compute margins. */
export const PRICE_FRESH_HOURS = 72;

export interface ForeverMarketPrice {
  median?: number;
  minBuyout?: number;
  quantity?: number;
  median7d?: number;
  median30d?: number;
  low30d?: number;
  high30d?: number;
  salesPerDay?: number;
  /** ISO time of the scan that produced the latest price. */
  observedAt?: string;
}

export interface ForeverPriceBundle {
  schema: 1;
  version: "forever";
  source: "AHledger";
  attribution: string;
  fetchedAt: string;
  /** Market id (game.ruleset.faction.region) -> item id -> price. */
  markets: Record<string, { label?: string; prices: Record<string, ForeverMarketPrice> }>;
}

/** Ruleset from a realm name. Beta realms carry the ruleset in their name; launch is realmless. */
export function rulesetOfRealm(realm: string | undefined): "normal" | "pvp" | "rp" | undefined {
  if (!realm) return undefined;
  if (/\bpvp\b/i.test(realm)) return "pvp";
  if (/\b(rp|roleplay|role-play)\b/i.test(realm)) return "rp";
  if (/\b(pve|normal)\b/i.test(realm)) return "normal";
  return undefined;
}

/** AHledger market for a character: ruleset (from the realm), faction, region. Undefined when unknown. */
export function foreverMarketFor(realm: string | undefined, faction: string | undefined, region = "us"): string | undefined {
  const ruleset = rulesetOfRealm(realm);
  const side = faction?.toLowerCase().startsWith("h") ? "horde" : faction?.toLowerCase().startsWith("a") ? "alliance" : undefined;
  return ruleset && side ? `forever.${ruleset}.${side}.${region}` : undefined;
}

export interface PriceLookup {
  market: string;
  price: ForeverMarketPrice;
  ageHours?: number;
  fresh: boolean;
  /** Value used for margins: the 7-day median (steadier than one scan), else the latest median, else the lowest buyout. */
  unit?: number;
}

export class ForeverPriceIndex {
  readonly bundle: ForeverPriceBundle;
  private readonly now: () => number;
  constructor(bundle: ForeverPriceBundle, now: () => number = () => Date.now()) {
    if (bundle.schema !== 1 || bundle.version !== "forever") throw new TypeError("Not a Forever price bundle (schema 1).");
    this.bundle = bundle;
    this.now = now;
  }
  markets(): string[] { return Object.keys(this.bundle.markets); }
  lookup(market: string | undefined, itemId: number | undefined): PriceLookup | undefined {
    if (!market || itemId === undefined) return undefined;
    const price = this.bundle.markets[market]?.prices[String(itemId)];
    if (!price || (price.median === undefined && price.minBuyout === undefined && price.median7d === undefined)) return undefined;
    const observed = price.observedAt ? Date.parse(price.observedAt) : NaN;
    const ageHours = Number.isFinite(observed) ? Math.max(0, (this.now() - observed) / 3_600_000) : undefined;
    return { market, price, ageHours, fresh: ageHours !== undefined && ageHours <= PRICE_FRESH_HOURS, unit: price.median7d ?? price.median ?? price.minBuyout };
  }
}

/**
 * What the price refresh should fetch: the markets of the account's Forever characters (realm ruleset +
 * faction) and the items that matter to them (observed items plus reagents and products of known recipes).
 */
export function foreverPriceTargets(
  characters: Array<{ realm: string; faction?: string | null }>,
  observedItems: number[],
  recipeSpells: Array<{ reagents: Array<{ itemId: number }>; createsItemId?: number }>,
  marketRegion = "us",
): { markets: string[]; items: number[]; unmapped: string[] } {
  const markets = new Set<string>(), unmapped = new Set<string>();
  for (const character of characters) {
    const market = foreverMarketFor(character.realm, character.faction ?? undefined, marketRegion);
    if (market) markets.add(market); else unmapped.add(`${character.realm} (${rulesetOfRealm(character.realm) ? "faction unknown" : "ruleset unknown"})`);
  }
  const items = new Set(observedItems);
  for (const spell of recipeSpells) {
    for (const reagent of spell.reagents) items.add(reagent.itemId);
    if (spell.createsItemId) items.add(spell.createsItemId);
  }
  return { markets: [...markets].sort(), items: [...items].sort((a, b) => a - b), unmapped: [...unmapped].sort() };
}

let current: ForeverPriceIndex | undefined;
let region = "us";
export function useForeverPrices<T>(index: ForeverPriceIndex | undefined, fn: () => T, marketRegion = "us"): T {
  const previous = current; const previousRegion = region;
  current = index; region = marketRegion;
  try { return fn(); } finally { current = previous; region = previousRegion; }
}
export function currentForeverPrices(): ForeverPriceIndex | undefined { return current; }

/** Fresh market price for an item in a character's market, or undefined. */
export function marketPrice(itemId: number | undefined, realm: string | undefined, faction: string | undefined): PriceLookup | undefined {
  const found = current?.lookup(foreverMarketFor(realm, faction, region), itemId);
  return found?.fresh && found.unit !== undefined ? found : undefined;
}

/** One evidence statement for a price, with market, scan time, depth and sales rate. */
export function describePrice(name: string, found: PriceLookup): string {
  const p = found.price;
  const parts = [
    p.median7d !== undefined ? `7-day median ${formatCopper(p.median7d)}` : undefined,
    p.median !== undefined ? `latest scan median ${formatCopper(p.median)}` : undefined,
    p.minBuyout !== undefined ? `lowest ${formatCopper(p.minBuyout)}` : undefined,
    p.quantity !== undefined ? `${p.quantity} listed` : undefined,
    p.salesPerDay !== undefined ? `about ${Math.round(p.salesPerDay)} sold/day (AHledger estimate)` : undefined,
    p.median30d !== undefined ? `30-day median ${formatCopper(p.median30d)}` : undefined,
  ].filter(Boolean);
  const age = found.ageHours === undefined ? "scan time unknown" : found.ageHours < 1 ? "scanned under an hour ago" : `scanned ${Math.round(found.ageHours)}h ago`;
  return `${name} on ${found.market}: ${parts.join(", ")} (${age}).`;
}
