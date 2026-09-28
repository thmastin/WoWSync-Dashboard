import type { ReactNode } from "react";

const SOURCE = {
  journeys: "https://news.blizzard.com/en-us/article/24235746/midnight-brings-journeys-to-your-adventure",
  refresh: "https://www.wowhead.com/news/renown-quest-rewards-reset-and-now-item-level-279-in-patch-12-1-382390",
  knowledge: "https://www.wowhead.com/guide/midnight/professions/knowledge-points-artisans-moxie",
  amani: "https://www.wowhead.com/guide/midnight/amani-tribe-renown-reputation-farming-rewards",
  zuljarra: "https://www.icy-veins.com/wow/zuljarras-forces-renown-guide",
  captain: "https://www.method.gg/guides/captain-tokka-reputation-guide-for-wow-midnight",
  ritualSites: "https://www.wowhead.com/guide/midnight/ritual-sites-challenges-locations-rewards",
} as const;

function SourceLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer">{children} <span aria-hidden="true">↗</span></a>;
}

const RANK_BREAKDOWN = [
  ["Silvermoon Court", [
    "Track begins.", "Buy starter helm, cloak and Haven's Elegant Regalia cosmetics.", "Buy Silvermoon textile housing decor.", "Soiree quests give more Brimming Arcana (more currency for social-standing rewards).", "Buy Court profession recipes.", "Buy +10 Tailoring/Enchanting/Jewelcrafting Knowledge books; claim Marl.", "Buy dining housing decor.", "Another Brimming Arcana increase from Soiree quests.", "Season 2: complete the refreshed 279 helm quest.", "Finery Funds / collection vendor gate.", "Collection/vendor gate; no documented player-power unlock.", "Claim Marl; collection vendor gate.", "Collection/vendor gate.", "Third Soiree Brimming Arcana increase.", "Collection/vendor gate.", "Collection/vendor gate.", "Mount/cosmetic vendor tier.", "Collection/vendor gate.", "Mount vendor tier.", "Court title and ensemble vendor tier; contributes to Midnight Diplomat." ]],
  ["Amani Tribe", [
    "Track begins.", "Buy starter neck or cloak cosmetic.", "Find Amani Spoil chests and buy basic decor.", "Unlock Abyss Angler events and Fused Vitality purchases.", "Buy Amani profession recipes and the Amani contract.", "Buy +10 Leatherworking/Mining/Skinning Knowledge books; claim 500 Marl.", "Buy Loa-idol decor.", "Use Wila'ma's Traveler blessing at Amani'Zar.", "Season 2: complete refreshed 279 neck quest; Amani Spoils improve.", "Finery Funds / tabard collection tier.", "Decor vendor tier.", "Claim 500 Marl; pet vendor tier.", "Collection/vendor gate.", "Buy Muck-Covered Writings from Abyss Angler vendors.", "Cauldron/decor vendor tier.", "Shoulder cosmetic tier.", "Mount vendor tier.", "Loa visage cosmetics.", "Mount vendor tier.", "Loa-Speaker title and cosmetic helm tier." ]],
  ["Hara'ti", [
    "Track begins.", "Start moth collection, see first moth set, buy starter waist/cloaks.", "Find Harandar treasures and buy basic decor.", "Collect second moth set; claim Marl.", "Buy Hara'ti profession recipes.", "See second moth set; buy +10 Herbalism/Inscription Knowledge books.", "Buy fungal storage decor.", "Season 2: complete refreshed 279 waist quest; Harandar treasures improve.", "Moth/minimap collection progression.", "Collection/system gate.", "Moth/minimap collection progression.", "Collection/vendor gate.", "Verdant Rutaani Seed vendor tier.", "Pet / collection tier.", "Bird decor vendor tier.", "Fierce Grimlynx mount tier.", "Shoulder and weapon-appearance vendor tier.", "Honorary Harati title / pennant tier.", "Cerulean Sporeglider mount tier.", "Rootdancer/Rootwarden/Scout/Guardian ensembles; Hara'ti Champion." ]],
  ["The Singularity", [
    "Track begins.", "Unlock Research Console and starter collection gear.", "Research samples / related Console progression.", "Stormarion rare/core benefit.", "Buy Singularity profession recipes and contract.", "Stormarion event/rare utility.", "Season 2: complete refreshed 279 trinket quest.", "Activity/collection gate.", "Buy +10 Alchemy/Blacksmithing/Engineering Knowledge books.", "Collection/system gate.", "Unlock Stormarion mercenary/event utility.", "Core/event benefit.", "Collection/vendor gate.", "Core/event benefit.", "Collection/vendor gate.", "Core/event benefit.", "Mount/cosmetic vendor tier.", "Collection/vendor gate.", "Mount vendor tier.", "Title/ensemble tier; contributes to Midnight Diplomat." ]],
  ["Zul'jarra's Forces", [
    "Track begins.", "Buy cloak appearance; Counter-Curse Bounty awards 272 Veteran bracers.", "Find Coiled Isle treasures and buy camp decor.", "First daily Curse Surge boss can drop a Corrosive Soul.", "Buy 12.1 profession recipes, contract and Snakehead lure.", "Buy profession-knowledge books and claim Marl.", "Rank reward/collection gate; no documented player-power unlock.", "Rank reward/collection gate; no documented player-power unlock.", "Rank reward/collection gate; no documented player-power unlock.", "Begin the multi-day Spirit of Tok'jara mount quest.", "Rank reward/collection gate.", "Rank reward/collection gate.", "Rank reward/collection gate.", "Rank reward/collection gate.", "Rank reward/collection gate.", "Rank reward/collection gate.", "Buy Indigo Coiled Horror mount.", "Rank reward/collection gate.", "Buy Violet-Backed Skyfang mount.", "Weapon/cosmetic vendor tier; Zul'jarra Champion." ]],
] as const;

