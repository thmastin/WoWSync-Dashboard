// Hash routing for the Dashboard (product review X1).
// Grammar:
//   #/<version>/overview
//   #/<version>/characters?realm=&q=&class=&age=&sort=
//   #/<version>/economy?realm=
//   #/<version>/shared
//   #/<version>/items?...   (reserved; UI may show a placeholder until X3)
//   #/<version>/c/<identityKey>[/snapshot/<id>]?from=overview|characters|...
// localStorage keeps only the last version, used when the hash is empty.

import type { VersionOrUnknown } from "./types.ts";
import { WOW_VERSIONS } from "./versions.ts";

export type RouteView = "overview" | "characters" | "economy" | "shared" | "items" | "detail";

export interface AppRoute {
  version: VersionOrUnknown;
  view: RouteView;
  identityKey?: string;
  snapshotId?: number;
  /** Realm scope for Classic Era / Anniversary. null = default (first realm / unset). */
  realm: string | null;
  /** Where detail was opened from — drives in-app Back. */
  from: RouteView | null;
  q: string;
  classFilter: string;
  age: string;
  sort: string;
}

const VIEWS = new Set<RouteView>(["overview", "characters", "economy", "shared", "items", "detail"]);
const TAB_VIEWS = new Set<RouteView>(["overview", "characters", "economy", "shared", "items"]);

export function isVersion(value: string): value is VersionOrUnknown {
  return (WOW_VERSIONS as string[]).includes(value) || value === "unknown-version";
}

export function emptyFilters(): Pick<AppRoute, "q" | "classFilter" | "age" | "sort"> {
  return { q: "", classFilter: "", age: "", sort: "" };
}

export function defaultRoute(version: VersionOrUnknown): AppRoute {
  return { version, view: "overview", realm: null, from: null, ...emptyFilters() };
}

function parseQuery(search: string): URLSearchParams {
  if (!search) return new URLSearchParams();
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

function fromParam(raw: string | null): RouteView | null {
  if (!raw) return null;
  return TAB_VIEWS.has(raw as RouteView) ? (raw as RouteView) : null;
}

/**
 * Parse `window.location.hash` (with or without leading `#`). Unknown paths
 * fall back to overview for a known version; a missing/invalid version uses
 * `fallbackVersion`.
 */
export function parseHash(hash: string, fallbackVersion: VersionOrUnknown): AppRoute {
  const raw = (hash || "").replace(/^#/, "");
  const [pathPart, queryPart = ""] = raw.split("?");
  const path = pathPart.replace(/^\/+|\/+$/g, "");
  const parts = path ? path.split("/").map((p) => decodeURIComponent(p)) : [];
  const query = parseQuery(queryPart);

  const versionToken = parts[0];
  const version: VersionOrUnknown = versionToken && isVersion(versionToken) ? versionToken : fallbackVersion;
  const rest = versionToken && isVersion(versionToken) ? parts.slice(1) : parts;

  const realm = query.get("realm");
  const base = {
    version,
    realm: realm && realm.trim() ? realm : null,
    from: fromParam(query.get("from")),
    q: query.get("q") ?? "",
    classFilter: query.get("class") ?? "",
    age: query.get("age") ?? "",
    sort: query.get("sort") ?? "",
  };

  if (rest[0] === "c" && rest[1]) {
    const identityKey = rest[1];
    let snapshotId: number | undefined;
    if (rest[2] === "snapshot" && rest[3] && /^\d+$/.test(rest[3])) {
      snapshotId = Number(rest[3]);
    }
    return { ...base, view: "detail", identityKey, snapshotId };
  }

  const segment = (rest[0] || "overview") as RouteView;
  if (segment === "detail") {
    return { ...base, view: "overview" };
  }
  if (!VIEWS.has(segment) || segment === "detail") {
    return { ...base, view: "overview" };
  }
  // Shared storage is Retail-only in the UI; keep the route but App can coerce.
  return { ...base, view: segment };
}

export function formatHash(route: AppRoute): string {
  const version = encodeURIComponent(route.version);
  let path: string;
  if (route.view === "detail" && route.identityKey) {
    path = `/${version}/c/${encodeURIComponent(route.identityKey)}`;
    if (route.snapshotId !== undefined) path += `/snapshot/${route.snapshotId}`;
  } else {
    const view = route.view === "detail" ? "overview" : route.view;
    path = `/${version}/${view}`;
  }

  const params = new URLSearchParams();
  if (route.realm) params.set("realm", route.realm);
  if (route.view === "detail" && route.from) params.set("from", route.from);
  if (route.q) params.set("q", route.q);
  if (route.classFilter) params.set("class", route.classFilter);
  if (route.age) params.set("age", route.age);
  if (route.sort) params.set("sort", route.sort);
  const qs = params.toString();
  return qs ? `#${path}?${qs}` : `#${path}`;
}

export function sameRoute(a: AppRoute, b: AppRoute): boolean {
  return formatHash(a) === formatHash(b);
}

/** Apply a partial update without dropping filters/realm unless cleared explicitly. */
export function patchRoute(current: AppRoute, patch: Partial<AppRoute>): AppRoute {
  const next: AppRoute = { ...current, ...patch };
  if (patch.view && patch.view !== "detail") {
    next.identityKey = undefined;
    next.snapshotId = undefined;
    if (patch.from === undefined) next.from = null;
  }
  if (next.view === "shared" && next.version !== "retail") {
    next.version = "retail";
  }
  return next;
}