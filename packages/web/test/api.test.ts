// The API client's failure handling. Every way a request can go wrong becomes a
// classified ApiError with a message a person can act on - never a cryptic
// "Unexpected token <" from JSON.parse, never a later `undefined` crash, and
// never something that resolves as if it were data. fetch is replaced with a
// stub; nothing here touches a network.
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import {
  ApiError,
  askAccount,
  deleteCharacter,
  describeApiError,
  fetchAccountContext,
  fetchAccountFacts,
  fetchCharacter,
  fetchSnapshots,
  importExport,
  request,
} from "../src/api.ts";

function stubFetch(impl: (input: string, init?: RequestInit) => Promise<Response> | Response) {
  const stub = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => impl(String(input), init));
  return stub;
}
afterEach(() => mock.restoreAll());

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function failureOf(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the request to fail");
}

// --- Failure classification -----------------------------------------------------------------

test("network failure (server stopped / connection refused) is kind 'network' with a plain message", async () => {
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  const err = await failureOf(() => fetchAccountFacts("retail"));
  assert.equal(err.kind, "network");
  assert.equal(err.status, undefined);
  assert.match(err.message, /Can't reach the WoWSync server/);
  assert.doesNotMatch(err.message, /fetch failed/, "no raw engine error text");
});

test("an HTML error page (proxy or old server) is an http error - never 'Unexpected token <'", async () => {
  stubFetch(() => new Response("<!DOCTYPE html><html><body><pre>Error</pre></body></html>", { status: 500, headers: { "Content-Type": "text/html" } }));
  const err = await failureOf(() => fetchAccountFacts("retail"));
  assert.equal(err.kind, "http");
  assert.equal(err.status, 500);
  assert.match(err.message, /HTTP 500/);
  assert.match(err.message, /server running/);
  assert.doesNotMatch(err.message, /Unexpected token|<|JSON/);
});

test("an empty error body (what the Vite dev proxy sends when the API server is down) is an http error, not a JSON parse crash", async () => {
  stubFetch(() => new Response("", { status: 500 }));
  const err = await failureOf(() => fetchAccountFacts("retail"));
  assert.equal(err.kind, "http");
  assert.equal(err.status, 500);
  assert.doesNotMatch(err.message, /JSON|Unexpected/);
});

test("502 / 504 gateway errors are http errors that suggest checking the server", async () => {
  for (const status of [502, 503, 504]) {
    stubFetch(() => new Response("Bad gateway", { status }));
    const err = await failureOf(() => fetchCharacter("x"));
    assert.equal(err.kind, "http");
    assert.equal(err.status, status);
    assert.match(err.message, new RegExp(`HTTP ${status}`));
    mock.restoreAll();
  }
});

test("a success status with a body that is not JSON is kind 'parse'", async () => {
  stubFetch(() => new Response("<html>not the API</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
  const err = await failureOf(() => fetchAccountFacts("retail"));
  assert.equal(err.kind, "parse");
  assert.equal(err.status, 200);
  assert.match(err.message, /not valid JSON/);
});

test("a success status with an EMPTY body is kind 'parse' too (not silently treated as data)", async () => {
  stubFetch(() => new Response("", { status: 200 }));
  assert.equal((await failureOf(() => fetchCharacter("x"))).kind, "parse");
});

test("valid JSON of the wrong shape is kind 'shape' for every fetcher - never a later undefined crash", async () => {
  const wrong = [{}, [], null, "text", 42, { unrelated: true }];
  const calls: [string, () => Promise<unknown>][] = [
    ["fetchAccountFacts", () => fetchAccountFacts("retail")],
    ["fetchCharacter", () => fetchCharacter("k")],
    ["fetchSnapshots", () => fetchSnapshots("k")],
    ["importExport", () => importExport("text")],
    ["fetchAccountContext", () => fetchAccountContext()],
    ["askAccount", () => askAccount("q")],
    ["deleteCharacter", () => deleteCharacter("k")],
  ];
  for (const [name, call] of calls) {
    for (const body of wrong) {
      stubFetch(() => jsonRes(body));
      const err = await failureOf(call);
      assert.equal(err.kind, "shape", `${name} with ${JSON.stringify(body)}`);
      mock.restoreAll();
    }
  }
});

test("account facts must actually carry a characters list (an object called `facts` is not enough)", async () => {
  stubFetch(() => jsonRes({ facts: {} }));
  assert.equal((await failureOf(() => fetchAccountFacts("retail"))).kind, "shape");
});

test("a JSON error body keeps the server's message, status and stable code", async () => {
  stubFetch(() => jsonRes({ error: "Character not found (it may already have been deleted).", code: "CHARACTER_NOT_FOUND" }, 404));
  const err = await failureOf(() => fetchCharacter("k"));
  assert.equal(err.kind, "http");
  assert.equal(err.status, 404);
  assert.equal(err.code, "CHARACTER_NOT_FOUND");
  assert.equal(err.message, "Character not found (it may already have been deleted).");
});

test("a JSON error body without a usable message falls back to a status-based one (no TypeError on null/array bodies)", async () => {
  for (const body of [null, [], "text", { code: 5 }, { error: 7 }]) {
    stubFetch(() => jsonRes(body, 400));
    const err = await failureOf(() => fetchCharacter("k"));
    assert.equal(err.kind, "http");
    assert.equal(err.status, 400);
    assert.match(err.message, /HTTP 400/);
    mock.restoreAll();
  }
});

// --- Success and plumbing -------------------------------------------------------------------------

test("a well-formed reply is returned untouched", async () => {
  const facts = { facts: { version: "retail", characters: [] } };
  stubFetch(() => jsonRes(facts));
  assert.deepEqual(await fetchAccountFacts("retail"), facts);
});

test("the abort signal reaches fetch, and an aborted request rejects with the AbortError itself (not a 'network' error to show)", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  stubFetch((_url, init) => {
    seen = init?.signal ?? undefined;
    throw new DOMException("aborted", "AbortError");
  });
  await assert.rejects(
    () => fetchAccountFacts("retail", controller.signal),
    (e: unknown) => e instanceof Error && e.name === "AbortError" && !(e instanceof ApiError),
  );
  assert.equal(seen, controller.signal);
});

test("identity keys are URL-encoded in paths (they contain '::', spaces and apostrophes)", async () => {
  let path = "";
  stubFetch((url) => {
    path = url;
    return jsonRes({ character: {} });
  });
  await fetchCharacter("retail::kel'thuzad::ezaller");
  assert.equal(path, "/api/characters/retail%3A%3Akel'thuzad%3A%3Aezaller");
});

test("deleteCharacter sends DELETE with the confirmation the server requires, and only a reply naming the character is accepted", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  stubFetch((url, init) => {
    seen = { url, init };
    return jsonRes({ deleted: { identityKey: "a::b::c", snapshotsDeleted: 2 } });
  });
  const reply = await deleteCharacter("a::b::c");
  assert.equal(seen?.init?.method, "DELETE");
  assert.deepEqual(JSON.parse(String(seen?.init?.body)), { confirmIdentityKey: "a::b::c" });
  assert.equal(reply.deleted.snapshotsDeleted, 2);
});

test("request(): a validate that throws is not swallowed into success", async () => {
  stubFetch(() => jsonRes({ ok: true }));
  await assert.rejects(() => request("/x", undefined, { validate: () => false }), (e: unknown) => e instanceof ApiError && e.kind === "shape");
});

test("describeApiError: ApiError message, plain Error message, and a fallback for anything else", () => {
  assert.equal(describeApiError(new ApiError("boom", "http", 500)), "boom");
  assert.equal(describeApiError(new Error("plain")), "plain");
  assert.equal(describeApiError("weird"), "Something went wrong.");
  assert.equal(describeApiError(undefined), "Something went wrong.");
});