export default function RenownResearch() {
  return (
    <section id="renown" className="research-section" aria-labelledby="renown-heading">
      <p className="eyebrow">Research topic · Retail · Midnight · Patch 12.1.x · Season 2 · 28 September 2026 snapshot</p>
      <h2 id="renown-heading">Midnight 12.1 Renown &amp; Reputation</h2>
      <p>This detailed companion to the Endgame field guide is reference material, not live character tracking or a required weekly checklist.</p>
      <div className="research-evidence"><strong>Freshness rule:</strong> the four refreshed Season 2 gear quests use current 12.1 evidence. Several detailed primary-faction reward tables predate Season 2; they remain useful for vendors, ranks and profession unlocks, but their old 246/Champion gear labels are deliberately not used here. <SourceLink href={SOURCE.refresh}>12.1 quest-refresh evidence</SourceLink></div>
      <div className="research-callout"><strong>Account-first:</strong> major Midnight Renown is Warband-wide. Prioritize permanent account eligibility and actual roster professions; do not make every alt grind a separate “best faction.” Recipes, Knowledge Points, Moxie, and learned profession recipes remain character/profession-specific.</div>

      <div className="research-table-wrap"><table className="research-table"><thead><tr><th>Track</th><th>Zone / quartermaster</th><th>Account scope</th><th>Meaningful account breakpoint</th></tr></thead><tbody>
        <tr><th>Silvermoon Court</th><td>Eversong Woods · Caeris Fairdawn<br /><code>/way #2395 43.4 47.4</code></td><td>Warband-wide 20-rank Renown; 2,500 rep/rank</td><td>R6: Enchanting/Jewelcrafting/Tailoring +10 Knowledge; R9: 279 helm quest</td></tr>
        <tr><th>Amani Tribe</th><td>Zul'Aman · Magovu<br /><code>/way #2437 45.8 65.8</code></td><td>Warband-wide 20-rank Renown; 2,500 rep/rank</td><td>R6: Leatherworking/Mining/Skinning +10 Knowledge; R9: 279 neck quest</td></tr>
        <tr><th>Hara'ti</th><td>Harandar · Naynar<br /><code>/way #2413 51.0 50.8</code></td><td>Warband-wide 20-rank Renown; 2,500 rep/rank</td><td>R6: Herbalism/Inscription +10 Knowledge; R8: 279 waist quest</td></tr>
        <tr><th>The Singularity</th><td>Voidstorm · Void Researcher Anomander<br /><code>/way #2444 52.6 72.8</code></td><td>Warband-wide 20-rank Renown; 2,500 rep/rank</td><td>R7: 279 trinket quest; R9: Alchemy/Blacksmithing/Engineering +10 Knowledge</td></tr>
        <tr><th>Zul'jarra's Forces</th><td>Coiled Isle · Jan'sari the Watchful<br /><code>/way #2512 58.77 45.97</code></td><td>Warband-wide 20-rank Renown; 12.1 track</td><td>R5: Season 2 recipes; R6: profession-knowledge access</td></tr>
      </tbody></table></div>
      <p>Rank unlocks are account eligibility, not an automatic learned-recipe grant. Buy and consume a Moxie-gated book or recipe on the intended profession character. Paragon progress continues after rank 20. <SourceLink href={SOURCE.amani}>Framework and activity sources</SourceLink></p>

      <details className="mechanic-detail" open><summary><span>1</span>Plain-language guide to the things these ranks unlock</summary><div className="tutorial-body">
        <div className="research-table-wrap"><table className="research-table"><thead><tr><th>Unlock</th><th>What it actually is</th><th>Why it matters / does not matter</th></tr></thead><tbody>
          <tr><th>Profession recipe</th><td>Permission for the matching profession holder to buy and learn a named recipe from that faction's vendor. The rank does not craft it, supply materials, spend a Spark, or teach it to every alt.</td><td>Useful only if the account has that profession and wants that product. It is an economy/profession unlock, not automatic player power.</td></tr>
          <tr><th>+10 Knowledge book</th><td>A one-time, profession-specific consumable that gives its reader ten permanent Knowledge Points for that Midnight profession.</td><td>This changes that crafter's specialization options and long-term crafting capability. It is the most durable non-gear value in the primary tracks.</td></tr>
          <tr><th>Voidlight Marl</th><td>Faction-vendor currency claimed or spent at the quartermaster on rank-gated recipes, cosmetics, mounts, decor, and early gear.</td><td>It does not directly raise item level. Save it for a purchase you actually want; faction eligibility and having enough Marl are separate conditions.</td></tr>
          <tr><th>Saltheril's Soiree / Brimming Arcana</th><td>Eversong's social weekly. Choose one noble faction, do its Runestone weekly, and earn Brimming Arcana—the currency used by the Court's four social-standing vendors.</td><td>Higher Court ranks increase Arcana income. The social standings unlock themed outfits, decor and a few profession-flavor recipes; they are not a Hunter, tank, or healer power tree.</td></tr>
          <tr><th>Amani Spoils / Abyss Angler / Fused Vitality</th><td>Spoils are Zul'Aman treasure chests. Abyss Angler is a diving world-event loop. Fused Vitality is a rank-gated purchase from Abundance event vendors.</td><td>These expand outdoor activity and collection/currency options. Read the live item tooltip before treating Fused Vitality as a gearing upgrade.</td></tr>
          <tr><th>Traveler Loa blessing</th><td>A selectable outdoor blessing from Wi'lama at Amani'Zar, unlocked at Amani 8.</td><td>It supports the relevant outdoor/Delve play loop; it is not permanent class talent power or an account-wide replacement for normal gear.</td></tr>
          <tr><th>Moth hunting / Luminous Dust</th><td>Harandar collection activity: rank gates reveal/collect sets of moths. Collected moths award Luminous Dust for moth-vendor cosmetics.</td><td>It does not award Hara'ti reputation itself and does not increase combat power. It is an optional exploration/collection system.</td></tr>
          <tr><th>Research Console / samples / cores / mercenaries</th><td>Voidstorm's Singularity activity system. Its ranks progressively open the Console and improve access to related samples, cores, rare-event benefits and event helpers.</td><td>Useful to players engaging with Voidstorm outdoor content. The rank labels are system access/efficiency, not an unexplained stat increase; inspect the live Console for the current selectable reward.</td></tr>
          <tr><th>Curse Surge / Corrosive Soul</th><td>Coiled Isle 12.1 outdoor event. Zul'jarra 4 makes the first Surge boss each day eligible to drop a Corrosive Soul.</td><td>This is a chance at a named event resource, not a guaranteed daily gear drop. It naturally overlaps Curse Sites and Vaults of Atal'Utek activity.</td></tr>
          <tr><th>Counter-Curse Bounty</th><td>Zul'jarra 2 quest unlocked by the Renown track; it awards 272 Veteran bracers.</td><td>A fresh-90 slot fill-in. It is below the four 279 refreshed primary-faction quests and becomes obsolete once the slot is better.</td></tr>
          <tr><th>Finery Funds, decor, ensembles, titles, pets, mounts</th><td>Collection currencies and vendor gates: housing pieces, appearance sets, titles, pets and mounts.</td><td>These are real account collection rewards, but they do not increase PvE combat performance. “Collection/vendor gate” in the rank table intentionally means this.</td></tr>
          <tr><th>Contract</th><td>Inscription-made weekly buff selecting one major faction to receive extra reputation from qualifying World Quests.</td><td>Only one contract is active at a time. Use it to focus the account's next real breakpoint, not as an additional reputation source for all factions at once.</td></tr>
        </tbody></table></div>
      </div></details>

      <details className="mechanic-detail" open><summary><span>2</span>How to earn Renown: the practical weekly loop</summary><div className="tutorial-body">
        <p><strong>The short version:</strong> do the campaign and side quests in the zone whose track you need; then, each reset, choose that zone's World Quests, Special Assignment, zone event and weekly opportunities. This is not a separate alt grind: qualifying reputation advances the shared Warband track no matter which character earns it.</p>
        <ol>
          <li><strong>Choose one actual breakpoint.</strong> For example, Singularity 9 for Virek's Alchemy/Engineering Knowledge books, or Amani 6 for Mining/Skinning. Do not try to push every faction at once.</li>
          <li><strong>Open the zone map and do its marked World Quests.</strong> They are the repeatable, targeted baseline. Complete the zone campaign and side quests first when available; those are substantial one-time progress, not a daily farm.</li>
          <li><strong>Prioritize the Special Assignment and the zone's named event/weekly.</strong> These are the higher-value recurring opportunities. They reset or rotate, so inspect the live tooltip rather than assuming an old guide's cadence.</li>
          <li><strong>Take overlap you already enjoy.</strong> Bountiful Delve caches, the first weekly rare kills, and the Silvermoon dungeon weekly can add Renown while also advancing gear, Vault, or world-content goals.</li>
          <li><strong>Use exactly one Contract only when it has a purpose.</strong> An Inscription Contract adds the selected track's reputation to qualifying World Quests. Replace it when your next useful breakpoint changes; it does not award reputation to every faction simultaneously.</li>
        </ol>
        <div className="research-table-wrap"><table className="research-table"><thead><tr><th>Source</th><th>What you actually do</th><th>Cadence / safety note</th></tr></thead><tbody>
          <tr><th>Campaign, side quests, treasures and lore</th><td>Quest through the faction's zone and complete its discovery content.</td><td>Mostly one-time progress. Great while leveling/unlocking, but never a repeatable post-cap route.</td></tr>
          <tr><th>World Quests</th><td>Open the appropriate zone map and complete its current faction/zone World Quests.</td><td>Recurring targeted baseline. A matching active Contract adds extra reputation here.</td></tr>
          <tr><th>Special Assignment</th><td>Complete the larger map-marked zone objective once it is available.</td><td>Recurring opportunity; its live UI communicates the current reset/requirements.</td></tr>
          <tr><th>Zone event and zone weekly</th><td>Join the activity native to that zone: Soiree/Runestone, Abundance, Legends of the Haranir, Stormarion Assault, or Coiled Isle activities.</td><td>Choose it when it also gives an activity reward you value; event rewards are commonly limited by a weekly/daily cadence.</td></tr>
          <tr><th>First weekly rare kills and Bountiful Delve caches</th><td>Kill eligible zone rares or finish a Bountiful Delve.</td><td>Useful overlap, not evidence that endlessly repeating the same rare or Delve is an unlimited Renown farm.</td></tr>
          <tr><th>Halduron's Silvermoon dungeon weekly</th><td>Complete the current dungeon-weekly objective and choose its offered faction.</td><td>It chooses <strong>one</strong> faction for that week, not a reward for every track.</td></tr>
        </tbody></table></div>
        <div className="research-callout"><strong>Do not grind blindly:</strong> after one-time quests, treasures, first rare rewards and the current weekly/event opportunities are exhausted, ordinary repeat activity is usually poor Renown efficiency. Let the next cycle arrive or play another endgame lane instead. <SourceLink href={SOURCE.amani}>Current primary-track sources</SourceLink> <span aria-hidden="true">·</span> <SourceLink href={SOURCE.zuljarra}>Current 12.1 Zul'jarra source</SourceLink></div>
      </div></details>

      <details className="mechanic-detail"><summary><span>3</span>Season 2 power rewards: useful fill-ins, not a class ranking</summary><div className="tutorial-body">
        <div className="research-table-wrap"><table className="research-table"><thead><tr><th>Faction / rank</th><th>Event</th><th>Reward</th><th>Use</th></tr></thead><tbody>
          <tr><th>Silvermoon Court 9</th><td>Saltheril's Soiree / Runestone</td><td>Helm, ilvl 279</td><td>Armor/stat fill-in only.</td></tr>
          <tr><th>Amani Tribe 9</th><td>Abundance</td><td>Neck, ilvl 279</td><td>Targeted early fill-in.</td></tr>
          <tr><th>Hara'ti 8</th><td>Legends of the Haranir</td><td>Waist, ilvl 279</td><td>Armor-type fill-in only.</td></tr>
          <tr><th>The Singularity 7</th><td>Stormarion Assault</td><td>Trinket, ilvl 279</td><td>Compare effect, not item level alone.</td></tr>
        </tbody></table></div>
        <p><strong>Confirmed:</strong> Patch 12.1 reset these quest rewards and raised them to ilvl 279. <strong>UNKNOWN / needs a live check:</strong> exact upgrade track, per-alt claim entitlement, repeat-claim behavior, and precise prerequisite flags. Unknown does not mean unavailable or completed.</p>
      </div></details>

      <details className="mechanic-detail"><summary><span>4</span>Profession priorities: the real account differentiation</summary><div className="tutorial-body">
        <div className="research-table-wrap"><table className="research-table"><thead><tr><th>Profession(s)</th><th>Renown target</th><th>Reason</th></tr></thead><tbody>
          <tr><th>Alchemy, Blacksmithing, Engineering</th><td>Singularity 9</td><td>One-time +10 Knowledge book for each profession holder.</td></tr>
          <tr><th>Enchanting, Jewelcrafting, Tailoring</th><td>Silvermoon Court 6</td><td>One-time +10 Knowledge books.</td></tr>
          <tr><th>Herbalism, Inscription</th><td>Hara'ti 6</td><td>One-time +10 Knowledge books.</td></tr>
          <tr><th>Leatherworking, Mining, Skinning</th><td>Amani Tribe 6</td><td>One-time +10 Knowledge books.</td></tr>
          <tr><th>Inscription</th><td>Major tracks at R5; Zul'jarra R5</td><td>Contracts; only one active contract benefits the Warband.</td></tr>
          <tr><th>Cooking / Fishing</th><td>Amani R5 / Zul'jarra R5; Captain Tokka</td><td>Specific recipes and fishing progression, not a primary KP route.</td></tr>
        </tbody></table></div>
        <p><strong>Roster guidance:</strong> Virek's best profession target is Singularity 9 (Engineering + Alchemy); Janne benefits from Hara'ti 6 (Herbalism) and Amani 6 (Mining); Squashpot benefits from Amani 6 (Skinning). There is no verified Hunter/BM-only Renown exception. <SourceLink href={SOURCE.knowledge}>Knowledge and Moxie source</SourceLink></p>
      </div></details>

      <details className="mechanic-detail"><summary><span>5</span>Efficient overlap, minor systems, and Journeys</summary><div className="tutorial-body">
        <p>Advance major tracks through zone campaign/side quests, World Quests, Special Assignments, zone events, weekly rare first kills, Bountiful Delve caches, and the Silvermoon dungeon weekly. The dungeon weekly selects one faction; one Inscription contract can be active. Coiled Isle WQs, Curse Sites and Vaults of Atal'Utek naturally advance Zul'jarra while doing 12.1 outdoor content. <SourceLink href={SOURCE.zuljarra}>Zul'jarra sources</SourceLink></p>
        <div className="research-table-wrap"><table className="research-table"><thead><tr><th>System</th><th>What it rewards</th><th>Decision</th></tr></thead><tbody>
          <tr><th>Captain Tokka</th><td>Coiled Isle fishing standing; Cursed Angler profession recipes, then fishing rod/mount/collection</td><td>Fishing-focused; full Warband standing scope is UNKNOWN.</td></tr>
          <tr><th>Slayer's Duellum</th><td>Slayer's Rise PvP cosmetics, pets, mounts, decor</td><td>Optional PvP/collection; no documented PvE class/profession power priority.</td></tr>
          <tr><th>Silvermoon social standings</th><td>Blood Knights, Farstriders, Magisters, Shades of the Row cosmetics</td><td>Separate from Court Renown; choose desired rewards, not class flavor.</td></tr>
          <tr><th>Ritual Sites</th><td>Activity utility, Field Accolades, gear/World-Vault overlap, collections</td><td>Relevant when doing Ritual Sites; not a hidden ordinary-PvE requirement.</td></tr>
        </tbody></table></div>
        <p><strong>Version boundary:</strong> Aqir Research Enclave is 12.1.5 PTR material and excluded. Adventure Guide → Journeys centralizes visible Renown/cultural reputation, Delves, Prey and a Vault shortcut. It does not prove unclaimed rewards, learned recipes, weekly caps, or account/character ownership. WoWSync does not yet capture live Renown/Journeys state; any future work must retain observed, derived, unknown, and last-seen separately. <SourceLink href={SOURCE.journeys}>Blizzard Journeys source</SourceLink> <span aria-hidden="true">·</span> <SourceLink href={SOURCE.captain}>Captain Tokka source</SourceLink> <span aria-hidden="true">·</span> <SourceLink href={SOURCE.ritualSites}>Ritual Sites source</SourceLink></p>
      </div></details>
      <details className="mechanic-detail"><summary><span>6</span>Rank-by-rank: what every major Renown level actually unlocks</summary><div className="tutorial-body">
        <p>Every row below is an unlock explanation, not a recommendation. A “collection/vendor gate” means it opens cosmetics, decor, pets, mounts, titles, or vendor stock; it does not improve combat power. The four Season 2 gear rows override the old Season 1 guide values.</p>
        {RANK_BREAKDOWN.map(([faction, rewards]) => <div key={faction} className="research-table-wrap"><table className="research-table"><caption>{faction}</caption><thead><tr><th>Rank</th><th>What it actually does</th></tr></thead><tbody>{rewards.map((reward, index) => <tr key={index + 1}><th>{index + 1}</th><td>{reward}</td></tr>)}</tbody></table></div>)}
      </div></details>
      <p className="research-footnote">Detailed rank matrix, exact recipe mapping, source freshness and disagreement log: <code>docs/MIDNIGHT_12_1_RENOWN_REPUTATION_RESEARCH.md</code>. Broader context: <code>docs/MIDNIGHT_12_1_ENDGAME_RESEARCH.md</code>.</p>
    </section>
  );
}
