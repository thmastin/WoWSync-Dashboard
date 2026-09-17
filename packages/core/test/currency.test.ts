import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCopper, formatCopperDelta } from "../src/currency.ts";

test("formatCopper: zero", () => {
  assert.equal(formatCopper(0), "0c");
});

test("formatCopper: sub-silver (copper only)", () => {
  assert.equal(formatCopper(42), "42c");
});

test("formatCopper: sub-gold (silver and copper, no gold)", () => {
  assert.equal(formatCopper(354), "3s 54c");
});

test("formatCopper: multi-gold value", () => {
  assert.equal(formatCopper(127343549), "12734g 35s 49c");
});

test("formatCopper: the real Squashpot latest-transition delta magnitude", () => {
  assert.equal(formatCopper(17537790), "1753g 77s 90c");
});

test("formatCopper: the real Ciao latest-transition delta magnitude", () => {
  assert.equal(formatCopper(11903060), "1190g 30s 60c");
});

test("formatCopper: negative value gets a leading minus, not a negative gold/silver/copper part", () => {
  assert.equal(formatCopper(-354), "-3s 54c");
});

test("formatCopper: undefined is never treated as zero", () => {
  assert.equal(formatCopper(undefined), "?");
});

test("formatCopperDelta: positive delta gets an explicit plus sign", () => {
  assert.equal(formatCopperDelta(17537790), "+1753g 77s 90c");
});

test("formatCopperDelta: negative delta keeps the minus from formatCopper, no double sign", () => {
  assert.equal(formatCopperDelta(-354), "-3s 54c");
});

test("formatCopperDelta: a real zero delta is distinguishable from an unknown one", () => {
  assert.equal(formatCopperDelta(0), "±0c");
  assert.equal(formatCopperDelta(undefined), "");
});
