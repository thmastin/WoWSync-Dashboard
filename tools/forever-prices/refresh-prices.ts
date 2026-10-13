// Fetches Forever Auction House prices from AHledger (https://ahledger.com) for the account's markets and
// items, and installs them into a Dashboard via PUT /api/versions/forever/prices.
//
//   node tools/forever-prices/refresh-prices.ts [--dashboard http://127.0.0.1:4174] [--out prices.json] [--dry-run]
//
// AHledger terms: free API, credit AHledger wherever prices are shown, honor cache headers, do not exceed
// rate limits. This job reads only the documented tooltip endpoint (up to 100 items per request), at most
// once an hour, well under 300 requests/minute, and backs off on 429/503 using Retry-After.
// No account data is sent: requests carry only market ids and item ids.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const dashboard = (arg("--dashboard") ?? process.env.WOWSYNC_DEV_URL ?? "http://127.0.0.1:4174").replace(/\/$/, "");
const out = arg("--out");
const dryRun = args.includes("--dry-run");
const API = "https://api.ahledger.com/v1";
const UA = "WoWSync personal price cache (single user, hourly)";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TooltipItem { id: number; median?: number | null; minBuyout?: number | null; quantity?: number | null; observedAt?: string | null; salesPerDay?: number | null; median7d?: number | null; median30d?: number | null }

async function getJson(url: string, attempt = 0): Promise<unknown> {
  const response = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if ((response.status === 429 || response.status === 503) && attempt < 4) {
    const wait = Math.min(120, Number(response.headers.get("retry-after")) || 30);
    console.log(`  ${response.status} from ${new URL(url).pathname}; waiting ${wait}s`);
    await sleep(wait * 1000);
    return getJson(url, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const targets = await getJson(`${dashboard}/api/versions/forever/prices/targets`) as { markets: string[]; items: number[]; unmapped: string[]; region: string };
console.log(`Targets: ${targets.markets.length} markets (${targets.markets.join(", ") || "none"}), ${targets.items.length} items${targets.unmapped.length ? `; realms without a known ruleset: ${targets.unmapped.join(", ")}` : ""}`);
const marketList = ((await getJson(`${API}/markets`)) as { markets: Array<{ id: string; label?: string }> }).markets;
const known = new Set(marketList.map((market) => market.id));
const labels = new Map(marketList.map((market) => [market.id, market.label]));

const bundle = { schema: 1 as const, version: "forever" as const, source: "AHledger" as const, attribution: "Prices from AHledger (https://ahledger.com), crowd-sourced player scans", fetchedAt: new Date().toISOString(), markets: {} as Record<string, { label?: string; prices: Record<string, Record<string, unknown>> }> };
let requests = 0, priced = 0;
for (const market of targets.markets) {
  if (!known.has(market)) { console.log(`  skipping ${market}: not an AHledger market`); continue; }
  const prices: Record<string, Record<string, unknown>> = {};
  for (let start = 0; start < targets.items.length; start += 100) {
    const batch = targets.items.slice(start, start + 100);
    const body = await getJson(`${API}/tooltip/${market}?items=${batch.join(",")}`) as { items?: TooltipItem[] };
    requests += 1;
    for (const item of body.items ?? []) {
      const row = { median: num(item.median), minBuyout: num(item.minBuyout), quantity: num(item.quantity), median7d: num(item.median7d), median30d: num(item.median30d), salesPerDay: num(item.salesPerDay), observedAt: typeof item.observedAt === "string" ? item.observedAt : undefined };
      if (row.median === undefined && row.minBuyout === undefined) continue;
      prices[String(item.id)] = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
      priced += 1;
    }
    await sleep(400);
  }
  bundle.markets[market] = { label: labels.get(market), prices };
  console.log(`  ${market}: ${Object.keys(prices).length} priced items`);
}
console.log(`Fetched ${priced} prices in ${requests} requests.`);
const text = JSON.stringify(bundle);
if (out) writeFileSync(out, text);
if (dryRun) process.exit(0);
const response = await fetch(`${dashboard}/api/versions/forever/prices`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: text });
const result = await response.text();
if (!response.ok) { console.error(`Install failed: ${response.status} ${result}`); process.exit(1); }
console.log(`Installed: ${result}`);
