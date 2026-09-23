import { buildNeedsAttention, groupNeedsAttentionByAgeBand } from "@wowsync-dashboard/core/needsAttention.ts";
import { classifyRetailProfessionCoverage } from "@wowsync-dashboard/core/professionCatalog.ts";
import { formatAgeSeconds, formatCopperDelta, formatRelativeTime, formatXpPercent } from "../format.ts";
import type { ScopedFacts } from "../scopedFacts.ts";
import { describeGoldTotal, describePlaytimeTotal } from "../totals.ts";

export default function AccountOverview({ scoped, onOpenCharacter, onOpenProfessions }: { scoped: ScopedFacts; onOpenCharacter: (key: string) => void; onOpenProfessions: () => void }) {
  const facts = scoped;
  const characterCount = facts.characters.length;
  const goldTotal = describeGoldTotal(facts.gold, facts.now);
  const playtimeTotal = describePlaytimeTotal(facts.playtime, characterCount, facts.now);
  const attention = buildNeedsAttention(facts.characters, facts.now);
  const attentionGroups = groupNeedsAttentionByAgeBand(attention);

  const isRetail = facts.version === "retail";
  let coveredCount = 0;
  let missingMidnightCount = 0;
  let noneCount = 0;
  let unknownCount = 0;
  for (const c of facts.professions.coverage) {
    if (isRetail) {
      const kind = classifyRetailProfessionCoverage(c);
      if (kind === "currentCovered") coveredCount += 1;
      else if (kind === "olderOnly") missingMidnightCount += 1;
      else if (kind === "none") noneCount += 1;
      else unknownCount += 1;
    } else if (c.coverageStatus === "covered") coveredCount += 1;
    else if (c.coverageStatus === "none") noneCount += 1;
    else unknownCount += 1;
  }
  const professionSummaryParts: string[] = [];
  if (coveredCount > 0) professionSummaryParts.push(coveredCount + " covered");
  if (isRetail && missingMidnightCount > 0) professionSummaryParts.push(missingMidnightCount + " missing Midnight");
  if (noneCount > 0) professionSummaryParts.push(noneCount + " not covered");
  if (unknownCount > 0) professionSummaryParts.push(unknownCount + " unknown");
  const professionSummary =
    facts.professions.coverage.length === 0
      ? "No profession data observed yet"
      : professionSummaryParts.length > 0
        ? professionSummaryParts.join(" · ")
        : "No profession data observed yet";
  const lastSyncedAt = facts.characters
    .map((c) => c.lastObservedAt)
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => b - a)[0];

  return (
    <div className="overview">
      <div className="scope-label">{scoped.scopeLabel}</div>
      <div className="stat-row">
        <StatTile label="Characters" value={String(characterCount)} />
        <StatTile label="Total known gold" value={goldTotal.value} hint={goldTotal.basis} emphasize={goldTotal.hasStale} />
        <StatTile label="Total known /played" value={playtimeTotal.value} hint={playtimeTotal.basis} emphasize={playtimeTotal.hasStale} />
        <StatTile
          label="Last synced"
          value={lastSyncedAt !== undefined ? formatAgeSeconds(facts.now - lastSyncedAt) : "never"}
          hint={
            facts.freshness.staleCharacters + facts.freshness.unknownCharacters > 0
              ? `${facts.freshness.recentCharacters} recent · ${facts.freshness.staleCharacters} stale · ${facts.freshness.unknownCharacters} unknown`
              : characterCount > 0
                ? "all recent"
                : undefined
          }
        />
      </div>

      <div className="overview-columns">
        <section className="panel">
          <h3>Needs attention</h3>
          {attention.length === 0 && (
            <p className="muted">
              Nothing flagged for this scope — every character is recent with observed bank/bags/professions (or those
              sections do not apply yet).
            </p>
          )}
          {attentionGroups.map((group) => (
            <div key={group.band} className="attention-band">
              <h4 className="attention-band-label">
                {group.label}{" "}
                <span className="muted">({group.rows.length})</span>
              </h4>
              <ul className="compact-list">
                {group.rows.map((row) => (
                  <li key={row.identityKey} className="clickable" onClick={() => onOpenCharacter(row.identityKey)}>
                    <strong>{row.name}</strong>{" "}
                    <span className="muted">
                      {row.realm}
                      {" · "}
                      {row.reasons.map((r) => r.text).join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
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
                  {formatRelativeTime(c.observedAt ?? c.importedAt)}
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
          <h3>Professions</h3>
          {facts.professions.coverage.length === 0 ? (
            <p className="muted">No profession data observed for this version yet.</p>
          ) : (
            <p
              className="clickable professions-summary"
              onClick={onOpenProfessions}
              role="link"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpenProfessions();
                }
              }}
            >
              Professions: {professionSummary}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function StatTile({ label, value, hint, emphasize }: { label: string; value: string; hint?: string; emphasize?: boolean }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className={`stat-hint${emphasize ? " stat-hint-stale" : ""}`}>{hint}</div>}
    </div>
  );
}