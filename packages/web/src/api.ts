import type { AccountContext, AccountFacts, ImportResult, StoredCharacterSummary, StoredSnapshot, VersionOrUnknown } from "./types.ts";

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

export function fetchCharacter(identityKey: string) {
  return request<{ character: StoredCharacterSummary }>(`/api/characters/${encodeURIComponent(identityKey)}`);
}

export function fetchSnapshots(identityKey: string) {
  return request<{ snapshots: StoredSnapshot[] }>(`/api/characters/${encodeURIComponent(identityKey)}/snapshots`);
}

export function fetchAccountFacts(version: VersionOrUnknown) {
  return request<{ facts: AccountFacts }>(`/api/versions/${version}/account-facts`);
}

export function importExport(text: string) {
  return request<{ result: ImportResult }>("/api/import", { method: "POST", body: JSON.stringify({ text }) });
}

/** The full "Export Dashboard Context" document. Not wrapped in a {key: ...} envelope - this is the exact JSON the developer-tool modal copies/downloads verbatim. */
export function fetchAccountContext() {
  return request<AccountContext>("/api/account-context");
}
