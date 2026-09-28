import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MidnightResearch from "../src/components/MidnightResearch.tsx";

test("Research renders the current Midnight Renown companion topic with provenance", () => {
  const html = renderToStaticMarkup(createElement(MidnightResearch));

  assert.match(html, /Midnight 12\.1 Renown &amp; Reputation/);
  assert.match(html, /Retail · Midnight · Patch 12\.1\.x · Season 2 · 28 September 2026 snapshot/);
  assert.match(html, /The Singularity/);
  assert.match(html, /Singularity 9/);
  assert.match(html, /Warband-wide 20-rank Renown/);
  assert.match(html, /Unknown does not mean unavailable or completed/);
  assert.match(html, /docs\/MIDNIGHT_12_1_RENOWN_REPUTATION_RESEARCH\.md/);
  assert.match(html, /renown-quest-rewards-reset-and-now-item-level-279-in-patch-12-1/);
  assert.match(html, /Rank-by-rank: what every major Renown level actually unlocks/);
  assert.match(html, /Every row below is an unlock explanation/);
  assert.match(html, /Plain-language guide to the things these ranks unlock/);
  assert.match(html, /What it actually is/);
  assert.match(html, /How to earn Renown: the practical weekly loop/);
  assert.match(html, /Do not grind blindly/);
  assert.match(html, /Exactly what each Renown vendor sells at a newly unlocked rank/);
  assert.match(html, /Tarnished Silvermoon Sunspire/);
  assert.match(html, /Coiled Hookshot/);
  assert.match(html, /Fishing and Cooking: a useful loop, not a gear obligation/);
  assert.match(html, /Fishing 1–300: a calm, current-leveling route/);
  assert.match(html, /Cooking 1–100: simple leveling, then make food you will use/);
  assert.match(html, /Combat food: class\/spec suggestions and activity choices/);
  assert.match(html, /Venom-Spiced Cutlets/);
  assert.match(html, /Rated PvP/);
});

test("Research navigation exposes Renown without removing established topics", () => {
  const html = renderToStaticMarkup(createElement(MidnightResearch));

  assert.match(html, /Renown &amp; rep/);
  assert.match(html, /id="renown"/);
  assert.match(html, /Great Vault/);
  assert.match(html, /Mythic\+/);
  assert.match(html, /Crafter/);
});
