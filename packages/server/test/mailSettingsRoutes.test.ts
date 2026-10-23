import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { createApp } from "../src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../src/net.ts";

test("mail settings API validates, persists and returns eligibility per version/realm/faction/account", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = 1_792_000_000;
  store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Auction", realm: "Realm", faction: "Alliance", class: "Warrior", level: 60, clientVersion: "1.15.9", clientBuild: "70003" } }));
  const identityKey = store.listCharacters("classic-era")[0]!.identityKey;
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, url: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ host: "127.0.0.1", port, method, path: url, headers: {
      Host: "127.0.0.1:" + port,
      ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}),
    } }, (response) => {
      let text = "";
      response.on("data", (chunk) => text += chunk);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
    });
    request.on("error", reject); request.end(payload);
  });
  try {
    const put = await call("PUT", "/api/mail-plan-settings", {
      accountId: "default", version: "classic-era", realm: "Realm", faction: "Alliance",
      auctionCharacterIdentityKey: identityKey,
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.settings.provenance, "USER_CONFIGURED");
    const get = await call("GET", "/api/mail-plan-settings?accountId=default&version=classic-era&realm=Realm&faction=Alliance");
    assert.equal(get.status, 200);
    assert.equal(get.body.auctionCharacter.state, "ELIGIBLE");
    assert.equal(get.body.mainCharacter.state, "UNDETERMINED");
    const invalid = await call("PUT", "/api/mail-plan-settings", {
      accountId: "default", version: "forever", realm: "Realm", faction: "Alliance",
      auctionCharacterIdentityKey: identityKey,
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "INVALID_MAIL_SETTINGS");
    const malformed = await call("GET", "/api/mail-plan-settings?accountId=default&version=retail&realm=Realm&faction=Alliance");
    assert.equal(malformed.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
