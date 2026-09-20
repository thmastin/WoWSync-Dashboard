// Network configuration: the server listens on loopback by default, WOWSYNC_HOST
// is the only (validated) way to widen that, and a Host/Origin guard closes the
// DNS-rebinding gap that a loopback bind alone leaves open. These tests actually
// listen on sockets - they assert what the OS reports, not just what a helper returns.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";
import {
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  LOOPBACK_HOSTNAMES,
  exposureWarning,
  listenOnce,
  loopbackOrigin,
  resolveHost,
  resolvePort,
} from "../src/net.ts";

/** A non-loopback IPv4 address of this machine, if it has one (to prove what is and isn't reachable from "the network"). */
function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === "IPv4" && !nic.internal) return nic.address;
    }
  }
  return undefined;
}

function connectOutcome(host: string, port: number): Promise<"connected" | "refused" | "other"> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "ECONNREFUSED" ? "refused" : "other"));
    socket.once("timeout", () => {
      socket.destroy();
      resolve("other");
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// --- WOWSYNC_HOST ----------------------------------------------------------------------------

test("the default bind is loopback: unset, empty, and whitespace-only WOWSYNC_HOST all mean 127.0.0.1 (never all interfaces)", () => {
  for (const env of [{}, { WOWSYNC_HOST: undefined }, { WOWSYNC_HOST: "" }, { WOWSYNC_HOST: "   " }]) {
    assert.deepEqual(resolveHost(env), { host: "127.0.0.1", exposure: "loopback" }, JSON.stringify(env));
  }
  assert.equal(DEFAULT_HOST, "127.0.0.1");
});

test("'localhost' is mapped to 127.0.0.1 (on Node 24 the name resolves to ::1 first, which the IPv4 self-request could not reach)", () => {
  assert.deepEqual(resolveHost({ WOWSYNC_HOST: "localhost" }), { host: "127.0.0.1", exposure: "loopback" });
  assert.deepEqual(resolveHost({ WOWSYNC_HOST: " LocalHost " }), { host: "127.0.0.1", exposure: "loopback" });
});

test("explicit values are classified by how far they expose the server", () => {
  const table: [string, string, string][] = [
    ["127.0.0.1", "127.0.0.1", "loopback"],
    ["127.5.5.5", "127.5.5.5", "loopback"],
    ["::1", "::1", "loopback"],
    ["0.0.0.0", "0.0.0.0", "all-interfaces"],
    ["::", "::", "all-interfaces"],
    ["192.168.1.5", "192.168.1.5", "specific"],
    ["my-pc.local", "my-pc.local", "specific"],
  ];
  for (const [input, host, exposure] of table) {
    assert.deepEqual(resolveHost({ WOWSYNC_HOST: input }), { host, exposure }, input);
  }
});

test("an invalid WOWSYNC_HOST refuses to start with an actionable message, instead of guessing a wider bind", () => {
  for (const bad of ["not a host!", "http://example.com", "1.2.3.4:80", "-bad", "a b", "under_score", "host name"]) {
    assert.throws(() => resolveHost({ WOWSYNC_HOST: bad }), (e: unknown) => e instanceof ConfigError && /WOWSYNC_HOST/.test(e.message) && /127\.0\.0\.1/.test(e.message), bad);
  }
});

test("the generic HOST / HOSTNAME variables are never consulted (shells and Docker set them to unrelated values)", () => {
  assert.deepEqual(resolveHost({ HOST: "0.0.0.0", HOSTNAME: "abc123def456" }), { host: "127.0.0.1", exposure: "loopback" });
});

test("PORT is parsed strictly: empty means the default, anything else invalid is an error (never a random port or a crash)", () => {
  assert.equal(resolvePort({}), DEFAULT_PORT);
  assert.equal(resolvePort({ PORT: "" }), DEFAULT_PORT);
  assert.equal(resolvePort({ PORT: " 8080 " }), 8080);
  for (const bad of ["abc", "0", "-1", "65536", "70000", "80.5", "1e3", "0x50"]) {
    assert.throws(() => resolvePort({ PORT: bad }), (e: unknown) => e instanceof ConfigError && /PORT/.test(e.message), bad);
  }
});

test("only a non-loopback bind produces the exposure warning, and it says what is at stake", () => {
  assert.equal(exposureWarning(resolveHost({}), 4173), undefined);
  assert.equal(exposureWarning(resolveHost({ WOWSYNC_HOST: "::1" }), 4173), undefined);
  for (const host of ["0.0.0.0", "192.168.1.5"]) {
    const w = exposureWarning(resolveHost({ WOWSYNC_HOST: host }), 4173)!;
    assert.match(w, /WARNING/);
    assert.match(w, /NO authentication/);
    assert.match(w, /DELETE/);
    assert.match(w, /OPENAI_API_KEY/);
    assert.match(w, /Unset WOWSYNC_HOST/);
  }
  assert.match(exposureWarning(resolveHost({ WOWSYNC_HOST: "0.0.0.0" }), 4173)!, /EVERY network interface/);
});

test("loopbackOrigin: the address this machine uses to reach its own server (wildcards -> 127.0.0.1, IPv6 bracketed)", () => {
  assert.equal(loopbackOrigin("127.0.0.1", 4173), "http://127.0.0.1:4173");
  assert.equal(loopbackOrigin("0.0.0.0", 4173), "http://127.0.0.1:4173");
  assert.equal(loopbackOrigin("::", 4173), "http://127.0.0.1:4173");
  assert.equal(loopbackOrigin("::1", 4173), "http://[::1]:4173");
  assert.equal(loopbackOrigin("192.168.1.5", 80), "http://192.168.1.5:80");
});

// --- Really listening ----------------------------------------------------------------------------

test("with the default configuration the server is bound to 127.0.0.1 and refuses connections arriving on the machine's network address", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  const server = await listenOnce(createApp(store, 0), resolveHost({}).host, 0);
  try {
    const { address, port } = server.address() as AddressInfo;
    assert.equal(address, "127.0.0.1", "the OS-reported bind address, not just a helper's return value");
    assert.equal(await connectOutcome("127.0.0.1", port), "connected");
    const lan = lanAddress();
    // Refused, or silently dropped by a firewall - either way NOT connected.
    if (lan) assert.notEqual(await connectOutcome(lan, port), "connected", `${lan} must not reach a loopback-bound server`);
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("WOWSYNC_HOST=0.0.0.0 is the explicit opt-in: reachable on loopback AND the machine's network address", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  const server = await listenOnce(createApp(store, 0), resolveHost({ WOWSYNC_HOST: "0.0.0.0" }).host, 0);
  try {
    const { address, port } = server.address() as AddressInfo;
    assert.equal(address, "0.0.0.0");
    assert.equal(await connectOutcome("127.0.0.1", port), "connected");
    const lan = lanAddress();
    if (lan) assert.equal(await connectOutcome(lan, port), "connected");
  } finally {
    await closeServer(server);
    store.close();
  }
});

test("a port that is already taken fails with a plain-language ConfigError, not an unhandled crash", async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const { port } = blocker.address() as AddressInfo;
  try {
    await assert.rejects(
      () => listenOnce((_req, res) => res.end(), "127.0.0.1", port),
      (e: unknown) => e instanceof ConfigError && /already in use/.test(e.message) && /PORT=/.test(e.message),
    );
  } finally {
    await closeServer(blocker);
  }
});

test("a bind address that does not belong to this machine fails with a plain-language ConfigError", async () => {
  await assert.rejects(
    () => listenOnce((_req, res) => res.end(), "203.0.113.77", 0), // TEST-NET-3: never a local address
    (e: unknown) => e instanceof ConfigError && /WOWSYNC_HOST/.test(e.message),
  );
});

test("/api/ask's request to its own /api/account-context uses the configured self origin, not a hardcoded address", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  const saved = { key: process.env.OPENAI_API_KEY, log: console.error };
  process.env.OPENAI_API_KEY = "sk-test-fake-key-do-not-use";
  console.error = () => {};
  // selfOrigin points at a port nothing listens on: if it is honoured, the context fetch fails (502)...
  const app = createApp(store, 0, undefined, { selfOrigin: "http://127.0.0.1:1" });
  const server = await listenOnce(app, "127.0.0.1", 0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hello" }),
    });
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /account context/i);
  } finally {
    console.error = saved.log;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.key;
    await closeServer(server);
    store.close();
  }
});

