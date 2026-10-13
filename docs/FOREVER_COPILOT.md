# Forever Co-Pilot

A goal-aware, read-only advisor for WoW Forever. A player asks a question ("Hallo the druid: what should I
do over the next five levels?", "How can my stable make gold?") and gets ranked recommendations built
from the account's Forever evidence plus Forever game knowledge, including opportunities the account has
never encountered. Each recommendation carries provenance, prerequisites, costs, alternatives and next
actions; character answers also carry a level-by-level plan.

## Surfaces

| Surface | How |
| --- | --- |
| MCP | `ask_forever_copilot` (read-only). `format: "markdown"` returns the compact player answer. |
| MCP | `get_character_progression` (Forever): visible reputation rows and the full talent capture (spec, unspent, ranks, availability, derived tier/prerequisites, points-in-tree gates, Forever tooltip text). |
| MCP | `lookup_forever_knowledge`: item, quest, NPC, spell, dungeon or zone from the knowledge bundle by id or name, with sources. Prices and drop chances stay UNKNOWN. |
| REST | `POST /api/versions/forever/copilot` with `{ question, character?, realm?, objectives?, preferences?, limit? }`. Other versions return 422. |
| Dashboard | Forever tab, **Co-Pilot** button in the header. |
| Knowledge | `GET /api/versions/forever/knowledge` (status), `PUT` the same path with the bundle as `application/octet-stream` (install). |
| Prices | `GET /api/versions/forever/prices` (status), `GET .../prices/targets`, `PUT .../prices` (install). |

## Architecture

```
question -> objective (keywords or explicit) -> subject (name + class/race/realm words) -> evidence
  evidence: DashboardReadModel, version "forever" only: state, gear, bags/bank, professions,
            full client recipe catalogs (learned and unlearned), quest log + completed history,
            raw trainer-window captures (class and profession)
  knowledge: private bundle (QuestieDB Forever + Wowhead Forever tooltips), scoped per request
-> generators -> drafts -> ranking -> topic coverage -> answer + plan + markdown
```

Main files:

| File | Role |
| --- | --- |
| `packages/core/src/foreverCopilot.ts` | Orchestration, owned-item/transfer/crafting/quest/tool/food/gold generators, ranking, rendering |
| `packages/core/src/foreverDiscovery.ts` | Discovery: quests, gear (quest rewards, vendors, recipes, drops), class training, class quests, profession trainer recipes, profession comparison, gathering and profession-investment gold ideas, level plan |
| `packages/core/src/foreverTrainer.ts` | Parses GearExport's raw trainer-window calls (name, rank, level, cost, status, skill requirement) |
| `packages/core/src/foreverKnowledgeBundle.ts` | Bundle types and query index |
| `packages/core/src/foreverKnowledgeStore.ts` | File-backed bundle holder for server and MCP (node only) |
| `packages/core/src/luaLiteral.ts` | Data-only Lua table reader (never evaluates code) |
| `tools/forever-knowledge/build-bundle.ts` | Builds the bundle |

## Pass 3 additions (2026-10-13)

- **Observed skills.** Weapon skills and armor proficiencies come from the Forever skill-line capture
  (`foreverSkills.ts`). An armor type the character lacks blocks the item; a missing weapon skill becomes
  "Train <skill> at a weapon master first" and lowers the ranking. The Classic baseline is used only when no
  skill lines were captured.
- **Talents.** GearExport `feature/forever-skills-talents` (`WoWSyncForeverTalents.lua`) reads talent trees and
  unspent points read-only, and the bridge forwards the `talents` section. Forever 1.60.1 has no legacy talent
  API; it uses the Retail trait system, so GearExport `8a81302` reads `C_ClassTalents`/`C_Traits` with getters
  only (ranks, spell names, talent currency, specialization). Forever returns one combined tree per class (no
  Classic tree split), which answers show as "Points spent: N (Talent r/max, ...)". A character without a
  talent export gets a "not yet exported" note.
- **Routing.** `foreverRouting.ts`: zone adjacency (Classic map baseline, labelled) scores quests by distance;
  quest givers are clustered into hubs; a "Quest route" recommendation lists hubs in travel order, and the level
  plan orders quests by distance.
- **Dungeons.** QuestieDB's dungeon table (name, areas, entrance). Level range = middle 80% of the creatures
  placed inside; raids/city instances (span > 15) and dungeons inside the other faction's capital are excluded.
  Dungeon quests and upgrade drops are listed under a group recommendation, not as solo quests.
- **Knowledge refresh.** `GET /api/versions/forever/knowledge/observed-ids` (read-only) feeds
  `build-bundle.ts --observed-url`. `tools/forever-knowledge/refresh-host.sh` (installed by
  `install-host-timer.sh` as a per-user systemd timer on the DEV host) updates QuestieDB, builds with the
  deployed Dashboard SHA's builder, and installs only when content changed. Answers report bundle age.

## Knowledge coverage (2026-10-13)

- Gear tooltips cover weapons and armor up to required level 60 (was 22) that have a quest, vendor or drop source.
- Cached tooltips older than 14 days are refetched (`--cache-max-days`), so Forever changes and launch reach the bundle.
- Recipes: Classic seed IDs plus every recipe in the account's captured profession catalogs (learned or not); each
  kept only if the Forever database has it. Professions nobody on the account has opened (e.g. Enchanting) stay uncovered.
- Class abilities: GearExport `classSpellCatalog` records spellbook entries not yet learned with the level the client
  reports. Forever 1.60.1 lists none (observed 2026-10-13), so in practice upcoming abilities, ranks and costs come
  from one class trainer visit per character; an empty catalog is treated as UNKNOWN.

## Rules the engine enforces

- **Version isolation.** Only Forever; every read uses version `forever`; the bundle is Forever-only.
- **Economies.** Characters form an economy only when realm and known faction match. Opposite-faction
  or unknown-faction characters are never suppliers, transfer targets or inputs; the profession
  comparison names them explicitly ("Bramm has Leatherworking but is Alliance (you are Horde)").
- **Quests.** A quest is offered only if it is not in the observed log or the completed history, the
  race and class masks allow it, the giver is friendly to the faction, prerequisites are met (else it is
  shown as a chain step), and the level fits. Below level 12 another race's starting zone is excluded;
  below level 15 the other continent is excluded. Same-named variants collapse to one.
- **Active quests.** Only rows the latest refresh returned (`rowEvidence` OBSERVED) and not in completed
  history count as open.
- **Gear.** Candidates come from active-quest rewards, discovered quest rewards, faction-friendly vendors
  in zones the plan uses, learned and unlearned recipes of the character or same-economy crafters, and
  specific drops. A candidate is an UPGRADE only if no listed stat is worse; item level alone never decides.
  Class armor/weapon proficiency uses a Classic Era baseline that is labelled unverified for Forever.
- **Training.** Class training comes from the observed trainer window (level, cost, status at the visit).
- **Prices.** Vendor sell prices are guaranteed floors. Auction House prices come only from AHledger's
  crowd-sourced scans (see below) as EXTERNAL evidence with market, scan time, depth and sales rate, credited
  to AHledger; prices older than 72 hours are not used. The Auction House cut and deposit are not deducted
  (Forever rates unverified). Vendor buy prices and unscanned items stay UNKNOWN; nothing is estimated.
- **Player control.** Nothing executes. Transfers are player-run steps.

## Ranking

`0.40 x value + 0.30 x feasibility + 0.15 x objective fit + 0.15 x evidence confidence`, reduced by a
cost penalty when an optional action costs more of the observed gold. Account observations have
confidence 1; QuestieDB-based discoveries about 0.75; Classic-seeded data lower. Minor active quests
collapse into one item, and every topic the question asks about (gear, quests, professions, class) keeps
its best items in the answer.

## Forever Auction House prices (AHledger)

Forever has no Blizzard auction feed. [AHledger](https://ahledger.com) aggregates players' own Auction House
scans per market (ruleset, faction, region: `forever.pvp.alliance.us`) and offers a free API; its terms
require crediting AHledger wherever prices are shown and honoring cache headers.

- `tools/forever-prices/refresh-prices.ts` reads `GET /api/versions/forever/prices/targets` (the account's
  markets from realm ruleset + faction, and items: observed items plus known recipe reagents/products), reads
  AHledger's `/v1/pricetable/{market}` (the whole market in one request; Retry-After honored) and installs
  `forever-prices.json` with `PUT /api/versions/forever/prices`. Only market and item ids are sent.
- On DEV, `install-host-timer.sh` adds the per-user `wowsync-forever-prices.timer` (hourly).
- Margins use the 7-day median (one scan can swing several-fold; e.g. Copper Bar latest 7s 90c vs 7-day 1s 81c on
  2026-10-13), with the latest scan shown beside it.
- The co-pilot uses these values for material conversions (convert vs sell raw), unused gear, and a
  "sell surplus materials" recommendation; MCP `get_forever_market_prices` returns prices per item.
- Region defaults to `us` (`WOWSYNC_FOREVER_REGION`). Launch is realmless: the market is derived from the
  realm name's ruleset, which needs a check against the launch client's realm/ruleset naming.

## Forever knowledge bundle

Built by:

```
node tools/forever-knowledge/build-bundle.ts --questie <QuestieDB checkout> --out <bundle.json> \
     [--db <wowsync.sqlite>] [--cache <dir>] [--max-req-level 22] [--offline]
```

| Source | Used for | Terms and handling |
| --- | --- | --- |
| [QuestieDB](https://github.com/Questie/QuestieDB) `data/Forever`, `support/Forever` | Quests, chains, givers, item sources (quest rewards, vendors, drops), NPC locations and faction friendliness, zones, quest XP (Classic seed) | No published license. The bundle is a **private runtime cache**: never committed, never redistributed. |
| Wowhead Forever tooltip API (`nether.wowhead.com/forever/tooltip/...`) | Item stats, slot, required level, vendor sell price; recipe reagents/tools/products; pattern skill | One ID per request, about 3 per second, cached locally. `www.wowhead.com` pages are not fetched: its robots policy excludes AI agents. Auction prices are never stored. |
| WoWSync database (optional, read-only) | Adds every ID the account has observed | |

Recipe discovery uses Classic recipe spell IDs only as lookup seeds; each is kept only if the Forever
database has it, and every value comes from the Forever record (e.g. Forever's Handstitched Leather Belt
is green with +1 Strength). Forever-only quests are only partly covered by QuestieDB.

### Installing on DEV

```bash
scp bundle.json omarchy:/tmp/forever-knowledge.json
ssh omarchy 'curl -sS -X PUT -H "content-type: application/octet-stream" --data-binary @/tmp/forever-knowledge.json http://127.0.0.1:4174/api/versions/forever/knowledge'
```

The Dashboard writes it atomically to `forever-knowledge.json` next to the database
(`WOWSYNC_FOREVER_KNOWLEDGE_PATH` overrides); the MCP process reads the same file and reloads on change.

## Reuse decisions (2026-10-13)

| Candidate | Decision |
| --- | --- |
| QuestieDB Forever data | **Used** (private cache): the only maintained Forever quest/NPC/item-source dataset. |
| Questie addon | Not installed: its tracker does not list Forever-specific quests; only its data is needed. |
| Wowhead Forever tooltips | Used per ID for stats/recipes; list pages not scraped. |
| AtlasLoot | Not used: no maintained Forever loot tables; QuestieDB item sources cover quest/vendor/drop. |
| Pawn | Not used: stat weights unvalidated for Forever; dominance comparison avoids invented weights. |
| Auctionator / Auctioneer / TSM | Not used: Auctionator supports Forever but needs per-player full scans (throttled in beta); AHledger already aggregates scans from many players. |
| AHledger API | **Used** (2026-10-13): crowd-sourced Forever prices per market, free API, attribution required. |
| Altoholic / DataStore | Not used: GearExport + Dashboard already track the account. |
| LibStub / Ace3 / LibDataBroker | Not relevant: no addon change in this delivery. |

## Known limits

- Recipe skill thresholds are known only from trainer windows, patterns, or captured profession windows.
- Vendor buy prices, travel time, quest-giver availability by phase, and drop chances are unknown.
- Reputation is captured (GearExport `de91ae0`, visible rows only) and readable over MCP, but not used in recommendations.
- Talent builds are not ranked by the engine. The co-pilot lists talents the client says can be taken now, with Forever tooltip text; the connected LLM reasons about tradeoffs.
- Talent descriptions are Wowhead Forever rank 1 text; they arrive with the next knowledge refresh after a character exports talents.
- Objective detection is keyword-based.
