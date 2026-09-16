import { formatCopper, formatCopperDelta, formatPlaytime, formatRelativeTime, formatXpPercent, freshnessLabel } from "../format.ts";
import type { ScopedFacts } from "../scopedFacts.ts";

export default function AccountOverview({ scoped, onOpenCharacter }: { scoped: ScopedFacts; onOpenCharacter: (key: string) => void }) {
  const facts = scoped;
  const characterCount = facts.characters.length;
  const recentlyUpdated = [...facts.characters]
    .filter((c) => c.lastImportedAt !== undefined)
    .sort((a, b) => (b.lastImportedAt ?? 0) - (a.lastImportedAt ?? 0))
    .slice(0, 5);

  const staleOrUnknown = facts.freshness.byCharacter.filter((c) => c.freshness !== "recent");
  const covered = facts.professions.coverage.filter((c) => c.coverageStatus === "covered");
  const missing = facts.professions.coverage.filter((c) => c.coverageStatus !== "covered");

  return (
    <div className="overview">
      <div className="scope-label">{scoped.scopeLabel}</div>
      <div className="stat-row">
        <StatTile label="Characters" value={String(characterCount)} />
        <StatTile
          label="Total known gold"
          value={facts.gold.charactersWithKnownGold > 0 ? formatCopper(facts.gold.totalKnownCopper) : "?"}
          hint={facts.gold.charactersWithUnknownGold > 0 ? `${facts.gold.charactersWithUnknownGold} character(s) unobserved` : undefined}
        />
        <StatTile
          label="Total known /played"
          value={facts.playtime.charactersWithKnownPlaytime > 0 ? formatPlaytime(facts.playtime.totalKnownPlayedSeconds) : "?"}
          hint={
            facts.playtime.charactersWithKnownPlaytime < characterCount
              ? `${characterCount - facts.playtime.charactersWithKnownPlaytime} character(s) unobserved`
              : undefined
          }
        />
        <StatTile
          label="Data freshness"
          value={`${facts.freshness.recentCharacters} recent`}
          hint={
            facts.freshness.staleCharacters + facts.freshness.unknownCharacters > 0
              ? `${facts.freshness.staleCharacters} stale, ${facts.freshness.unknownCharacters} unknown`
              : "all up to date"
          }
        />
      </div>

      <div className="overview-columns">
        <section className="panel">
          <h3>Recently updated</h3>
          {recentlyUpdated.length === 0 && <p className="muted">No characters imported for this scope yet.</p>}
          <ul className="compact-list">
            {recentlyUpdated.map((c) => (
              <li key={c.identityKey} className="clickable" onClick={() => onOpenCharacter(c.identityKey)}>
                <strong>{c.name}</strong> <span className="muted">Lv {c.level ?? "?"} · {formatRelativeTime(c.lastImportedAt)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h3>Recent changes</h3>
          {facts.recentChanges.length === 0 && <p className="muted">No changes since the last import.</p>}
          <ul className="compact-list">
            {facts.recentChanges.map((c, i) => (
              <li key={i} className="clickable" onClick={() => onOpenCharacter(c.identityKey)}>
                <strong>{c.characterName}</strong>{" "}
                <span className="muted">
                  {c.levelChanged ? `Level ${c.fromLevel ?? "?"}→${c.toLevel ?? "?"} · ` : ""}
                  {c.goldDeltaCopper ? `${formatCopperDelta(c.goldDeltaCopper)} · ` : ""}
                  {c.locationChanged ? "moved · " : ""}
                  {c.professionChanged ? "profession · " : ""}
                  {c.inventoryChanged ? "inventory · " : ""}
                  {c.trainerUnlocked ? "trainer unlock · " : ""}
                  {formatRelativeTime(c.importedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h3>Progression</h3>
          {facts.progression.recentLevelUps.length === 0 && !facts.progression.closestToNextLevel && (
            <p className="muted">No progression data yet.</p>
          )}
          {facts.progression.recentLevelUps.length > 0 && (
            <ul className="compact-list">
              {facts.progression.recentLevelUps.map((lu) => (
                <li key={lu.identityKey} className="clickable" onClick={() => onOpenCharacter(lu.identityKey)}>
                  <strong>{lu.name}</strong> <span className="muted">Level {lu.fromLevel} → {lu.toLevel}</span>
                </li>
              ))}
            </ul>
          )}
          {facts.progression.closestToNextLevel && (
            <div className="muted small" style={{ marginTop: 6 }}>
              Closest to next level: <strong>{facts.progression.closestToNextLevel.name}</strong> (
              {formatXpPercent(facts.progression.closestToNextLevel.xpPercent)})
            </div>
          )}
        </section>

        <section className="panel">
          <h3>Professions coverage</h3>
          {facts.professions.coverage.length === 0 && <p className="muted">No profession catalog for this version.</p>}
          {covered.length === 0 && missing.length > 0 && <p className="muted">No professions covered yet.</p>}
          <ul className="compact-list">
            {covered.slice(0, 8).map((entry) => (
              <li key={entry.profession}>
                <strong>{entry.profession}</strong>{" "}
                <span className="muted">{entry.characters.map((c) => `${c.name} (${c.skill ?? "?"})`).join(", ")}</span>
              </li>
            ))}
          </ul>
          {missing.length > 0 && (
            <details className="coverage-missing">
              <summary>
                {missing.filter((m) => m.coverageStatus === "none").length} not covered
                {missing.some((m) => m.coverageStatus === "unknown") ? `, ${missing.filter((m) => m.coverageStatus === "unknown").length} unknown` : ""}
              </summary>
              <ul className="compact-list">
                {missing.map((entry) => (
                  <li key={entry.profession} className="muted small">
                    {entry.profession} — {entry.coverageStatus === "none" ? "none" : "unknown coverage"}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="panel">
          <h3>Data freshness</h3>
          {staleOrUnknown.length === 0 && <p className="muted">Every character was observed within the last few days.</p>}
          <ul className="compact-list">
            {staleOrUnknown.map((c) => (
              <li key={c.identityKey} className="clickable" onClick={() => onOpenCharacter(c.identityKey)}>
                <strong>{c.name}</strong>{" "}
                <span className={`muted freshness-text-${c.freshness}`}>
                  {freshnessLabel(c.freshness)} — last seen {formatRelativeTime(c.lastObservedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h3>Account summary (LLM)</h3>
          <p className="muted">
            Ask-my-account analysis isn't wired up yet. Once enabled, this panel will summarize this scope's
            account state using the deterministic facts above — never raw exports.
          </p>
        </section>
      </div>
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}
