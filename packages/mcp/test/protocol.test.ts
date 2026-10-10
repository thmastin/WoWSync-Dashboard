import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { assertForeverAllocationContract } from "../../core/test/foreverAllocationContract.ts";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const entrypoint = path.join(packageRoot, "src", "index.ts");
const now = 1_790_793_200;
const recipeState = { formatVersion: 1, clientFamily: "Retail", professionRecipes: { observedAt: now, completeness: "partial", data: {
  formatVersion: 1, ownerScope: "CHARACTER", coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", enumeration: "OBSERVED", filteredEnumerationUsed: false, returnedRecipeCount: 1 },
  professions: [{ baseSkillLineID: 202, parentProfessionID: 202, professionID: 2910, skillLineID: 2910, professionName: "Midnight Engineering", expansionName: "Midnight", evidence: "OBSERVED", observedAt: now,
    client: { clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: 69933 },
    coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", enumeration: "OBSERVED", filteredEnumerationUsed: false, returnedRecipeCount: 1 },
    recipes: [{ recipeID: 1229853, learned: true, learnedState: "OBSERVED_TRUE", recipeInfoResult: "OBSERVED_VALUE", skillLineAssociationState: "OBSERVED", skillLineIDs: [2910], evidence: "OBSERVED", observedAt: now }],
  }],
} } };

function retail(name: string, realm: string, professions = false, moneyCopper?: number, bankLastSeen = false, generatedAt = now, level = 90, equipmentItem = 1, gearCandidates = false) {
  const exported = buildWowSyncExport({
    generatedAt,
    character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: "69933", level, ...(moneyCopper !== undefined ? { moneyCopper } : {}) },
    equipment: { slots: [{ slot: 1, slotName: "Head", itemRef: `item:${equipmentItem}`, name: "Observed Helm", itemLevel: 279 }] },
    professions: professions ? { entries: [{ name: "Engineering", skill: 100, maxSkill: 100 }, { name: "Alchemy", skill: 100, maxSkill: 100 }], retail: true } : undefined,
    spells: { coverage: "Protocol fixture player spellbook", entries: [{ spellID: 1234, name: "Protocol Spell", rank: "" }] },
    trainer: { categories: [{ category: "CLASS", name: "Protocol Trainer", services: [{ spellID: 1234, ability: "Protocol Spell", status: "known" }, { spellID: 1235, ability: "Available Spell", status: "available", requiredLevel: 90 }, { spellID: 1236, ability: "Later Spell", status: "unavailable", requiredLevel: 91 }] }] },
    // 777 is captured bare (no hyperlink); 4242 carries a full item string and bound=no (Slice 3 RESOLVED coverage).
    bags: { containers: [{ id: 0, capacity: 20, free: 18, items: [{ itemRef: "item:777", name: "Observed Bag Item", qty: 2 }, { itemRef: "item:4242::::::::90:253:::::::::", name: "Observed Full-String Item", qty: 3, bound: false }] }] },
    bank: { lastSeen: bankLastSeen, containers: [{ id: 1, capacity: 28, free: 27, items: [{ itemRef: "item:888", name: "Observed Bank Item", qty: 1 }] }] },
  });
  const withMetadata = exported.replace(/\n\[END\]$/, "\n\n[ITEM METADATA]\nbaseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent\n777\t7\t5\t1\t11\tyes\n\n[END]");
  const candidateHeader = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
  return gearCandidates ? withMetadata.replace(/\n\[END\]$/, `\n\n[GEAR CANDIDATES]\nState: partial; observed=${generatedAt}\nContractVersion: 1\n${candidateHeader}\nEQUIPPABLE\tCONTAINER_SLOT\t0\t1\t123\titem:123\t?\t1\t0\t0\t4\t4\tINVTYPE_HEAD\tno\t?\tyes\tno\t?\t9\tno\tLAST_SEEN\n\n[END]`) : withMetadata;
}

function retailItemQuantity(name: string, realm: string, quantity: number, generatedAt: number, itemID = 777) {
  return buildWowSyncExport({ generatedAt, character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: "69933" }, bags: { containers: [{ id: 0, capacity: 20, items: quantity ? [{ itemRef: `item:${itemID}`, name: "Observed Bag Item", qty: quantity }] : [] }] }, bank: { containers: [] } });
}

function forever(name: string, realm: string, surname?: string, surnameSource?: string) {
  const generatedAt = now - 15;
  const text = buildWowSyncExport({ generatedAt, character: { name, surname, surnameSource, realm, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" }, equipment: { slots: [{ slot: 16, slotName: "Main Hand", itemRef: "item:900:0:0:0:0:0:0:0", name: "Observed Forever Weapon" }] }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:901:0:0:0:0:0:0:0:123:0:0:0", name: "Observed Forever Variant", qty: 2 }] }] }, bank: { unknown: true } });
  const itemString = "item:901:0:0:0:0:0:0:0:123:0:0:0";
  const factValue = (value: string | number | boolean) => ({ state: "OBSERVED", type: typeof value, value });
  return { text, sidecar: { clientProfile: "Forever:1.60.1:70291:16001", name, realm, generatedAt, sourceCharacterGuid: "Player-1-HALLO", equipment: { observedAt: generatedAt + 1, completeness: "complete", data: { slots: { "16": { itemID: 900, itemString: "item:900:0:0:0:0:0:0:0", name: "Observed Forever Weapon" } } } }, bags: { observedAt: generatedAt + 2, completeness: "complete", data: { containers: [{ id: 0, slots: { "1": { itemID: 901, itemString, name: "Observed Forever Variant", count: 2 } } }] } }, bank: { observedAt: generatedAt + 2, completeness: "unknown", reason: "Not visited", data: {} }, itemMetadata: {}, itemEvidence: { observedAt: generatedAt + 3, completeness: "complete", source: "Forever item API capture", data: { sourceSections: { bags: { observedAt: generatedAt + 2, state: "complete" } }, items: [{ itemID: 901, itemString, itemInfoInstant: { api: "C_Item.GetItemInfoInstant", state: "OBSERVED_VALUE", input: { itemString }, returns: [901, "Armor", "Cloth", "INVTYPE_CHEST"].map((value) => ({ observation: factValue(value) })) }, isEquippableItem: { api: "C_Item.IsEquippableItem", state: "OBSERVED_VALUE", returns: [{ observation: factValue(true) }] } }] } } } };
}

function structured<T>(result: { isError?: boolean; structuredContent?: unknown }): T {
  assert.equal(result.isError, undefined);
  assert.notEqual(result.structuredContent, undefined);
  return result.structuredContent as T;
}

