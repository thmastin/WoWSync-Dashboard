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

/**
 * What went wrong, in terms a caller can act on:
 * - "network": no HTTP response at all (server stopped, connection refused/reset, offline).
 * - "http":    the server (or a proxy) answered with an error status. `status` is set; `code` is the
 *              server's stable machine-readable code when it sent one (e.g. CHARACTER_NOT_FOUND).
 * - "parse":   a success status, but the body was not valid JSON (wrong server, proxy page, truncated reply).
 * - "shape":   valid JSON that is not the shape this client expects (version skew, wrong endpoint).
 */
export type ApiErrorKind = "network" | "http" | "parse" | "shape";

/** An API failure that keeps its classification, so callers can tell e.g. "the character is gone" (404 + code) from a real outage. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, kind: ApiErrorKind, status?: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export interface RequestOptions {
  /** Aborts the request (e.g. the user switched tabs). An aborted request rejects with the browser's AbortError, which callers should ignore. */
  signal?: AbortSignal;
  /** Returns true when the parsed body has the shape the caller relies on. A failing check is an ApiError of kind "shape", never a later `undefined` crash. */
  validate?: (body: unknown) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** validate helper: the body is an object whose `key` is an object (not null/array). */
export const hasObject = (key: string) => (body: unknown) => isRecord(body) && isRecord(body[key]);
/** validate helper: the body is an object whose `key` is an array. */
export const hasArray = (key: string) => (body: unknown) => isRecord(body) && Array.isArray(body[key]);

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function httpFallbackMessage(status: number): string {
  if (status >= 500) {
    return `The server reported an error (HTTP ${status}). Is the WoWSync server running? Check its console window.`;
  }
  if (status === 404) return "Not found (HTTP 404).";
  return `The request was rejected (HTTP ${status}).`;
}

export async function request<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      ...init,
      signal: options.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    text = await res.text();
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError("Can't reach the WoWSync server. Is it running?", "network");
  }

  let body: unknown;
  let parsed = false;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
      parsed = true;
    } catch {
      // handled below, depending on the status
    }
  }

  if (!res.ok) {
    const message = parsed && isRecord(body) && typeof body.error === "string" ? body.error : httpFallbackMessage(res.status);
    const code = parsed && isRecord(body) && typeof body.code === "string" ? body.code : undefined;
    throw new ApiError(message, "http", res.status, code);
  }
  if (!parsed) {
    throw new ApiError("The server sent a reply that is not valid JSON. Is something else running on this port?", "parse", res.status);
  }
  if (options.validate && !options.validate(body)) {
    throw new ApiError("The server sent an unexpected reply (is the dashboard server out of date?).", "shape", res.status);
  }
  return body as T;
}

/** A short, human-readable description of any failure, for display next to a Retry button. */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

export function fetchCharacter(identityKey: string, signal?: AbortSignal) {
  return request<{ character: StoredCharacterSummary }>(`/api/characters/${encodeURIComponent(identityKey)}`, undefined, {
    signal,
    validate: hasObject("character"),
  });
}

export function fetchSnapshots(identityKey: string, signal?: AbortSignal) {
  return request<{ snapshots: StoredSnapshot[] }>(`/api/characters/${encodeURIComponent(identityKey)}/snapshots`, undefined, {
    signal,
    validate: hasArray("snapshots"),
  });
}

export function fetchAccountFacts(version: VersionOrUnknown, signal?: AbortSignal) {
  return request<{ facts: AccountFacts }>(`/api/versions/${version}/account-facts`, undefined, {
    signal,
    validate: (body) => hasObject("facts")(body) && Array.isArray((body as { facts: { characters?: unknown } }).facts.characters),
  });
}

export function importExport(text: string, signal?: AbortSignal) {
  // Never abort a state-changing request from the UI: the caller passes no signal for imports.
  return request<{ result: ImportResult }>("/api/import", { method: "POST", body: JSON.stringify({ text }) }, { signal, validate: hasObject("result") });
}

/**
 * Permanently deletes one character and its whole snapshot history. The
 * server refuses unless the body's confirmIdentityKey matches the key in
 * the URL - the UI additionally makes the user type the character's name
 * (see deleteConfirmation.ts) before this is ever called. The reply is
 * validated: only a body that names the deleted character counts as success.
 */
export function deleteCharacter(identityKey: string) {
  return request<{ deleted: DeleteCharacterResult }>(
    `/api/characters/${encodeURIComponent(identityKey)}`,
    { method: "DELETE", body: JSON.stringify({ confirmIdentityKey: identityKey }) },
    {
      validate: (body) => hasObject("deleted")(body) && typeof (body as { deleted: { identityKey?: unknown } }).deleted.identityKey === "string",
    },
  );
}

/** The full "Export Dashboard Context" document. Not wrapped in a {key: ...} envelope - this is the exact JSON the developer-tool modal copies/downloads verbatim. */
export function fetchAccountContext(signal?: AbortSignal) {
  return request<AccountContext>("/api/account-context", undefined, {
    signal,
    validate: (body) => isRecord(body) && isRecord(body.versions),
  });
}

/**
 * "Ask My Account" (POC): sends a single question to the server, which
 * retrieves the same canonical account context (above) and forwards it,
 * the question, and a system prompt to a configured LLM provider. Each
 * call is independent - no conversation history is kept on either side.
 */
export function askAccount(question: string) {
  return request<AskAccountResponse>(
    "/api/ask",
    { method: "POST", body: JSON.stringify({ question }) },
    { validate: (body) => isRecord(body) && typeof body.answer === "string" },
  );
}
