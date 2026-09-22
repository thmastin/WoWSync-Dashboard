import { formatRelativeTime } from "../format.ts";
import { searchItemRows } from "../itemSearch.ts";
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
  const q = route.q;
  const result = searchItemRows(inventory, characters, q);

  function setQuery(next: string) {
    onNavigate(patchRoute(route, { view: "items", q: next }));
  }

  return (
    <div className="items-search">
      <div className="roster-controls">
        <input
          className="roster-search item-search-input"
          type="search"
          placeholder="Search item name (e.g. Strange Dust)…"
          value={q}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search items"
          autoFocus
        />
        <span className="muted roster-count">
          {q.trim()
            ? result.truncated
              ? `${result.rows.length} of ${result.totalMatches} locations`
              : `${result.totalMatches} location${result.totalMatches === 1 ? "" : "s"}`
            : "Type a name to search"}
        </span>
      </div>

      {inventory.hasUnknownStorage && (
        <p className="muted small items-caveat">
          Some bags/bank were never observed — quantities below are a <strong>known total</strong>, not a complete
          account total.
          {inventory.unknownBank.length > 0 && (
            <> Bank never observed: {inventory.unknownBank.map((c) => c.name).join(", ")}.</>
          )}
          {inventory.unknownBags.length > 0 && (
            <> Bags never observed: {inventory.unknownBags.map((c) => c.name).join(", ")}.</>
          )}
        </p>
      )}

      {!q.trim() && <p className="muted">Results stay on this version only. Shared storage is not included.</p>}

      {q.trim() && result.totalMatches === 0 && (
        <p className="muted small">No known items match &quot;{q.trim()}&quot;.</p>
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
        <p className="muted small items-more">+{result.hiddenCount} more — narrow the name to see the rest.</p>
      )}
    </div>
  );
}
