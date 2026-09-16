// Tests for the "Ask My Account" local API layer. These never touch a
// real LLM provider - a tiny local HTTP server stands in for OpenAI
// (pointed at via OPENAI_BASE_URL, the same override a real Azure/
// OpenAI-compatible proxy would use), so the whole route - validation,
// the real self-loopback GET /api/account-context call, error mapping,
// and the response shape - is exercised for real, without any network
// access or live credentials. See README.md for the separate, opt-in
// live smoke-test procedure against the real OpenAI API.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { SqliteSnapshotStore, type SnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";

type MockResponder = (body: unknown) => { status: number; rawBody: string };

function startHttpServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function startMockOpenAI(respond: MockResponder) {
  let called = false;
  const promise = startHttpServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      called = true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = undefined;
      }
      const result = respond(parsed);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.rawBody);
    });
  });
  return promise.then((server) => ({ ...server, wasCalled: () => called }));
}

function jsonResponder(status: number, body: unknown): MockResponder {
  return () => ({ status, rawBody: JSON.stringify(body) });
}

function openAiSuccess(answer: string) {
  return jsonResponder(200, {
    choices: [{ message: { content: answer } }],
    usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
  });
}

async function withAppAndMockProvider(
  opts: { store?: SnapshotStore; respond?: MockResponder; apiKey?: string | null; model?: string },
  run: (ctx: { baseUrl: string; wasProviderCalled: () => boolean; logs: string[] }) => Promise<void>,
) {
  const store = opts.store ?? new SqliteSnapshotStore(":memory:");
  const mock = await startMockOpenAI(opts.respond ?? openAiSuccess("A default test answer."));

  const savedEnv = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, WOWSYNC_LLM_MODEL: process.env.WOWSYNC_LLM_MODEL };
  if (opts.apiKey === null) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = opts.apiKey ?? "sk-test-fake-key-do-not-use";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mock.port}`;
  if (opts.model) process.env.WOWSYNC_LLM_MODEL = opts.model;
  else delete process.env.WOWSYNC_LLM_MODEL;

  const logs: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  // Bind the app to an ephemeral port, then reconstruct createApp with
  // that exact port so its internal self-loopback URL is correct.
  const probe = await startHttpServer((_req, res) => res.end());
  const appPort = probe.port;
  await probe.close();
  const app = createApp(store, appPort);
  const appServer = await new Promise<http.Server>((resolve) => {
    const server = http.createServer(app);
    server.listen(appPort, "127.0.0.1", () => resolve(server));
  });

  try {
    await run({ baseUrl: `http://127.0.0.1:${appPort}`, wasProviderCalled: mock.wasCalled, logs });
  } finally {
    console.error = originalConsoleError;
    await new Promise((r) => appServer.close(() => r(undefined)));
    await mock.close();
    if (opts.store === undefined) store.close();
    if (savedEnv.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedEnv.OPENAI_API_KEY;
    if (savedEnv.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedEnv.OPENAI_BASE_URL;
    if (savedEnv.WOWSYNC_LLM_MODEL === undefined) delete process.env.WOWSYNC_LLM_MODEL;
    else process.env.WOWSYNC_LLM_MODEL = savedEnv.WOWSYNC_LLM_MODEL;
  }
}

async function ask(baseUrl: string, question: unknown) {
  const res = await fetch(`${baseUrl}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

// --- Valid question / successful answer ---

test("a valid question returns a successful answer with the expected response shape", async () => {
  await withAppAndMockProvider({ respond: openAiSuccess("Your total known gold on Dreamscythe is 125g 54s 4c.") }, async ({ baseUrl }) => {
    const { status, body } = await ask(baseUrl, "How much gold do I have on TBC Anniversary?");
    assert.equal(status, 200);
    assert.equal(body.answer, "Your total known gold on Dreamscythe is 125g 54s 4c.");
    assert.equal(typeof body.model, "string");
    assert.equal(typeof body.contextGeneratedAt, "number");
    assert.ok(body.contextSummary);
    assert.ok(Array.isArray(body.contextSummary.versions));
    assert.equal(body.contextSummary.versions.length, 3);
    assert.equal(body.usage.totalTokens, 1290);
  });
});

// --- Empty / oversized question ---

test("an empty question is rejected without contacting the provider", async () => {
  await withAppAndMockProvider({}, async ({ baseUrl, wasProviderCalled }) => {
    const { status, body } = await ask(baseUrl, "   ");
    assert.equal(status, 400);
    assert.match(body.error, /question/i);
    assert.equal(wasProviderCalled(), false);
  });
});

test("a missing question field is rejected", async () => {
  await withAppAndMockProvider({}, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 400);
  });
});

test("an excessively long question is rejected without contacting the provider", async () => {
  await withAppAndMockProvider({}, async ({ baseUrl, wasProviderCalled }) => {
    const { status, body } = await ask(baseUrl, "x".repeat(5000));
    assert.equal(status, 400);
    assert.match(body.error, /too long/i);
    assert.equal(wasProviderCalled(), false);
  });
});

// --- Missing provider credentials ---

test("a missing OPENAI_API_KEY produces a clear error without contacting the provider", async () => {
  await withAppAndMockProvider({ apiKey: null }, async ({ baseUrl, wasProviderCalled }) => {
    const { status, body } = await ask(baseUrl, "How much gold do I have?");
    assert.equal(status, 500);
    assert.match(body.error, /OPENAI_API_KEY/);
    assert.equal(wasProviderCalled(), false);
  });
});

// --- Provider errors ---

test("a provider 401 (rejected key) is mapped to a clear, non-leaky error", async () => {
  await withAppAndMockProvider({ respond: jsonResponder(401, { error: { message: "Incorrect API key provided: sk-test-fake-key-do-not-use" } }) }, async ({ baseUrl }) => {
    const { status, body } = await ask(baseUrl, "How much gold do I have?");
    assert.equal(status, 500);
    assert.doesNotMatch(body.error, /sk-test-fake-key-do-not-use/);
  });
});

test("a provider 429 (rate limit) is mapped to a 429 with a clear message", async () => {
  await withAppAndMockProvider({ respond: jsonResponder(429, { error: { message: "Rate limit exceeded" } }) }, async ({ baseUrl }) => {
    const { status, body } = await ask(baseUrl, "How much gold do I have?");
    assert.equal(status, 429);
    assert.match(body.error, /rate/i);
  });
});

test("a provider 500 (unavailable) is mapped to a 502", async () => {
  await withAppAndMockProvider({ respond: jsonResponder(500, { error: { message: "Internal error" } }) }, async ({ baseUrl }) => {
    const { status, body } = await ask(baseUrl, "How much gold do I have?");
    assert.equal(status, 502);
    assert.match(body.error, /unavailable/i);
  });
});

test("a malformed provider response (200 but no answer content) is mapped to a 502", async () => {
  await withAppAndMockProvider({ respond: jsonResponder(200, { choices: [{ message: {} }] }) }, async ({ baseUrl }) => {
    const { status, body } = await ask(baseUrl, "How much gold do I have?");
    assert.equal(status, 502);
    assert.match(body.error, /malformed|empty/i);
  });
});

test("a non-JSON provider response body is mapped to a 502, not a crash", async () => {
  await withAppAndMockProvider({ respond: () => ({ status: 200, rawBody: "not json at all" }) }, async ({ baseUrl }) => {
    const { status, body } = await ask(baseUrl, "How much gold do I have?");
    assert.equal(status, 502);
    assert.ok(body.error);
  });
});

// --- Account-context retrieval failure ---

test("a failure building the account context fails the request outright, never falling back to a stale context", async () => {
  const brokenStore = {
    buildAccountContext() {
      throw new Error("simulated account-context build failure");
    },
  } as unknown as SnapshotStore;
  await withAppAndMockProvider({ store: brokenStore, respond: openAiSuccess("should never be reached") }, async ({ baseUrl, wasProviderCalled }) => {
    const { status, body } = await ask(baseUrl, "How much gold do I have?");
    assert.equal(status, 502);
    assert.match(body.error, /account context/i);
    assert.equal(wasProviderCalled(), false);
  });
});

// --- API key never appears in responses or logs ---

test("the API key never appears in the response body or logged output, across success and failure paths", async () => {
  const secretKey = "sk-super-secret-test-key-should-never-leak";
  await withAppAndMockProvider(
    { apiKey: secretKey, respond: jsonResponder(500, { error: { message: "boom" } }) },
    async ({ baseUrl, logs }) => {
      const { body } = await ask(baseUrl, "How much gold do I have?");
      assert.doesNotMatch(JSON.stringify(body), new RegExp(secretKey));
      for (const line of logs) assert.doesNotMatch(line, new RegExp(secretKey));
    },
  );
  await withAppAndMockProvider({ apiKey: secretKey, respond: openAiSuccess("fine") }, async ({ baseUrl, logs }) => {
    const { body } = await ask(baseUrl, "How much gold do I have?");
    assert.doesNotMatch(JSON.stringify(body), new RegExp(secretKey));
    for (const line of logs) assert.doesNotMatch(line, new RegExp(secretKey));
  });
});

// --- Real store, real question grounding data present in context ---

test("the account context sent to the provider reflects real imported characters, discovered dynamically", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  const raw = [
    "WOWSYNC v1",
    "",
    "Generated: 1789000000",
    "",
    "Format: tab-separated columns; ?=unknown; timestamps=Unix seconds; money=copper; itemRef preserves item variants.",
    "",
    "[CHARACTER]",
    "State: OBSERVED; complete; observed=1789000000",
    "Name: Askable",
    "Realm: Testrealm",
    "Class: MAGE",
    "Level: 10",
    "Faction: Horde",
    "MoneyCopper: 500",
    "Client: 1.15.7 build 60927",
    "",
    "[LOCATION]",
    "State: OBSERVED; complete; observed=1789000000",
    "Zone: Elwynn Forest",
    "",
    "[EQUIPMENT]",
    "State: OBSERVED; complete; observed=1789000000",
    "slot\titemRef\tname\tilvl\trequiredLevel\teffectiveStats",
    "1:Head\tEMPTY",
    "",
    "[BAGS]",
    "State: OBSERVED; complete; observed=1789000000",
    "container\tcapacity\tfree\tfamily\tbagRef",
    "Slots: 0 free / 0",
    "itemRef\tname\tqty\tbound\tvendorEachCopper",
    "Items: EMPTY",
    "",
    "[BANK]",
    "State: UNKNOWN",
    "Reason: Not observed",
    "",
    "[PROFESSIONS]",
    "State: OBSERVED; complete; observed=1789000000",
    "profession\tskill\tmaxSkill",
    "Professions: None identified in exposed skill lines",
    "",
    "[KNOWN SPELLS]",
    "State: OBSERVED; complete; observed=1789000000",
    "Coverage: test",
    "spellID\tname\trank",
    "",
    "[TRAINER]",
    "State: UNKNOWN",
    "Reason: Not observed",
    "",
    "[END]",
  ].join("\n");
  store.importSnapshot(raw);

  let capturedRequestBody: string | undefined;
  await withAppAndMockProvider(
    {
      store,
      respond: (body) => {
        capturedRequestBody = JSON.stringify(body);
        return { status: 200, rawBody: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
      },
    },
    async ({ baseUrl }) => {
      const { status } = await ask(baseUrl, "Who are my characters?");
      assert.equal(status, 200);
    },
  );
  assert.ok(capturedRequestBody);
  assert.match(capturedRequestBody!, /Askable/);
  assert.match(capturedRequestBody!, /Testrealm/);
  store.close();
});