// --- Host / Origin guard --------------------------------------------------------------------------

function rawRequest(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    // Node does not frame a DELETE body on its own: state the length explicitly.
    const headers = { ...opts.headers, ...(opts.body !== undefined ? { "Content-Length": String(Buffer.byteLength(opts.body)) } : {}) };
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/api/versions", headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

async function withGuardedServer(run: (port: number) => Promise<void>) {
  const store = new SqliteSnapshotStore(":memory:");
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    await closeServer(server);
    store.close();
  }
}

test("guard: loopback host names are served; a rebinding attacker's hostname is refused with a JSON 403", async () => {
  await withGuardedServer(async (port) => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "LOCALHOST", "127.0.0.1"]) {
      assert.equal((await rawRequest(port, { headers: { Host: host } })).status, 200, host);
    }
    for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `192.168.1.5:${port}`, "attacker.test"]) {
      const res = await rawRequest(port, { headers: { Host: host } });
      assert.equal(res.status, 403, host);
      assert.equal(JSON.parse(res.body).code, "HOST_NOT_ALLOWED");
    }
  });
});

test("guard: a state-changing request from a foreign Origin is refused even with a loopback Host; same-origin and Origin-less ones pass", async () => {
  await withGuardedServer(async (port) => {
    const json = { "Content-Type": "application/json", Host: `127.0.0.1:${port}` };
    const del = (origin?: string) =>
      rawRequest(port, {
        method: "DELETE",
        path: "/api/characters/x",
        headers: { ...json, ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ confirmIdentityKey: "x" }),
      });
    assert.equal((await del("https://evil.example")).status, 403);
    assert.equal((await del("null")).status, 403);
    assert.equal((await del("http://localhost:5173")).status, 404, "the Vite dev origin is allowed (404: no such character, i.e. it reached the route)");
    assert.equal((await del()).status, 404, "curl/scripts send no Origin");
    // Reads are governed by Host only.
    assert.equal((await rawRequest(port, { headers: { Host: `127.0.0.1:${port}`, Origin: "https://evil.example" } })).status, 200);
  });
});

