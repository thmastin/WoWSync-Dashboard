import { useMemo, useState } from "react";
import {
  classifyRetailProfessionCoverage,
  highestProfessionExpansionLabel,
  matchedRetailExpansionName,
  professionPlanningKind,
  selectPrimaryProfessionCharacter,
  type ProfessionPlanningKind,
} from "@wowsync-dashboard/core/professionCatalog.ts";
import type { ScopedFacts } from "../scopedFacts.ts";
import type { ProfessionCoverageEntry } from "../types.ts";

function skillLabel(skill?: number, maxSkill?: number): string {
  const left = skill === undefined ? "?" : String(skill);
  const right = maxSkill === undefined ? "?" : String(maxSkill);
  return `${left}/${right}`;
}

function expansionLabelForCharacter(c: { expansion?: string; tier?: string }): string | undefined {
  return (
    matchedRetailExpansionName(c.expansion) ??
    matchedRetailExpansionName(c.tier) ??
    (c.expansion && c.expansion.toLowerCase() !== "unknown" ? c.expansion : undefined) ??
    c.tier
  );
}

function matchesFilter(profession: string, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return profession.toLowerCase().includes(q);
}

function byProfessionName(a: ProfessionCoverageEntry, b: ProfessionCoverageEntry): number {
  return a.profession.localeCompare(b.profession);
}

type KindBuckets = {
  crafting: ProfessionCoverageEntry[];
  gathering: ProfessionCoverageEntry[];
};

function splitByKind(entries: ProfessionCoverageEntry[]): KindBuckets {
  const crafting: ProfessionCoverageEntry[] = [];
  const gathering: ProfessionCoverageEntry[] = [];
  for (const entry of entries) {
    if (professionPlanningKind(entry.profession) === "gathering") gathering.push(entry);
    else crafting.push(entry);
  }
  crafting.sort(byProfessionName);
  gathering.sort(byProfessionName);
  return { crafting, gathering };
}

const KIND_LABEL: Record<ProfessionPlanningKind, string> = {
  crafting: "Crafting",
  gathering: "Gathering",
};

