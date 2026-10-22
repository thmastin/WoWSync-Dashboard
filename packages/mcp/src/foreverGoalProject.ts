import { classifyFreshness, type InventorySection, type SnapshotReadStore, type StoredCharacterSummary, type StoredSnapshot } from "@wowsync-dashboard/core";

export const RORDIN_PROFESSION_GOAL = "Create a project for Rordin Longbraid on Forever to learn Mining and Blacksmithing and craft his first useful equipment upgrade.";

export type ForeverGoalProjectPlan = {
  version: "forever";
  title: string;
  objective: string;
  priority: 3;
  idempotencyKey: string;
  needs: Array<{ stableId: string; kind: "PROFESSION"; resourceKey: string; label: string; requiredQuantity: 1; sourceIdentityKey: string; destinationIdentityKey: string }>;
  workOrders: Array<{
    stableId: string; kind: "INVESTIGATE" | "OTHER" | "CRAFT"; status: "PLANNED" | "WAITING_FOR_EVIDENCE";
    title: string; instructions: string; assignedIdentityKey: string; resourceNeedIds: string[]; dependsOn: string[];
  }>;
  target: { identityKey: string; name: string; surname?: string; realm: string; class?: string; level?: number; profileState: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; observedAt?: number; freshness: "recent" | "stale" | "unknown" };
  resourceDiscovery: {
    version: "forever"; realm: string; accountMembership: "UNKNOWN";
    rosterCharacterCount: number; sameRealmCharacterCount: number; otherRealmCharacterCount: number;
    matchingObservedLocationCount: number; matchingLastSeenLocationCount: number; unknownBankCharacterCount: number;
    characters: Array<{ identityKey: string; name: string; surname?: string; realm: string; class?: string; level?: number; profileState: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; profileObservedAt?: number; profileFreshness: "recent" | "stale" | "unknown"; professionState: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; professions: Array<{ name: string; skill?: number; maxSkill?: number }>; professionObservedAt?: number; professionFreshness: "recent" | "stale" | "unknown" }>;
    charactersTruncated: boolean;
    leads: Array<{ character: { identityKey: string; name: string; surname?: string; realm: string }; location: "bags" | "bank"; itemRef?: string; name?: string; quantity?: number; provenance: "OBSERVED" | "LAST_SEEN"; observedAt?: number; freshness: "recent" | "stale" | "unknown" }>;
    caveat: string;
  };
  recipeEvidence: {
    state: "OBSERVED" | "UNKNOWN";
    observedAt?: number;
    completeness: "partial" | "unknown";
    candidateCompleteness: "UNKNOWN";
    returnedCandidateCount?: number;
    uniqueCandidateCount?: number;
    learnedTrueCount?: number;
    learnedFalseCount?: number;
    knownRecipes: Array<{ recipeID: number; professionName?: string; baseSkillLineID?: number; skillLineID?: number; name?: string; outputItemID?: number; outputItemInfo?: Record<string, unknown>; reagentSlots?: unknown[]; skill?: number; maxTrivialLevel?: number; evidence: "OBSERVED" }>;
    reason: string;
  };
};

function supportsRequest(goal: string): boolean {
  // This tool writes persistent player intent. Accept only the explicitly authorized
  // goal; embedded quotes, negations, or additional instructions must not trigger it.
  const value = goal.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return value === RORDIN_PROFESSION_GOAL.toLocaleLowerCase();
}

function inventoryLeads(section: InventorySection, character: StoredCharacterSummary, snapshot: StoredSnapshot, now: number, location: "bags" | "bank") {
  if (section.status.state === "UNKNOWN") return [];
  const at = evidenceTimestamp(section.status.state, section.status.observedAt, snapshot);
  return section.items.flatMap((item) => {
    // Names only select leads for human review. They are never treated as authoritative item classification.
    if (!item.name || !/\b(ore|bar|ingot|stone|metal)\b/i.test(item.name)) return [];
    return [{ character: { identityKey: character.identityKey, name: character.name, ...(character.surname ? { surname: character.surname } : {}), realm: character.realm }, location,
      ...(item.itemRef ? { itemRef: item.itemRef } : {}), name: item.name, ...(item.qty !== undefined ? { quantity: item.qty } : {}),
      provenance: section.status.state as "OBSERVED" | "LAST_SEEN", ...(at !== undefined ? { observedAt: at } : {}), freshness: classifyFreshness(at, now) } as const];
  });
}

