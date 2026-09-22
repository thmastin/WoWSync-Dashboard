import { formatCopper, formatRelativeTime, freshnessLabel } from "../format.ts";
import { filterAndSortRoster, rosterClassOptions, toggleSort, type RosterSortKey } from "../roster.ts";
import { formatHash, patchRoute, type AppRoute } from "../routing.ts";
import type { CharacterFacts } from "../types.ts";

export default function CharactersRoster({
  characters,
  route,
  onNavigate,
  onOpenCharacter,
}: {
  characters: CharacterFacts[];
  route: AppRoute;
  onNavigate: (next: AppRoute) => void;
  onOpenCharacter: (identityKey: string) => void;
}) {
  const sort = route.sort || "name";
  const rows = filterAndSortRoster(characters, {
    q: route.q,
    classFilter: route.classFilter,
    age: route.age,
    sort,
    bankMissing: route.bankMissing,
  });
  const classes = rosterClassOptions(characters);

  function setFilter(patch: Partial<AppRoute>) {
    onNavigate(patchRoute(route, { view: "characters", ...patch }));
  }

  function sortHeader(label: string, key: RosterSortKey) {
    return (
      <button type="button" className="roster-sort" onClick={() => setFilter({ sort: toggleSort(sort, key) })}>
        {label}
        {sortMarker(sort, key)}
      </button>
    );
  }

  if (characters.length === 0) {
    return <p className="muted">No characters imported for this version yet. Use Import WoWSync to add one.</p>;
  }

  return (
    <div className="roster">
      <div className="roster-controls">
        <input
          className="roster-search"
          type="search"
          placeholder="Search name, realm, class…"
          value={route.q}
          onChange={(e) => setFilter({ q: e.target.value })}
          aria-label="Search roster"
        />
        <label className="roster-filter">
          Class
          <select value={route.classFilter} onChange={(e) => setFilter({ classFilter: e.target.value })}>
            <option value="">All</option>
            {classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="roster-filter">
          Sync age
          <select value={route.age} onChange={(e) => setFilter({ age: e.target.value })}>
            <option value="">All</option>
            <option value="recent">Recent</option>
            <option value="stale">Stale</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label className="roster-check">
          <input type="checkbox" checked={route.bankMissing} onChange={(e) => setFilter({ bankMissing: e.target.checked })} />
          Bank never observed
        </label>
        <span className="muted roster-count">
          {rows.length} of {characters.length}
        </span>
      </div>

      <div className="roster-table-wrap">
        <table className="roster-table">
          <thead>
            <tr>
              <th>{sortHeader("Name", "name")}</th>
              <th>{sortHeader("Realm", "realm")}</th>
              <th>{sortHeader("Class", "class")}</th>
              <th>{sortHeader("Level", "level")}</th>
              <th>{sortHeader("Gold", "gold")}</th>
              <th>Bank</th>
              <th>{sortHeader("Synced", "synced")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No characters match these filters.
                </td>
              </tr>
            )}
            {rows.map((c) => {
              const href = formatHash(patchRoute(route, { view: "detail", identityKey: c.identityKey, from: "characters" }));
              return (
                <tr key={c.identityKey} className="roster-row" onClick={() => onOpenCharacter(c.identityKey)}>
                  <td>
                    <a
                      href={href}
                      className="roster-name-link"
                      onClick={(e) => {
                        e.preventDefault();
                        onOpenCharacter(c.identityKey);
                      }}
                    >
                      {c.name}
                    </a>{" "}
                    <span className={`freshness-badge freshness-${c.freshness}`}>{freshnessLabel(c.freshness)}</span>
                  </td>
                  <td>{c.realm}</td>
                  <td>{c.class ?? "—"}</td>
                  <td>{c.level ?? "—"}</td>
                  <td>{formatCopper(c.goldCopper)}</td>
                  <td>{c.bankStatus === "UNKNOWN" ? <span className="bank-chip">bank ?</span> : "seen"}</td>
                  <td className="muted">{formatRelativeTime(c.lastObservedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sortMarker(sort: string, key: RosterSortKey): string {
  const raw = sort || "name";
  const desc = raw.startsWith("-");
  const k = desc ? raw.slice(1) : raw;
  if (k !== key) return "";
  if (key === "synced" && raw === "synced") return " ↓";
  return desc ? " ↓" : " ↑";
}
