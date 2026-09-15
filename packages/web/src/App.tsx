import { useEffect, useState } from "react";
import { fetchAccountFacts } from "./api.ts";
import AccountEconomy from "./components/AccountEconomy.tsx";
import AccountOverview from "./components/AccountOverview.tsx";
import CharactersGrid from "./components/CharactersGrid.tsx";
import CharacterDetail from "./components/CharacterDetail.tsx";
import DeveloperExportModal from "./components/DeveloperExportModal.tsx";
import ImportModal from "./components/ImportModal.tsx";
import { scopeFacts } from "./scopedFacts.ts";
import type { AccountFacts, VersionOrUnknown } from "./types.ts";
import { VERSION_ACCENTS, VERSION_LABELS, WOW_VERSIONS } from "./versions.ts";

type View = { kind: "overview" } | { kind: "characters" } | { kind: "economy" } | { kind: "detail"; identityKey: string };

function loadStoredVersion(): VersionOrUnknown {
  const stored = localStorage.getItem("wowsync.activeVersion");
  if (stored && (WOW_VERSIONS as string[]).includes(stored)) return stored as VersionOrUnknown;
  return "tbc-anniversary";
}

export default function App() {
  const [activeVersion, setActiveVersion] = useState<VersionOrUnknown>(loadStoredVersion);
  const [view, setView] = useState<View>({ kind: "overview" });
  const [facts, setFacts] = useState<AccountFacts | null>(null);
  const [selectedRealm, setSelectedRealm] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [devExportOpen, setDevExportOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    localStorage.setItem("wowsync.activeVersion", activeVersion);
  }, [activeVersion]);

  useEffect(() => {
    setFacts(null);
    setSelectedRealm(null);
    fetchAccountFacts(activeVersion).then((r) => setFacts(r.facts));
  }, [activeVersion, refreshTick]);

  const accent = VERSION_ACCENTS[activeVersion];
  const scoped = facts ? scopeFacts(facts, selectedRealm) : null;

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  function openCharacter(identityKey: string) {
    setView({ kind: "detail", identityKey });
  }

  return (
    <div className="app" style={{ ["--accent" as string]: accent }}>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">⚔</span> WoWSync Dashboard
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="dev-button" onClick={() => setDevExportOpen(true)} title="Developer: export the dashboard's current structured state as JSON">
            Developer
          </button>
          <button className="primary-button" onClick={() => setImportOpen(true)}>
            Import WoWSync
          </button>
        </div>
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
            <div className="scope-row">
              <div className="view-tabs">
                <button className={view.kind === "overview" ? "active" : ""} onClick={() => setView({ kind: "overview" })}>
                  Overview
                </button>
                <button className={view.kind === "characters" ? "active" : ""} onClick={() => setView({ kind: "characters" })}>
                  Characters
                </button>
                <button className={view.kind === "economy" ? "active" : ""} onClick={() => setView({ kind: "economy" })}>
                  Economy
                </button>
              </div>

              {scoped && scoped.isRealmScoped ? (
                <div className="realm-selector">
                  <span className="realm-selector-label">Realm:</span>
                  {scoped.availableRealms.map((realm) => (
                    <button
                      key={realm}
                      className={`realm-pill ${realm === scoped.scopeLabel ? "active" : ""}`}
                      onClick={() => setSelectedRealm(realm)}
                    >
                      {realm}
                    </button>
                  ))}
                </div>
              ) : scoped ? (
                <div className="realm-selector">
                  <span className="scope-badge">Account-wide</span>
                </div>
              ) : null}
            </div>

            {!scoped && <div className="loading">Loading…</div>}
            {scoped && view.kind === "overview" && <AccountOverview scoped={scoped} onOpenCharacter={openCharacter} />}
            {scoped && view.kind === "characters" && <CharactersGrid characters={scoped.characters} onOpenCharacter={openCharacter} />}
            {scoped && view.kind === "economy" && <AccountEconomy scoped={scoped} onOpenCharacter={openCharacter} />}
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

      {devExportOpen && <DeveloperExportModal onClose={() => setDevExportOpen(false)} />}
    </div>
  );
}
