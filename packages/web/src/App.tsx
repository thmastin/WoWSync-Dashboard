import { useCallback, useEffect, useState } from "react";
import { fetchAccountFacts, fetchVersions } from "./api.ts";
import ErrorNotice from "./components/ErrorNotice.tsx";
import { useAsync } from "./useAsync.ts";
import AccountEconomy from "./components/AccountEconomy.tsx";
import AccountOverview from "./components/AccountOverview.tsx";
import AskAccountModal from "./components/AskAccountModal.tsx";
import CharactersRoster from "./components/CharactersRoster.tsx";
import ItemsSearch from "./components/ItemsSearch.tsx";
import CharacterDetail from "./components/CharacterDetail.tsx";
import DeveloperExportModal from "./components/DeveloperExportModal.tsx";
import ImportModal from "./components/ImportModal.tsx";
import SharedStorageView from "./components/SharedStorageView.tsx";
import { scopeFacts } from "./scopedFacts.ts";
import { defaultRoute, formatHash, parseHash, patchRoute, sameRoute, type AppRoute, type RouteView } from "./routing.ts";
import type { VersionOrUnknown } from "./types.ts";
import { formatRelativeTime, freshnessLabel } from "./format.ts";
import { pickDefaultVersion, versionTabMeta } from "./versionTabs.ts";
import { VERSION_ACCENTS, VERSION_LABELS, WOW_VERSIONS } from "./versions.ts";

function readStoredVersionPreference(): string | null {
  const stored = localStorage.getItem("wowsync.activeVersion");
  if (stored && (WOW_VERSIONS as string[]).includes(stored)) return stored;
  return null;
}

/** Last-used version from localStorage, or temporary retail until /api/versions resolves a fresher default. */
function loadStoredVersion(): VersionOrUnknown {
  return (readStoredVersionPreference() as VersionOrUnknown | null) ?? "retail";
}

function readRoute(): AppRoute {
  return parseHash(window.location.hash, loadStoredVersion());
}

export default function App() {
  // True only when first paint seeded an empty hash with no valid localStorage version.
  // Cleared on any user-driven navigate so we never yank them off a click or deep link.
  const [pendingFreshestDefault, setPendingFreshestDefault] = useState(() => {
    const hashEmpty = !window.location.hash || window.location.hash === "#";
    return hashEmpty && readStoredVersionPreference() === null;
  });
  const [route, setRoute] = useState<AppRoute>(() => {
    const initial = readRoute();
    // Empty hash -> seed from localStorage so the first paint has a real address.
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
    if (!replace) setPendingFreshestDefault(false);
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

  const versionsLoad = useAsync((signal) => fetchVersions(signal).then((r) => r.versions), "versions", refreshTick);
  const versionSummaries = versionsLoad.state.data ?? null;

  // N7: when empty-hash had no stored preference, replace temporary retail with freshest sync once summaries arrive.
  useEffect(() => {
    if (!pendingFreshestDefault || !versionSummaries) return;
    const picked = pickDefaultVersion(versionSummaries);
    if (picked === route.version) {
      setPendingFreshestDefault(false);
      return;
    }
    setPendingFreshestDefault(false);
    navigate(defaultRoute(picked), true);
  }, [pendingFreshestDefault, versionSummaries, route.version, navigate]);

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
    let from: RouteView = route.view;
    if (from === "detail") from = route.from ?? "characters";
    if (from === "detail") from = "characters";
    navigate(patchRoute(route, { view: "detail", identityKey, from }));
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
        <div className="header-item-search">
          <input
            className="header-search-input"
            type="search"
            placeholder="Find item…"
            value={route.view === "items" ? route.q : ""}
            onChange={(e) => navigate(patchRoute(route, { view: "items", q: e.target.value }))}
            onFocus={() => {
              if (route.view !== "items") navigate(patchRoute(route, { view: "items" }));
            }}
            aria-label="Find item across this version"
          />
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

      <nav className="version-tabs" role="tablist" aria-label="WoW version">
        {WOW_VERSIONS.map((v) => {
          const summary = versionSummaries?.find((s) => s.version === v);
          const nowSeconds = Date.now() / 1000;
          const meta = versionTabMeta(summary, nowSeconds);
          const ageText = formatRelativeTime(summary?.lastUpdatedAt);
          const title = `${VERSION_LABELS[v]}: ${meta.count} character${meta.count === 1 ? "" : "s"}, ${freshnessLabel(meta.freshness).toLowerCase()} (${ageText})`;
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={v === activeVersion}
              className={`version-tab ${v === activeVersion ? "active" : ""}`}
              style={v === activeVersion ? { borderColor: VERSION_ACCENTS[v], color: VERSION_ACCENTS[v] } : undefined}
              title={title}
              onClick={() => navigate(defaultRoute(v))}
            >
              <span className="version-tab-label">{VERSION_LABELS[v]}</span>
              <span className="version-tab-meta">
                <span className="version-tab-count">{meta.count}</span>
                <span
                  className={`version-tab-dot version-tab-dot-${meta.freshness}`}
                  aria-label={freshnessLabel(meta.freshness)}
                />
              </span>
            </button>
          );
        })}
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
                <button className={tabView === "items" ? "active" : ""} onClick={() => navigate(patchRoute(route, { view: "items", q: route.q }))}>
                  Items
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
            {scoped && route.view === "items" && (
              <ItemsSearch
                inventory={scoped.inventory}
                characters={scoped.characters}
                route={route}
                onNavigate={navigate}
                onOpenCharacter={openCharacter}
              />
            )}
            {route.view !== "shared" && factsLoad.state.status === "error" && (
              <ErrorNotice error={factsLoad.state.error} onRetry={factsLoad.retry} />
            )}
            {route.view !== "shared" && !scoped && factsLoad.state.status === "loading" && <div className="loading">Loading…</div>}
            {scoped && route.view === "overview" && <AccountOverview scoped={scoped} onOpenCharacter={openCharacter} />}
            {scoped && route.view === "characters" && (
              <CharactersRoster
                characters={scoped.characters}
                route={route}
                now={scoped.now}
                onNavigate={navigate}
                onOpenCharacter={openCharacter}
              />
            )}
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