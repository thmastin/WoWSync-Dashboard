import { formatCopper, formatCopperDelta, formatPlaytime } from "../format.ts";
import type { ScopedFacts } from "../scopedFacts.ts";
import { describeGoldTotal, describePlaytimeTotal } from "../totals.ts";

export default function AccountEconomy({ scoped }: { scoped: ScopedFacts; onOpenCharacter?: (key: string) => void }) {
  const facts = scoped;
  const goldTotal = describeGoldTotal(facts.gold, facts.now);
  const playtimeTotal = describePlaytimeTotal(facts.playtime, facts.characters.length, facts.now);

  return (
    <div className="economy">
      <div className="scope-label detail-card-wide">{scoped.scopeLabel}</div>
      <p className="muted small detail-card-wide" style={{ marginBottom: 4 }}>
        Gold ledger and /played for this version and realm scope. Profession coverage lives on the Professions tab; item search is on the Items tab.
      </p>

      <section className="panel">
        <h3>Gold</h3>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Total known gold: <strong>{goldTotal.value}</strong> - {goldTotal.basis}
          {goldTotal.known && <> A sum of each character&apos;s last observed gold, not a live balance.</>}
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
                <tr key={g.identityKey} onClick={() => onOpenCharacter?.(g.identityKey)}>
                  <td>{g.name}</td>
                  <td>{formatCopper(g.goldCopper)}</td>
                  <td>{g.deltaCopper !== undefined ? formatCopperDelta(g.deltaCopper) : "-"}</td>
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
          Total known /played: <strong>{playtimeTotal.value}</strong> - {playtimeTotal.basis}
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
                <tr key={p.identityKey} onClick={() => onOpenCharacter?.(p.identityKey)}>
                  <td>{p.name}</td>
                  <td>{formatPlaytime(p.playedSeconds)}</td>
                  <td>{formatPlaytime(p.levelPlayedSeconds)}</td>
                  <td>{p.deltaPlayedSeconds !== undefined ? `+${formatPlaytime(p.deltaPlayedSeconds)}` : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
