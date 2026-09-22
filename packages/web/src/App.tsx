import { useCallback, useEffect, useState } from "react";
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
import { defaultRoute, formatHash, parseHash, patchRoute, sameRoute, type AppRoute, type RouteView } from "./routing.ts";
import type { VersionOrUnknown } from "./types.ts";
import { VERSION_ACCENTS, VERSION_LABELS, WOW_VERSIONS } from "./versions.ts";

function loadStoredVersion(): VersionOrUnknown {
  const stored = localStorage.getItem("wowsync.activeVersion");
  if (stored && (WOW_VERSIONS as string[]).includes(stored)) return stored as VersionOrUnknown;
  return "tbc-anniversary";
}

function readRoute(): AppRoute {
  return parseHash(window.location.hash, loadStoredVersion());
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>(() => {
    const initial = readRoute();
    // Empty hash → seed from localStorage so the first paint has a real address.
    if (!window.location.hash || window.location.hash === "#") {
      const seeded = defaultRoute(loadStoredVersion());
      history.replaceState(null, "", formatHash(seeded));
      return seeded;
    }
    return initial;
  });
  const [importOpen, setImportOpen] = useState(false);
  const [devExportOpen, setDevExportOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const navigate = useCallback((next: AppRoute, replace = false) => {
    const hash = formatHash(next);
    if (replace) {
      history.replaceState(null, "", hash);
      setRoute(next);
      return;
    }
    if (window.location.hash === hash) {
      setRoute(next);
      return;
    }
    // Assigning location.hash pushes history and fires hashchange.
    window.location.hash = hash.startsWith("#") ? hash.slice(1) : hash;
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = readRoute();
      setRoute((prev) => (sameRoute(prev, next) ? prev : next));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    localStorage.setItem("wowsync.activeVersion", route.version);
  }, [route.version]);

  const activeVersion = route.version;
  const factsLoad = useAsync((signal) => fetchAccountFacts(activeVersion, signal).then((r) => r.facts), activeVersion, refreshTick);
  const loaded = factsLoad.state.data;
  const facts = loaded && loaded.version === activeVersion ? loaded : null;
  const scoped = facts ? scopeFacts(facts, route.realm) : null;

  // If the URL names a realm that no longer exists in this version, clear it in the address.
  useEffect(() => {
    if (!scoped || !scoped.isRealmScoped || !route.realm) return;
    if (!scoped.availableRealms.includes(route.realm)) {
      navigate(patchRoute(route, { realm: null }), true);
    }
  }, [scoped, route, navigate]);

  const accent = VERSION_ACCENTS[activeVersion];

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  function openCharacter(identityKey: string) {
    const from: RouteView = route.view === "detail" ? route.from ?? "characters" : route.view === "items" ? "characters" : route.view;
    navigate(patchRoute(route, { view: "detail", identityKey, from: from === "detail" ? "characters" : from }));
  }

  function openSharedStorage() {
    navigate(patchRoute(route, { version: "retail", view: "shared" }));
  }

  function backFromDetail() {
    const target = route.from && route.from !== "detail" ? route.from : "characters";
    navigate(patchRoute(route, { view: target, identityKey: undefined, snapshotId: undefined, from: null }));
  }

  const tabView: RouteView =
    route.view === "detail" || route.view === "items" ? (route.view === "items" ? "items" : "characters") : route.view;

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
            onClick={() => navigate(defaultRoute(v))}
          >
            {VERSION_LABELS[v]}
          </button>
        ))}
      </nav>

      <main className="app-main">
        {route.view === "detail" && route.identityKey ? (
          <CharacterDetail
            identityKey={route.identityKey}
            refreshTick={refreshTick}
            onBack={backFromDetail}
            onDeleted={() => {
              refresh();
              navigate(patchRoute(route, { view: route.from ?? "characters", identityKey: undefined, from: null }));
            }}
            onOpenSharedStorage={openSharedStorage}
          />
        ) : (
          <>
            <div className="scope-row">
              <div className="view-tabs">
                <button className={tabView === "overview" ? "active" : ""} onClick={() => navigate(patchRoute(route, { view: "overview" }))}>
                  Overview
                </button>
                <button className={tabView === "characters" ? "active" : ""} onClick={() => navigate(patchRoute(route, { view: "characters" }))}>
                  Characters
                </button>
                <button className={tabView === "economy" ? "active" : ""} onClick={() => navigate(patchRoute(route, { view: "economy" }))}>
                  Economy
                </button>
                {activeVersion === "retail" && (
                  <button className={tabView === "shared" ? "active" : ""} onClick={() => navigate(patchRoute(route, { view: "shared" }))}>
                    Shared Storage
                  </button>
                )}
              </div>

              {route.view === "shared" ? null : scoped && scoped.isRealmScoped ? (
                <div className="realm-selector">
                  <span className="realm-selector-label">Realm:</span>
                  {scoped.availableRealms.map((realm) => (
                    <button
                      key={realm}
                      className={`realm-pill ${realm === scoped.scopeLabel ? "active" : ""}`}
                      onClick={() => navigate(patchRoute(route, { realm }))}
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

            {route.view === "shared" && <SharedStorageView />}
            {route.view === "items" && (
              <div className="panel">
                <h3>Item search</h3>
                <p className="muted">Global item search lands next (roster spine X3). The URL `#/{activeVersion}/items` is reserved.</p>
              </div>
            )}
            {route.view !== "shared" && route.view !== "items" && factsLoad.state.status === "error" && (
              <ErrorNotice error={factsLoad.state.error} onRetry={factsLoad.retry} />
            )}
            {route.view !== "shared" && route.view !== "items" && !scoped && factsLoad.state.status === "loading" && <div className="loading">Loading…</div>}
            {scoped && route.view === "overview" && <AccountOverview scoped={scoped} onOpenCharacter={openCharacter} />}
            {scoped && route.view === "characters" && <CharactersGrid characters={scoped.characters} onOpenCharacter={openCharacter} />}
            {scoped && route.view === "economy" && <AccountEconomy scoped={scoped} onOpenCharacter={openCharacter} />}
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