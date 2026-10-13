// Fetches Forever Auction House prices from AHledger (https://ahledger.com) for the account's markets and
// items, and installs them into a Dashboard via PUT /api/versions/forever/prices.
//
//   node tools/forever-prices/refresh-prices.ts [--dashboard http://127.0.0.1:4174] [--out prices.json] [--dry-run]
//
// AHledger terms: free API, credit AHledger wherever prices are shown, honor cache headers, do not exceed
// rate limits. This job reads the documented price table endpoint, one request per market, at most once an hour,
// and backs off on 429/503 using Retry-After.
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
console.log(`Targets: ${targets.markets.length} markets (${targets.markets.join(", ") || "none"}), ${targets.items.length} items${targets.unmapped.length ? `; without a market: ${targets.unmapped.join(", ")}` : ""}`);
const marketList = ((await getJson(`${API}/markets`)) as { markets: Array<{ id: string; label?: string }> }).markets;
const known = new Set(marketList.map((market) => market.id));
const labels = new Map(marketList.map((market) => [market.id, market.label]));

// One documented price table per market ("AHL1|market|unix|rows", then
// id:median:minBuyout:quantity:median7d:median30d:low30d:high30d:salesPerDay*10; empty = unknown).
async function getText(url: string, attempt = 0): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": UA, accept: "text/plain" }, signal: AbortSignal.timeout(60_000) });
  if ((response.status === 429 || response.status === 503) && attempt < 4) {
    const wait = Math.min(120, Number(response.headers.get("retry-after")) || 30);
    console.log(`  ${response.status} from ${new URL(url).pathname}; waiting ${wait}s`);
    await sleep(wait * 1000);
    return getText(url, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.text();
}
const field = (value: string | undefined) => value === undefined || value === "" ? undefined : num(Number(value));

const bundle = { schema: 1 as const, version: "forever" as const, source: "AHledger" as const, attribution: "Prices from AHledger (https://ahledger.com), crowd-sourced player scans", fetchedAt: new Date().toISOString(), markets: {} as Record<string, { label?: string; prices: Record<string, Record<string, unknown>> }> };
let requests = 0, priced = 0;
for (const market of targets.markets) {
  if (!known.has(market)) { console.log(`  skipping ${market}: not an AHledger market`); continue; }
  const text = await getText(`${API}/pricetable/${market}`);
  requests += 1;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = /^AHL1\|([a-z./]+)\|(\d+)\|(\d+)$/.exec(lines[0] ?? "");
  if (!header || header[1]!.replace(/\//g, ".") !== market) throw new Error(`Unexpected price table header for ${market}: ${lines[0]?.slice(0, 80)}`);
  const asOf = new Date(Number(header[2]) * 1000).toISOString();
  const prices: Record<string, Record<string, unknown>> = {};
  for (const line of lines.slice(1)) {
    const [id, median, minBuyout, quantity, median7d, median30d, low30d, high30d, sales10] = line.split(":");
    if (!/^\d+$/.test(id ?? "")) continue;
    const row = { median: field(median), minBuyout: field(minBuyout), quantity: field(quantity), median7d: field(median7d), median30d: field(median30d), low30d: field(low30d), high30d: field(high30d), salesPerDay: field(sales10) !== undefined ? field(sales10)! / 10 : undefined, observedAt: asOf };
    if (row.median === undefined && row.minBuyout === undefined && row.median7d === undefined) continue;
    prices[id!] = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
    priced += 1;
  }
  bundle.markets[market] = { label: labels.get(market), prices };
  const covered = targets.items.filter((item) => prices[String(item)]).length;
  console.log(`  ${market}: ${Object.keys(prices).length} items as of ${asOf} (${covered}/${targets.items.length} of the account's items)`);
  await sleep(1000);
}
console.log(`Fetched ${priced} prices in ${requests} requests.`);
const text = JSON.stringify(bundle);
if (out) writeFileSync(out, text);
if (dryRun) process.exit(0);
const response = await fetch(`${dashboard}/api/versions/forever/prices`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: text });
const result = await response.text();
if (!response.ok) { console.error(`Install failed: ${response.status} ${result}`); process.exit(1); }
console.log(`Installed: ${result}`);
