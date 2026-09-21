import { useEffect, useState } from "react";
import { fetchAccountFacts } from "./api.ts";
import ErrorNotice from "./components/ErrorNotice.tsx";
import { useAsync } from "./useAsync.ts";
import AccountEconomy from "./components/AccountEconomy.tsx";
import AccountOverview from "./components/AccountOverview.tsx";
import AskAccountModal from "./components/AskAccountModal.tsx";
import CharactersGrid from "./components/CharactersGrid.tsx";
import CharacterDetail from "./components/CharacterDetail.tsx";
import DeveloperExportModal from "./components/DeveloperExportModal.tsx";
import ImportModal from "./components/ImportModal.tsx";
import SharedStorageView from "./components/SharedStorageView.tsx";
import { scopeFacts } from "./scopedFacts.ts";
import type { VersionOrUnknown } from "./types.ts";
import { VERSION_ACCENTS, VERSION_LABELS, WOW_VERSIONS } from "./versions.ts";

type View = { kind: "overview" } | { kind: "characters" } | { kind: "economy" } | { kind: "shared" } | { kind: "detail"; identityKey: string };

function loadStoredVersion(): VersionOrUnknown {
  const stored = localStorage.getItem("wowsync.activeVersion");
  if (stored && (WOW_VERSIONS as string[]).includes(stored)) return stored as VersionOrUnknown;
  return "tbc-anniversary";
}

export default function App() {
  const [activeVersion, setActiveVersion] = useState<VersionOrUnknown>(loadStoredVersion);
  const [view, setView] = useState<View>({ kind: "overview" });
  const [selectedRealm, setSelectedRealm] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [devExportOpen, setDevExportOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    localStorage.setItem("wowsync.activeVersion", activeVersion);
  }, [activeVersion]);

  // A different version drops the old facts at once; a refresh (after an
  // import/delete) reloads the same version in place. Slow replies to a
  // superseded request are ignored, and a failure is shown with Retry -
  // never an endless "Loading…" or another version's facts under this tab.
  const factsLoad = useAsync((signal) => fetchAccountFacts(activeVersion, signal).then((r) => r.facts), activeVersion, refreshTick);
  const loaded = factsLoad.state.data;
  const facts = loaded && loaded.version === activeVersion ? loaded : null;

  // The realm choice belongs to a version. (It used to reset on every refresh, so
  // each import snapped the view back to the first realm.)
  useEffect(() => {
    setSelectedRealm(null);
  }, [activeVersion]);

  const accent = VERSION_ACCENTS[activeVersion];
  const scoped = facts ? scopeFacts(facts, selectedRealm) : null;

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  function openCharacter(identityKey: string) {
    setView({ kind: "detail", identityKey });
  }

  // Shared storage (Warband / Guild Bank) is Retail-only account information: it lives in its own tab,
  // and a character's "carried by this export" cards link here.
  function openSharedStorage() {
    setActiveVersion("retail");
    setView({ kind: "shared" });
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
          <button className="dev-button" onClick={() => setAskOpen(true)} title="Experimental: ask an external LLM a question about your account">
            Ask My Account
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
          <CharacterDetail
            identityKey={view.identityKey}
            refreshTick={refreshTick}
            onBack={() => setView({ kind: "characters" })}
            onDeleted={() => {
              refresh();
              setView({ kind: "characters" });
            }}
            onOpenSharedStorage={openSharedStorage}
          />
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
                {activeVersion === "retail" && (
                  <button className={view.kind === "shared" ? "active" : ""} onClick={() => setView({ kind: "shared" })}>
                    Shared Storage
                  </button>
                )}
              </div>

              {view.kind === "shared" ? null : scoped && scoped.isRealmScoped ? (
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

            {view.kind === "shared" && <SharedStorageView />}
            {view.kind !== "shared" && factsLoad.state.status === "error" && <ErrorNotice error={factsLoad.state.error} onRetry={factsLoad.retry} />}
            {view.kind !== "shared" && !scoped && factsLoad.state.status === "loading" && <div className="loading">Loading…</div>}
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

      {askOpen && <AskAccountModal onClose={() => setAskOpen(false)} />}
    </div>
  );
}
