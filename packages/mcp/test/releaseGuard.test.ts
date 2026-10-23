import assert from "node:assert/strict";
import { test } from "node:test";
import { isStaleRelease } from "../src/releaseGuard.ts";

const oldSha = "1".repeat(40);
const newSha = "2".repeat(40);
const root = "/home/wowsync-dev/releases";
const file = root + "/" + oldSha + "/packages/mcp/src/index.ts";

test("release guard flags a process whose release differs from releases/current", () => {
  assert.equal(isStaleRelease(file, root + "/current", (value) => value === root + "/current" ? root + "/" + newSha : value), true);
  assert.equal(isStaleRelease(file, root + "/current", (value) => value === root + "/current" ? root + "/" + oldSha : value), false);
  assert.equal(isStaleRelease("/workspace/packages/mcp/src/index.ts", "/workspace/releases/current", (value) => value), false);
  assert.equal(isStaleRelease(file, root + "/current", () => { throw new Error("unavailable"); }), true);
});
