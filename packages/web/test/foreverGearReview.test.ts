import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import type { ForeverGearAllocationApi } from "../src/api.ts";
import ForeverGearReview from "../src/components/ForeverGearReview.tsx";
import { buildForeverGearReview, describeForeverAssessment, filterForeverGearReview, gearReviewSummary } from "../src/foreverGearReview.ts";
import { defaultRoute, formatHash, parseHash, patchRoute } from "../src/routing.ts";

const row = (overrides: Record<string, unknown> = {}) => ({
  disposition: "INSUFFICIENT_EVIDENCE",
  item: { name: "Gloves", itemRef: "item:1368::::::::2:1482:::::::::", itemIdentity: "OBSERVED" },
  source: { identityKey: "forever::classic-beta-pvp-2::fizzwick", name: "Fizzwick", realm: "Classic Beta PvP 2", location: "CARRIED_INVENTORY", provenance: "OBSERVED", observedAt: 1_800_000_000, freshness: "FRESH" },
  recipient: { identityKey: "forever::classic-beta-pvp-2::hallo", name: "Hallo", realm: "Classic Beta PvP 2" },
  evidence: { provenance: "DERIVED", eligibility: "UNKNOWN", suitability: "UNKNOWN", transferability: "UNKNOWN", confidence: "UNKNOWN", reasons: ["Eligibility and transfer route are unknown."], whatWouldChange: ["Capture a validated eligibility result."] },
  // Observed Hallo/Fizzwick values are retained exactly; no allocation verdict is fabricated by this fixture.
  comparison: { upgradeStatus: "UNKNOWN", confidence: "UNKNOWN", rawComparisons: [{ slot: 10, equippedItemRef: "item:6171", classification: "EQUIPPED_DOMINATES_RECORDED_STATS", reason: "Observed RESISTANCE0_NAME: candidate 17 vs equipped 21; this one metric is not a full upgrade assessment." }] },
  ...overrides,
});
const response = (rows: unknown[], version = "forever", ruleset = "forever-70291-allocation-screen-v2") => ({
  status: "FOUND",
  value: { data: { version, ruleset, allocationPlan: rows, recipient: { identityKey: "forever::classic-beta-pvp-2::hallo", name: "Hallo", realm: "Classic Beta PvP 2", observedAt: 1_800_000_000, freshness: "FRESH", class: { value: "Hunter", provenance: "OBSERVED" }, level: { value: 9, provenance: "OBSERVED" }, equipment: { state: "OBSERVED", observedAt: 1_800_000_000, freshness: "FRESH", items: [] } } } },
}) as unknown as ForeverGearAllocationApi;

