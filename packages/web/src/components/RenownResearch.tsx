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

      <details className="mechanic-detail" open><summary><span>1</span>Season 2 power rewards: useful fill-ins, not a class ranking</summary><div className="tutorial-body">
        <div className="research-table-wrap"><table className="research-table"><thead><tr><th>Faction / rank</th><th>Event</th><th>Reward</th><th>Use</th></tr></thead><tbody>
          <tr><th>Silvermoon Court 9</th><td>Saltheril's Soiree / Runestone</td><td>Helm, ilvl 279</td><td>Armor/stat fill-in only.</td></tr>
          <tr><th>Amani Tribe 9</th><td>Abundance</td><td>Neck, ilvl 279</td><td>Targeted early fill-in.</td></tr>
          <tr><th>Hara'ti 8</th><td>Legends of the Haranir</td><td>Waist, ilvl 279</td><td>Armor-type fill-in only.</td></tr>
          <tr><th>The Singularity 7</th><td>Stormarion Assault</td><td>Trinket, ilvl 279</td><td>Compare effect, not item level alone.</td></tr>
        </tbody></table></div>
        <p><strong>Confirmed:</strong> Patch 12.1 reset these quest rewards and raised them to ilvl 279. <strong>UNKNOWN / needs a live check:</strong> exact upgrade track, per-alt claim entitlement, repeat-claim behavior, and precise prerequisite flags. Unknown does not mean unavailable or completed.</p>
      </div></details>

      <details className="mechanic-detail"><summary><span>2</span>Profession priorities: the real account differentiation</summary><div className="tutorial-body">
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

      <details className="mechanic-detail"><summary><span>3</span>Efficient overlap, minor systems, and Journeys</summary><div className="tutorial-body">
        <p>Advance major tracks through zone campaign/side quests, World Quests, Special Assignments, zone events, weekly rare first kills, Bountiful Delve caches, and the Silvermoon dungeon weekly. The dungeon weekly selects one faction; one Inscription contract can be active. Coiled Isle WQs, Curse Sites and Vaults of Atal'Utek naturally advance Zul'jarra while doing 12.1 outdoor content. <SourceLink href={SOURCE.zuljarra}>Zul'jarra sources</SourceLink></p>
        <div className="research-table-wrap"><table className="research-table"><thead><tr><th>System</th><th>What it rewards</th><th>Decision</th></tr></thead><tbody>
          <tr><th>Captain Tokka</th><td>Coiled Isle fishing standing; Cursed Angler profession recipes, then fishing rod/mount/collection</td><td>Fishing-focused; full Warband standing scope is UNKNOWN.</td></tr>
          <tr><th>Slayer's Duellum</th><td>Slayer's Rise PvP cosmetics, pets, mounts, decor</td><td>Optional PvP/collection; no documented PvE class/profession power priority.</td></tr>
          <tr><th>Silvermoon social standings</th><td>Blood Knights, Farstriders, Magisters, Shades of the Row cosmetics</td><td>Separate from Court Renown; choose desired rewards, not class flavor.</td></tr>
          <tr><th>Ritual Sites</th><td>Activity utility, Field Accolades, gear/World-Vault overlap, collections</td><td>Relevant when doing Ritual Sites; not a hidden ordinary-PvE requirement.</td></tr>
        </tbody></table></div>
        <p><strong>Version boundary:</strong> Aqir Research Enclave is 12.1.5 PTR material and excluded. Adventure Guide → Journeys centralizes visible Renown/cultural reputation, Delves, Prey and a Vault shortcut. It does not prove unclaimed rewards, learned recipes, weekly caps, or account/character ownership. WoWSync does not yet capture live Renown/Journeys state; any future work must retain observed, derived, unknown, and last-seen separately. <SourceLink href={SOURCE.journeys}>Blizzard Journeys source</SourceLink> <span aria-hidden="true">·</span> <SourceLink href={SOURCE.captain}>Captain Tokka source</SourceLink> <span aria-hidden="true">·</span> <SourceLink href={SOURCE.ritualSites}>Ritual Sites source</SourceLink></p>
      </div></details>
      <p className="research-footnote">Detailed rank matrix, exact recipe mapping, source freshness and disagreement log: <code>docs/MIDNIGHT_12_1_RENOWN_REPUTATION_RESEARCH.md</code>. Broader context: <code>docs/MIDNIGHT_12_1_ENDGAME_RESEARCH.md</code>.</p>
    </section>
  );
}
