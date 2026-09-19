import type {
  AccountContext,
  AccountFacts,
  AskAccountResponse,
  DeleteCharacterResult,
  ImportResult,
  StoredCharacterSummary,
  StoredSnapshot,
  VersionOrUnknown,
} from "./types.ts";

/** An API error that keeps the HTTP status, so callers can tell e.g. "already deleted" (404) from a real failure. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
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

/**
 * Permanently deletes one character and its whole snapshot history. The
 * server refuses unless the body's confirmIdentityKey matches the key in
 * the URL - the UI additionally makes the user type the character's name
 * (see deleteConfirmation.ts) before this is ever called.
 */
export function deleteCharacter(identityKey: string) {
  return request<{ deleted: DeleteCharacterResult }>(`/api/characters/${encodeURIComponent(identityKey)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmIdentityKey: identityKey }),
  });
}

export function importExport(text: string) {
  return request<{ result: ImportResult }>("/api/import", { method: "POST", body: JSON.stringify({ text }) });
}

/** The full "Export Dashboard Context" document. Not wrapped in a {key: ...} envelope - this is the exact JSON the developer-tool modal copies/downloads verbatim. */
export function fetchAccountContext() {
  return request<AccountContext>("/api/account-context");
}

/**
 * "Ask My Account" (POC): sends a single question to the server, which
 * retrieves the same canonical account context (above) and forwards it,
 * the question, and a system prompt to a configured LLM provider. Each
 * call is independent - no conversation history is kept on either side.
 */
export function askAccount(question: string) {
  return request<AskAccountResponse>("/api/ask", { method: "POST", body: JSON.stringify({ question }) });
}
