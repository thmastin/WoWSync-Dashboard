import { useMemo, useState } from "react";
import type { ScopedFacts } from "../scopedFacts.ts";
import type { ProfessionCoverageEntry } from "../types.ts";

function skillLabel(skill?: number, maxSkill?: number, tier?: string): string {
  const left = skill === undefined ? "?" : String(skill);
  const right = maxSkill === undefined ? "?" : String(maxSkill);
  const base = `${left}/${right}`;
  return tier ? `${base} - ${tier}` : base;
}

function matchesFilter(profession: string, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return profession.toLowerCase().includes(q);
}

export default function AccountProfessions({
  scoped,
  onOpenCharacter,
}: {
  scoped: ScopedFacts;
  onOpenCharacter: (identityKey: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const coverage = scoped.professions.coverage;

  const filtered = useMemo(
    () => coverage.filter((entry) => matchesFilter(entry.profession, filter)),
    [coverage, filter],
  );

  const covered = filtered.filter((c) => c.coverageStatus === "covered");
  const none = filtered.filter((c) => c.coverageStatus === "none");
  const unknown = filtered.filter((c) => c.coverageStatus === "unknown");

  const hasAny = coverage.length > 0;
  const filterActive = filter.trim().length > 0;

  return (
    <div className="professions">
      <div className="scope-label detail-card-wide">{scoped.scopeLabel}</div>
      <p className="muted small detail-card-wide" style={{ marginBottom: 8 }}>
        Profession coverage for this version and realm scope. Unknown skill is shown as ?, never as 0.
      </p>

      <div className="professions-toolbar">
        <input
          className="roster-search"
          type="search"
          placeholder="Filter profession name."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter professions by name"
        />
      </div>

      {!hasAny && <p className="muted">No profession data observed for this version yet.</p>}

      {hasAny && filterActive && filtered.length === 0 && (
        <p className="muted">No professions match &quot;{filter.trim()}&quot;.</p>
      )}

      {covered.length > 0 && (
        <section className="panel">
          <h3>
            Covered <span className="muted">({covered.length})</span>
          </h3>
          <div className="table-scroll">
            <table className="history-table professions-table">
              <thead>
                <tr>
                  <th>Profession</th>
                  <th>Characters</th>
                  <th>Skill</th>
                </tr>
              </thead>
              <tbody>
                {covered.map((entry) => (
                  <CoveredRow key={entry.profession} entry={entry} onOpenCharacter={onOpenCharacter} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {hasAny && !filterActive && covered.length === 0 && (
        <section className="panel">
          <h3>Covered</h3>
          <p className="muted">No professions covered yet.</p>
        </section>
      )}

      {(none.length > 0 || unknown.length > 0) && (
        <section className="panel">
          <h3>Gaps</h3>
          {none.length > 0 && (
            <div className="professions-gap-block">
              <h4 className="attention-band-label">
                Not covered <span className="muted">({none.length})</span>
              </h4>
              <ul className="compact-list">
                {none.map((entry) => (
                  <li key={entry.profession} className="muted">
                    {entry.profession}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {unknown.length > 0 && (
            <div className="professions-gap-block">
              <h4 className="attention-band-label">
                Unknown coverage <span className="muted">({unknown.length})</span>
              </h4>
              <ul className="compact-list">
                {unknown.map((entry) => (
                  <li key={entry.profession} className="muted">
                    {entry.profession} - unknown
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function CoveredRow({
  entry,
  onOpenCharacter,
}: {
  entry: ProfessionCoverageEntry;
  onOpenCharacter: (identityKey: string) => void;
}) {
  return (
    <tr>
      <td>
        <strong>{entry.profession}</strong>
      </td>
      <td>
        <div className="profession-char-list">
          {entry.characters.map((c) => (
            <button
              key={c.identityKey}
              type="button"
              className="roster-name-link profession-char-chip"
              onClick={() => onOpenCharacter(c.identityKey)}
            >
              {c.name}
            </button>
          ))}
          {entry.characters.length === 0 && <span className="muted">-</span>}
        </div>
      </td>
      <td>
        <div className="profession-skill-list">
          {entry.characters.map((c) => (
            <span key={c.identityKey} className="profession-skill-chip" title={c.name}>
              {skillLabel(c.skill, c.maxSkill, c.tier)}
            </span>
          ))}
          {entry.characters.length === 0 && <span className="muted">?/?</span>}
        </div>
      </td>
    </tr>
  );
}