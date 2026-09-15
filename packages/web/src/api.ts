import type {
  ImportResult,
  RecentChange,
  StoredCharacterSummary,
  StoredSnapshot,
  VersionOrUnknown,
  VersionSummary,
} from "./types.ts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export function fetchVersions() {
  return request<{ versions: VersionSummary[]; labels: Record<string, string> }>("/api/versions");
}

export function fetchCharacters(version: VersionOrUnknown) {
  return request<{ characters: StoredCharacterSummary[] }>(`/api/versions/${version}/characters`);
}

export function fetchRecentChanges(version: VersionOrUnknown, limit = 20) {
  return request<{ changes: RecentChange[] }>(`/api/versions/${version}/recent-changes?limit=${limit}`);
}

export function fetchCharacter(identityKey: string) {
  return request<{ character: StoredCharacterSummary }>(`/api/characters/${encodeURIComponent(identityKey)}`);
}

export function fetchSnapshots(identityKey: string) {
  return request<{ snapshots: StoredSnapshot[] }>(`/api/characters/${encodeURIComponent(identityKey)}/snapshots`);
}

export function importExport(text: string) {
  return request<{ result: ImportResult }>("/api/import", { method: "POST", body: JSON.stringify({ text }) });
}