test("without the guard option (a deliberate LAN bind) any Host is served", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  const server = await listenOnce(createApp(store, 0), "127.0.0.1", 0);
  try {
    const { port } = server.address() as AddressInfo;
    assert.equal((await rawRequest(port, { headers: { Host: "my-nas.lan" } })).status, 200);
  } finally {
    await closeServer(server);
    store.close();
  }
});

// --- Review findings: upgrade path, loopback range, IP spellings ----------------------------------------

import {
  allowedHostsFor,
  classifyAddress,
  describeListening,
} from "../src/net.ts";

test("UPGRADE PATH: starting on 127.0.0.1 while an older server holds the same port on ALL interfaces is refused (Windows would otherwise allow both, leaving the exposed one running)", async () => {
  const oldServer = http.createServer((_req, res) => res.end("old"));
  await new Promise<void>((resolve) => oldServer.listen(0, "0.0.0.0", () => resolve()));
  const { port } = oldServer.address() as AddressInfo;
  try {
    await assert.rejects(
      () => listenOnce((_req, res) => res.end("new"), "127.0.0.1", port),
      (e: unknown) => e instanceof ConfigError && /already in use/.test(e.message) && /Stop/.test(e.message),
    );
    // The old server is still the only thing answering.
    const body = await new Promise<string>((resolve) => http.get({ host: "127.0.0.1", port }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve(d)); }));
    assert.equal(body, "old");
  } finally {
    await closeServer(oldServer);
  }
});

test("a free port is not mistaken for a taken one (the pre-listen probe does not block a normal start)", async () => {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as AddressInfo;
  await closeServer(probe); // now free again
  const server = await listenOnce((_req, res) => res.end("ok"), "127.0.0.1", port);
  try {
    assert.equal((server.address() as AddressInfo).port, port);
  } finally {
    await closeServer(server);
  }
});

