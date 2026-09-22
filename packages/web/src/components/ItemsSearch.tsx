import { formatRelativeTime } from "../format.ts";
import { searchItemRows, type ItemBoundFilter, type ItemStorageFilter } from "../itemSearch.ts";
import { formatHash, patchRoute, type AppRoute } from "../routing.ts";
import type { CharacterFacts, InventoryFacts } from "../types.ts";

function storageLabel(storage: "bags" | "bank"): string {
  return storage === "bags" ? "Bags" : "Bank";
}

function caveatLabel(state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"): string | null {
  if (state === "LAST_SEEN") return "LAST_SEEN";
  if (state === "UNKNOWN") return "UNKNOWN";
  return null;
}

function boundLabel(bound: string | undefined): string {
  if (bound === undefined || !bound.trim()) return "—";
  const b = bound.trim().toLowerCase();
  if (b === "yes" || b === "bound" || b === "bop" || b === "soulbound") return "Bound";
  if (b === "no" || b === "unbound" || b === "boe" || b === "none") return "Unbound";
  return bound;
}

export default function ItemsSearch({
  inventory,
  characters,
  route,
  onNavigate,
  onOpenCharacter,
}: {
  inventory: InventoryFacts;
  characters: CharacterFacts[];
  route: AppRoute;
  onNavigate: (next: AppRoute) => void;
  onOpenCharacter: (identityKey: string) => void;
}) {
  const storage = (
    route.storageFilter === "bags" || route.storageFilter === "bank" ? route.storageFilter : ""
  ) as ItemStorageFilter;
  const bound = (
    route.boundFilter === "bound" || route.boundFilter === "unbound" ? route.boundFilter : ""
  ) as ItemBoundFilter;
  const result = searchItemRows(inventory, characters, { q: route.q, storage, bound });

  function setFilters(patch: Partial<AppRoute>) {
    onNavigate(patchRoute(route, { view: "items", ...patch }));
  }

  return (
    <div className="items-search">
      <div className="roster-controls">
        <input
          className="roster-search item-search-input"
          type="search"
          placeholder="Search item name (e.g. Strange Dust)…"
          value={route.q}
          onChange={(e) => setFilters({ q: e.target.value })}
          aria-label="Search items"
          autoFocus
        />
        <label className="roster-filter">
          Storage
          <select value={storage} onChange={(e) => setFilters({ storageFilter: e.target.value })} aria-label="Filter by storage">
            <option value="">All</option>
            <option value="bags">Bags</option>
            <option value="bank">Bank</option>
          </select>
        </label>
        <label className="roster-filter">
          Bound
          <select value={bound} onChange={(e) => setFilters({ boundFilter: e.target.value })} aria-label="Filter by binding">
            <option value="">All</option>
            <option value="bound">Bound</option>
            <option value="unbound">Unbound</option>
          </select>
        </label>
        <span className="muted roster-count">
          {route.q.trim()
            ? result.truncated
              ? `${result.rows.length} of ${result.totalMatches} locations`
              : `${result.totalMatches} location${result.totalMatches === 1 ? "" : "s"}`
            : "Type a name to search"}
        </span>
      </div>

      {inventory.hasUnknownStorage && (
        <p className="muted small items-caveat">
          Some bags/bank were never observed — quantities below are a <strong>known total</strong>, not a complete account
          total.
          {inventory.unknownBank.length > 0 && <> Bank never observed: {inventory.unknownBank.map((c) => c.name).join(", ")}.</>}
          {inventory.unknownBags.length > 0 && <> Bags never observed: {inventory.unknownBags.map((c) => c.name).join(", ")}.</>}
        </p>
      )}

      {!route.q.trim() && <p className="muted">Results stay on this version only. Shared storage is not included.</p>}

      {route.q.trim() && result.totalMatches === 0 && (
        <p className="muted small">No known items match &quot;{route.q.trim()}&quot; with the current filters.</p>
      )}

      {result.rows.length > 0 && (
        <div className="roster-table-wrap">
          <table className="roster-table items-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Character</th>
                <th>Realm</th>
                <th>Storage</th>
                <th>Bound</th>
                <th>Qty</th>
                <th>Seen</th>
                <th>Caveat</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => {
                const caveat = caveatLabel(row.storageState);
                return (
                  <tr
                    key={`${row.itemKey}|${row.identityKey}|${row.storage}`}
                    className="roster-row"
                    onClick={() => onOpenCharacter(row.identityKey)}
                  >
                    <td>
                      <strong>{row.itemName}</strong>
                    </td>
                    <td>
                      <a
                        href={formatHash(patchRoute(route, { view: "detail", identityKey: row.identityKey, from: "items" }))}
                        className="roster-name-link"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenCharacter(row.identityKey);
                        }}
                      >
                        {row.characterName}
                      </a>
                    </td>
                    <td>{row.realm || "—"}</td>
                    <td>{storageLabel(row.storage)}</td>
                    <td className="muted">{boundLabel(row.bound)}</td>
                    <td>{row.qty}</td>
                    <td className="muted">{formatRelativeTime(row.observedAt)}</td>
                    <td className="muted">{caveat ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {result.truncated && (
        <p className="muted small items-more">+{result.hiddenCount} more — narrow the name or filters to see the rest.</p>
      )}
    </div>
  );
}