function evidenceTimestamp(state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN", observedAt: number | undefined, snapshot: StoredSnapshot): number | undefined {
  if (observedAt !== undefined) return observedAt;
  return state === "OBSERVED" ? snapshot.generatedAt ?? snapshot.importedAt : undefined;
}

/** Builds a narrow, evidence-aware project from the supported natural-language acceptance request. */
export function buildRordinForeverGoalProject(goal: string, store: SnapshotReadStore, now = Math.floor(Date.now() / 1000)): ForeverGoalProjectPlan | { error: string } {
  if (!supportsRequest(goal)) return { error: "This MCP goal workflow supports the explicit Forever request to create Rordin Longbraid's Mining, Blacksmithing, and first-useful-equipment project. No project was written." };
  const roster = store.listCharacters("forever");
  const matches = roster.filter((character) => character.name.toLocaleLowerCase() === "rordin" && character.surname?.toLocaleLowerCase() === "longbraid");
  if (matches.length !== 1) return { error: matches.length === 0 ? "Rordin Longbraid is not uniquely observed in the Forever character roster; no project was written." : "More than one Rordin Longbraid identity exists in the Forever roster; no project was written." };
  const targetCharacter = matches[0]!;
  const snapshots = store.listSnapshots(targetCharacter.identityKey);
  const targetSnapshot = snapshots[0];
  const targetSection = targetSnapshot?.parsed.character;
  const targetProfileState = targetSection?.status.state ?? "UNKNOWN";
  const targetAt = targetProfileState === "UNKNOWN" || !targetSnapshot ? undefined : evidenceTimestamp(targetProfileState, targetSection?.status.observedAt, targetSnapshot);
  const targetFreshness = targetProfileState === "UNKNOWN" ? "unknown" : classifyFreshness(targetAt, now);
  const target = { identityKey: targetCharacter.identityKey, name: targetCharacter.name, ...(targetCharacter.surname ? { surname: targetCharacter.surname } : {}), realm: targetCharacter.realm,
    ...(targetProfileState !== "UNKNOWN" && targetSection?.class ? { class: targetSection.class } : {}),
    ...(targetProfileState !== "UNKNOWN" && targetSection?.level !== undefined ? { level: targetSection.level } : {}), profileState: targetProfileState,
    ...(targetAt !== undefined ? { observedAt: targetAt } : {}), freshness: targetFreshness } as const;
  const sameRealm = roster.filter((character) => character.realm === targetCharacter.realm);
  const latestByIdentity = new Map(sameRealm.map((character) => [character.identityKey, store.listSnapshots(character.identityKey)[0]]));
  const allLeads = sameRealm.flatMap((character) => {
    const snapshot = latestByIdentity.get(character.identityKey);
    if (!snapshot) return [];
    return [...inventoryLeads(snapshot.parsed.bags, character, snapshot, now, "bags"), ...inventoryLeads(snapshot.parsed.bank, character, snapshot, now, "bank")];
  }).sort((a, b) => (a.character.identityKey.localeCompare(b.character.identityKey) || a.location.localeCompare(b.location) || (a.itemRef ?? "").localeCompare(b.itemRef ?? "")));
  const leads = allLeads.slice(0, 12);
  const matchingObservedLocationCount = allLeads.filter((lead) => lead.provenance === "OBSERVED").length;
  const matchingLastSeenLocationCount = allLeads.filter((lead) => lead.provenance === "LAST_SEEN").length;
  const unknownBankCharacterCount = sameRealm.filter((character) => latestByIdentity.get(character.identityKey)?.parsed.bank.status.state === "UNKNOWN").length;
  const rosterCharacters = sameRealm.flatMap((character) => {
    const snapshot = latestByIdentity.get(character.identityKey);
    if (!snapshot) return [{ identityKey: character.identityKey, name: character.name, ...(character.surname ? { surname: character.surname } : {}), realm: character.realm, profileState: "UNKNOWN" as const, profileFreshness: "unknown" as const, professionState: "UNKNOWN" as const, professions: [], professionFreshness: "unknown" as const }];
    const section = snapshot.parsed.professions;
    const profile = snapshot.parsed.character;
    const profileAt = evidenceTimestamp(profile.status.state, profile.status.observedAt, snapshot);
    const professionAt = evidenceTimestamp(section.status.state, section.status.observedAt, snapshot);
    return [{ identityKey: character.identityKey, name: character.name, ...(character.surname ? { surname: character.surname } : {}), realm: character.realm,
      ...(profile.status.state !== "UNKNOWN" && profile.class ? { class: profile.class } : {}), ...(profile.status.state !== "UNKNOWN" && profile.level !== undefined ? { level: profile.level } : {}), profileState: profile.status.state,
      ...(profileAt !== undefined ? { profileObservedAt: profileAt } : {}), profileFreshness: profile.status.state === "UNKNOWN" ? "unknown" as const : classifyFreshness(profileAt, now),
      professionState: section.status.state, ...(section.status.state === "UNKNOWN" ? { professions: [] } : { professions: section.entries.map(({ name, skill, maxSkill }) => ({ name, ...(skill !== undefined ? { skill } : {}), ...(maxSkill !== undefined ? { maxSkill } : {}) })) }),
      ...(professionAt !== undefined ? { professionObservedAt: professionAt } : {}), professionFreshness: section.status.state === "UNKNOWN" ? "unknown" as const : classifyFreshness(professionAt, now) }];
  });
  const stableIntent = "forever:rordin-longbraid:learn-mining:blacksmithing:first-useful-equipment-upgrade:v1";
  const idempotencyKey = `${stableIntent}:${targetCharacter.identityKey}`;
  const task = (suffix: string) => `${stableIntent.replaceAll(":", "_")}_${suffix}`;
  const review = task("review"); const mining = task("mining"); const blacksmithing = task("blacksmithing"); const recipe = task("recipe"); const compare = task("compare"); const fulfillment = task("fulfillment"); const craft = task("craft");
  const professionState = targetSnapshot?.parsed.professions.status.state ?? "UNKNOWN";
  const professionEntries = targetSnapshot?.parsed.professions.entries ?? [];
  const professionEvidence = ["Mining", "Blacksmithing"].map((name) => {
    const row = professionEntries.find((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    return `${name}: ${professionState === "UNKNOWN" ? "UNKNOWN (no profession observation)" : row ? `${professionState}, skill ${row.skill ?? "UNKNOWN"}${row.maxSkill !== undefined ? `/${row.maxSkill}` : ""}` : `${professionState}, exact profession not listed`}`;
  }).join("; ");
  const recipeSection = targetSnapshot?.parsed.foreverGearObservation?.professionRecipes;
  const recipeData = recipeSection?.data;
  const recipeScopes = Array.isArray(recipeData?.professions) ? recipeData.professions as Array<Record<string, unknown>> : [];
  const knownRecipes = recipeScopes.flatMap((scope) => {
    if (scope.evidence !== "OBSERVED") return [];
    return (Array.isArray(scope.recipes) ? scope.recipes as Array<Record<string, unknown>> : [])
      .filter((row) => row.evidence === "OBSERVED" && row.learnedState === "OBSERVED_TRUE" && row.learned === true && typeof row.recipeID === "number")
      .map((row) => ({ recipeID: row.recipeID as number, ...(typeof scope.professionName === "string" ? { professionName: scope.professionName } : typeof scope.name === "string" ? { professionName: scope.name } : {}), ...(typeof scope.baseSkillLineID === "number" ? { baseSkillLineID: scope.baseSkillLineID } : {}), ...(typeof scope.skillLineID === "number" ? { skillLineID: scope.skillLineID } : {}), ...(typeof row.name === "string" ? { name: row.name } : {}), ...(typeof row.outputItemID === "number" ? { outputItemID: row.outputItemID } : {}), ...(row.outputItemInfo && typeof row.outputItemInfo === "object" ? { outputItemInfo: row.outputItemInfo as Record<string, unknown> } : {}), ...(Array.isArray(row.reagentSlots) ? { reagentSlots: row.reagentSlots } : {}), ...(typeof row.skill === "number" ? { skill: row.skill } : {}), ...(typeof row.maxTrivialLevel === "number" ? { maxTrivialLevel: row.maxTrivialLevel } : {}), evidence: "OBSERVED" as const }));
  }).sort((a, b) => a.recipeID - b.recipeID);
  const recipeCoverage = recipeData?.coverage && typeof recipeData.coverage === "object" ? recipeData.coverage as Record<string, unknown> : undefined;
  const recipeEvidence: ForeverGoalProjectPlan["recipeEvidence"] = recipeSection ? {
    state: "OBSERVED", observedAt: recipeSection.observedAt, completeness: "partial", candidateCompleteness: "UNKNOWN",
    ...(typeof recipeCoverage?.returnedRecipeCount === "number" ? { returnedCandidateCount: recipeCoverage.returnedRecipeCount } : {}),
    ...(typeof recipeCoverage?.uniqueCandidateCount === "number" ? { uniqueCandidateCount: recipeCoverage.uniqueCandidateCount } : {}),
    ...(typeof recipeCoverage?.learnedTrueCount === "number" ? { learnedTrueCount: recipeCoverage.learnedTrueCount } : {}),
    ...(typeof recipeCoverage?.learnedFalseCount === "number" ? { learnedFalseCount: recipeCoverage.learnedFalseCount } : {}),
    knownRecipes,
    reason: `Forever recipe data was observed at ${recipeSection.observedAt}; ${knownRecipes.length} exact recipe row(s) explicitly report learned. The candidate list is incomplete (candidateCompleteness UNKNOWN). Output and reagent API records do not establish current skill/level eligibility, complete ingredient availability, equipment benefit, or present craftability.`,
  } : { state: "UNKNOWN", completeness: "unknown", candidateCompleteness: "UNKNOWN", knownRecipes: [], reason: "This Rordin snapshot has no structured Forever profession recipe section. Missing rows do not mean unlearned; candidate completeness, outputs, and reagents remain UNKNOWN." };
  const leadLines = leads.slice(0, 8).map((lead) => `- ${lead.name ?? "Unlabeled item"}${lead.itemRef ? ` (${lead.itemRef})` : " (item variant UNKNOWN)"}, quantity ${lead.quantity ?? "UNKNOWN"}, ${lead.location}, ${lead.character.name}${lead.character.surname ? ` ${lead.character.surname}` : ""}, ${lead.provenance}/${lead.freshness}${lead.observedAt ? ` at ${new Date(lead.observedAt * 1000).toISOString()}` : "; timestamp UNKNOWN"}`).join("\n");
  const observedRecipeSummary = recipeEvidence.state === "OBSERVED" ? ` The captured recipe section reports ${recipeEvidence.learnedTrueCount ?? knownRecipes.length} learned of ${recipeEvidence.uniqueCandidateCount ?? "UNKNOWN"} unique candidates; known rows: ${knownRecipes.map((row) => `${row.name ?? `recipe ${row.recipeID}`} (ID ${row.recipeID}, output ${row.outputItemID ?? "UNKNOWN"})`).join("; ") || "none"}. Candidate completeness remains UNKNOWN, and the rows alone do not establish eligibility or craftability.` : ` Recipe evidence remains UNKNOWN: ${recipeEvidence.reason}`;
  const objective = `Player goal: ${RORDIN_PROFESSION_GOAL}\nTarget identity: ${targetCharacter.identityKey}; ${targetCharacter.realm}; current class/level and freshness are shown in attached evidence.\nProfession evidence at creation: ${professionEvidence}.\nSame-realm material-name search produced ${allLeads.length} location lead(s) (${matchingObservedLocationCount} OBSERVED, ${matchingLastSeenLocationCount} LAST_SEEN), of which at most ${leads.length} are included, in the Forever import context. These are not proof of account membership, ownership sharing, accessibility, or transferability. Personal bank UNKNOWN count: ${unknownBankCharacterCount}; UNKNOWN does not mean empty.${observedRecipeSummary}\nDo not assume a Copper Ore conversion ratio, complete reagent availability, craftability, or upgrade.`.slice(0, 2000);
  const orders = [
    { stableId: review, kind: "INVESTIGATE" as const, status: "PLANNED" as const, title: "Review Rordin's current profession, inventory, and equipment evidence", instructions: `At creation the profession evidence is: ${professionEvidence}. Refresh the ordinary Forever export before acting if this evidence is stale or unknown. Do not treat absent professions or storage sections as zero/empty.`, assignedIdentityKey: targetCharacter.identityKey, resourceNeedIds: [], dependsOn: [] },
    { stableId: mining, kind: "OTHER" as const, status: "PLANNED" as const, title: "Learn Mining if it is not already observed", instructions: "Player-controlled profession learning. First confirm the current profession state; do not mark complete until the player records the result or a later export observes it.", assignedIdentityKey: targetCharacter.identityKey, resourceNeedIds: ["mining_profession"], dependsOn: [review] },
    { stableId: blacksmithing, kind: "OTHER" as const, status: "PLANNED" as const, title: "Learn Blacksmithing if it is not already observed", instructions: "Player-controlled profession learning. First confirm the current profession state; do not mark complete until the player records the result or a later export observes it.", assignedIdentityKey: targetCharacter.identityKey, resourceNeedIds: ["blacksmithing_profession"], dependsOn: [review] },
    { stableId: recipe, kind: "INVESTIGATE" as const, status: "PLANNED" as const, title: "Review Forever Blacksmithing recipes and verify a useful equipment target", instructions: `${recipeEvidence.reason} Do not infer craftability from recipe knowledge. For any candidate equipment, verify requirements and compare against Rordin's current equipment before treating it as useful. Potential same-realm inventory leads at creation:\n` + (leadLines || "- No name-matched ore/bar/ingot/stone leads were identified; that does not establish empty inventory. Other item names may still be relevant."), assignedIdentityKey: targetCharacter.identityKey, resourceNeedIds: [], dependsOn: [] },
    { stableId: compare, kind: "INVESTIGATE" as const, status: "PLANNED" as const, title: "Compare a verified craft output with Rordin's observed equipment", instructions: "Only assess an output after exact item metadata and a current equipment comparison are available. Separate slot legality, eligibility, recorded stat differences, suitability, and overall upgrade status. Keep upgrade UNKNOWN if required evidence is missing.", assignedIdentityKey: targetCharacter.identityKey, resourceNeedIds: [], dependsOn: [recipe] },
    { stableId: fulfillment, kind: "INVESTIGATE" as const, status: "PLANNED" as const, title: "Plan exact reagent fulfillment after the recipe is verified", instructions: "Add exact item needs only after verifying recipe quantities. Compare them with fresh, exact-variant observed bag/bank evidence. Other-character locations are investigation leads only; do not assume account membership, access, or transferability. Do not reserve or move resources until the player confirms a safe plan.", assignedIdentityKey: targetCharacter.identityKey, resourceNeedIds: [], dependsOn: [recipe, compare] },
    { stableId: craft, kind: "CRAFT" as const, status: "WAITING_FOR_EVIDENCE" as const, title: "Craft the selected equipment manually after requirements are verified", instructions: "Blocked until an exact Forever recipe/output, character requirements, candidate-upgrade comparison, and complete reagent needs are recorded and reviewed. This work order never performs the craft.", assignedIdentityKey: targetCharacter.identityKey, resourceNeedIds: [], dependsOn: [fulfillment] },
  ];
  return {
    version: "forever", title: "Learn Mining and Blacksmithing, then craft Rordin's first useful equipment upgrade", objective, priority: 3, idempotencyKey,
    needs: [
      { stableId: "mining_profession", kind: "PROFESSION", resourceKey: "Mining", label: "Mining skill at least 1", requiredQuantity: 1, sourceIdentityKey: targetCharacter.identityKey, destinationIdentityKey: targetCharacter.identityKey },
      { stableId: "blacksmithing_profession", kind: "PROFESSION", resourceKey: "Blacksmithing", label: "Blacksmithing skill at least 1", requiredQuantity: 1, sourceIdentityKey: targetCharacter.identityKey, destinationIdentityKey: targetCharacter.identityKey },
    ], workOrders: orders, target,
    resourceDiscovery: { version: "forever", realm: targetCharacter.realm, accountMembership: "UNKNOWN", rosterCharacterCount: roster.length, sameRealmCharacterCount: sameRealm.length, otherRealmCharacterCount: roster.length - sameRealm.length, matchingObservedLocationCount, matchingLastSeenLocationCount, unknownBankCharacterCount,
      characters: rosterCharacters.slice(0, 40), charactersTruncated: rosterCharacters.length > 40,
      leads, caveat: "This is the same-realm Forever Dashboard roster, not a verified account roster. Character and profession rows preserve each latest snapshot's state/freshness. Candidate material leads are extracted from observed bag/bank names containing ore, bar, ingot, stone, or metal. Exact itemStrings are preserved when available. None of this establishes account membership, ownership sharing, access, current availability, recipe suitability, or transferability. The bounded name search is not an exhaustive resource inventory." },
    recipeEvidence,
  };
}
