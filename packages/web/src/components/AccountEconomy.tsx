import { useState } from "react";
import { formatCopper, formatCopperDelta, formatPlaytime } from "../format.ts";
import type { AccountFacts, InventoryAggregateEntry } from "../types.ts";

export default function AccountEconomy({ facts, onOpenCharacter }: { facts: AccountFacts; onOpenCharacter: (key: string) => void }) {
  return (
    <div className="economy">
      <section className="panel">
        <h3>Gold</h3>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Total known gold: <strong>{formatCopper(facts.gold.totalKnownCopper)}</strong>
          {facts.gold.charactersWithUnknownGold > 0 && (
            <> — {facts.gold.charactersWithUnknownGold} character(s) not observed; not counted as zero.</>
          )}
        </div>
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Character</th>
                <th>Gold</th>
                <th>Since last snapshot</th>
              </tr>
            </thead>
            <tbody>
              {facts.gold.byCharacter.map((g) => (
                <tr key={g.identityKey} onClick={() => onOpenCharacter(g.identityKey)}>
                  <td>{g.name}</td>
                  <td>{formatCopper(g.goldCopper)}</td>
                  <td>{g.deltaCopper !== undefined ? formatCopperDelta(g.deltaCopper) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {facts.gold.largestRecentChanges.length > 0 && (
          <div className="muted small" style={{ marginTop: 8 }}>
            Largest recent change: <strong>{facts.gold.largestRecentChanges[0].name}</strong>{" "}
            {formatCopperDelta(facts.gold.largestRecentChanges[0].deltaCopper)}
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Playtime</h3>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Total known /played: <strong>{formatPlaytime(facts.playtime.totalKnownPlayedSeconds)}</strong>
        </div>
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Character</th>
                <th>Total /played</th>
                <th>This level</th>
                <th>Since last snapshot</th>
              </tr>
            </thead>
            <tbody>
              {facts.playtime.byCharacter.map((p) => (
                <tr key={p.identityKey} onClick={() => onOpenCharacter(p.identityKey)}>
                  <td>{p.name}</td>
                  <td>{formatPlaytime(p.playedSeconds)}</td>
                  <td>{formatPlaytime(p.levelPlayedSeconds)}</td>
                  <td>{p.deltaPlayedSeconds !== undefined ? `+${formatPlaytime(p.deltaPlayedSeconds)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel detail-card-wide">
        <h3>Professions</h3>
        {facts.professions.coverage.length === 0 && <p className="muted">No profession data observed yet.</p>}
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Profession</th>
                <th>Characters</th>
              </tr>
            </thead>
            <tbody>
              {facts.professions.coverage.map((entry) => (
                <tr key={entry.profession}>
                  <td>{entry.profession}</td>
                  <td>{entry.characters.map((c) => `${c.name} (${c.skill ?? "?"}/${c.maxSkill ?? "?"})`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {facts.professions.byCharacter.some((c) => c.status === "UNKNOWN") && (
          <div className="muted small" style={{ marginTop: 8 }}>
            {facts.professions.byCharacter.filter((c) => c.status === "UNKNOWN").map((c) => c.name).join(", ")}: professions never observed.
          </div>
        )}
      </section>

      <InventorySearch facts={facts} onOpenCharacter={onOpenCharacter} />
    </div>
  );
}

function InventorySearch({ facts, onOpenCharacter }: { facts: AccountFacts; onOpenCharacter: (key: string) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const results: InventoryAggregateEntry[] = q.length === 0 ? [] : facts.inventory.items.filter((i) => (i.name ?? "").toLowerCase().includes(q));

  return (
    <section className="panel detail-card-wide">
      <h3>Item search</h3>
      <input
        className="item-search-input"
        type="text"
        placeholder="Search known inventory (e.g. Strange Dust)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {facts.inventory.hasUnknownStorage && (
        <div className="muted small" style={{ marginTop: 6 }}>
          Some characters' bags/bank were never observed — results below are a <strong>known total</strong>, not
          necessarily the complete account total.
          {facts.inventory.unknownBank.length > 0 && (
            <> Bank unknown for: {facts.inventory.unknownBank.map((c) => c.name).join(", ")}.</>
          )}
        </div>
      )}
      {q.length > 0 && results.length === 0 && <p className="muted small">No known items match "{query}".</p>}
      {results.map((item) => (
        <div key={item.itemKey} className="inventory-result">
          <div className="inventory-result-header">
            <strong>{item.name ?? "?"}</strong> <span className="muted">Known total: {item.totalKnownQty}</span>
          </div>
          <ul className="compact-list">
            {item.locations.map((loc, i) => (
              <li key={i} className="clickable" onClick={() => onOpenCharacter(loc.identityKey)}>
                {loc.name} — {loc.storage === "bags" ? "Bags" : "Bank"}: {loc.qty}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
