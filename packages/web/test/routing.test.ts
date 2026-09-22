import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultRoute, formatHash, parseHash, patchRoute, sameRoute } from "../src/routing.ts";

test("empty hash uses fallback version and overview", () => {
  const r = parseHash("", "retail");
  assert.equal(r.version, "retail");
  assert.equal(r.view, "overview");
  assert.equal(r.realm, null);
});

test("round-trips overview with realm", () => {
  const route = { ...defaultRoute("tbc-anniversary"), realm: "Cairne" };
  const again = parseHash(formatHash(route), "retail");
  assert.equal(again.version, "tbc-anniversary");
  assert.equal(again.view, "overview");
  assert.equal(again.realm, "Cairne");
  assert.ok(sameRoute(route, again));
});

test("character detail encodes identityKey and from", () => {
  const route = {
    ...defaultRoute("retail"),
    view: "detail" as const,
    identityKey: "retail::cairne::virek",
    from: "overview" as const,
  };
  const hash = formatHash(route);
  assert.match(hash, /\/c\/retail/);
  assert.match(hash, /from=overview/);
  const again = parseHash(hash, "classic-era");
  assert.equal(again.view, "detail");
  assert.equal(again.identityKey, "retail::cairne::virek");
  assert.equal(again.from, "overview");
});

test("snapshot segment is optional", () => {
  const hash = "#/retail/c/retail%3A%3Acairne%3A%3Avirek/snapshot/47";
  const r = parseHash(hash, "retail");
  assert.equal(r.snapshotId, 47);
  assert.equal(r.identityKey, "retail::cairne::virek");
  assert.equal(parseHash(formatHash(r), "retail").snapshotId, 47);
});

test("characters query filters survive round-trip", () => {
  const route = {
    ...defaultRoute("classic-era"),
    view: "characters" as const,
    realm: "Grobbulus",
    q: "tor",
    classFilter: "Warrior",
    age: "stale",
    sort: "name",
  };
  const again = parseHash(formatHash(route), "retail");
  assert.deepEqual(
    { q: again.q, classFilter: again.classFilter, age: again.age, sort: again.sort, realm: again.realm },
    { q: "tor", classFilter: "Warrior", age: "stale", sort: "name", realm: "Grobbulus" },
  );
});

test("patchRoute to shared forces retail", () => {
  const next = patchRoute(defaultRoute("forever"), { view: "shared" });
  assert.equal(next.version, "retail");
  assert.equal(next.view, "shared");
});

test("invalid path falls back to overview for the version", () => {
  const r = parseHash("#/forever/nope", "retail");
  assert.equal(r.version, "forever");
  assert.equal(r.view, "overview");
});