export default function AccountProfessions({
  scoped,
  onOpenCharacter,
}: {
  scoped: ScopedFacts;
  onOpenCharacter: (identityKey: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const coverage = scoped.professions.coverage;
  const isRetail = scoped.version === "retail";

  const filtered = useMemo(
    () => coverage.filter((entry) => matchesFilter(entry.profession, filter)),
    [coverage, filter],
  );

  const none = useMemo(
    () => splitByKind(filtered.filter((c) => c.coverageStatus === "none")),
    [filtered],
  );
  const unknown = useMemo(
    () => splitByKind(filtered.filter((c) => c.coverageStatus === "unknown")),
    [filtered],
  );
  const olderOnly = useMemo(
    () =>
      isRetail
        ? splitByKind(
            filtered.filter(
              (c) =>
                c.coverageStatus === "covered" && classifyRetailProfessionCoverage(c) === "olderOnly",
            ),
          )
        : { crafting: [], gathering: [] },
    [filtered, isRetail],
  );
  const covered = useMemo(
    () =>
      splitByKind(
        filtered.filter((c) => {
          if (c.coverageStatus !== "covered") return false;
          if (!isRetail) return true;
          return classifyRetailProfessionCoverage(c) === "currentCovered";
        }),
      ),
    [filtered, isRetail],
  );

  const hasAny = coverage.length > 0;
  const filterActive = filter.trim().length > 0;
  const hasGaps =
    none.crafting.length +
      none.gathering.length +
      olderOnly.crafting.length +
      olderOnly.gathering.length +
      unknown.crafting.length +
      unknown.gathering.length >
    0;
  const hasCovered = covered.crafting.length + covered.gathering.length > 0;

  return (
    <div className="professions">
      <div className="scope-label detail-card-wide">{scoped.scopeLabel}</div>
      <p className="muted small detail-card-wide" style={{ marginBottom: 8 }}>
        {isRetail ? (
          <>
            Plan Midnight coverage by craft vs gather. Primary is highest expansion then skill. Gaps
            include professions with no Midnight holder (older expansion only), plus none and unknown.
            Unknown skill shows as ?, never as 0.
          </>
        ) : (
          <>
            Plan coverage by craft vs gather. One solid crafter per craft is usually enough for
            account coverage; gathering tends to follow who you actually play. Unknown skill shows as
            ?, never as 0. None and unknown gaps stay separate.
          </>
        )}
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

      {hasAny && (hasGaps || !filterActive) && (
        <section className="panel">
          <h3>Gaps</h3>
          <KindGapBlock
            kind="crafting"
            none={none.crafting}
            olderOnly={olderOnly.crafting}
            unknown={unknown.crafting}
            showAllClear={!filterActive}
            retailMidnightGaps={isRetail}
          />
          <KindGapBlock
            kind="gathering"
            none={none.gathering}
            olderOnly={olderOnly.gathering}
            unknown={unknown.gathering}
            showAllClear={!filterActive}
            retailMidnightGaps={isRetail}
          />
        </section>
      )}

      {hasAny && (hasCovered || !filterActive) && (
        <section className="panel">
          <h3>Covered</h3>
          <KindCoveredBlock
            kind="crafting"
            entries={covered.crafting}
            onOpenCharacter={onOpenCharacter}
            showEmpty={!filterActive}
            showExpansion={isRetail}
          />
          <KindCoveredBlock
            kind="gathering"
            entries={covered.gathering}
            onOpenCharacter={onOpenCharacter}
            showEmpty={!filterActive}
            showExpansion={isRetail}
          />
        </section>
      )}
    </div>
  );
}

function KindGapBlock({
  kind,
  none,
  olderOnly,
  unknown,
  showAllClear,
  retailMidnightGaps,
}: {
  kind: ProfessionPlanningKind;
  none: ProfessionCoverageEntry[];
  olderOnly: ProfessionCoverageEntry[];
  unknown: ProfessionCoverageEntry[];
  showAllClear: boolean;
  retailMidnightGaps: boolean;
}) {
  const label = KIND_LABEL[kind];
  if (none.length === 0 && olderOnly.length === 0 && unknown.length === 0) {
    if (!showAllClear) return null;
    return (
      <div className="professions-kind-block">
        <h4 className="attention-band-label">{label}</h4>
        <p className="muted small professions-all-clear">No {label.toLowerCase()} gaps.</p>
      </div>
    );
  }

  return (
    <div className="professions-kind-block">
      <h4 className="attention-band-label">{label}</h4>
      {none.length > 0 && (
        <div className="professions-gap-block">
          <h5 className="professions-gap-subhead">
            Not covered <span className="muted">({none.length})</span>
          </h5>
          <ul className="compact-list">
            {none.map((entry) => (
              <li key={entry.profession} className="muted">
                {entry.profession}
              </li>
            ))}
          </ul>
        </div>
      )}
      {retailMidnightGaps && olderOnly.length > 0 && (
        <div className="professions-gap-block">
          <h5 className="professions-gap-subhead">
            Missing Midnight <span className="muted">({olderOnly.length})</span>
          </h5>
          <ul className="compact-list">
            {olderOnly.map((entry) => {
              const highest = highestProfessionExpansionLabel(entry.characters) ?? "?";
              return (
                <li key={entry.profession} className="muted">
                  {entry.profession} - highest: {highest}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {unknown.length > 0 && (
        <div className="professions-gap-block">
          <h5 className="professions-gap-subhead">
            Unknown coverage <span className="muted">({unknown.length})</span>
          </h5>
          <ul className="compact-list">
            {unknown.map((entry) => (
              <li key={entry.profession} className="muted">
                {entry.profession} - unknown
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function KindCoveredBlock({
  kind,
  entries,
  onOpenCharacter,
  showEmpty,
  showExpansion,
}: {
  kind: ProfessionPlanningKind;
  entries: ProfessionCoverageEntry[];
  onOpenCharacter: (identityKey: string) => void;
  showEmpty: boolean;
  showExpansion: boolean;
}) {
  const label = KIND_LABEL[kind];
  if (entries.length === 0) {
    if (!showEmpty) return null;
    return (
      <div className="professions-kind-block">
        <h4 className="attention-band-label">{label}</h4>
        <p className="muted small">No {label.toLowerCase()} professions covered yet.</p>
      </div>
    );
  }

  return (
    <div className="professions-kind-block">
      <h4 className="attention-band-label">
        {label} <span className="muted">({entries.length})</span>
      </h4>
      <div className="table-scroll">
        <table className="history-table professions-table">
          <thead>
            <tr>
              <th>Profession</th>
              <th>Primary</th>
              {showExpansion && <th>Expansion</th>}
              <th>Skill</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <CoveredRow
                key={entry.profession}
                entry={entry}
                onOpenCharacter={onOpenCharacter}
                showExpansion={showExpansion}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CoveredRow({
  entry,
  onOpenCharacter,
  showExpansion,
}: {
  entry: ProfessionCoverageEntry;
  onOpenCharacter: (identityKey: string) => void;
  showExpansion: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const primary = selectPrimaryProfessionCharacter(entry.characters);
  const others = primary
    ? entry.characters
        .filter((c) => c.identityKey !== primary.identityKey)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const moreCount = others.length;
  const colSpan = showExpansion ? 5 : 4;
  const primaryExpansion = primary ? expansionLabelForCharacter(primary) : undefined;

  return (
    <>
      <tr>
        <td>
          <strong>{entry.profession}</strong>
        </td>
        <td>
          {primary ? (
            <button
              type="button"
              className="roster-name-link profession-char-chip"
              onClick={() => onOpenCharacter(primary.identityKey)}
            >
              {primary.name}
            </button>
          ) : (
            <span className="muted">-</span>
          )}
        </td>
        {showExpansion && (
          <td>
            {primaryExpansion ? (
              <span className="profession-expansion-chip">{primaryExpansion}</span>
            ) : (
              <span className="muted">?</span>
            )}
          </td>
        )}
        <td>
          {primary ? (
            <span className="profession-skill-chip">
              {showExpansion
                ? skillLabel(primary.skill, primary.maxSkill)
                : `${skillLabel(primary.skill, primary.maxSkill)}${primary.tier ? ` - ${primary.tier}` : ""}`}
            </span>
          ) : (
            <span className="muted">?/?</span>
          )}
        </td>
        <td>
          {moreCount > 0 && (
            <button
              type="button"
              className="profession-more-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide" : `+${moreCount} more`}
            </button>
          )}
        </td>
      </tr>
      {expanded && moreCount > 0 && (
        <tr className="profession-more-row">
          <td colSpan={colSpan}>
            <div className="profession-more-list">
              {others.map((c) => (
                <span key={c.identityKey} className="profession-more-item">
                  <button
                    type="button"
                    className="roster-name-link profession-char-chip"
                    onClick={() => onOpenCharacter(c.identityKey)}
                  >
                    {c.name}
                  </button>
                  {showExpansion && (
                    <span className="profession-expansion-chip">
                      {expansionLabelForCharacter(c) ?? "?"}
                    </span>
                  )}
                  <span className="profession-skill-chip">
                    {showExpansion
                      ? skillLabel(c.skill, c.maxSkill)
                      : `${skillLabel(c.skill, c.maxSkill)}${c.tier ? ` - ${c.tier}` : ""}`}
                  </span>
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}