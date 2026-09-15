import { formatCopper } from "../format.ts";
import type { SummarizedAbility, TrainerCategory } from "../types.ts";

function categoryLabel(category: string): string {
  if (category === "CLASS") return "Class Trainer";
  if (category === "WEAPON") return "Weapon Trainer";
  if (category === "UNKNOWN") return "Unresolved Trainer Visit";
  if (category.startsWith("PROF_")) {
    return category
      .slice(5)
      .split("_")
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(" ");
  }
  return category;
}

function levelLabel(level: number): string {
  // 0 is a real, observed value (Blizzard's own "no level requirement"
  // convention for skill-gated recipes) — this is a direct translation of
  // that, not a guess.
  return level === 0 ? "No level requirement" : `Level ${level}`;
}

function StatusBadge({ state }: { state: string }) {
  return <span className={`status-badge status-${state.toLowerCase()}`}>{state}</span>;
}

function AbilityRow({ ability, showRequiredLevel }: { ability: SummarizedAbility; showRequiredLevel?: boolean }) {
  return (
    <li className="ability-row">
      <span className="ability-name">{ability.ability ?? "?"}</span>
      {ability.rank && ability.rank !== "-" && <span className="muted"> — {ability.rank}</span>}
      {ability.costCopper !== undefined && <span className="muted"> — {formatCopper(ability.costCopper)}</span>}
      {showRequiredLevel && ability.requiredLevel !== undefined && (
        <span className="muted"> — {levelLabel(ability.requiredLevel)}</span>
      )}
      {ability.requirementsAtVisit && ability.requirementsAtVisit !== "-" && (
        <div className="ability-requirement muted small">requires: {ability.requirementsAtVisit}</div>
      )}
    </li>
  );
}

export default function TrainerCategoryCard({ category }: { category: TrainerCategory }) {
  const summary = category.summary;

  return (
    <div className="trainer-category">
      <div className="trainer-category-header">
        <strong>{categoryLabel(category.category)}</strong>
        {category.name && <span className="muted"> — {category.name}</span>}
        <StatusBadge state={category.status.state} />
      </div>

      {category.status.state === "UNKNOWN" ? (
        <p className="muted small">Not observed{category.status.reason ? `: ${category.status.reason}` : "."}</p>
      ) : !summary || summary.totalServices === 0 ? (
        <p className="muted small">No trainer services recorded for this visit.</p>
      ) : (
        <>
          <div className="trainer-summary-line muted small">
            Available: {summary.available.length} · Upcoming: {summary.upcomingByLevel.reduce((n, g) => n + g.abilities.length, 0)}
            {summary.known.length > 0 ? ` · Already known: ${summary.known.length}` : ""}
            {summary.unknownUnlockLevel.length > 0 ? ` · Unknown level: ${summary.unknownUnlockLevel.length}` : ""}
            {category.status.visitedZone ? ` · Last seen: ${category.status.visitedZone}` : ""}
          </div>

          {summary.nextTraining && (
            <div className="next-training">
              <span className="next-training-label">Next Training</span>{" "}
              {levelLabel(summary.nextTraining.requiredLevel)} — {summary.nextTraining.abilityCount} abilit
              {summary.nextTraining.abilityCount === 1 ? "y" : "ies"}
              {summary.nextTraining.totalCostCopper !== undefined && (
                <>
                  {" "}
                  — {summary.nextTraining.costPartial ? "≥" : ""}
                  {formatCopper(summary.nextTraining.totalCostCopper)}
                </>
              )}
            </div>
          )}

          {summary.available.length > 0 && (
            <div className="trainer-block">
              <div className="trainer-block-title">Available Now</div>
              <ul className="ability-list">
                {summary.available.map((a, i) => (
                  <AbilityRow key={i} ability={a} />
                ))}
              </ul>
            </div>
          )}

          <details className="trainer-drilldown">
            <summary>Show all trainer details ({summary.totalServices})</summary>

            {summary.upcomingByLevel.length > 0 && (
              <div className="trainer-block">
                <div className="trainer-block-title">Upcoming Training</div>
                {summary.upcomingByLevel.map((group) => (
                  <details key={group.requiredLevel} className="level-group">
                    <summary>
                      {levelLabel(group.requiredLevel)} — {group.abilities.length} abilit
                      {group.abilities.length === 1 ? "y" : "ies"}
                      {group.totalCostCopper !== undefined && (
                        <span className="muted">
                          {" "}
                          ({group.costPartial ? "≥" : ""}
                          {formatCopper(group.totalCostCopper)})
                        </span>
                      )}
                    </summary>
                    <ul className="ability-list">
                      {group.abilities.map((a, i) => (
                        <AbilityRow key={i} ability={a} />
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            )}

            {summary.unknownUnlockLevel.length > 0 && (
              <div className="trainer-block">
                <div className="trainer-block-title">Unknown Unlock Level</div>
                <ul className="ability-list">
                  {summary.unknownUnlockLevel.map((a, i) => (
                    <AbilityRow key={i} ability={a} />
                  ))}
                </ul>
              </div>
            )}

            {summary.known.length > 0 && (
              <div className="trainer-block">
                <div className="trainer-block-title">Already Known ({summary.known.length})</div>
                <ul className="ability-list">
                  {summary.known.map((a, i) => (
                    <AbilityRow key={i} ability={a} />
                  ))}
                </ul>
              </div>
            )}
          </details>
        </>
      )}
    </div>
  );
}