test("classifyAddress: every spelling of 'all interfaces' and 'loopback' is recognised, including IPv4-mapped and zero-padded IPv6", () => {
  const all = ["0.0.0.0", "::", "::0", "0::0", "0:0:0:0:0:0:0:0", "0000:0000:0000:0000:0000:0000:0000:0000", "::ffff:0.0.0.0", "::ffff:0:0"];
  for (const ip of all) assert.equal(classifyAddress(ip), "all-interfaces", ip);
  const loop = ["127.0.0.1", "127.0.0.5", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1"];
  for (const ip of loop) assert.equal(classifyAddress(ip), "loopback", ip);
  const specific = ["192.168.1.5", "10.0.0.1", "8.8.8.8", "fe80::1", "fe80::1%eth0", "2001:db8::1", "::ffff:192.168.1.5", "not-an-ip", ""];
  for (const ip of specific) assert.equal(classifyAddress(ip), "specific", ip);
});

test("resolveHost uses the same classification (a wildcard spelling is never reported as 'specific')", () => {
  assert.equal(resolveHost({ WOWSYNC_HOST: "::0" }).exposure, "all-interfaces");
  assert.equal(resolveHost({ WOWSYNC_HOST: "::ffff:0.0.0.0" }).exposure, "all-interfaces");
  assert.equal(resolveHost({ WOWSYNC_HOST: "::ffff:127.0.0.1" }).exposure, "loopback");
  assert.match(exposureWarning(resolveHost({ WOWSYNC_HOST: "::0" }), 4173)!, /EVERY network interface/);
});

test("all-digit host values that are not valid IP addresses (0, 0000, 127.1, 2130706433) are rejected, not handed to a resolver that may map them to 0.0.0.0", () => {
  for (const bad of ["0", "0000", "127.1", "2130706433", "1.2.3", "300.1.1.1", "1.2.3.4.5"]) {
    assert.throws(() => resolveHost({ WOWSYNC_HOST: bad }), (e: unknown) => e instanceof ConfigError && /WOWSYNC_HOST/.test(e.message), bad);
  }
  // A hostname that merely CONTAINS digits is still fine.
  assert.equal(resolveHost({ WOWSYNC_HOST: "pc-2.local" }).exposure, "specific");
});

test("loopbackOrigin maps every wildcard spelling to 127.0.0.1", () => {
  for (const ip of ["0.0.0.0", "::", "::0", "0::0", "::ffff:0.0.0.0"]) {
    assert.equal(loopbackOrigin(ip, 4173), "http://127.0.0.1:4173", ip);
  }
});

test("the startup line describes what the OS actually bound: a wildcard is never shown as a loopback URL", () => {
  assert.equal(describeListening({ address: "127.0.0.1", port: 4173 }), "http://127.0.0.1:4173");
  assert.equal(describeListening({ address: "::1", port: 4173 }), "http://[::1]:4173");
  assert.match(describeListening({ address: "::", port: 4173 }), /ALL network interfaces/);
  assert.match(describeListening({ address: "0.0.0.0", port: 4173 }), /ALL network interfaces/);
  assert.doesNotMatch(describeListening({ address: "::", port: 4173 }), /127\.0\.0\.1/);
});

test("allowedHostsFor: a loopback bind allows the loopback names PLUS its own address (127.0.0.5 must not lock itself out); other binds get no guard", async () => {
  assert.deepEqual(allowedHostsFor(resolveHost({})), ["localhost", "127.0.0.1", "::1"]);
  assert.deepEqual(allowedHostsFor(resolveHost({ WOWSYNC_HOST: "127.0.0.5" })), ["localhost", "127.0.0.1", "::1", "127.0.0.5"]);
  assert.equal(allowedHostsFor(resolveHost({ WOWSYNC_HOST: "0.0.0.0" })), undefined);
  assert.equal(allowedHostsFor(resolveHost({ WOWSYNC_HOST: "192.168.1.5" })), undefined);

  // End to end: a server really bound to 127.0.0.5 answers requests addressed to it, and its own /api/ask self-fetch passes the guard.
  const bind = resolveHost({ WOWSYNC_HOST: "127.0.0.5" });
  const store = new SqliteSnapshotStore(":memory:");
  const app = createApp(store, 0, undefined, { allowedHosts: allowedHostsFor(bind), selfOrigin: loopbackOrigin(bind.host, 0) });
  let server: http.Server;
  try {
    server = await listenOnce(app, bind.host, 0);
  } catch {
    store.close();
    return; // 127.0.0.5 is not bindable on this OS: nothing further to prove
  }
  try {
    const { port } = server.address() as AddressInfo;
    const res = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.5", port, path: "/api/versions", headers: { Host: `127.0.0.5:${port}` } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on("error", reject);
    });
    assert.equal(res, 200);
  } finally {
    await closeServer(server);
    store.close();
  }
});
