import { useEffect, useState } from "react";
import { fetchCharacters, fetchRecentChanges, fetchVersions } from "./api.ts";
import CharacterDetail from "./components/CharacterDetail.tsx";
import ImportModal from "./components/ImportModal.tsx";
import { formatCopper, formatCopperDelta, formatPlaytime, formatRelativeTime } from "./format.ts";
import type { RecentChange, StoredCharacterSummary, VersionOrUnknown, VersionSummary } from "./types.ts";
import { VERSION_ACCENTS, VERSION_LABELS, WOW_VERSIONS } from "./versions.ts";

type View = { kind: "overview" } | { kind: "characters" } | { kind: "detail"; identityKey: string };

function loadStoredVersion(): VersionOrUnknown {
  const stored = localStorage.getItem("wowsync.activeVersion");
  if (stored && (WOW_VERSIONS as string[]).includes(stored)) return stored as VersionOrUnknown;
  return "tbc-anniversary";
}

export default function App() {
  const [activeVersion, setActiveVersion] = useState<VersionOrUnknown>(loadStoredVersion);
  const [view, setView] = useState<View>({ kind: "overview" });
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [characters, setCharacters] = useState<StoredCharacterSummary[]>([]);
  const [changes, setChanges] = useState<RecentChange[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    localStorage.setItem("wowsync.activeVersion", activeVersion);
  }, [activeVersion]);

  useEffect(() => {
    fetchVersions().then((r) => setVersions(r.versions));
  }, [refreshTick]);

  useEffect(() => {
    fetchCharacters(activeVersion).then((r) => setCharacters(r.characters));
    fetchRecentChanges(activeVersion).then((r) => setChanges(r.changes));
  }, [activeVersion, refreshTick]);

  const currentSummary = versions.find((v) => v.version === activeVersion);
  const accent = VERSION_ACCENTS[activeVersion];

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  return (
    <div className="app" style={{ ["--accent" as string]: accent }}>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">⚔</span> WoWSync Dashboard
        </div>
        <button className="primary-button" onClick={() => setImportOpen(true)}>
          Import WoWSync
        </button>
      </header>

      <nav className="version-tabs">
        {WOW_VERSIONS.map((v) => (
          <button
            key={v}
            className={`version-tab ${v === activeVersion ? "active" : ""}`}
            style={v === activeVersion ? { borderColor: VERSION_ACCENTS[v], color: VERSION_ACCENTS[v] } : undefined}
            onClick={() => {
              setActiveVersion(v);
              setView({ kind: "overview" });
            }}
          >
            {VERSION_LABELS[v]}
          </button>
        ))}
      </nav>

      <main className="app-main">
        {view.kind === "detail" ? (
          <CharacterDetail identityKey={view.identityKey} onBack={() => setView({ kind: "characters" })} />
        ) : (
          <>
            <div className="view-tabs">
              <button className={view.kind === "overview" ? "active" : ""} onClick={() => setView({ kind: "overview" })}>
                Overview
              </button>
              <button className={view.kind === "characters" ? "active" : ""} onClick={() => setView({ kind: "characters" })}>
                Characters
              </button>
            </div>

            {view.kind === "overview" && (
              <Overview
                summary={currentSummary}
                characters={characters}
                changes={changes}
                onOpenCharacter={(key) => setView({ kind: "detail", identityKey: key })}
              />
            )}
            {view.kind === "characters" && (
              <CharactersView characters={characters} onOpenCharacter={(key) => setView({ kind: "detail", identityKey: key })} />
            )}
          </>
        )}
      </main>

      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onImported={() => {
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Overview({
  summary,
  characters,
  changes,
  onOpenCharacter,
}: {
  summary?: VersionSummary;
  characters: StoredCharacterSummary[];
  changes: RecentChange[];
  onOpenCharacter: (key: string) => void;
}) {
  const recentlyUpdated = [...characters]
    .filter((c) => c.latestImportedAt !== undefined)
    .sort((a, b) => (b.latestImportedAt ?? 0) - (a.latestImportedAt ?? 0))
    .slice(0, 5);

  return (
    <div className="overview">
      <div className="stat-row">
        <StatTile label="Characters" value={String(summary?.characterCount ?? 0)} />
        <StatTile
          label="Total gold"
          value={summary && summary.charactersWithKnownGold > 0 ? formatCopper(summary.totalMoneyCopper) : "?"}
          hint={summary && summary.charactersWithKnownGold < summary.characterCount ? "partial — some characters unobserved" : undefined}
        />
        <StatTile
          label="Total /played"
          value={summary && summary.charactersWithKnownPlaytime > 0 ? formatPlaytime(summary.totalPlayedSeconds) : "?"}
          hint={summary && summary.charactersWithKnownPlaytime < summary.characterCount ? "partial — some characters unobserved" : undefined}
        />
        <StatTile label="Last sync" value={formatRelativeTime(summary?.lastUpdatedAt)} />
      </div>

      <div className="overview-columns">
        <section className="panel">
          <h3>Recently updated</h3>
          {recentlyUpdated.length === 0 && <p className="muted">No characters imported for this version yet.</p>}
          <ul className="compact-list">
            {recentlyUpdated.map((c) => (
              <li key={c.identityKey} className="clickable" onClick={() => onOpenCharacter(c.identityKey)}>
                <strong>{c.name}</strong> <span className="muted">Lv {c.latestLevel ?? "?"} · {formatRelativeTime(c.latestImportedAt)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h3>Recent changes</h3>
          {changes.length === 0 && <p className="muted">No changes since the last import.</p>}
          <ul className="compact-list">
            {changes.map((c) => (
              <li key={c.snapshotId} className="clickable" onClick={() => onOpenCharacter(c.identityKey)}>
                <strong>{c.characterName}</strong>{" "}
                <span className="muted">
                  {c.diff.level.delta ? `Level +${c.diff.level.delta} · ` : ""}
                  {c.diff.moneyCopper.delta ? `${formatCopperDelta(c.diff.moneyCopper.delta)} · ` : ""}
                  {c.diff.location.changed ? `→ ${c.diff.location.toZone ?? "?"} · ` : ""}
                  {formatRelativeTime(c.importedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h3>Account summary (LLM)</h3>
          <p className="muted">
            Ask-my-account analysis isn't wired up yet. Once enabled, this panel will summarize this version's
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

function CharactersView({
  characters,
  onOpenCharacter,
}: {
  characters: StoredCharacterSummary[];
  onOpenCharacter: (key: string) => void;
}) {
  if (characters.length === 0) {
    return <p className="muted">No characters imported for this version yet. Use "Import WoWSync" to add one.</p>;
  }
  return (
    <div className="character-grid">
      {characters.map((c) => (
        <div key={c.identityKey} className="character-card" onClick={() => onOpenCharacter(c.identityKey)}>
          <div className="character-card-name">{c.name}</div>
          <div className="character-card-sub muted">
            {c.class ?? "?"} · {c.realm}
          </div>
          <div className="character-card-stats">
            <span>Lv {c.latestLevel ?? "?"}</span>
            <span>{formatCopper(c.latestMoneyCopper)}</span>
          </div>
          <div className="character-card-stats muted small">
            <span>{formatPlaytime(c.latestPlayedSeconds)} played</span>
            <span>{formatRelativeTime(c.latestImportedAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