function digest(pathname: string): string {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

test("the local STDIO MCP server exposes only bounded read tools over the read-only store", async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "wowsync-mcp-"));
  const databasePath = path.join(temporaryDirectory, "fixture.sqlite");
  const writer = new SqliteSnapshotStore(databasePath);
  try {
    writer.importSnapshot(retail("Virek", "Cairne", true, 100, true, now - 20, 89), {
      currencies: {
        observedAt: now,
        data: {
          listRead: true,
          formatVersion: 1,
          currencies: Array.from({ length: 101 }, (_, index) => ({ currencyID: index + 1, name: `Currency ${index + 1}`, quantity: index, isAccountWide: index === 0 })),
        },
      },
      characterState: recipeState,
    });
    writer.importSnapshot(retail("Virek", "Cairne", true, 500, true, now - 10, 90, 2, true), {
      currencies: {
        observedAt: now - 10,
        data: { listRead: true, formatVersion: 1, currencies: Array.from({ length: 101 }, (_, index) => ({ currencyID: index + 1, name: `Currency ${index + 1}`, quantity: index + 1, isAccountWide: index === 0 })) },
      },
    });
    writer.importSnapshot(retail("Virek", "Thrall"));
    writer.importSnapshot(retail("Zero", "Cairne", false, 0));
    const observedForever = forever("Hallo", "Forever Realm", "Emberstone", "UnitName[2]+GetUnitName suffix");
    writer.importSnapshot(observedForever.text, { foreverGearObservation: observedForever.sidecar });
    writer.importSnapshot(buildWowSyncExport({ character: { name: "Virek", realm: "Era", clientVersion: "1.15.9" }, bank: { unknown: true }, professions: { unknown: true }, bags: { unknown: true } }));
    writer.importSnapshot(readFileSync(new URL("../../core/test/fixtures/sanitized/virek-warband-last-seen-1789965777.wowsync.txt", import.meta.url), "utf8"));
    writer.importSnapshot(readFileSync(new URL("../../core/test/fixtures/derived/ezaller-shared-storage-1789478317.wowsync.txt", import.meta.url), "utf8"));
    // Azeroth ERP Vertical Slice 1: one ACTIVE demand so get_item_allocation has something to resolve.
    writer.createDemand({ baseItemId: 777, requiredQuantity: 1 });
    // Slice 3: a second ACTIVE demand on a full-item-string item so the protocol also carries a RESOLVED result.
    writer.createDemand({ baseItemId: 4242, requiredQuantity: 5 });
    const currencyCharacter = writer.listCharacters("retail").find((character) => character.name === "Virek" && character.realm === "Cairne");
    const otherRealmCharacter = writer.listCharacters("retail").find((character) => character.name === "Virek" && character.realm === "Thrall");
    assert.ok(currencyCharacter);
    assert.ok(otherRealmCharacter);
    const transferAt = Math.floor(Date.now() / 1000);
    writer.importSnapshot(retailItemQuantity("Transfer Source", "Cairne", 3, transferAt - 10, 779));
    writer.importSnapshot(retailItemQuantity("Transfer Destination", "Thrall", 0, transferAt - 10, 779));
    writer.importSnapshot(retailItemQuantity("Transfer Source", "Cairne", 2, transferAt, 779));
    writer.importSnapshot(retailItemQuantity("Transfer Destination", "Thrall", 1, transferAt, 779));
    const transferSource = writer.listCharacters("retail").find((character) => character.name === "Transfer Source");
    const transferDestination = writer.listCharacters("retail").find((character) => character.name === "Transfer Destination");
    assert.ok(transferSource);
    assert.ok(transferDestination);
    writer.createErpProject({ version: "retail", title: "Currency reservation protocol fixture", needs: [{ stableId: "currency_4", kind: "CURRENCY", resourceKey: "4", label: "Currency 4", requiredQuantity: 4, sourceIdentityKey: currencyCharacter.identityKey }] });
    writer.createErpProject({ version: "retail", title: "Same-version source screen protocol fixture", needs: [{ stableId: "source_need", kind: "ITEM_REF", resourceKey: "item:777", label: "Observed Bag Item", requiredQuantity: 1, destinationIdentityKey: otherRealmCharacter.identityKey }, { stableId: "recipe_check", kind: "RECIPE", resourceKey: "1229853", label: "Observed recipe", requiredQuantity: 1, sourceIdentityKey: currencyCharacter.identityKey }], workOrders: [{ stableId: "craft_check", kind: "CRAFT", status: "PLANNED", title: "Craft on assigned character", resourceNeedIds: ["recipe_check"], dependsOn: [], assignedIdentityKey: otherRealmCharacter.identityKey, plannedOutput: { kind: "ITEM_ID", resourceKey: "777", label: "Observed Bag Item", quantity: 1 } }, { stableId: "unspecified_craft", kind: "CRAFT", status: "PLANNED", title: "Craft without recorded prerequisites", resourceNeedIds: [], dependsOn: [], assignedIdentityKey: otherRealmCharacter.identityKey }] });
    writer.importSnapshot(buildWowSyncExport({ generatedAt: Math.floor(Date.now() / 1000), character: { name: "Procurement Buyer", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: "69933", moneyCopper: 500 }, bags: { containers: [{ id: 0, capacity: 20, items: [{ itemRef: "item:12345", name: "Procurement Fixture Item", qty: 2 }] }] }, bank: { containers: [] } }));
    const procurementBuyer = writer.listCharacters("retail").find((character) => character.name === "Procurement Buyer" && character.realm === "Cairne");
    assert.ok(procurementBuyer);
    writer.createErpProject({ version: "retail", title: "Manual procurement protocol fixture", needs: [{ stableId: "procurement_target", kind: "ITEM_REF", resourceKey: "item:12345", label: "Procurement Fixture Item", requiredQuantity: 5, sourceIdentityKey: procurementBuyer.identityKey, destinationIdentityKey: procurementBuyer.identityKey }], workOrders: [{ stableId: "procurement_review", kind: "PURCHASE", status: "PLANNED", title: "Review item gap manually", resourceNeedIds: ["procurement_target"], dependsOn: [], assignedIdentityKey: procurementBuyer.identityKey, procurementPlan: { targetNeedId: "procurement_target", spendingCeilingCopper: 300 } }] });
    writer.createErpProject({ version: "retail", title: "Transfer observation protocol fixture", needs: [{ stableId: "transfer_need", kind: "ITEM_REF", resourceKey: "item:779", label: "Observed Bag Item", requiredQuantity: 1, sourceIdentityKey: transferSource.identityKey, destinationIdentityKey: transferDestination.identityKey }], workOrders: [{ stableId: "transfer_check", kind: "TRANSFER", status: "PLANNED", title: "Review paired source and destination evidence", resourceNeedIds: ["transfer_need"], dependsOn: [], sourceIdentityKey: transferSource.identityKey, destinationIdentityKey: transferDestination.identityKey }] });
    let ownerPlan = writer.createErpProject({ version: "retail", title: "Shared owner protocol fixture", needs: [{ stableId: "warband_leather", kind: "ITEM_REF", resourceKey: "item:2318::::::::85:253:::::::::", label: "Light Leather", requiredQuantity: 3, destinationIdentityKey: currencyCharacter.identityKey, sourceOwnerKey: "retail::warband::local" }], workOrders: [{ stableId: "manual_retrieve", kind: "RETRIEVE", status: "PLANNED", title: "Review storage access manually", resourceNeedIds: ["warband_leather"], dependsOn: [] }] });
    ownerPlan = writer.updateErpProject({ ...ownerPlan, workOrders: ownerPlan.workOrders.map((order) => ({ ...order, status: "WAITING_FOR_EVIDENCE" })) }, ownerPlan.revision)!;
  } finally {
    writer.close();
  }
  const databaseBefore = digest(databasePath);

  const client = new Client({ name: "wowsync-mcp-protocol-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: packageRoot,
    env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "analyze_retail_gear_candidate",
      "get_account_changes",
      "get_account_currencies",
      "get_account_overview",
      "get_allocation_review",
      "get_character_changes",
      "get_character_currencies",
      "get_character_equipment",
      "get_character_history",
      "get_character_professions",
      "get_character_spells",
      "get_character_state",
      "get_character_storage",
      "get_character_summary",
      "get_character_trainer",
      "get_erp_projects",
      "get_forever_gear_allocation",
      "get_forever_gear_observation",
      "get_gear_candidate_evidence",
      "get_gear_candidate_recipient_screen",
      "get_item_allocation",
      "get_item_metadata",
      "get_profession_coverage",
      "get_renown",
      "get_research_document",
      "get_research_section",
      "get_shared_storage",
      "list_characters",
      "list_research_documents",
      "list_versions",
      "search_items",
      "search_research",
    ]);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
    assert.equal(tools.some((tool) => /sql|file|shell|command|account_facts/i.test(tool.name)), false);

    const versions = structured<{ versions: Array<{ version: string }> }>(await client.callTool({ name: "list_versions", arguments: {} }));
    assert.deepEqual(versions.versions.map((entry) => entry.version).sort(), ["classic-era", "forever", "retail"]);
    const emptyErpProjects = structured<{ version: string; projects: unknown[]; returnedCount: number; totalCount: number; truncated: boolean; resourceCommitments: { items: unknown[]; totalCount: number; returnedCount: number; truncated: boolean } }>(await client.callTool({ name: "get_erp_projects", arguments: { version: "forever" } }));
    assert.deepEqual(emptyErpProjects, { version: "forever", projects: [], returnedCount: 0, totalCount: 0, truncated: false, resourceCommitments: { items: [], totalCount: 0, returnedCount: 0, truncated: false, linesWithReservations: 0, unknownSourceLines: 0, overlappingScopeLines: 0 } }, "MCP exposes planning and the shared core commitment view through the bounded read-only contract");
    const retailErpProjects = structured<{ version: string; projects: Array<{ title: string; history: Array<{ revision: number; kind: string; changedFields: string[]; workOrderStatusChanges?: Array<{ workOrderId: string; title: string; fromStatus?: string; toStatus: string }> }>; historyEventCount: number; historyTruncated: boolean; needEvidence: Array<{ state: string; observedQuantity?: number; potentialQuantity?: number; sourceIdentityKey?: string; sourceOwnerKey?: string; sourceSections: Array<{ state: string; observedAt?: number }>; freshness: string }>; resourceSourceScreens: Array<{ candidateCount: number; candidatesTruncated: boolean; candidates: Array<{ sourceIdentityKey: string; observedQuantity?: number; transferability: string; access: string; accountMembership: string }> }>; workOrderReadiness: Array<{ workOrderId: string; procurementAssessment?: { reviewState: string; budgetState: string; budgetEvidence: { observedCopper?: number; freshness: string }; spendingCeilingCopper: number; marketAvailability: string; quotedPrice: string; affordability: string; reason: string }; state: string; capabilityChecks?: Array<{ needId: string; kind: string; state: string; evidenceSourceIdentityKey?: string; assignedIdentityKey?: string }>; linkedNeeds?: Array<{ needId: string; kind: string; state: string; requiredQuantity: number; observedQuantity?: number; potentialQuantity?: number; sourceIdentityKey?: string; freshness: string; unresolvedSections: string[] }> }>; workOrderProgress: Array<{ workOrderId: string; linkedNeedState: string; observationChange: string; reconciliation: string; transferObservationReviews?: Array<{ state: string; interpretation: string; resourceKey: string; source: { identityKey?: string; state: string; comparisons: Array<{ section: string; previousQuantity: number; currentQuantity: number; delta: number }> }; destination: { identityKey?: string; state: string; comparisons: Array<{ section: string; previousQuantity: number; currentQuantity: number; delta: number }> }; reason: string }> }>; workOrders: Array<{ stableId: string; kind: string }> }>; returnedCount: number; totalCount: number; truncated: boolean; resourceCommitments: { items: Array<{ resourceKey: string; kind: string; sourceScope: string; observedQuantity?: number; sourceOwnerKey?: string }>; totalCount: number; returnedCount: number; truncated: boolean } }>(await client.callTool({ name: "get_erp_projects", arguments: { version: "retail" } }));
    const currencyPlan = retailErpProjects.projects.find((entry) => entry.title === "Currency reservation protocol fixture");
    assert.equal(currencyPlan?.needEvidence[0]?.state, "UNKNOWN", "MCP preserves the currency section's LAST_SEEN provenance instead of presenting it as current");
    assert.equal(currencyPlan?.needEvidence[0]?.potentialQuantity, 3);
    assert.equal(currencyPlan?.needEvidence[0]?.sourceIdentityKey, "retail::cairne::virek");
    assert.equal(currencyPlan?.needEvidence[0]?.sourceSections[0]?.state, "LAST_SEEN");
    assert.equal(currencyPlan?.needEvidence[0]?.sourceSections[0]?.observedAt, now);
    assert.equal(currencyPlan?.needEvidence[0]?.freshness, "stale");
    const sharedOwnerPlan = retailErpProjects.projects.find((entry) => entry.title === "Shared owner protocol fixture");
    assert.equal(sharedOwnerPlan?.workOrders[0]?.kind, "RETRIEVE", "MCP exposes the distinct manual retrieval action type");
    assert.equal(sharedOwnerPlan?.needEvidence[0]?.state, "POTENTIAL_COVERAGE_LAST_SEEN");
    assert.equal(sharedOwnerPlan?.needEvidence[0]?.potentialQuantity, 3);
    assert.equal(sharedOwnerPlan?.needEvidence[0]?.sourceOwnerKey, "retail::warband::local");
    assert.deepEqual(sharedOwnerPlan?.history.map((event) => [event.revision, event.kind]), [[2, "UPDATED"], [1, "CREATED"]], "MCP exposes the same project audit timeline as REST through the read-only contract");
    assert.deepEqual(sharedOwnerPlan?.history[0]?.workOrderStatusChanges, [{ workOrderId: "manual_retrieve", title: "Review storage access manually", fromStatus: "PLANNED", toStatus: "WAITING_FOR_EVIDENCE" }]);
    const sharedOwnerProgress = sharedOwnerPlan?.workOrderProgress[0];
    assert.deepEqual(sharedOwnerProgress && (({ transferObservationReviews: _transferReviews, ...base }) => base)(sharedOwnerProgress), { workOrderId: "manual_retrieve", recordedStatus: "WAITING_FOR_EVIDENCE", completionRecorded: false, linkedNeedState: "STALE_OR_UNKNOWN", observationChange: "UNKNOWN", reconciliation: "INSUFFICIENT_EVIDENCE", coveredNeedIds: [], shortfallNeedIds: [], unresolvedNeedIds: ["warband_leather"], allocationConflictNeedIds: [], changedNeedIds: [], reason: "Linked resource evidence is stale, incomplete, unsupported, or unknown for: warband_leather. Refresh or clarify evidence before drawing an outcome." });
    assert.equal(sharedOwnerProgress?.transferObservationReviews, undefined, "retrieval is not interpreted as a character-to-character transfer");
    const sourceScreenPlan = retailErpProjects.projects.find((entry) => entry.title === "Same-version source screen protocol fixture");
    const craftOutputProgress = sourceScreenPlan?.workOrderProgress.find((entry) => entry.workOrderId === "craft_check") as unknown as { plannedOutputAssessment?: { state: string; recipientIdentityKey?: string; observedQuantity?: number; observationChange: string } } | undefined;
    const craftOutputIntent = sourceScreenPlan?.workOrders.find((entry) => entry.stableId === "craft_check") as unknown as { plannedOutput?: { kind: string; resourceKey: string; label: string; quantity: number } } | undefined;
    assert.deepEqual(craftOutputIntent?.plannedOutput, { kind: "ITEM_ID", resourceKey: "777", label: "Observed Bag Item", quantity: 1 }, "MCP preserves player-declared craft output intent");
    assert.equal(craftOutputProgress?.plannedOutputAssessment?.recipientIdentityKey, "retail::thrall::virek");
    assert.equal(craftOutputProgress?.plannedOutputAssessment?.state, "COVERED_BY_OBSERVED");
    assert.equal(craftOutputProgress?.plannedOutputAssessment?.observedQuantity, 2);
    assert.equal(craftOutputProgress?.plannedOutputAssessment?.observationChange, "UNKNOWN", "MCP does not invent a before/after craft outcome");
    assert.equal(sourceScreenPlan?.resourceSourceScreens[0]?.candidates[0]?.sourceIdentityKey, "retail::cairne::virek");
    assert.equal(sourceScreenPlan?.resourceSourceScreens[0]?.candidateCount, 2, "both matching same-version characters are retained as possible sources");
    assert.equal(sourceScreenPlan?.resourceSourceScreens[0]?.candidatesTruncated, false);
    assert.deepEqual([sourceScreenPlan?.resourceSourceScreens[0]?.candidates[0]?.transferability, sourceScreenPlan?.resourceSourceScreens[0]?.candidates[0]?.access, sourceScreenPlan?.resourceSourceScreens[0]?.candidates[0]?.accountMembership], ["UNKNOWN", "UNKNOWN", "UNKNOWN"], "MCP source screening never turns same-version roster co-location into a transfer assertion");
    assert.equal(sourceScreenPlan?.workOrderReadiness[0]?.state, "WAITING_FOR_EVIDENCE");
    assert.deepEqual(sourceScreenPlan?.workOrderReadiness[0]?.capabilityChecks?.map((check) => [check.kind, check.state, check.evidenceSourceIdentityKey, check.assignedIdentityKey]), [["RECIPE", "EVIDENCE_UNKNOWN", "retail::thrall::virek", "retail::thrall::virek"]], "MCP checks the assigned character's own observation and does not substitute the requirement's other source");
    assert.ok(sourceScreenPlan?.needEvidence.some((need) => need.state === "POTENTIAL_COVERAGE_LAST_SEEN" && need.sourceIdentityKey === "retail::cairne::virek" && need.freshness === "stale"), "MCP retains the explicit project need's historical source evidence");
    assert.deepEqual(sourceScreenPlan?.workOrderReadiness[0]?.linkedNeeds?.map((need) => [need.kind, need.state, need.requiredQuantity, need.sourceIdentityKey, need.freshness]), [["RECIPE", "UNKNOWN", 1, "retail::thrall::virek", "unknown"]], "MCP checks the assigned crafter without borrowing the stale recipe observation from another character");
    assert.equal(sourceScreenPlan?.workOrderReadiness[1]?.state, "WAITING_FOR_EVIDENCE", "MCP does not describe a CRAFT step without a linked exact profession or recipe requirement as ready");
    const procurementPlan = retailErpProjects.projects.find((entry) => entry.title === "Manual procurement protocol fixture");
    const procurementReview = procurementPlan?.workOrderReadiness.find((entry) => entry.workOrderId === "procurement_review")?.procurementAssessment as { reviewState: string; budgetState: string; budgetEvidence: { observedCopper?: number; freshness: string }; spendingCeilingCopper: number; marketAvailability: string; quotedPrice: string; affordability: string; reason: string } | undefined;
    assert.deepEqual(procurementReview && [procurementReview.reviewState, procurementReview.budgetState, procurementReview.spendingCeilingCopper], ["OBSERVED_ITEM_GAP", "GROSS_OBSERVED_GOLD_AT_OR_ABOVE_CEILING", 300]);
    assert.deepEqual(procurementReview && [procurementReview.marketAvailability, procurementReview.quotedPrice, procurementReview.affordability], ["UNKNOWN", "UNKNOWN", "UNKNOWN"]);
    assert.match(procurementReview?.reason ?? "", /not a purchase recommendation or action/);
    const transferPlan = retailErpProjects.projects.find((entry) => entry.title === "Transfer observation protocol fixture");
    const transferReview = transferPlan?.workOrderProgress.find((entry) => entry.workOrderId === "transfer_check")?.transferObservationReviews?.[0];
    assert.equal(transferReview?.state, "BOTH_SIDES_CHANGED");
    assert.equal(transferReview?.interpretation, "CAUSE_UNKNOWN");
    assert.equal(transferReview?.source.identityKey, "retail::cairne::transfer source");
    assert.equal(transferReview?.destination.identityKey, "retail::thrall::transfer destination");
    const transferSourceBag = transferReview?.source.comparisons.find((comparison) => comparison.section === "bags" && comparison.delta !== 0);
    const transferDestinationBag = transferReview?.destination.comparisons.find((comparison) => comparison.section === "bags" && comparison.delta !== 0);
    assert.deepEqual(transferSourceBag && [transferSourceBag.previousQuantity, transferSourceBag.currentQuantity, transferSourceBag.delta], [3, 2, -1]);
    assert.deepEqual(transferDestinationBag && [transferDestinationBag.previousQuantity, transferDestinationBag.currentQuantity, transferDestinationBag.delta], [0, 1, 1]);
    assert.match(transferReview?.reason ?? "", /do not establish that the changes are related or that a transfer occurred/);
    assert.equal(retailErpProjects.resourceCommitments.totalCount, 6, "the player-set purchase ceiling is not a resource commitment; MCP exposes the same version-scoped core commitment view as REST");
    assert.ok(retailErpProjects.resourceCommitments.items.some((line) => line.kind === "CURRENCY" && line.resourceKey === "4" && line.sourceScope === "CHARACTER"));
    assert.ok(retailErpProjects.resourceCommitments.items.some((line) => line.resourceKey === "item:2318::::::::85:253:::::::::" && line.sourceScope === "SHARED_OWNER" && line.sourceOwnerKey === "retail::warband::local"));
    assert.equal(retailErpProjects.truncated, false);
    const limitedProjects = structured<{ projects: unknown[]; returnedCount: number; totalCount: number; truncated: boolean }>(await client.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 1 } }));
    assert.deepEqual([limitedProjects.returnedCount, limitedProjects.totalCount, limitedProjects.truncated], [1, 5, true], "MCP callers can bound ERP project results without losing the total count");

    const foreverCharacters = structured<{ characters: Array<{ name: string; surname?: string; surnameSource?: string; realm: string }> }>(await client.callTool({ name: "list_characters", arguments: { version: "forever" } }));
    assert.deepEqual(foreverCharacters.characters.map(({ name, surname, surnameSource }) => [name, surname, surnameSource]), [["Hallo", "Emberstone", "UnitName[2]+GetUnitName suffix"]]);
    const foreverSummary = structured<{ status: string; value?: { data?: { name: string; surname?: string; surnameSource?: string } } }>(await client.callTool({ name: "get_character_summary", arguments: { version: "forever", name: "Hallo", realm: "Forever Realm" } }));
    assert.equal(foreverSummary.value?.data?.name, "Hallo");
    assert.equal(foreverSummary.value?.data?.surname, "Emberstone");
    assert.equal(foreverSummary.value?.data?.surnameSource, "UnitName[2]+GetUnitName suffix");

    const foreverView = structured<{ status: string; value?: { data?: { identity: { version: string; surname?: string }; equipment: { items: Array<{ provenance: string }> }; carried: { items: Array<{ itemRef: string }> }; evaluationCandidates: { state: string; items: Array<{ itemRef: string; eligibility: string; upgradeStatus: string }> }; unknowns: { eligibility: string; transferability: string }; bank: { state: string } }; provenance: { source?: string; freshness?: string } } }>(await client.callTool({ name: "get_forever_gear_observation", arguments: { version: "forever", name: "Hallo", realm: "Forever Realm" } }));
    assert.equal(foreverView.status, "FOUND");
    assert.equal(foreverView.value?.data?.identity.version, "forever");
    assert.equal(foreverView.value?.data?.identity.surname, "Emberstone");
    assert.equal(foreverView.value?.data?.equipment.items[0]?.provenance, "OBSERVED");
    assert.equal(foreverView.value?.data?.carried.items[0]?.itemRef, "item:901:0:0:0:0:0:0:0:123:0:0:0");
    assert.equal(foreverView.value?.data?.evaluationCandidates.state, "LAST_SEEN");
    assert.equal(foreverView.value?.data?.evaluationCandidates.items[0]?.itemRef, "item:901:0:0:0:0:0:0:0:123:0:0:0");
    assert.equal(foreverView.value?.data?.evaluationCandidates.items[0]?.eligibility, "UNKNOWN");
    assert.equal(foreverView.value?.data?.evaluationCandidates.items[0]?.upgradeStatus, "UNKNOWN");
    assert.equal(foreverView.value?.data?.unknowns.eligibility, "UNKNOWN");
    assert.equal(foreverView.value?.data?.unknowns.transferability, "UNKNOWN");
    assert.equal(foreverView.value?.data?.bank.state, "UNKNOWN");
    assert.equal(foreverView.value?.provenance.freshness, "stale");
    const foreverAllocation = structured<{ status: string; value?: { data?: { version: string; conclusion: string; scope: { accountMembership: string }; allocationPlan?: Array<{ disposition: string; item: { itemRef?: string }; recipient: { identityKey: string }; evidence: { transferability: string } }>; assessments: Array<{ eligibility: string; suitability: string; upgradeStatus: string; transferability: string; allocationPriority: string; decision: string }> } } }>(await client.callTool({ name: "get_forever_gear_allocation", arguments: { version: "forever", name: "Hallo", realm: "Forever Realm" } }));
    assert.equal(foreverAllocation.status, "FOUND");
    if (foreverAllocation.value?.data) assertForeverAllocationContract(foreverAllocation.value.data);
    assert.equal(foreverAllocation.value?.data?.version, "forever");
    assert.equal(foreverAllocation.value?.data?.scope.accountMembership, "UNKNOWN");
    assert.equal(foreverAllocation.value?.data?.conclusion, "INSUFFICIENT_EVIDENCE");
    assert.equal(foreverAllocation.value?.data?.assessments[0]?.eligibility, "UNKNOWN");
    assert.equal(foreverAllocation.value?.data?.assessments[0]?.upgradeStatus, "UNKNOWN");
    assert.equal(foreverAllocation.value?.data?.assessments[0]?.transferability, "UNKNOWN");
    assert.equal(foreverAllocation.value?.data?.assessments[0]?.allocationPriority, "UNRANKED");
    assert.equal(foreverAllocation.value?.data?.assessments[0]?.decision, "NO_RECOMMENDATION");
    assert.ok(foreverAllocation.value?.data?.allocationPlan?.length, "MCP exposes the product plan projection");
    assert.ok(foreverAllocation.value?.data?.allocationPlan?.every((entry) => entry.item.itemRef?.startsWith("item:") && entry.recipient.identityKey && (entry.disposition !== "POSSIBLE_OTHER_CHARACTER" || entry.evidence.transferability === "UNKNOWN")));
    assert.equal((await client.callTool({ name: "get_forever_gear_observation", arguments: { name: "Hallo", realm: "Forever Realm" } })).isError, true, "Forever version is explicit and mandatory");

    const candidateRead = structured<{ data?: { selection: string; characters: Array<{ identity: { name: string; identityKey: string }; captured: boolean; snapshot?: { snapshotId: number; freshness: string }; sidecar?: { rows: Array<{ observationState: string; currentCharacterCanUse: { state: string; value?: boolean } }> } }> }; provenance: { state: string; version: string; warning?: string } }>(await client.callTool({ name: "get_gear_candidate_evidence", arguments: { version: "retail" } }));
    assert.equal(candidateRead.provenance.state, "DERIVED");
    assert.equal(candidateRead.provenance.version, "retail");
    assert.match(candidateRead.provenance.warning ?? "", /not necessarily current inventory/);
    const candidateVirek = candidateRead.data?.characters.find((entry) => entry.identity.name === "Virek" && entry.identity.name);
    assert.equal(candidateVirek?.captured, true);
    assert.equal(candidateVirek?.sidecar?.rows[0]?.observationState, "LAST_SEEN");
    assert.equal(candidateVirek?.sidecar?.rows[0]?.currentCharacterCanUse.value, false);
    const candidateZero = candidateRead.data?.characters.find((entry) => entry.identity.name === "Zero");
    assert.equal(candidateZero?.captured, false, "missing sidecar is not an empty candidate list");
    const candidateAllocation = structured<{ status: string; value?: { recommendation: string; candidate: { validity: string }; assessments: unknown[] } }>(await client.callTool({ name: "analyze_retail_gear_candidate", arguments: { version: "retail", exporterIdentityKey: candidateVirek!.identity.identityKey, snapshotId: candidateVirek!.snapshot!.snapshotId, rowOrdinal: 1 } }));
    assert.equal(candidateAllocation.status, "FOUND");
    assert.equal(candidateAllocation.value?.candidate.validity, "UNKNOWN_OR_NOT_ALLOCATABLE", "LAST_SEEN candidate evidence cannot be recommended as a current candidate");
    assert.equal(candidateAllocation.value?.recommendation, "UNKNOWN");
    const unsupportedCandidates = structured<{ data?: unknown; provenance: { state: string; reason?: string } }>(await client.callTool({ name: "get_gear_candidate_evidence", arguments: { version: "classic-era" } }));
    assert.equal(unsupportedCandidates.provenance.state, "UNKNOWN");
    assert.match(unsupportedCandidates.provenance.reason ?? "", /Retail-only/);
    assert.equal(unsupportedCandidates.data, undefined);
    assert.equal((await client.callTool({ name: "get_gear_candidate_evidence", arguments: {} })).isError, true, "version is required");

    const registeredRecipientScreen = tools.find((tool) => tool.name === "get_gear_candidate_recipient_screen")!;
    assert.deepEqual(registeredRecipientScreen.annotations, { readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    assert.match(registeredRecipientScreen.description ?? "", /native armor-family plausibility/);
    assert.match(registeredRecipientScreen.description ?? "", /class-level weapon proficiency\/access/);
    assert.match(registeredRecipientScreen.description ?? "", /specialization-dependent/);
    assert.match(registeredRecipientScreen.description ?? "", /specialization suitability/);
    assert.match(registeredRecipientScreen.description ?? "", /do not prove.*technically forbids/i);
    assert.match(registeredRecipientScreen.description ?? "", /positive results do not mean CanEquip/i);
    const schema = registeredRecipientScreen.inputSchema as { required?: string[]; additionalProperties?: boolean; properties?: Record<string, { const?: string; enum?: string[]; maximum?: number; minimum?: number }> };
    assert.deepEqual(schema.required?.sort(), ["exporterName", "exporterRealm", "recipientName", "recipientRealm", "version"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties?.version?.const, "retail");
    assert.equal(schema.properties?.limit?.maximum, 100);
    const recipientScreen = structured<{ status: string; value?: { data?: { accountMembership: string; accountMembershipCaveat: string; uncheckedRestrictions: string; recipientClass: { evidence: { state: string; value?: string; normalizedClass?: string; sectionState: string }; snapshot?: { snapshotId: number } }; candidateEvidence: { captured: boolean; rows?: Array<{ result: string; reason: string; observationState: string; armorCheck: { state: string; candidateFamily?: string; recipientNativeFamily?: string }; weaponProficiencyCheck: { state: string; candidateFamily?: string } }> }; recipientLevel: { evidence: { state: string }; snapshot?: { snapshotId: number } } }; provenance: { state: string; snapshotId?: number; derivedFrom?: string[]; warning?: string } } }>(await client.callTool({ name: "get_gear_candidate_recipient_screen", arguments: { version: "retail", exporterName: "Virek", exporterRealm: "Cairne", recipientName: "Zero", recipientRealm: "Cairne" } }));
    assert.equal(recipientScreen.status, "FOUND");
    assert.equal(recipientScreen.value?.data?.candidateEvidence.captured, true);
    assert.equal(recipientScreen.value?.data?.candidateEvidence.rows?.[0]?.result, "NOT_RULED_OUT_BY_CHECKED_RULES", "exporter's currentCharacterCanUse=false does not rule out the selected recipient");
    assert.equal(recipientScreen.value?.data?.candidateEvidence.rows?.[0]?.observationState, "LAST_SEEN");
    assert.equal(recipientScreen.value?.data?.recipientLevel.evidence.state, "KNOWN");
    assert.deepEqual(recipientScreen.value?.data?.recipientClass.evidence, { state: "KNOWN", value: "Warrior", normalizedClass: "WARRIOR", sectionState: "OBSERVED" });
    assert.equal(recipientScreen.value?.data?.recipientClass.snapshot?.snapshotId, recipientScreen.value?.data?.recipientLevel.snapshot?.snapshotId);
    assert.equal(recipientScreen.value?.data?.candidateEvidence.rows?.[0]?.armorCheck.state, "PASS");
    assert.equal(recipientScreen.value?.data?.candidateEvidence.rows?.[0]?.armorCheck.candidateFamily, "Plate");
    assert.equal(recipientScreen.value?.data?.candidateEvidence.rows?.[0]?.weaponProficiencyCheck.state, "NOT_APPLICABLE");
    assert.equal(recipientScreen.value?.data?.accountMembership, "NOT_ESTABLISHED_BY_DASHBOARD_IDENTITY");
    assert.match(recipientScreen.value?.data?.accountMembershipCaveat ?? "", /does not establish/);
    assert.match(recipientScreen.value?.data?.uncheckedRestrictions ?? "", /native armor-family plausibility/);
    assert.match(recipientScreen.value?.data?.uncheckedRestrictions ?? "", /class-level weapon proficiency\/access/);
    assert.match(recipientScreen.value?.data?.uncheckedRestrictions ?? "", /Weapon PASS does not establish specialization suitability/);
    assert.match(recipientScreen.value?.data?.uncheckedRestrictions ?? "", /do not establish CanEquip/);
    assert.match(recipientScreen.value?.data?.uncheckedRestrictions ?? "", /transferability/);
    assert.match(recipientScreen.value?.data?.uncheckedRestrictions ?? "", /allocation/);
    assert.equal(recipientScreen.value?.provenance.state, "DERIVED");
    assert.ok(recipientScreen.value?.provenance.snapshotId);
    assert.ok((recipientScreen.value?.provenance.derivedFrom?.length ?? 0) >= 2);
    assert.equal((await client.callTool({ name: "get_gear_candidate_recipient_screen", arguments: { version: "classic-era", exporterName: "Virek", exporterRealm: "Cairne", recipientName: "Zero", recipientRealm: "Cairne" } })).isError, true, "tool schema allows Retail only");
    assert.equal((await client.callTool({ name: "get_gear_candidate_recipient_screen", arguments: { version: "retail", exporterName: "Virek", exporterRealm: "Cairne", recipientName: "Zero", recipientRealm: "Cairne", extra: true } })).isError, true, "strict tool schema rejects unlisted fields");
    assert.equal((await client.callTool({ name: "get_gear_candidate_recipient_screen", arguments: { version: "retail", exporterName: "Virek", exporterRealm: "Cairne", recipientName: "Zero" } })).isError, true, "recipient realm is required");
    const unavailableScreen = structured<{ status: string; value?: { data?: { candidateEvidence: { captured: boolean; rows?: unknown[]; reason?: string } } } }>(await client.callTool({ name: "get_gear_candidate_recipient_screen", arguments: { version: "retail", exporterName: "Zero", exporterRealm: "Cairne", recipientName: "Virek", recipientRealm: "Cairne" } }));
    assert.equal(unavailableScreen.value?.data?.candidateEvidence.captured, false);
    assert.equal(unavailableScreen.value?.data?.candidateEvidence.rows, undefined);
    assert.match(unavailableScreen.value?.data?.candidateEvidence.reason ?? "", /unavailable, not an empty/);

    const listed = structured<{ version: string; totalCount: number; truncated: boolean }>(await client.callTool({ name: "list_characters", arguments: { version: "retail" } }));
    assert.equal(listed.version, "retail");
    assert.equal(listed.totalCount, 7);
    assert.equal(listed.truncated, false);

    const summary = structured<{ status: string; value?: { provenance: { state: string; version: string } } }>(await client.callTool({ name: "get_character_summary", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(summary.status, "FOUND");
    assert.equal(summary.value?.provenance.state, "OBSERVED");
    assert.equal(summary.value?.provenance.version, "retail");

    const currentState = structured<{ status: string; value?: { data?: { identity: { version: string }; bank: { state: string; provenance: { warning?: string } }; bags: { state: string }; professions: { state: string; entries?: unknown[] }; currencies: { state: string } } } }>(await client.callTool({ name: "get_character_state", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(currentState.status, "FOUND");
    assert.equal(currentState.value?.data?.identity.version, "retail");
    assert.equal(currentState.value?.data?.bags.state, "OBSERVED");
    assert.equal(currentState.value?.data?.bank.state, "LAST_SEEN");
    assert.match(currentState.value?.data?.bank.provenance.warning ?? "", /Historical/);
    assert.equal(currentState.value?.data?.professions.entries?.length, 2);
    assert.ok(["OBSERVED", "LAST_SEEN"].includes(currentState.value?.data?.currencies.state ?? ""));

    const spells = structured<{ status: string; value?: { data?: { sectionState: string; coverage?: string; spells?: { items: Array<{ spellID?: string; name?: string }>; totalCount: number; truncated: boolean }; snapshot?: { snapshotId: number } }; provenance: { state: string; freshness?: string } } }>(await client.callTool({ name: "get_character_spells", arguments: { version: "retail", name: "Virek", realm: "Cairne", query: "Protocol", limit: 1 } }));
    assert.equal(spells.status, "FOUND");
    assert.equal(spells.value?.provenance.state, "OBSERVED");
    assert.match(spells.value?.data?.coverage ?? "", /player spellbook/);
    assert.equal(spells.value?.data?.spells?.items[0]?.name, "Protocol Spell");
    assert.equal(spells.value?.data?.spells?.truncated, false);
    const trainer = structured<{ status: string; value?: { data?: { sectionState: string; services: Array<{ ability?: string; statusAtVisit?: string }>; categories: Array<{ trainerName?: string; statusCounts: { known: number; available: number } }> }; provenance: { state: string } } }>(await client.callTool({ name: "get_character_trainer", arguments: { version: "retail", name: "Virek", realm: "Cairne", status: "available" } }));
    assert.equal(trainer.status, "FOUND");
    assert.equal(trainer.value?.data?.services[0]?.ability, "Available Spell");
    assert.equal(trainer.value?.data?.services[0]?.statusAtVisit, "available");
    assert.equal(trainer.value?.data?.categories[0]?.trainerName, "Protocol Trainer");
    const selectedTrainer = await client.callTool({ name: "get_character_trainer", arguments: { version: "retail", name: "Virek", realm: "Cairne", snapshotId: spells.value?.data?.snapshot?.snapshotId } });
    assert.equal(selectedTrainer.isError, undefined);
    const wrongCharacterSnapshot = await client.callTool({ name: "get_character_spells", arguments: { version: "retail", name: "Zero", realm: "Cairne", snapshotId: spells.value?.data?.snapshot?.snapshotId } });
    assert.equal(wrongCharacterSnapshot.isError, true);

    const history = structured<{ status: string; value?: { data?: { items: Array<{ snapshotId: number; level: number }>; totalCount: number; truncated: boolean } } }>(await client.callTool({ name: "get_character_history", arguments: { version: "retail", name: "Virek", realm: "Cairne", limit: 1 } }));
    assert.equal(history.status, "FOUND");
    assert.equal(history.value?.data?.totalCount, 3);
    assert.equal(history.value?.data?.items.length, 1);
    assert.equal(history.value?.data?.truncated, true);
    const changes = structured<{ status: string; value?: { data?: { fromSnapshot?: { snapshotId: number }; toSnapshot?: { snapshotId: number }; changes?: { economy: { goldCopper: { delta?: number } }; progression: { level: { delta?: number } }; bank: { state: string; itemChanges: { items: unknown[] } } } } } }>(await client.callTool({ name: "get_character_changes", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(changes.status, "FOUND");
    assert.ok((changes.value?.data?.toSnapshot?.snapshotId ?? 0) > (changes.value?.data?.fromSnapshot?.snapshotId ?? 0));
    assert.equal(changes.value?.data?.changes?.economy.goldCopper.delta, 400);
    assert.equal(changes.value?.data?.changes?.progression.level.delta, 1);
    assert.equal(changes.value?.data?.changes?.bank.state, "LAST_SEEN");
    assert.deepEqual(changes.value?.data?.changes?.bank.itemChanges.items, []);
    const explicitChanges = await client.callTool({ name: "get_character_changes", arguments: { version: "retail", name: "Virek", realm: "Cairne", fromSnapshotId: changes.value!.data!.fromSnapshot!.snapshotId, toSnapshotId: changes.value!.data!.toSnapshot!.snapshotId } });
    assert.equal(structured<{ status: string }>(explicitChanges).status, "FOUND");
    const crossCharacter = await client.callTool({ name: "get_character_changes", arguments: { version: "retail", name: "Zero", realm: "Cairne", fromSnapshotId: changes.value!.data!.fromSnapshot!.snapshotId, toSnapshotId: changes.value!.data!.toSnapshot!.snapshotId } });
    assert.equal(crossCharacter.isError, true);
    const oneExplicitId = await client.callTool({ name: "get_character_changes", arguments: { version: "retail", name: "Virek", realm: "Cairne", fromSnapshotId: changes.value!.data!.fromSnapshot!.snapshotId } });
    assert.equal(oneExplicitId.isError, true);
    const excessiveHistoryLimit = await client.callTool({ name: "get_character_history", arguments: { version: "retail", name: "Virek", realm: "Cairne", limit: 101 } });
    assert.equal(excessiveHistoryLimit.isError, true);

    const accountOverview = structured<{ data?: { version: string; aggregationScope: string; gold: { totalKnownCopper?: number; charactersWithKnownGold: number; charactersWithUnknownGold: number }; storageCoverage: { sharedStorage: { guilds: { owners: unknown[] } } }; currencies: { returnedCount: number; truncated: boolean } }; provenance: { state: string; version: string } }>(await client.callTool({ name: "get_account_overview", arguments: { version: "retail" } }));
    assert.equal(accountOverview.provenance.state, "DERIVED");
    assert.equal(accountOverview.data?.version, "retail");
    assert.equal(accountOverview.data?.aggregationScope, "account-wide");
    assert.ok((accountOverview.data?.gold.charactersWithKnownGold ?? 0) >= 1);
    assert.ok((accountOverview.data?.gold.charactersWithUnknownGold ?? 0) >= 1);
    assert.ok((accountOverview.data?.gold.totalKnownCopper ?? 0) > 0);
    const knownZero = structured<{ status: string; value?: { data?: { gold: { copper?: number; provenance: { state: string } } } } }>(await client.callTool({ name: "get_character_state", arguments: { version: "retail", name: "Zero", realm: "Cairne" } }));
    assert.equal(knownZero.value?.data?.gold.copper, 0);
    assert.equal(knownZero.value?.data?.gold.provenance.state, "OBSERVED");
    const unknownState = structured<{ status: string; value?: { data?: { bank: { state: string }; professions: { state: string }; currencies: { state: string }; playtime: { playedSeconds?: number } } } }>(await client.callTool({ name: "get_character_state", arguments: { version: "classic-era", name: "Virek", realm: "Era" } }));
    assert.equal(unknownState.value?.data?.bank.state, "UNKNOWN");
    assert.equal(unknownState.value?.data?.professions.state, "UNKNOWN");
    assert.equal(unknownState.value?.data?.currencies.state, "UNKNOWN");
    assert.equal(unknownState.value?.data?.playtime.playedSeconds, undefined);
    assert.equal(accountOverview.data?.storageCoverage.sharedStorage.guilds.owners.length, 1);
    assert.equal(accountOverview.data?.currencies.returnedCount, 20);
    const detailedCurrencies = structured<{ data?: { aggregationScope: string; coverage: { unknownCharacters: number }; currencies: { items: Array<{ currencyID: number; scope: string; account?: { quantity?: number | null } | null; characterTotalCount: number; charactersTruncated: boolean }> } }; provenance: { state: string } }>(await client.callTool({ name: "get_account_currencies", arguments: { version: "retail", currencyID: 1, characterLimit: 1 } }));
    assert.equal(detailedCurrencies.data?.aggregationScope, "account-wide");
    assert.equal(detailedCurrencies.data?.currencies.items[0]?.scope, "ACCOUNT");
    assert.equal(detailedCurrencies.data?.currencies.items[0]?.account?.quantity, 0, "an observed account-wide zero is preserved and not summed with other characters");
    assert.equal(detailedCurrencies.data?.currencies.items[0]?.characterTotalCount, 7);
    assert.equal(detailedCurrencies.data?.currencies.items[0]?.charactersTruncated, true);
    assert.equal(detailedCurrencies.provenance.state, "DERIVED");
    const realmCurrencyWithoutRealm = await client.callTool({ name: "get_account_currencies", arguments: { version: "classic-era" } });
    assert.equal(realmCurrencyWithoutRealm.isError, true);
    const realmCurrencies = structured<{ data?: { aggregationScope: string; realm?: string; coverage: { totalCharacters: number } } }>(await client.callTool({ name: "get_account_currencies", arguments: { version: "classic-era", realm: "Era" } }));
    assert.equal(realmCurrencies.data?.aggregationScope, "realm");
    assert.equal(realmCurrencies.data?.realm, "Era");
    const accountChanges = structured<{ data?: { items: Array<{ realm: string }>; totalCount: number; truncated: boolean } }>(await client.callTool({ name: "get_account_changes", arguments: { version: "retail", limit: 1 } }));
    assert.ok((accountChanges.data?.totalCount ?? 0) > 0);
    assert.equal(accountChanges.data?.items.length, 1);
    assert.equal(accountChanges.data?.items[0]?.realm, "Cairne");
    assert.equal(accountChanges.data?.truncated, true, "additional paired-transfer fixture changes remain visible through the existing bounded account-change contract");
    assert.equal(accountOverview.data?.currencies.truncated, true);
    const eraOverview = structured<{ data?: { version: string; aggregationScope: string; gold: Array<{ realm: string; gold: { totalKnownCopper?: number } }>; playtime: Array<{ realm: string; playtime: { totalKnownPlayedSeconds?: number } }>; currencies: { scope: string; byRealm?: Array<{ realm: string; coverage: { unknownCharacters: number } }> } } }>(await client.callTool({ name: "get_account_overview", arguments: { version: "classic-era" } }));
    assert.equal(eraOverview.data?.version, "classic-era");
    assert.equal(eraOverview.data?.aggregationScope, "realm");
    assert.ok(Array.isArray(eraOverview.data?.gold));
    assert.equal(eraOverview.data?.gold[0]?.gold.totalKnownCopper, undefined);
    assert.equal(eraOverview.data?.playtime[0]?.playtime.totalKnownPlayedSeconds, undefined);
    assert.equal(eraOverview.data?.currencies.scope, "realm");
    assert.ok((eraOverview.data?.currencies.byRealm?.[0]?.coverage.unknownCharacters ?? 0) > 0);

    const equipment = structured<{ status: string; value?: { provenance: { state: string } } }>(await client.callTool({ name: "get_character_equipment", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(equipment.status, "FOUND");
    assert.equal(equipment.value?.provenance.state, "OBSERVED");
    const professions = structured<{ status: string; value?: { provenance: { state: string } } }>(await client.callTool({ name: "get_character_professions", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(professions.status, "FOUND");
    assert.equal(professions.value?.provenance.state, "OBSERVED");
    const professionRecipeRead = professions.value as { data?: { recipeKnowledge?: { status: { state: string }; data: { professions: Array<{ recipes: Array<{ recipeID: number; learnedState: string }> }> } } } };
    assert.equal(professionRecipeRead.data?.recipeKnowledge?.status.state, "LAST_SEEN", "the newer export lacked recipe data; previous proof remains historical");
    assert.deepEqual(professionRecipeRead.data?.recipeKnowledge?.data.professions[0].recipes.map((recipe) => [recipe.recipeID, recipe.learnedState]), [[1229853, "OBSERVED_TRUE"]]);

    const ambiguity = structured<{ status: string; candidates?: Array<{ realm: string }> }>(await client.callTool({ name: "get_character_summary", arguments: { version: "retail", name: "Virek" } }));
    assert.equal(ambiguity.status, "AMBIGUOUS");
    assert.deepEqual(ambiguity.candidates?.map((candidate) => candidate.realm).sort(), ["Cairne", "Thrall"]);

    const wrongVersion = structured<{ status: string }>(await client.callTool({ name: "get_character_summary", arguments: { version: "classic-era", name: "Virek", realm: "Cairne" } }));
    assert.equal(wrongVersion.status, "NOT_FOUND");

    const bag = structured<{ status: string; value?: { data?: { items?: Array<{ name: string }>; metadata?: Array<{ state: string }> }; provenance: { state: string } } }>(await client.callTool({ name: "get_character_storage", arguments: { version: "retail", name: "Virek", realm: "Cairne", storage: "bags" } }));
    assert.equal(bag.status, "FOUND");
    assert.equal(bag.value?.data?.items?.[0]?.name, "Observed Bag Item");
    assert.equal(bag.value?.data?.metadata?.[0]?.state, "KNOWN");
    const bank = structured<{ status: string; value?: { data?: { items?: Array<{ name: string }> }; provenance: { state: string } } }>(await client.callTool({ name: "get_character_storage", arguments: { version: "retail", name: "Virek", realm: "Cairne", storage: "bank" } }));
    assert.equal(bank.status, "FOUND");
    assert.equal(bank.value?.data?.items?.[0]?.name, "Observed Bank Item");
    const itemSearch = structured<{ data?: { items: Array<{ item: { name: string } }> }; provenance: { version: string } }>(await client.callTool({ name: "search_items", arguments: { version: "retail", query: "Observed Bag Item", limit: 1 } }));
    assert.equal(itemSearch.data?.items[0]?.item.name, "Observed Bag Item");
    assert.equal(itemSearch.provenance.version, "retail");
    const crossVersionSearch = structured<{ data?: { totalCount: number } }>(await client.callTool({ name: "search_items", arguments: { version: "classic-era", query: "Observed Bag Item" } }));
    assert.equal(crossVersionSearch.data?.totalCount, 0);
    const itemMetadata = structured<{ data?: Array<{ baseItemId: number; state: string; metadata?: { expansionId: { state: string }; craftingReagent: { state: string } } }> }>(await client.callTool({ name: "get_item_metadata", arguments: { version: "retail", itemIds: [777, 99999] } }));
    assert.deepEqual(itemMetadata.data?.map((item) => item.state), ["KNOWN", "UNKNOWN"]);
    assert.equal(itemMetadata.data?.[0]?.metadata?.expansionId.state, "KNOWN");
    assert.equal(itemMetadata.data?.[0]?.metadata?.craftingReagent.state, "KNOWN");

    // Azeroth ERP Vertical Slice 1: get_item_allocation evaluates the ACTIVE demand created above against
    // real character-storage evidence, delegates entirely to DashboardReadModel (no arithmetic in the
    // tool body), and a missing demand is structurally distinct from a resolved one.
    // Slice 3: this fixture captures item 777 only as a bare `item:777` (no hyperlink), so base-item
    // aggregation is not proven: BASE_ITEM_AGGREGATION_UNPROVEN, with no allocation numbers at all.
    const allocation = structured<{ data?: Record<string, unknown> & { resolution: string; disposition: string; confirmedQuantity?: number; confirmedItemStringIdentity?: { class: string }; reasons: Array<{ code: string }> }; provenance: { state: string } }>(
      await client.callTool({ name: "get_item_allocation", arguments: { version: "retail", baseItemId: 777 } }),
    );
    assert.equal(allocation.provenance.state, "DERIVED");
    assert.equal(allocation.data?.resolution, "BASE_ITEM_AGGREGATION_UNPROVEN");
    assert.equal(allocation.data?.disposition, "REQUIRES_REVIEW");
    assert.equal(allocation.data?.confirmedItemStringIdentity?.class, "ITEM_STRING_INCOMPLETE");
    assert.ok((allocation.data?.confirmedQuantity ?? 0) >= 2, "at least one character's OBSERVED bags item 777 is still reported as confirmed quantity");
    for (const field of ["allocated", "confirmedDeficit", "confirmedSurplus"]) assert.ok(allocation.data && !(field in allocation.data), `${field} is structurally absent`);
    assert.ok(allocation.data?.reasons.some((r) => r.code === "EXPLICIT_DEMAND_EXISTS"));
    // Slice 3: the full-item-string, bound=no item 4242 (3 in OBSERVED bags on each of three Retail
    // characters, demand 5) passes through the same tool as an ordinary RESOLVED result.
    const resolved = structured<{ data?: Record<string, unknown> & { resolution: string; disposition: string; confirmedAvailable?: number; allocated?: number; confirmedDeficit?: number; confirmedSurplus?: number; hasUnresolvedEvidence?: boolean; confirmedItemStringIdentity?: { class: string }; potentialItemStringIdentity?: { class: string }; confirmedBinding?: Record<string, number>; potentialBinding?: Record<string, number>; reasons: Array<{ code: string }> } }>(
      await client.callTool({ name: "get_item_allocation", arguments: { version: "retail", baseItemId: 4242 } }),
    );
    assert.equal(resolved.data?.resolution, "RESOLVED");
    assert.deepEqual([resolved.data?.confirmedAvailable, resolved.data?.allocated, resolved.data?.confirmedDeficit, resolved.data?.confirmedSurplus], [9, 5, 0, 4]);
    assert.equal(resolved.data?.hasUnresolvedEvidence, false);
    assert.equal(resolved.data?.disposition, "SEND_HELLOMAGS");
    assert.ok(resolved.data?.reasons.some((r) => r.code === "SALE_PIPELINE_APPROVED"));
    assert.equal(resolved.data?.confirmedItemStringIdentity?.class, "UNIFORM_ITEM_STRING");
    assert.equal(resolved.data?.potentialItemStringIdentity?.class, "NONE_HELD");
    assert.deepEqual(resolved.data?.confirmedBinding, { boundRowCount: 0, unboundRowCount: 3, unknownRowCount: 0 });
    assert.deepEqual(resolved.data?.potentialBinding, { boundRowCount: 0, unboundRowCount: 0, unknownRowCount: 0 });
    const noActiveDemand = structured<{ data?: { resolution: string } }>(
      await client.callTool({ name: "get_item_allocation", arguments: { version: "retail", baseItemId: 999999999 } }),
    );
    assert.equal(noActiveDemand.data?.resolution, "NO_ACTIVE_DEMAND", "no demand was created for this item; it must never read as resolved zero-surplus");
    assert.ok(noActiveDemand.data && !("confirmedSurplus" in noActiveDemand.data));

    // Azeroth ERP Vertical Slice 2: get_allocation_review partitions the account into the demanded items
    // (777 and 4242, each identical to its get_item_allocation result) and unallocated holdings that carry no surplus or
    // disposition at all. Delegates entirely to DashboardReadModel; the database digest check below proves
    // the call wrote nothing.
    const allocationReview = structured<{ data?: { demanded: { items: Array<{ commodity: { baseItemId: number } }>; totalCount: number }; unallocated: { items: Array<Record<string, unknown> & { baseItemId: number }>; totalCount: number; limit: number }; dispositionCounts: Record<string, number>; itemNames: Record<string, string> }; provenance: { state: string } }>(
      await client.callTool({ name: "get_allocation_review", arguments: { version: "retail", unallocatedLimit: 100 } }),
    );
    assert.equal(allocationReview.provenance.state, "DERIVED");
    // REQUIRES_REVIEW (777, aggregation unproven) sorts before SEND_HELLOMAGS (4242); both pass through unchanged.
    assert.deepEqual(allocationReview.data?.demanded.items.map((r) => r.commodity.baseItemId), [777, 4242]);
    assert.deepEqual(allocationReview.data?.demanded.items[0], allocation.data);
    assert.deepEqual(allocationReview.data?.demanded.items[1], resolved.data);
    // Dashboard Allocation tab milestone: the demanded page carries an itemNames presentation sidecar (observed
    // account-owned evidence names), outside every AllocationResult (the deep-equals above still hold).
    assert.deepEqual(allocationReview.data?.itemNames, { "777": "Observed Bag Item", "4242": "Observed Full-String Item" });
    assert.ok(allocationReview.data?.demanded.items.every((r) => !("name" in r)));
    const pagedNames = structured<{ data?: { itemNames: Record<string, string> } }>(await client.callTool({ name: "get_allocation_review", arguments: { version: "retail", demandedLimit: 1 } }));
    assert.deepEqual(pagedNames.data?.itemNames, { "777": "Observed Bag Item" }, "names cover only the returned demanded page");
    // The Dashboard-only unallocated search is not part of the MCP contract: the strict schema rejects it.
    const searchReview = await client.callTool({ name: "get_allocation_review", arguments: { version: "retail", q: "observed" } });
    assert.equal(searchReview.isError, true);
    const unallocatedIds = allocationReview.data?.unallocated.items.map((entry) => entry.baseItemId) ?? [];
    assert.ok(!unallocatedIds.includes(777), "a demanded item is never also unallocated");
    assert.ok(unallocatedIds.includes(888), "held bank inventory with no demand is listed as unallocated");
    assert.ok(allocationReview.data?.unallocated.items.every((entry) => entry.allocationState === "UNALLOCATED" && !("disposition" in entry) && !("confirmedSurplus" in entry) && !("surplus" in entry)));
    assert.ok(allocationReview.data?.unallocated.items.every((entry) => ["confirmedItemStringIdentity", "potentialItemStringIdentity", "confirmedBinding", "potentialBinding"].every((facet) => facet in entry)), "Slice 3 facets are reported on every unallocated entry");
    assert.ok(allocationReview.data && "unallocatedItemStringIdentityCounts" in allocationReview.data);
    const eraReview = structured<{ data?: unknown; provenance: { state: string } }>(await client.callTool({ name: "get_allocation_review", arguments: { version: "classic-era" } }));
    assert.equal(eraReview.provenance.state, "UNKNOWN");
    assert.equal(eraReview.data, undefined);
    const overLimitReview = await client.callTool({ name: "get_allocation_review", arguments: { version: "retail", unallocatedLimit: 101 } });
    assert.equal(overLimitReview.isError, true);
    const versionlessReview = await client.callTool({ name: "get_allocation_review", arguments: {} });
    assert.equal(versionlessReview.isError, true);

    const warband = structured<{ data?: { owners: Array<{ owner: { kind: string }; current?: { liveAtExport: boolean; provenance: { sources: Array<{ carrierState: string }> } | { } | undefined; content: { items: unknown[] } } }> }; provenance: { state: string } }>(await client.callTool({ name: "get_shared_storage", arguments: { version: "retail", kind: "warband", limit: 1 } }));
    assert.equal(warband.provenance.state, "DERIVED");
    assert.equal(warband.data?.owners[0]?.owner.kind, "warband");
    assert.equal(warband.data?.owners[0]?.current?.liveAtExport, false);
    const guild = structured<{ data?: { owners: Array<{ owner: { kind: string; guildClubId?: string }; current?: { coverage: { inaccessibleTabs: number[] }; provenance: { sources: Array<{ carrierState: string }> } } }> } }>(await client.callTool({ name: "get_shared_storage", arguments: { version: "retail", kind: "guild", limit: 1 } }));
    assert.equal(guild.data?.owners[0]?.owner.kind, "guild");
    assert.equal(typeof guild.data?.owners[0]?.owner.guildClubId, "string");
    assert.deepEqual(guild.data?.owners[0]?.current?.coverage.inaccessibleTabs, [3]);
    assert.equal(guild.data?.owners[0]?.current?.provenance.sources[0]?.carrierState, "OBSERVED");

    const coverage = structured<{ provenance: { state: string; derivedFrom?: string[] } }>(await client.callTool({ name: "get_profession_coverage", arguments: { version: "retail" } }));
    assert.equal(coverage.provenance.state, "DERIVED");
    assert.ok(coverage.provenance.derivedFrom?.length);

    const renown = structured<{ status: string; value?: { provenance: { state: string; reason?: string } } }>(await client.callTool({ name: "get_renown", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(renown.status, "FOUND");
    assert.equal(renown.value?.provenance.state, "UNKNOWN");
    assert.match(renown.value?.provenance.reason ?? "", /does not currently capture Renown/);

    const currencies = structured<{ status: string; value?: { returnedCount?: number; totalCount?: number; truncated?: boolean; data?: { currencies?: unknown[] } } }>(await client.callTool({ name: "get_character_currencies", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(currencies.status, "FOUND");
    assert.equal(currencies.value?.returnedCount, 100);
    assert.equal(currencies.value?.totalCount, 101);
    assert.equal(currencies.value?.truncated, true);
    assert.equal(currencies.value?.data?.currencies?.length, 100);

    const documents = structured<{ documents: Array<{ documentId: string; sections: Array<{ sectionId: string; heading: string }>; sectionsTotal: number; sectionsTruncated: boolean }> }>(await client.callTool({ name: "list_research_documents", arguments: { version: "retail" } }));
    assert.ok(documents.documents.length > 0);
    assert.ok(documents.documents[0]!.sections.length > 0);
    assert.equal(documents.documents[0]!.sectionsTruncated, false);
    assert.equal("markdown" in documents.documents[0]!, false);
    const researchDocument = structured<{ document: { documentId: string; contentHash: string }; markdown: string; returnedCharacters: number; totalCharacters: number; truncated: boolean; source: string }>(await client.callTool({ name: "get_research_document", arguments: { documentId: "midnight-12-1-renown" } }));
    assert.equal(researchDocument.document.documentId, "midnight-12-1-renown");
    assert.match(researchDocument.document.contentHash, /^sha256:/);
    assert.equal(researchDocument.source, "registered research document");
    assert.ok(researchDocument.returnedCharacters <= 40_000);
    assert.equal(researchDocument.truncated, false);
    const unregisteredDocument = await client.callTool({ name: "get_research_document", arguments: { documentId: "outside-root" } });
    assert.equal(unregisteredDocument.isError, true);
    assert.match(JSON.stringify(unregisteredDocument.structuredContent), /RESEARCH_DOCUMENT_NOT_FOUND/);

    const search = structured<{ matches: Array<{ document: { documentId: string }; section: { sectionId: string }; citations: unknown[] }> }>(await client.callTool({ name: "search_research", arguments: { query: "Ritual Sites", version: "retail", patch: "12.1.x" } }));
    assert.ok(search.matches.length > 0 && search.matches.length <= 5);
    assert.equal(search.matches[0]?.document.documentId, "midnight-12-1-renown");
    assert.ok(search.matches.some((match) => match.citations.length > 0));

    const first = search.matches[0];
    assert.ok(first);
    const section = structured<{ document: { documentId: string }; section: { sectionId: string; citations: unknown[] }; truncated: boolean }>(await client.callTool({ name: "get_research_section", arguments: { documentId: first.document.documentId, sectionId: first.section.sectionId } }));
    assert.equal(section.document.documentId, "midnight-12-1-renown");
    assert.equal(section.section.sectionId, first.section.sectionId);
    assert.ok(section.section.citations.length > 0);
    assert.equal(typeof section.truncated, "boolean");

    const invalid = await client.callTool({ name: "get_research_section", arguments: { documentId: "outside-root", sectionId: "missing" } });
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid.structuredContent), /RESEARCH_SECTION_NOT_FOUND/);
    const escapedPath = await client.callTool({ name: "get_research_section", arguments: { documentId: "../outside", sectionId: "missing" } });
    assert.equal(escapedPath.isError, true);

    const missingVersion = await client.callTool({ name: "list_characters", arguments: {} });
    assert.equal(missingVersion.isError, true);
    const excessiveLimit = await client.callTool({ name: "list_characters", arguments: { version: "retail", limit: 101 } });
    assert.equal(excessiveLimit.isError, true);
  } finally {
    await client.close();
    assert.equal(digest(databasePath), databaseBefore, "the spawned MCP process did not modify the primary fixture database");
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the direct Node STDIO entrypoint supports modern discovery with protocol-only stdout", async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "wowsync-mcp-modern-"));
  const databasePath = path.join(temporaryDirectory, "fixture.sqlite");
  const writer = new SqliteSnapshotStore(databasePath);
  try {
    writer.importSnapshot(retail("Probe", "Cairne"));
  } finally {
    writer.close();
  }
  const databaseBefore = digest(databasePath);
  const child = spawn(process.execPath, [entrypoint], {
    cwd: packageRoot,
    env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuffer = "";
  let stderr = "";
  const frames: Array<Record<string, unknown>> = [];
  const parseErrors: string[] = [];
  const responseWaiters = new Map<string | number, Array<(message: Record<string, unknown>) => void>>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length === 0) {
        parseErrors.push("<empty stdout line>");
      } else {
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          frames.push(message);
          const id = message.id;
          if (typeof id === "string" || typeof id === "number") {
            const waiters = responseWaiters.get(id) ?? [];
            responseWaiters.delete(id);
            for (const resolve of waiters) resolve(message);
          }
        } catch {
          parseErrors.push(line);
        }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  const waitForResponse = (id: number): Promise<Record<string, unknown>> => {
    const existing = frames.find((frame) => frame.id === id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for MCP response ${id}; stderr: ${stderr}`)), 5_000);
      const waiters = responseWaiters.get(id) ?? [];
      waiters.push((message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      responseWaiters.set(id, waiters);
    });
  };
  const send = (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const modernMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  try {
    send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: modernMeta } });
    const discovery = await waitForResponse(1);
    assert.equal(discovery.error, undefined, JSON.stringify(discovery.error));
    const discoveryResult = discovery.result as { supportedVersions?: string[] };
    assert.ok(discoveryResult.supportedVersions?.includes("2026-07-28"));

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: modernMeta } });
    const toolListResponse = await waitForResponse(2);
    assert.equal(toolListResponse.error, undefined, JSON.stringify(toolListResponse.error));
    const listedTools = (toolListResponse.result as { tools: Array<{ name: string }> }).tools;
    assert.deepEqual(listedTools.map((tool) => tool.name).sort(), [
      "analyze_retail_gear_candidate",
      "get_account_changes",
      "get_account_currencies",
      "get_account_overview",
      "get_allocation_review",
      "get_character_changes",
      "get_character_currencies",
      "get_character_equipment",
      "get_character_history",
      "get_character_professions",
      "get_character_spells",
      "get_character_state",
      "get_character_storage",
      "get_character_summary",
      "get_character_trainer",
      "get_erp_projects",
      "get_forever_gear_allocation",
      "get_forever_gear_observation",
      "get_gear_candidate_evidence",
      "get_gear_candidate_recipient_screen",
      "get_item_allocation",
      "get_item_metadata",
      "get_profession_coverage",
      "get_renown",
      "get_research_document",
      "get_research_section",
      "get_shared_storage",
      "list_characters",
      "list_research_documents",
      "list_versions",
      "search_items",
      "search_research",
    ]);
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Modern MCP stdio child did not exit after stdin closed"));
      }, 5_000);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    assert.equal(stdoutBuffer.trim(), "", "the process left a partial stdout frame");
    assert.deepEqual(parseErrors, [], "stdout included non-JSON protocol content");
    assert.equal(frames.length, 2, "stdout contained an unexpected MCP frame");
    assert.doesNotMatch(stderr, /WoWSync MCP startup failed/);
    assert.equal(digest(databasePath), databaseBefore, "the MCP process did not modify the fixture database");
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