test("only uses the matching recipient's version-scoped 70291 plan rows", () => {
  const result = buildForeverGearReview([
    { recipientIdentityKey: "forever::classic-beta-pvp-2::hallo", result: response([row(), row({ recipient: { identityKey: "other", name: "Other", realm: "R" } })]) },
    { recipientIdentityKey: "forever::classic-beta-pvp-2::mage", result: response([row()], "retail") },
    { recipientIdentityKey: "forever::classic-beta-pvp-2::wrong", result: response([row()], "forever", "other-rules") },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.recipients.length, 1);
  assert.equal(result[0]!.recipients[0]!.identityKey, "forever::classic-beta-pvp-2::hallo");
});

test("the documented Hallo/Fizzwick variant and raw stat comparison remain UNKNOWN as an overall upgrade", () => {
  const result = buildForeverGearReview([{ recipientIdentityKey: "forever::classic-beta-pvp-2::hallo", result: response([row()]) }]);
  const [group] = result;
  assert.equal(group?.itemRef, "item:1368::::::::2:1482:::::::::");
  assert.equal(group?.recipients[0]?.comparison?.upgradeStatus, "UNKNOWN");
  assert.match(group?.recipients[0]?.comparison?.rawComparisons[0]?.reason ?? "", /candidate 17 vs equipped 21/);
  assert.equal(group?.recipients[0]?.evidence.transferability, "UNKNOWN");
  assert.equal(group?.recipients[0]?.recipientEvidence.class?.value, "Hunter");
  assert.equal(group?.recipients[0]?.recipientEvidence.equipment.freshness, "FRESH");
});

test("groups only identical exact variants from the same source; partial identities stay separate", () => {
  const a = row();
  const b = row({ recipient: { identityKey: "mage", name: "Mage", realm: "Classic Beta PvP 2" } });
  const partial = row({ item: { name: "Gloves", itemRef: "item:1368", itemIdentity: "PARTIAL" }, recipient: { identityKey: "hunter", name: "Hunter", realm: "Classic Beta PvP 2" } });
  const unknown = row({ item: { name: "Gloves" }, recipient: { identityKey: "priest", name: "Priest", realm: "Classic Beta PvP 2" } });
  const groups = buildForeverGearReview([
    { recipientIdentityKey: "forever::classic-beta-pvp-2::hallo", result: response([a]) },
    { recipientIdentityKey: "mage", result: response([b]) },
    { recipientIdentityKey: "hunter", result: response([partial]) },
    { recipientIdentityKey: "priest", result: response([unknown]) },
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups.find((g) => g.itemRef === a.item.itemRef)?.recipients.length, 2);
  assert.equal(groups.find((g) => g.itemRef === "item:1368")?.recipients.length, 1);
  assert.equal(groups.filter((g) => !g.itemRef).length, 1);
  assert.equal(groups.find((g) => g.key.includes("variant:"))?.observedAt, 1_800_000_000);
  assert.equal(groups.find((g) => g.key.includes("variant:"))?.freshness, "FRESH");
});

test("deduplicates exact duplicate rows, retains distinct recipients, and summarizes outcomes", () => {
  const result = buildForeverGearReview([
    { recipientIdentityKey: "forever::classic-beta-pvp-2::hallo", result: response([row(), row()]) },
    { recipientIdentityKey: "other", result: response([row({ disposition: "POSSIBLE_OTHER_CHARACTER", recipient: { identityKey: "other", name: "Other", realm: "R" } })]) },
  ]);
  assert.equal(result[0]!.recipients.length, 2);
  const summary = gearReviewSummary(result);
  assert.deepEqual(summary, { itemCount: 1, recipientRows: 2, insufficient: 1, conditional: 1 });
});

test("does not collapse contradictory recipient outcomes or same-name source identities", () => {
  const sameNameOtherIdentity = row({
    source: { identityKey: "forever::other-realm::fizzwick", name: "Fizzwick", realm: "Other Realm", location: "CARRIED_INVENTORY", provenance: "OBSERVED", observedAt: 1_800_000_000, freshness: "FRESH" },
    disposition: "POSSIBLE_OTHER_CHARACTER",
    evidence: { provenance: "HYPOTHESIS", eligibility: "UNKNOWN", suitability: "UNKNOWN", transferability: "UNKNOWN", confidence: "LIMITED", reasons: ["Conflicting test screen."], whatWouldChange: [] },
  });
  const plan = row({ disposition: "EQUIP_CANDIDATE" });
  const contradiction = row({ disposition: "INSUFFICIENT_EVIDENCE", source: { ...plan.source, observedAt: 1_800_000_060, freshness: "AGING" }, evidence: { ...plan.evidence, reasons: ["Different recipient assessment."] } });
  const groups = buildForeverGearReview([
    { recipientIdentityKey: "forever::classic-beta-pvp-2::hallo", result: response([plan, contradiction, sameNameOtherIdentity]) },
  ]);
  assert.equal(groups.length, 2, "same displayed name/item cannot merge across source identities");
  const sameSource = groups.find((g) => g.sourceIdentityKey === "forever::classic-beta-pvp-2::fizzwick")!;
  assert.equal(sameSource.recipients.length, 2, "distinct conclusions remain visible instead of being silently collapsed");
  assert.deepEqual(new Set(sameSource.recipients.map((r) => r.disposition)), new Set(["EQUIP_CANDIDATE", "INSUFFICIENT_EVIDENCE"]));
  assert.ok(sameSource.recipients.every((r) => r.conflicting), "conflicting recipient conclusions must be marked for the UI");
  assert.ok(sameSource.sourceContextDiffers, "grouped source timestamps/location differences must be explicit");
});

test("player filters narrow recipients, outcomes, and item text without changing source evidence", () => {
  const groups = buildForeverGearReview([
    { recipientIdentityKey: "forever::classic-beta-pvp-2::hallo", result: response([row()]) },
    { recipientIdentityKey: "other", result: response([row({ disposition: "POSSIBLE_OTHER_CHARACTER", recipient: { identityKey: "other", name: "Other", realm: "R" } })]) },
  ]);
  const possible = filterForeverGearReview(groups, { recipientIdentityKey: "other", disposition: "POSSIBLE_OTHER_CHARACTER", query: "gloves" });
  assert.equal(possible.length, 1);
  assert.deepEqual(possible[0]!.recipients.map((r) => r.name), ["Other"]);
  assert.equal(possible[0]!.itemRef, "item:1368::::::::2:1482:::::::::");
  assert.equal(filterForeverGearReview(groups, { query: "nonexistent" }).length, 0);
});

test("assessment statuses use player-facing wording while preserving UNKNOWN meaning", () => {
  assert.equal(describeForeverAssessment("UNKNOWN"), "not established");
  assert.equal(describeForeverAssessment("POSSIBLE_BY_RULE_SCREEN"), "possible by a limited rule screen; not confirmed");
  assert.equal(describeForeverAssessment("HYPOTHESIS"), "hypothesis-based screen");
  assert.equal(describeForeverAssessment("BLOCKED_BOUND_TO_SOURCE"), "observed as bound to its current source");
});

test("gear review deep link remains Forever-only", () => {
  const next = patchRoute(defaultRoute("retail"), { view: "gear-review" });
  assert.equal(next.version, "forever");
  const roundTrip = parseHash(formatHash(next), "retail");
  assert.equal(roundTrip.view, "gear-review");
  assert.equal(roundTrip.version, "forever");
});

test("the product review renders an accessible roster workflow and explicitly limits conclusions", () => {
  const html = renderToStaticMarkup(createElement(ForeverGearReview, { characters: [], refreshTick: 0, onOpenCharacter: () => undefined }));
  assert.match(html, /Gear opportunities across this roster/);
  assert.match(html, /aria-label="Gear review summary"/);
  assert.match(html, /Recipient/);
  assert.match(html, /Assessment/);
  assert.match(html, /recorded stat advantage is not by itself an equip recommendation/);
  assert.match(html, /No bank rows are inferred from missing bank observations/);
  assert.doesNotMatch(html, /Equip now|Send item|Transfer item/);
});
