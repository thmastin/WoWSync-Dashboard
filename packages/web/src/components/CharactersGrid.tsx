import { formatCopper, formatPlaytime, formatRelativeTime, formatXpPercent, freshnessLabel } from "../format.ts";
import type { CharacterFacts } from "../types.ts";

export default function CharactersGrid({
  characters,
  onOpenCharacter,
}: {
  characters: CharacterFacts[];
  onOpenCharacter: (key: string) => void;
}) {
  if (characters.length === 0) {
    return <p className="muted">No characters imported for this version yet. Use "Import WoWSync" to add one.</p>;
  }
  return (
    <div className="character-grid">
      {characters.map((c) => (
        <div key={c.identityKey} className="character-card" onClick={() => onOpenCharacter(c.identityKey)}>
          <div className="character-card-top">
            <div className="character-card-name">{c.name}</div>
            <span className={`freshness-badge freshness-${c.freshness}`}>{freshnessLabel(c.freshness)}</span>
          </div>
          <div className="character-card-sub muted">
            {c.class ?? "?"} · {c.realm}
            {c.faction ? ` · ${c.faction}` : ""}
          </div>
          <div className="character-card-stats">
            <span>Lv {c.level ?? "?"}</span>
            <span>{formatCopper(c.goldCopper)}</span>
          </div>
          <div className="character-card-stats muted small">
            <span>{formatPlaytime(c.playedSeconds)} total</span>
            <span>{formatPlaytime(c.levelPlayedSeconds)} this level</span>
          </div>
          {c.xpPercent !== undefined && (
            <div className="xp-bar" title={`${formatXpPercent(c.xpPercent)} to next level`}>
              <div className="xp-bar-fill" style={{ width: `${Math.min(100, Math.max(0, c.xpPercent))}%` }} />
            </div>
          )}
          <div className="character-card-stats muted small">
            <span>
              {c.snapshotCount} snapshot{c.snapshotCount === 1 ? "" : "s"}
            </span>
            <span>{formatRelativeTime(c.lastImportedAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
