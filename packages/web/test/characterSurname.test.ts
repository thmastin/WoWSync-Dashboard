import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CharactersRoster from "../src/components/CharactersRoster.tsx";
import type { AppRoute } from "../src/routing.ts";
import type { CharacterFacts } from "../src/types.ts";

function render(name: string, surname?: string) {
  const route = {
    view: "characters", q: "", classFilter: "", age: "", sort: "name", bankMissing: false,
  } as AppRoute;
  const character = {
    identityKey: "forever::classic beta pvp 2::rordin", name, ...(surname ? { surname } : {}),
    realm: "Classic Beta PvP 2", class: "Warrior", level: 3, snapshotCount: 1, freshness: "recent",
    bankStatus: "UNKNOWN", professionsObservationStatus: "UNKNOWN", bagsStatus: "UNKNOWN",
  } as CharacterFacts;
  return renderToStaticMarkup(createElement(CharactersRoster, {
    characters: [character], route, now: 1_791_683_475, onNavigate: () => {}, onOpenCharacter: () => {},
  }));
}

test("Forever roster displays an observed surname and keeps surname-free characters readable", () => {
  assert.match(render("Rordin", "Longbraid"), />Rordin Longbraid</);
  assert.match(render("Hallo"), />Hallo</);
  assert.doesNotMatch(render("Hallo"), /Hallo\s+undefined/);
});
