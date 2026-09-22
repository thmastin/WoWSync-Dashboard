import { formatCopper, formatCopperDelta, formatPlaytime } from "../format.ts";
import type { ScopedFacts } from "../scopedFacts.ts";
import { describeGoldTotal, describePlaytimeTotal } from "../totals.ts";

export default function AccountEconomy({ scoped }: { scoped: ScopedFacts; onOpenCharacter?: (key: string) => void }) {
  const facts = scoped;
  const goldTotal = describeGoldTotal(facts.gold, facts.now);
  const playtimeTotal = describePlaytimeTotal(facts.playtime, facts.characters.length, facts.now);
  const covered = facts.professions.coverage.filter((c) => c.coverageStatus === "covered");
  const missing = facts.professions.coverage.filter((c) => c.coverageStatus !== "covered");

  return (
    <div className="economy">
      <div className="scope-label detail-card-wide">{scoped.scopeLabel}</div>

      <section className="panel">
        <h3>Gold</h3>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Total known gold: <strong>{goldTotal.value}</strong> — {goldTotal.basis}
          {goldTotal.known && <>. A sum of each character's last observed gold, not a live balance.</>}
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
          Total known /played: <strong>{playtimeTotal.value}</strong> — {playtimeTotal.basis}
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
        {facts.professions.coverage.length === 0 && <p className="muted">No profession catalog for this version.</p>}
        {covered.length > 0 && (
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Profession</th>
                  <th>Characters</th>
                </tr>
              </thead>
              <tbody>
                {covered.map((entry) => (
                  <tr key={entry.profession}>
                    <td>{entry.profession}</td>
                    <td>{entry.characters.map((c) => `${c.name} — ${c.skill ?? "?"}/${c.maxSkill ?? "?"}`).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {missing.length > 0 && (
          <details className="coverage-missing" style={{ marginTop: covered.length > 0 ? 10 : 0 }}>
            <summary>
              {missing.filter((m) => m.coverageStatus === "none").length} profession(s) not covered
              {missing.some((m) => m.coverageStatus === "unknown")
                ? `, ${missing.filter((m) => m.coverageStatus === "unknown").length} with unknown coverage`
                : ""}
            </summary>
            <ul className="compact-list">
              {missing.map((entry) => (
                <li key={entry.profession} className="muted small">
                  {entry.profession} — {entry.coverageStatus === "none" ? "none observed" : "unknown (not every character's professions were observed, or only a 0/0 skill was reported)"}
                </li>
              ))}
            </ul>
          </details>
        )}
        {facts.professions.byCharacter.some((c) => c.observationStatus === "UNKNOWN") && (
          <div className="muted small" style={{ marginTop: 8 }}>
            {facts.professions.byCharacter.filter((c) => c.observationStatus === "UNKNOWN").map((c) => c.name).join(", ")}: professions never observed.
          </div>
        )}
      </section>
      <section className="panel detail-card-wide">
        <h3>Item search</h3>
        <p className="muted small">
          Item search moved to the <strong>Items</strong> tab (same version + realm scope). Use the header box or that tab.
        </p>
      </section>
</div>
  );
}

