import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import {
  DASHBOARD_RESEARCH_REGISTRATIONS,
  buildErpResourceCommitmentSummary,
  buildErpFulfillmentTriage,
  buildErpPortfolioFulfillmentReview,
  buildErpSourceFulfillmentReview,
  buildErpPortfolioNextActionReview,
  buildErpProcurementBudgetPortfolioReview,
  buildErpProcurementBuyerPortfolioReview,
  DashboardReadModel,
  classifyFreshness,
  answerForeverCopilot,
  READ_MODEL_VERSIONS,
  ResearchRegistry,
  SqliteSnapshotReadStore,
  type ResearchDocumentClass,
  type VersionOrUnknown,
} from "@wowsync-dashboard/core";
import { buildErpNeedObservationChangeReview } from "@wowsync-dashboard/core/erpObservationChanges.ts";
import { buildRordinForeverGoalProject } from "./foreverGoalProject.ts";
import { ForeverKnowledgeStore, foreverKnowledgePath } from "@wowsync-dashboard/core/foreverKnowledgeStore.ts";
import { describeForeverTalents, lookupForeverKnowledge } from "@wowsync-dashboard/core/foreverKnowledgeLookup.ts";
import { recipeLearnSkills } from "@wowsync-dashboard/core/foreverRecipeLearning.ts";
import type { ForeverTalentView } from "@wowsync-dashboard/core/readModel.ts";
import { ForeverPriceStore, foreverPricesPath } from "@wowsync-dashboard/core/foreverPriceStore.ts";
import { AHLEDGER_ATTRIBUTION, foreverMarketFor, PRICE_FRESH_HOURS } from "@wowsync-dashboard/core/foreverPrices.ts";
import { z } from "zod";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const DEFAULT_DATABASE_PATH = path.join(REPO_ROOT, "data", "wowsync.sqlite");
const DEFAULT_RESEARCH_ROOT = path.join(REPO_ROOT, "docs");
const MAX_CHARACTER_LIST = 100;
const DEFAULT_CHARACTER_LIST = 50;
const MAX_CURRENCIES = 100;
const DEFAULT_RESEARCH_HITS = 5;
const MAX_RESEARCH_HITS = 8;
const MAX_SECTION_CHARACTERS = 20_000;
const MAX_DOCUMENT_CHARACTERS = 40_000;

const versionSchema = z.enum(READ_MODEL_VERSIONS as unknown as [VersionOrUnknown, ...VersionOrUnknown[]]);
const nameSchema = z.string().trim().min(1).max(64);
const realmSchema = z.string().trim().min(1).max(64);
const limitSchema = z.number().int().min(1);
const documentClassSchema = z.enum(["VERSIONED_RESEARCH", "OPERATIONAL_TRUTH"]);
const toolAnnotations = { readOnlyHint: true, openWorldHint: false, destructiveHint: false } as const;
// These tools only stage or commit mutations separately approved in Dashboard.
// MCP host annotations remain advisory and are not the approval boundary.
const planningWriteAnnotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: true } as const;

export interface WoWSyncMcpConfiguration {
  /** Process configuration only. MCP callers cannot select databases. */
  databasePath?: string;
  /** Process configuration only. MCP callers cannot select research roots. */
  researchRoot?: string;
  /** Optional process-owned loopback Dashboard origin. Enables planning-record writes through the existing REST validation boundary. */
  planningApiBaseUrl?: string;
  /** Exposes the bounded Forever-only tool profile selected by process configuration. */
  profile?: "forever";
}

export interface WoWSyncMcpServer {
  server: McpServer;
  close(): Promise<void>;
}

export function defaultMcpConfiguration(): { databasePath: string; researchRoot: string } {
  return { databasePath: DEFAULT_DATABASE_PATH, researchRoot: DEFAULT_RESEARCH_ROOT };
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function compactForeverProfessions(result: unknown, args: Record<string, unknown>): unknown {
  const wrapper = result as { structuredContent?: unknown };
  const root = (wrapper?.structuredContent ?? result) as Record<string, any>;
  const value = root?.value as Record<string, any> | undefined;
  const data = value?.data as Record<string, any> | undefined;
  if (!data) return result;
  const recipeDomain = data.recipeKnowledge as Record<string, any> | undefined;
  const recipeData = recipeDomain?.data as Record<string, any> | undefined;
  const recipeProfessions = Array.isArray(recipeData?.professions) ? recipeData.professions as Array<Record<string, any>> : [];
  const skillEntries = Array.isArray(data.entries) ? data.entries as Array<Record<string, any>> : [];
  const nameOf = (entry: Record<string, any>) => String(entry.professionName ?? entry.name ?? "");
  const summaries = skillEntries.map((skill) => {
    const name = nameOf(skill);
    const recipe = recipeProfessions.find((row) => nameOf(row).toLowerCase() === name.toLowerCase());
    const recipes = Array.isArray(recipe?.recipes) ? recipe.recipes as unknown[] : [];
    const observedAt = data.status?.observedAt ?? value?.provenance?.observedAt ?? recipeDomain?.observedAt ?? recipeDomain?.status?.observedAt;
    const summary: Record<string, unknown> = {
      name,
      ...(skill.skill !== undefined ? { skill: skill.skill } : {}),
      ...(skill.maxSkill !== undefined ? { maxSkill: skill.maxSkill } : {}),
      observedAt: typeof observedAt === "number" ? observedAt : "UNKNOWN",
      freshness: typeof observedAt === "number" ? classifyFreshness(observedAt, Math.floor(Date.now() / 1000)) : "unknown",
      recipeCount: recipes.length,
    };
    if (args.includeRecipes === true && typeof args.profession === "string" && name.toLowerCase() === args.profession.toLowerCase()) {
      const offset = typeof args.offset === "number" ? args.offset : 0;
      const limit = typeof args.limit === "number" ? args.limit : 50;
      const page = recipes.slice(offset, offset + limit);
      summary.recipes = page;
      summary.recipePaging = { offset, limit, totalCount: recipes.length, truncated: offset + page.length < recipes.length };
    }
    return summary;
  });
  const { recipeKnowledge: _discarded, specialization: _specialization, ...rest } = data;
  return textResult({ ...root, value: { ...value, data: { ...rest, entries: summaries, ...(recipeDomain ? { recipeKnowledge: { status: recipeDomain.status, ...(recipeDomain.evidence ? { evidence: recipeDomain.evidence } : {}), completeness: recipeDomain.completeness } } : {}) } } });
}

function safeFailure(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

function documentMetadata(document: ReturnType<ResearchRegistry["listDocuments"]>[number]) {
  return {
    documentId: document.documentId,
    title: document.title,
    documentClass: document.documentClass,
    version: document.version,
    expansion: document.expansion,
    patch: document.patch,
    season: document.season,
    researchSnapshot: document.researchSnapshot,
    contentHash: document.contentHash,
    citations: document.citations,
  };
}

function resolvePlanningApiBaseUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("WoWSync MCP planning API must be an absolute loopback HTTP origin."); }
  const loopbackNames = new Set(["127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackNames.has(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError("WoWSync MCP planning writes accept only a plain HTTP loopback IP origin (127.0.0.1 or ::1), without credentials or a path.");
  }
  return new URL(url.origin);
}

async function forwardPlanningRequest(baseUrl: URL, method: "POST" | "PUT" | "PATCH", route: string, body: unknown) {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded, "utf8") > 64_000) return safeFailure("PLANNING_REQUEST_TOO_LARGE", "The planning request exceeds the 64 KB MCP limit.");
  try {
    const response = await fetch(new URL(route, baseUrl), {
      method,
      headers: { "content-type": "application/json" },
      body: encoded,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    const reader = response.body?.getReader();
    if (!reader) return safeFailure("PLANNING_API_INVALID_RESPONSE", "The local Dashboard returned an empty response stream.");
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > 2_000_000) {
        await reader.cancel();
        return safeFailure("PLANNING_RESPONSE_TOO_LARGE", "The local Dashboard returned an oversized planning response.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(bytes);
    let result: unknown;
    try { result = JSON.parse(text); } catch { return safeFailure("PLANNING_API_INVALID_RESPONSE", "The local Dashboard returned a non-JSON response; no game action was performed."); }
    if (!response.ok) return safeFailure("PLANNING_API_REJECTED", `The local Dashboard rejected the planning request with HTTP ${response.status}: ${JSON.stringify(result).slice(0, 2_000)}`);
    return textResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local Dashboard request failed.";
    return safeFailure("PLANNING_API_UNAVAILABLE", `Could not reach the configured loopback Dashboard planning API: ${message.slice(0, 500)}`);
  }
}

function uuidFromKey(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function proposePlanningChange(baseUrl: URL, version: VersionOrUnknown, operation: string, mutation: Record<string, unknown>, rationale: string, proposalId: string = randomUUID()) {
  return forwardPlanningRequest(baseUrl, "POST", `/api/versions/${encodeURIComponent(version)}/erp/change-proposals`, { proposalId, operation, mutation, rationale });
}

/** A thin MCP adapter: reads from a read-only snapshot store, with optional fixed loopback REST writes for player plan records. */
export function createWoWSyncMcpServer(configuration: WoWSyncMcpConfiguration = {}): WoWSyncMcpServer {
  const defaults = defaultMcpConfiguration();
  const planningApiBaseUrl = resolvePlanningApiBaseUrl(configuration.planningApiBaseUrl);
  const store = new SqliteSnapshotReadStore(configuration.databasePath ?? defaults.databasePath);
  const readModel = () => new DashboardReadModel(store);
  const foreverKnowledge = new ForeverKnowledgeStore(foreverKnowledgePath(configuration.databasePath ?? defaults.databasePath));
  const foreverPrices = new ForeverPriceStore(foreverPricesPath(configuration.databasePath ?? defaults.databasePath));
  const marketRegion = (process.env.WOWSYNC_FOREVER_REGION ?? "us").toLowerCase();
  const registry = new ResearchRegistry(configuration.researchRoot ?? defaults.researchRoot, DASHBOARD_RESEARCH_REGISTRATIONS);
  const server = new McpServer(
    { name: planningApiBaseUrl ? "wowsync-local-erp" : "wowsync-readonly", version: "0.1.0" },
    {
      instructions: planningApiBaseUrl
        ? "WoWSync retrieval plus optional local ERP plan recording. Require an explicit WoW version. Planning tools write only player-authored planning records through the loopback Dashboard REST API; they never execute in-game actions. Latest-known data is not guaranteed live; preserve OBSERVED, DERIVED, LAST_SEEN, and UNKNOWN provenance."
        : "Read-only WoWSync retrieval. Require an explicit WoW version for account-state questions. Latest-known data is not guaranteed live; preserve OBSERVED, DERIVED, LAST_SEEN, and UNKNOWN provenance.",
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    },
  );
  const foreverProfile = configuration.profile === "forever";
  let storeClosed = false;
  const closeStore = () => {
    if (storeClosed) return;
    storeClosed = true;
    store.close();
  };
  // serveStdio owns and closes each factory-created server instance. Close its
  // associated read-only database connection when the SDK closes this server.
  server.server.onclose = closeStore;
  // One stderr line per tool call (name, outcome, duration; never arguments or results) so a host such as
  // the Secure MCP Tunnel leaves verifiable evidence of which tools a connected client actually used.
  const registerTool = server.registerTool.bind(server);
  const foreverHandlers = new Map<string, { config: Record<string, unknown>; handler: (...args: unknown[]) => unknown }>();
  const foreverAliases: Record<string, string> = {
    list_characters: "list_forever_characters",
    get_character_storage: "get_forever_items",
    search_items: "get_forever_items",
  };
  const foreverNames = new Set([
    "list_characters", "get_character_state", "get_forever_gear_observation", "get_forever_gear_allocation",
    "get_character_professions", "get_recipe_reagent_availability", "get_forever_character_quests",
    "get_character_progression", "lookup_forever_knowledge", "get_forever_market_prices",
    "find_recipe_crafters", "get_character_trainer", "get_character_storage", "search_items",
  ]);
  server.registerTool = ((name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
    const typedConfig = config as Record<string, unknown>;
    if (foreverProfile) {
      if (foreverNames.has(name)) foreverHandlers.set(name, { config: typedConfig, handler });
      return server;
    }
    return registerTool(name, config as never, (async (...args: unknown[]) => {
    const started = Date.now();
    let outcome = "ok";
    try {
      const result = await handler(...args) as { isError?: boolean };
      if (result?.isError) outcome = "error";
      return result;
    } catch (error) {
      outcome = "exception";
      throw error;
    } finally {
      process.stderr.write(`WoWSync MCP tool=${name} outcome=${outcome} ms=${Date.now() - started}\n`);
    }
    }) as never);
  }) as typeof server.registerTool;

  server.registerTool("list_versions", {
    title: "List WoWSync version buckets",
    description: "Lists known version-isolated WoWSync buckets. It does not choose a default version.",
    annotations: toolAnnotations,
  }, async () => textResult({ versions: readModel().listVersions() }));

  server.registerTool("list_characters", {
    title: "List characters in one version",
    description: "Returns compact latest-known character summaries for one explicit WoW version. It never aggregates across versions.",
    inputSchema: z.object({ version: versionSchema, realm: realmSchema.optional(), limit: limitSchema.max(MAX_CHARACTER_LIST).optional() }).strict(),
    annotations: toolAnnotations,
  }, async ({ version, realm, limit }) => {
    const characters = readModel().listCharacters({ version, realm });
    const resolvedLimit = limit ?? DEFAULT_CHARACTER_LIST;
    return textResult({ version, realm, characters: characters.slice(0, resolvedLimit), returnedCount: Math.min(characters.length, resolvedLimit), totalCount: characters.length, truncated: characters.length > resolvedLimit });
  });

  server.registerTool("get_erp_projects", {
    title: "Review WoWSync ERP projects",
    description: "Returns a bounded version-isolated page of player-authored projects, shared commitments, changed requirement observations, dependency packages, source/resource fulfillment reviews, procurement budget and buyer quote reviews, and triage. Source reviews join only exact needs that explicitly name the same versioned character/shared owner and resource identity with their evidence, reservations, linked task readiness, quotes/capability checks, and paired observations. They are review queues, not supply totals or selected routes. Procurement comparisons remain player-entered evidence; they are not predicted prices, affordability, ownership, or purchases. Changed quantities do not establish task completion or causation. Inaccessible or historical storage remains UNKNOWN/LAST_SEEN. This tool is read-only and never executes in-game actions.",
    inputSchema: z.object({ version: versionSchema, limit: limitSchema.max(20).optional() }).strict(),
    annotations: toolAnnotations,
  }, async ({ version, limit }) => {
    const projects = readModel().getErpProjects({ version });
    const resolvedLimit = limit ?? 10;
    const observationChanges = version === "unknown-version" ? { items: [], totalCount: 0, returnedCount: 0, affectedProjectCount: 0, truncated: false } : buildErpNeedObservationChangeReview(projects, version);
    const fulfillmentTriage = buildErpFulfillmentTriage(projects, version);
    const portfolioFulfillment = buildErpPortfolioFulfillmentReview(projects, version);
    const procurementBudgetReview = buildErpProcurementBudgetPortfolioReview(projects, version);
    const procurementBuyerReview = buildErpProcurementBuyerPortfolioReview(projects, version);
    const sourceFulfillment = buildErpSourceFulfillmentReview(projects, version);
    const portfolioNextActions = buildErpPortfolioNextActionReview(projects, version);
    return textResult({ version, projects: projects.slice(0, resolvedLimit), returnedCount: Math.min(projects.length, resolvedLimit), totalCount: projects.length, truncated: projects.length > resolvedLimit, resourceCommitments: buildErpResourceCommitmentSummary(projects), observationChanges, fulfillmentTriage, portfolioFulfillment, sourceFulfillment, portfolioNextActions, procurementBudgetReview, procurementBuyerReview });
  });

  server.registerTool("get_erp_operations_context", {
    title: "Recover version-scoped WoWSync project context",
    description: "A compact startup read for a fresh Operations conversation. Returns one explicitly selected WoW version, its known character roster and observation timestamps, current project revisions and priorities, project requirements/evidence summaries, work-order dependencies/readiness, recent saved decision rationale, shared commitments, and a bounded next-action queue. It does not merge versions or infer ownership, access, or task completion. Use get_erp_project for one complete project before proposing an edit; all changes require explicit user approval and the current revision.",
    inputSchema: z.object({ version: versionSchema, projectLimit: z.number().int().min(1).max(20).optional(), entriesPerProject: z.number().int().min(1).max(20).optional() }).strict(),
    annotations: toolAnnotations,
  }, async ({ version, projectLimit, entriesPerProject }) => {
    const model = new DashboardReadModel(store);
    const maxProjects = projectLimit ?? 10;
    const maxEntries = entriesPerProject ?? 20;
    const allCharacters = model.listCharacters({ version });
    const allProjects = model.getErpProjects({ version });
    const nextActions = buildErpPortfolioNextActionReview(allProjects, version);
    return textResult({
      version,
      accountEvidence: model.getAccountOverview({ version }),
      characters: allCharacters.slice(0, 100).map((character) => ({
        identityKey: character.identityKey, name: character.name, ...(character.surname ? { surname: character.surname } : {}), realm: character.realm,
        ...(character.class ? { class: character.class } : {}), ...(character.latestLevel !== undefined ? { level: character.latestLevel } : {}),
        ...(character.latestGeneratedAt !== undefined ? { lastExportGeneratedAt: character.latestGeneratedAt } : {}),
        ...(character.latestImportedAt !== undefined ? { lastImportedAt: character.latestImportedAt } : {}), snapshotCount: character.snapshotCount,
      })),
      characterCount: allCharacters.length, charactersTruncated: allCharacters.length > 100,
      projects: allProjects.slice(0, maxProjects).map((project) => ({
        stableId: project.stableId, version: project.version, title: project.title, status: project.status, priority: project.priority,
        revision: project.revision, createdAt: project.createdAt, updatedAt: project.updatedAt,
        ...(project.objective ? { objective: project.objective } : {}),
        requirements: project.needs.slice(0, maxEntries).map((need) => {
          const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
          return { ...need, evidence: evidence ? { state: evidence.state, freshness: evidence.freshness, observedAt: evidence.observedAt, reason: evidence.reason } : { state: "UNKNOWN", freshness: "unknown", reason: "No current evidence assessment is available." } };
        }), requirementCount: project.needs.length,
        workOrders: project.workOrders.slice(0, maxEntries).map((order) => {
          const readiness = project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId);
          const progress = project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId);
          return { ...order, ...(readiness ? { readiness: { state: readiness.state, reason: readiness.reason } } : {}), ...(progress ? { recordedProgress: { recordedStatus: progress.recordedStatus, reconciliation: progress.reconciliation, reason: progress.reason } } : {}) };
        }), workOrderCount: project.workOrders.length,
        reservations: project.reservations.slice(0, maxEntries), reservationCount: project.reservations.length,
        recentDecisions: project.history.slice(0, 5), historyEventCount: project.historyEventCount, historyTruncated: project.historyTruncated,
        fulfillment: project.fulfillment,
      })),
      projectCount: allProjects.length, projectsTruncated: allProjects.length > maxProjects,
      resourceCommitments: buildErpResourceCommitmentSummary(allProjects),
      nextActions: { ...nextActions, items: nextActions.items.slice(0, 10), returnedCount: Math.min(nextActions.totalCount, 10), truncated: nextActions.truncated || nextActions.totalCount > 10 },
      interpretation: "VERSION_SCOPED_OBSERVATIONS_AND_PLAYER_AUTHORED_PLANS; not execution, ownership, access, or completion proof",
    });
  });

  server.registerTool("get_erp_project", {
    title: "Inspect one version-scoped WoWSync project",
    description: "Returns one current project, including objective, exact revision, requirements and provenance-aware evidence, reservations, work orders, dependencies, readiness, reconciliation, and append-only decision history. A missing ID in the requested version is not searched in another version.",
    inputSchema: z.object({ version: versionSchema, projectId: z.string().trim().min(1).max(120) }).strict(),
    annotations: toolAnnotations,
  }, async ({ version, projectId }) => {
    const project = readModel().getErpProjects({ version }).find((entry) => entry.stableId === projectId);
    return project ? textResult({ version, project }) : safeFailure("PROJECT_NOT_FOUND", `Project ${projectId} was not found in ${version}.`);
  });

  server.registerTool("get_erp_change_proposals", {
    title: "Recover pending WoWSync project changes",
    description: "Lists bounded pending, approved, or in-progress project-change proposals from one explicit game version so an Operations conversation can recover a review across chat sessions. It never approves or commits a change.",
    inputSchema: z.object({ version: versionSchema, limit: z.number().int().min(1).max(50).default(20) }).strict(),
    annotations: toolAnnotations,
  }, async ({ version, limit }) => version === "unknown-version"
    ? safeFailure("INVALID_VERSION", "Choose one supported, explicit WoW version to retrieve planning proposals.")
    : textResult({ version, proposals: store.listErpChangeProposals(version).slice(0, limit), interpretation: "PROPOSALS_ARE_NOT_PROJECT_CHANGES; APPROVED means separately approved in Dashboard but not necessarily committed" }));

  server.registerTool("get_erp_change_proposal", {
    title: "Inspect one project-change proposal",
    description: "Retrieves one immutable proposal, its exact digest, approval/commit state, and saved outcome within the requested version. A missing proposal in that version is not searched elsewhere. This is read-only.",
    inputSchema: z.object({ version: versionSchema, proposalId: z.string().trim().min(1).max(120) }).strict(),
    annotations: toolAnnotations,
  }, async ({ version, proposalId }) => {
    const proposal = store.getErpChangeProposal(proposalId);
    return proposal?.version === version ? textResult({ version, proposal }) : safeFailure("PROPOSAL_NOT_FOUND", `Proposal ${proposalId} was not found in ${version}.`);
  });

  if (planningApiBaseUrl) {
    const boundedRecord = z.record(z.string().max(80), z.unknown());
    server.registerTool("create_erp_project_from_goal", {
      title: "Propose a Forever ERP project from a stated goal",
      description: "Builds the supported Rordin Forever project from the stated goal and stages an immutable proposal. No project changes until the player reviews and approves the exact proposal in Dashboard. Recipes and transfer routes remain UNKNOWN.",
      inputSchema: z.object({ goal: z.string().trim().min(1).max(1000) }).strict(),
      annotations: planningWriteAnnotations,
    }, async ({ goal }) => {
      const plan = buildRordinForeverGoalProject(goal, store);
      if ("error" in plan) return safeFailure("GOAL_NOT_SUPPORTED", plan.error);
      const rationale = `User-stated goal: ${goal.trim()}`;
      const proposed = await proposePlanningChange(planningApiBaseUrl, "forever", "CREATE_PROJECT", { idempotencyKey: plan.idempotencyKey, rationale, title: plan.title, objective: plan.objective, priority: plan.priority, needs: plan.needs, workOrders: plan.workOrders }, rationale, uuidFromKey(plan.idempotencyKey));
      if ("isError" in proposed && proposed.isError) return proposed;
      return textResult({ goal, target: plan.target, proposal: proposed.structuredContent, resourceDiscovery: plan.resourceDiscovery, recipeEvidence: plan.recipeEvidence, nextAction: "Open Forever > Projects & Work Orders, inspect and approve the exact proposal, then ask MCP to commit it. No project changes before approval." });
    });
    server.registerTool("create_erp_project", {
      title: "Propose a WoWSync ERP project",
      description: "Stages an immutable, version-scoped project creation proposal. Reuse proposalId only for retries of the exact same request. The player must approve the displayed proposal in Dashboard before commit_approved_erp_change can persist it.",
      inputSchema: z.object({ version: versionSchema, proposalId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(256), rationale: z.string().trim().min(1).max(2000), title: z.string().trim().min(1).max(160), objective: z.string().max(2000).optional(), priority: z.number().int().min(1).max(5).optional(), needs: z.array(boundedRecord).max(20).optional() }).strict(),
      annotations: planningWriteAnnotations,
    }, async ({ version, proposalId, idempotencyKey, rationale, title, objective, priority, needs }) => proposePlanningChange(planningApiBaseUrl, version, "CREATE_PROJECT", { idempotencyKey, rationale, title, ...(objective !== undefined ? { objective } : {}), ...(priority !== undefined ? { priority } : {}), ...(needs !== undefined ? { needs } : {}) }, rationale, proposalId));

    server.registerTool("plan_erp_work_order_batch", {
      title: "Propose a reviewed WoWSync work plan",
      description: "Stages an immutable proposal for atomically adding bounded manual work orders. The player approves the exact payload in Dashboard; existing evidence and revision validation is repeated on commit. No in-game action is performed.",
      inputSchema: z.object({ version: versionSchema, proposalId: z.string().uuid(), rationale: z.string().trim().min(1).max(2000), updates: z.array(z.object({ projectId: z.string().trim().min(1).max(120), expectedRevision: z.number().int().positive(), tasks: z.array(boundedRecord).min(1).max(20) }).strict()).min(1).max(10) }).strict(),
      annotations: planningWriteAnnotations,
    }, async ({ version, proposalId, rationale, updates }) => proposePlanningChange(planningApiBaseUrl, version, "APPEND_WORK_ORDER_BATCH", { updates }, rationale, proposalId));

    server.registerTool("update_erp_project_plan", {
      title: "Propose a WoWSync project edit",
      description: "Stages an immutable, exact-revision proposal for one project edit. Dashboard approval is required. Existing REST validation rechecks project identity, reservations, evidence, and revision on commit.",
      inputSchema: z.object({ version: versionSchema, proposalId: z.string().uuid(), projectId: z.string().trim().min(1).max(120), expectedRevision: z.number().int().positive(), rationale: z.string().trim().min(1).max(2000), project: boundedRecord }).strict(),
      annotations: planningWriteAnnotations,
    }, async ({ version, proposalId, projectId, expectedRevision, rationale, project }) => {
      if (project.stableId !== projectId || project.version !== version) return safeFailure("PROJECT_IDENTITY_MISMATCH", "The submitted project must retain its exact stable ID and explicit version.");
      return proposePlanningChange(planningApiBaseUrl, version, "UPDATE_PROJECT_PLAN", { projectId, body: { expectedRevision, rationale, project } }, rationale, proposalId);
    });

    server.registerTool("set_erp_project_status", {
      title: "Propose a project status change",
      description: "Stages a revision-checked status proposal. Completion requires a player-entered outcome note and records user-declared closure, not verified game completion. Approve in Dashboard before committing.",
      inputSchema: z.object({ version: versionSchema, proposalId: z.string().uuid(), projectId: z.string().trim().min(1).max(120), expectedRevision: z.number().int().positive(), status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]), rationale: z.string().trim().min(1).max(2000), completionNote: z.string().trim().min(1).max(2000).optional() }).strict().superRefine((input, context) => {
        if (input.status === "COMPLETED" && !input.completionNote) context.addIssue({ code: "custom", path: ["completionNote"], message: "A player-entered completion note is required." });
        if (input.status !== "COMPLETED" && input.completionNote !== undefined) context.addIssue({ code: "custom", path: ["completionNote"], message: "completionNote is accepted only for player-declared completion." });
      }),
      annotations: planningWriteAnnotations,
    }, async ({ version, proposalId, projectId, expectedRevision, status, rationale, completionNote }) => proposePlanningChange(planningApiBaseUrl, version, "SET_PROJECT_STATUS", { projectId, body: { expectedRevision, status, rationale, ...(completionNote ? { completionNote } : {}) } }, rationale, proposalId));

    server.registerTool("replan_erp_reservations", {
      title: "Propose a reservation reduction",
      description: "Stages an exact-revision reservation reduction/release. Dashboard approval is required; the existing atomic validation is repeated on commit. This cannot add supply or move resources.",
      inputSchema: z.object({ version: versionSchema, proposalId: z.string().uuid(), rationale: z.string().trim().min(1).max(2000), projects: z.array(z.object({ projectId: z.string().trim().min(1).max(120), expectedRevision: z.number().int().positive(), reservations: z.array(boundedRecord).max(100) }).strict()).min(1).max(10) }).strict(),
      annotations: planningWriteAnnotations,
    }, async ({ version, proposalId, rationale, projects }) => proposePlanningChange(planningApiBaseUrl, version, "REPLAN_RESERVATIONS", { projects }, rationale, proposalId));

    server.registerTool("commit_approved_erp_change", {
      title: "Commit a Dashboard-approved project change",
      description: "Commits only the immutable proposal approved through the separate Dashboard UI. Requires its exact proposal ID, explicit version, and digest; accepts no replacement mutation. Retries return the same result, while stale, altered, expired, rejected, or unapproved requests fail closed.",
      inputSchema: z.object({ version: versionSchema, proposalId: z.string().trim().min(1).max(120), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
      annotations: planningWriteAnnotations,
    }, async ({ version, proposalId, digest }) => forwardPlanningRequest(planningApiBaseUrl, "POST", `/api/versions/${encodeURIComponent(version)}/erp/change-proposals/${encodeURIComponent(proposalId.startsWith("proposal_") ? proposalId : `proposal_${proposalId}`)}/commit`, { digest }));
  }
  const characterQuery = z.object({ version: versionSchema, name: nameSchema, realm: realmSchema.optional() }).strict();
  server.registerTool("get_character_summary", {
    title: "Get a character summary",
    description: "Returns the latest-known compact summary for one explicit-version character. If name and realm are ambiguous, returns AMBIGUOUS rather than guessing.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getCharacterSummary(query)));
  server.registerTool("get_character_state", {
    title: "Get compact current character state",
    description: "Returns a bounded current snapshot summary for one explicit-version character, with section-level OBSERVED, LAST_SEEN, or UNKNOWN provenance. Historical bank data is never described as current. structuredObservations summarizes which structured domains exist (recipes; Classic quests, reputation, talents) and, for Forever, the client compatibility verdict (Dashboard vs exporter claim).",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getCharacterState(query)));
  server.registerTool("get_character_spells", {
    title: "Get captured character spellbook",
    description: "Returns a bounded known-spell section from the latest or one selected snapshot. Coverage describes what the client captured; this is not a complete recipe catalogue or pet spellbook.",
    inputSchema: z.object({ ...characterQuery.shape, snapshotId: z.number().int().positive().optional(), query: z.string().trim().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getCharacterSpells(query)));
  server.registerTool("get_character_trainer", {
    title: "Get captured trainer observations",
    description: "Returns bounded trainer visit evidence from the latest or one selected character snapshot. statusAtVisit is preserved verbatim; available/known/unavailable are observations at visit time, not inferred current learnability or a complete recipe list. A visit from an earlier export is reported LAST_SEEN. For Retail, Forever, Classic Era, and TBC, a service may carry recipeMatch joining it to the character's captured recipe rows: basis RECIPE_ID (exact spell/recipe ID) or DERIVED_NAME (unique exact name match only), with the recipe's output and reagents; no match is not evidence the recipe does not exist.",
    inputSchema: z.object({ ...characterQuery.shape, snapshotId: z.number().int().positive().optional(), category: z.string().trim().min(1).max(64).optional(), status: z.enum(["known", "available", "unavailable", "other"]).optional(), query: z.string().trim().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getCharacterTrainer(query)));
  server.registerTool("get_character_history", {
    title: "Get recent character snapshot history",
    description: "Returns a compact newest-first timeline for one explicit-version character. Defaults to 20 snapshots, caps at 100, and uses offset paging; raw snapshots are never returned.",
    inputSchema: z.object({ ...characterQuery.shape, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getCharacterSnapshotHistory(query)));
  server.registerTool("get_character_changes", {
    title: "Compare character snapshots",
    description: "Compares previous to latest for one explicit-version character, or compares two snapshot IDs belonging to that character. Returns bounded semantic changes and explicit UNKNOWN/LAST_SEEN/non-comparable section states.",
    inputSchema: z.object({ ...characterQuery.shape, fromSnapshotId: z.number().int().positive().optional(), toSnapshotId: z.number().int().positive().optional() }).strict().refine((query) => (query.fromSnapshotId === undefined) === (query.toSnapshotId === undefined), "fromSnapshotId and toSnapshotId must be supplied together."),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getCharacterChanges(query)));
  server.registerTool("get_account_overview", {
    title: "Get version-scoped account overview and economy",
    description: "Returns bounded version-scoped account facts, known gold and playtime, progression, profession/currency summaries, and storage coverage. Unknown values remain unknown; Warband and guild storage are not counted as character wealth.",
    inputSchema: z.object({ version: versionSchema }).strict(),
    annotations: toolAnnotations,
  }, async ({ version }) => textResult(readModel().getAccountOverview({ version })));
  server.registerTool("get_account_currencies", {
    title: "Get detailed version-scoped currency evidence",
    description: "Returns bounded currency scope, aggregate evidence, and per-character capture coverage. Realm-partitioned or unrecognized versions require one explicit realm; account-wide balances are represented once and character totals use known quantities only.",
    inputSchema: z.object({ version: versionSchema, realm: realmSchema.optional(), currencyID: z.number().int().positive().optional(), query: z.string().trim().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(), characterOffset: z.number().int().min(0).optional(), characterLimit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getAccountCurrencies(query)));
  server.registerTool("get_account_changes", {
    title: "Get recent version-scoped account changes",
    description: "Returns a bounded page of AccountFacts meaningful character changes, newest observation first. Each entry retains character identity and realm; realm-partitioned version entries are not combined into an economy.",
    inputSchema: z.object({ version: versionSchema, realm: realmSchema.optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getAccountChanges(query)));
  server.registerTool("get_character_equipment", {
    title: "Get latest-known character equipment",
    description: "Returns normal equipment slots from the latest-known explicit-version snapshot, with OBSERVED, LAST_SEEN, or UNKNOWN provenance.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getCharacterEquipment(query)));
  server.registerTool("get_forever_gear_observation", {
    title: "Get Forever observed equipment and carried items",
    description: "Returns one Forever-version character's observed equipped slots and carried inventory with snapshot/source/freshness provenance. The existing Dashboard identity model has no WoW account identifier, so account scope is explicitly UNKNOWN and limited to this Dashboard import context. Candidate classification remains UNKNOWN unless validated Forever metadata supports it; eligibility, suitability, upgrade status, transferability, and unobserved bank contents remain UNKNOWN. Never applies Retail rules.",
    inputSchema: z.object({ version: z.literal("forever"), name: nameSchema, realm: realmSchema }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getForeverGearObservation(query)));
  server.registerTool("get_forever_crafted_upgrade_assessment", {
    title: "Assess Forever learned equipment recipes against observed gear",
    description: "Read-only, snapshot-scoped assessment of positively observed learned Forever equipment recipes. snapshot.buildVerification is VERIFIED only for an exact verified version/build/interface profile; snapshot.compatibility also reports the exporter's own claim (VERIFIED_PROFILE / UNVERIFIED_BUILD) and whether the two agree. Covers output identity, slot, exact captured item stats, candidate eligibility, profession prerequisites, reagent requirements and source-character reagent availability. Partial recipe coverage remains partial; older-build reference facts are never promoted to current observations; missing bank, access, eligibility, item stats or craftability remain UNKNOWN. Does not craft, transfer, reserve, or mutate ERP plans.",
    inputSchema: z.object({ version: z.literal("forever"), name: nameSchema, realm: realmSchema, snapshotId: z.number().int().positive().optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getForeverCraftedUpgradeAssessment(query)));
  server.registerTool("get_forever_character_quests", {
    title: "Get Forever active quests and objectives",
    description: "Returns read-only quest and objective observations for one explicit Forever character, optionally pinned to a snapshotId belonging to that character. Active quests, objective progress, completion, turn-in readiness, completed history, tracking, and waypoint context remain separately evidenced; partial/stale/unavailable data stays explicit. A quest disappearing from the active log does not prove completion. Never applies Retail rules or takes gameplay actions.",
    inputSchema: z.object({ version: z.literal("forever"), name: nameSchema, realm: realmSchema, snapshotId: z.number().int().positive().optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getForeverQuestObservation(query)));
  server.registerTool("get_character_quests", {
    title: "Get active quests, objectives, and completed quest IDs",
    description: "Read-only quest observations for one explicit-version character: Forever (C_QuestLog) or Classic Era / TBC Anniversary (legacy quest log). Active quests and objectives keep their own evidence; a quest kept from an earlier refresh because it vanished from the log is rowEvidence LAST_SEEN and is never inferred completed. completedHistory holds the IDs GetQuestsCompleted returned (bounded list plus returnedCount; IDs not re-confirmed by the latest query are LAST_SEEN). Pass completedQuestIDs to look up specific IDs: OBSERVED/LAST_SEEN, NOT_IN_RETURNED_HISTORY (only when the history was fully observed), or UNKNOWN. Daily IDs may reset. Turn-in readiness stays UNKNOWN unless observed. Retail quests are not captured. Never takes gameplay actions.",
    inputSchema: z.object({ ...characterQuery.shape, snapshotId: z.number().int().positive().optional(), completedQuestIDs: z.array(z.number().int().positive()).min(1).max(50).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getCharacterQuests(query)));
  server.registerTool("get_character_progression", {
    title: "Get reputation standings and talents (Classic Era, TBC Anniversary, Forever)",
    description: "Forever: visible reputation rows (C_Reputation, same row shape as Classic) and the full talent capture from the Forever trait system: specialization, unspent points, points spent, each talent with current/max rank, client-reported availability (isAvailable, canPurchaseRank), DERIVED tier/column and prerequisites, points-in-tree gates, and the Forever tooltip description (rank 1 text) when the knowledge bundle has it. Forever reports one combined tree per class. includeTalents returns every talent, not only ranked ones. Forever also returns upcomingAbilities: spellbook entries not yet learned, with the level the client reports (training cost via get_character_trainer). Classic Era / TBC Anniversary: the character's visible legacy reputation rows (standing ID with a derived label, raw bar values, at-war/watched flags; collapsed headers hide rows, so coverage is VISIBLE_REPUTATION_ROWS_ONLY and an absent faction is UNKNOWN, not Neutral) and talent trees (points per tree, ranked talents, derived distribution such as 31/20/0). Each domain states OBSERVED, LAST_SEEN (carried from an earlier snapshot or a failed refresh), or UNKNOWN. Retail reputation is read with get_renown.",
    inputSchema: z.object({ ...characterQuery.shape, snapshotId: z.number().int().positive().optional(), factionQuery: z.string().trim().min(1).max(100).optional(), includeTalents: z.boolean().optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => {
    const result = readModel().getCharacterProgression(query);
    if (query.version !== "forever" || result.status !== "FOUND" || !result.value.data) return textResult(result);
    const data = result.value.data;
    return textResult({ ...result, value: { ...result.value, data: { ...data, talents: describeForeverTalents(data.talents as ForeverTalentView, foreverKnowledge.get()) } } });
  });
  server.registerTool("get_forever_market_prices", {
    title: "Get Forever Auction House prices (AHledger crowd-sourced scans)",
    description: `Read-only Forever Auction House prices from AHledger (https://ahledger.com), crowd-sourced player scans, as cached on this Dashboard (refreshed hourly for the account's markets and the items that matter to it). Pass items by id or exact name (up to 25) and either a character (its realm ruleset and faction pick the market, e.g. forever.pvp.alliance.us) or a market id. Each price has median, lowest buyout, quantity listed, AHledger's sales-per-day estimate, 30-day median, scan time and age; prices older than ${PRICE_FRESH_HOURS}h are marked stale. Vendor sell price is included as the guaranteed floor. Prices are EXTERNAL observations, never estimates; items not in the cache are UNKNOWN. Credit AHledger when showing these prices.`,
    inputSchema: z.object({
      version: z.literal("forever"),
      items: z.array(z.union([z.number().int().positive(), z.string().trim().min(2).max(100)])).min(1).max(25),
      character: z.object({ name: nameSchema, realm: realmSchema.optional() }).strict().optional(),
      market: z.string().regex(/^forever\.(normal|pvp|rp)\.(alliance|horde)\.[a-z]{2}$/).optional(),
    }).strict().refine((value) => value.character !== undefined || value.market !== undefined, { message: "Pass character or market." }),
    annotations: toolAnnotations,
  }, async ({ items, character, market }) => {
    const prices = foreverPrices.get();
    if (!prices) return textResult({ status: "UNAVAILABLE", reason: "No Forever price bundle is installed on this Dashboard yet." });
    let resolvedMarket = market;
    let marketBasis = market ? "requested" : undefined;
    if (!resolvedMarket && character) {
      const matches = readModel().listCharacters({ version: "forever" }).filter((entry) => entry.name.toLowerCase() === character.name.toLowerCase() && (!character.realm || entry.realm === character.realm));
      if (matches.length !== 1) return textResult({ status: matches.length ? "CHARACTER_AMBIGUOUS" : "CHARACTER_NOT_FOUND", candidates: matches.map((entry) => ({ name: entry.name, realm: entry.realm })) });
      resolvedMarket = foreverMarketFor(matches[0]!.realm, (matches[0] as { faction?: string }).faction, marketRegion);
      marketBasis = `DERIVED from ${matches[0]!.name}'s realm "${matches[0]!.realm}" (ruleset) and faction`;
      if (!resolvedMarket) return textResult({ status: "MARKET_UNKNOWN", reason: `Cannot tell the ruleset or faction for ${matches[0]!.name} (realm "${matches[0]!.realm}"); pass market explicitly.` });
    }
    const index = foreverKnowledge.get();
    const nameToId = (name: string) => {
      const needle = name.toLowerCase();
      const fromTooltips = index ? Object.values(index.bundle.tooltips.items).find((item) => item.name.toLowerCase() === needle)?.id : undefined;
      return fromTooltips ?? (index ? index.items().find(([, item]) => item.name.toLowerCase() === needle)?.[0] : undefined);
    };
    const rows = items.map((item) => {
      const id = typeof item === "number" ? item : nameToId(item);
      if (id === undefined) return { query: item, status: "UNKNOWN_ITEM" };
      const found = prices.lookup(resolvedMarket, id);
      const vendor = index?.tooltipItem(id)?.sellPriceCopper;
      const name = index?.tooltipItem(id)?.name ?? index?.item(id)?.name;
      if (!found) return { query: item, itemId: id, name, status: "UNKNOWN", reason: "No AHledger scan for this item in this market in the cache.", vendorSellCopper: vendor };
      return { query: item, itemId: id, name, status: found.fresh ? "OBSERVED_EXTERNAL" : "STALE", ...found.price, ageHours: found.ageHours !== undefined ? Math.round(found.ageHours * 10) / 10 : undefined, vendorSellCopper: vendor };
    });
    return textResult({ status: "FOUND", market: resolvedMarket, marketBasis, fetchedAt: prices.bundle.fetchedAt, prices: rows, units: "copper (10000 = 1 gold)", attribution: AHLEDGER_ATTRIBUTION, notes: "Crowd-sourced scans move; the Auction House cut and deposit are not deducted." });
  });
  server.registerTool("lookup_forever_knowledge", {
    title: "Look up Forever game knowledge (items, quests, NPCs, spells, dungeons, zones)",
    description: "Read-only lookup in the private Forever knowledge bundle (QuestieDB Forever + Wowhead Forever tooltips), by id or name (exact match first, then partial; max 10). item: stats, slot, required level, vendor sell price, who sells it, what drops it, which quest rewards it. quest: level, faction, giver and location, turn-in, objectives, prerequisites, follow-up, rewards, XP (Classic-seeded). npc: title, level, location, faction, roles, quests it starts, items it sells. spell: Forever tooltip text, reagents, tools, created item (talents and recipes). dungeon: creature level range (derived), entrance, quests. zone: quest count, quest level range, quests. Game knowledge only, not account state; vendor buy prices, Auction House prices and drop chances are UNKNOWN. Forever-only content is only partly covered.",
    inputSchema: z.object({
      version: z.literal("forever"),
      kind: z.enum(["item", "quest", "npc", "spell", "dungeon", "zone"]),
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(2).max(100).optional(),
      limit: z.number().int().min(1).max(10).optional(),
    }).strict().refine((value) => value.id !== undefined || value.name !== undefined, { message: "Pass id or name." }),
    annotations: toolAnnotations,
  }, async ({ version: _version, ...query }) => textResult(lookupForeverKnowledge(foreverKnowledge.get(), query)));
  server.registerTool("get_forever_gear_allocation", {
    title: "Evaluate observed Forever gear candidates",
    description: "Evaluates exact observed Forever carried candidates against the requested character and screens each candidate against every Dashboard-known Forever character's observed level, equipment slots, and captured equipped stats. Returns explicit Classic-derived armor/weapon proficiency hypotheses separately from confirmed eligibility, exact-variant recorded-stat comparisons, binding category UNKNOWN when target-client semantics are unvalidated, and per-recipient fit/exclusion reasons. Account membership and cross-character transfer access remain UNKNOWN; fit screens are not transfer recommendations and are not ranked without complete validated comparative priority evidence. Never applies Retail rules or initiates gameplay/bank actions.",
    inputSchema: z.object({ version: z.literal("forever"), name: nameSchema, realm: realmSchema }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getForeverGearAllocation(query)));
  server.registerTool("ask_forever_copilot", {
    title: "Ask the Forever Co-Pilot a goal-oriented question",
    description: "Answers a player's Forever goal question (improve a character, make gold, develop professions, become self-sufficient, level faster) by combining the account's Forever evidence with version-correct Forever game knowledge from the Wowhead Forever database. Returns ranked recommendations, each with what to do, why, OBSERVED/DERIVED/LAST_SEEN/EXTERNAL/UNKNOWN evidence lines with sources, prerequisites, costs, alternatives/tradeoffs, unknowns, and next actions; premise challenges (for example owning a better item already); recorded ERP project goals; and limitations. Name the character in the question or pass character; stable-wide questions are answered per realm because realms are separate economies. Never invents prices, ownership, recipes, or eligibility; Auction House prices are UNKNOWN. Read-only: it never plays, buys, sells, mails, or moves items, and every transfer or /bankx move is for the player to run. Use format 'markdown' for a compact player-facing answer.",
    inputSchema: z.object({
      version: z.literal("forever"),
      question: z.string().trim().min(1).max(2_000),
      character: z.object({ name: nameSchema, realm: realmSchema.optional() }).strict().optional(),
      realm: realmSchema.optional(),
      objectives: z.array(z.enum(["IMPROVE_CHARACTER", "MAKE_GOLD", "DEVELOP_PROFESSIONS", "SELF_SUFFICIENCY", "LEVELING", "GEAR"])).min(1).max(6).optional(),
      preferences: z.object({ emphasis: z.enum(["IMMEDIATE_POWER", "SELF_SUFFICIENCY", "BALANCED"]).optional(), avoidSpending: z.boolean().optional(), goals: z.array(z.string().trim().min(1).max(200)).max(10).optional() }).strict().optional(),
      limit: z.number().int().min(1).max(20).optional(),
      format: z.enum(["full", "markdown"]).optional(),
    }).strict(),
    annotations: toolAnnotations,
  }, async ({ format, ...request }) => {
    const answer = answerForeverCopilot(new DashboardReadModel(store), request, foreverKnowledge.get(), foreverPrices.get(), marketRegion);
    if (format === "markdown") return textResult({ status: answer.status, markdown: answer.markdown });
    return textResult(answer);
  });
  const professionsWithCaptureIssue = (model: DashboardReadModel, query: { version: VersionOrUnknown; name: string; realm?: string }, result: unknown) => {
    if (query.version !== "forever") return result;
    const issue = model.getForeverRecipeCaptureIssue(query as never);
    const visits = model.getForeverTrainerVisits(query as never);
    const trainerVisits = visits.status === "FOUND" ? visits.value : [];
    const index = foreverKnowledge.get();
    const faction = (model.listCharacters({ version: "forever" }).find((entry) => entry.name.toLowerCase() === query.name.toLowerCase() && (!query.realm || entry.realm === query.realm)) as { faction?: string } | undefined)?.faction;
    // Add learnSkill to each recipe row: trainer window (OBSERVED) or pattern tooltip (EXTERNAL, matched by name).
    const withLearn = JSON.parse(JSON.stringify(result)) as { value?: { data?: { recipeKnowledge?: { data?: { professions?: Array<{ professionName?: string; name?: string; recipes?: Array<{ recipeID: number; name?: string; learnSkill?: unknown }> }> } } } } };
    for (const profession of withLearn.value?.data?.recipeKnowledge?.data?.professions ?? []) {
      const name = profession.professionName ?? profession.name;
      if (!name || !profession.recipes) continue;
      const learn = recipeLearnSkills(name, profession.recipes.flatMap((recipe) => typeof recipe.name === "string" ? [{ recipeID: recipe.recipeID, name: recipe.name }] : []), trainerVisits, index, faction);
      for (const recipe of profession.recipes) { const source = learn.get(recipe.recipeID); if (source) recipe.learnSkill = source; }
    }
    return issue ? { ...withLearn, latestRecipeCapture: { state: "FAILED", error: issue.error, at: issue.at, snapshotId: issue.snapshotId, note: "Recipe rows are from the last successful capture (LAST_SEEN). Reopen the profession window, then /wowsync and /reload." } } : withLearn;
  };
  server.registerTool("get_character_professions", {
    title: "Get latest-known character professions",
    description: "Returns profession skills and version-scoped recipe observations for one explicit-version character. Recipe sources: Retail C_TradeSkillUI captures, Forever structured captures (any well-formed build; unverified builds are labelled), and Classic Era / TBC rows from a profession window the player opened (TradeSkill rows are the character's own learned list; Craft-window rows such as Enchanting are visible with learnedState UNKNOWN; Enchanting outputs are enchant identities, not items). Candidate recipe coverage is partial; absence does not mean unlearned. For Forever, each recipe may carry learnSkill { rank, basis TRAINER_OBSERVED (trainer window, with cost) or PATTERN_TOOLTIP (pattern item tooltip, matched by name; item and where it comes from) }; recipes without it have no known learn skill yet. latestRecipeCapture FAILED means the newest export could not refresh the recipe list (reason included) and rows are from the last successful capture; and an earlier observation is labelled LAST_SEEN with its source snapshot. Recipe/output/reagent observations do not alone establish current skill eligibility or that crafting is presently possible.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => {
    const model = new DashboardReadModel(store);
    return textResult(professionsWithCaptureIssue(model, query, model.getCharacterProfessions(query)));
  });
  server.registerTool("find_recipe_crafters", {
    title: "Find characters with captured evidence for a recipe",
    description: "Answers 'which of my characters can make this?' within one explicit version (Retail, Forever, Classic Era, TBC Anniversary; never across versions). Filter by recipeID (Retail/Forever), recipeKey (Classic opaque identity), outputItemID, enchantID (Classic Enchanting), or nameContains. Groups characters into learned (client-reported learned), observedNotLearned (shown in the UI and reported not learned), and unresolved (learned state not established, e.g. knowledgeClass VISIBLE_LEARNED_UNKNOWN for a Classic Craft-window row). Each row carries its own OBSERVED/LAST_SEEN evidence and source snapshot. Candidate coverage is partial: characters without captured evidence are listed separately and are not proven unable. Knowing a recipe does not establish skill, facility, or reagent readiness.",
    inputSchema: z.object({ version: versionSchema, recipeID: z.number().int().positive().optional(), recipeKey: z.string().trim().min(1).max(1024).optional(), outputItemID: z.number().int().positive().optional(), enchantID: z.number().int().positive().optional(), nameContains: z.string().trim().min(2).max(80).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().findRecipeCrafters(query)));
  server.registerTool("get_recipe_reagent_availability", {
    title: "Get a recipe's reagents and where they are observed",
    description: "For one explicit-version character and exactly one recipe from its captured rows (recipeID for Retail/Forever; recipeKey, outputItemID, enchantID, or exact recipeName for Classic): the reagent slots (alternatives are OR choices, never summed), and per-owner holdings in the crafter's bags, the crafter's bank, and other characters' bags/bank, each with OBSERVED/LAST_SEEN/UNKNOWN provenance and freshness. Only current crafter bags can support a carried-sufficiency conclusion; UNKNOWN storage is not empty and other characters' items are not transferable by assumption. Classic rows may also carry the client's own counts at observation time (clientReportedCount, clientReportedCarried); these are historical reports, not current availability. A selector matching several rows returns the candidates instead of choosing. Never crafts or moves items; craftability stays NOT_ESTABLISHED.",
    inputSchema: characterQuery.extend({ recipeID: z.number().int().positive().optional(), recipeKey: z.string().trim().min(1).max(1024).optional(), outputItemID: z.number().int().positive().optional(), enchantID: z.number().int().positive().optional(), recipeName: z.string().trim().min(1).max(256).optional() }).strict().refine((query) => [query.recipeID, query.recipeKey, query.outputItemID, query.enchantID, query.recipeName].filter((value) => value !== undefined).length === 1, "Provide exactly one of recipeID, recipeKey, outputItemID, enchantID, or recipeName."),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getRecipeReagentAvailability(query)));
  server.registerTool("get_character_currencies", {
    title: "Get latest-known character currencies",
    description: "Returns at most 100 structured currency records for one explicit-version character. Missing capture remains UNKNOWN, never zero.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => {
    const result = readModel().getCharacterCurrencies(query);
    if (result.status !== "FOUND" || !result.value.data?.currencies) return textResult(result);
    const currencies = result.value.data.currencies;
    const limited = currencies.slice(0, MAX_CURRENCIES);
    return textResult({
      ...result,
      value: {
        ...result.value,
        data: { ...result.value.data, currencies: limited },
        returnedCount: limited.length,
        totalCount: currencies.length,
        truncated: currencies.length > limited.length,
      },
    });
  });

  server.registerTool("search_items", {
    title: "Search observed character items",
    description: "Searches latest-known observed character bags and banks in one explicit version. Shared storage is separate. Results are bounded and include known UNKNOWN storage caveats and item metadata state.",
    inputSchema: z.object({ version: versionSchema, query: z.string().trim().min(1).max(100), storage: z.enum(["bags", "bank"]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().searchItems(query)));
  server.registerTool("get_character_storage", {
    title: "Get character bags or bank contents",
    description: "Returns one character-owned storage section for an explicit version. Preserves OBSERVED, LAST_SEEN, UNKNOWN, known-empty state, and item metadata state.",
    inputSchema: z.object({ ...characterQuery.shape, storage: z.enum(["bags", "bank"]), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getCharacterStorage(query)));
  server.registerTool("get_shared_storage", {
    title: "Get Warband or guild storage observations",
    description: "Returns bounded Retail Warband or guild storage observations from the shared-storage journal. Preserves owner, accessibility, coverage, OBSERVED/LAST_SEEN carrier provenance, and observation freshness.",
    inputSchema: z.object({ version: versionSchema, kind: z.enum(["warband", "guild"]), guildClubId: z.string().trim().min(1).max(128).optional(), query: z.string().trim().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(), ownerOffset: z.number().int().min(0).optional(), ownerLimit: z.number().int().min(1).max(20).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getSharedStorageContents(query)));
  server.registerTool("get_gear_candidate_evidence", {
    title: "Get Retail gear candidate evidence",
    description: "Returns snapshot-scoped Retail [GEAR CANDIDATES] evidence, latest captured section per character. Shows raw candidate fields and OBSERVED/LAST_SEEN row state with snapshot provenance. Missing sidecars mean not captured, not zero candidates. This tool makes no recipient usability, transferability, upgrade, demand, allocation, surplus, or disposition claims.",
    inputSchema: z.object({ version: versionSchema, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getGearCandidateEvidence(query)));
  server.registerTool("analyze_retail_gear_candidate", {
    title: "Analyze Retail gear candidate allocation",
    description: "Deterministically compares one explicitly referenced Retail candidate snapshot row against all Dashboard-known Retail characters and their retained qualifying per-spec equipment observations. Use get_gear_candidate_evidence first to obtain exporter identityKey, snapshotId and rowOrdinal. Returns eligibility, conservative checked-rule suitability, retained equipment provenance, slot comparison, item-level delta, ties and UNKNOWN reasons. Results are Retail-only; candidate identity remains snapshot-scoped; no transferability or disposition is inferred. Stat lines and item-specific restrictions are absent from candidate evidence, so item-level upgrades are explicitly coarse and not a stat simulation.",
    inputSchema: z.object({ version: z.literal("retail"), exporterIdentityKey: z.string().min(1).max(300), snapshotId: z.number().int().positive(), rowOrdinal: z.number().int().positive() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().analyzeRetailGearCandidate(query)));
  server.registerTool("get_gear_candidate_recipient_screen", {
    title: "Screen Retail gear candidates against recipient evidence",
    description: "For explicitly selected Dashboard-known Retail exporter and recipient characters, screens snapshot-scoped candidate rows against the recipient's OBSERVED known level and captured required level, native armor-family plausibility for clearly identified ordinary body armor, and recipient class-level weapon proficiency/access for supported modern weapon families. Native armor-family mismatches are plausibility-screen results and do not prove that the Retail client technically forbids equipping a lower armor family. Weapon RULED_OUT means only that the checked current Retail class-level proficiency rule identifies a mismatch; UNKNOWN includes Hunter one-handed axe/sword and dagger cases because access is specialization-dependent and recipient specialization is not checked by this screen. Results are RULED_OUT, NOT_RULED_OUT_BY_CHECKED_RULES, or UNKNOWN; positive results do not mean CanEquip. Weapon PASS does not establish specialization suitability, ability compatibility, weapon pairing, primary-stat suitability, or upgrade value. Exposes recipient class evidence, snapshot and row provenance, states that Battle.net account membership is not established, and lists unchecked item-specific restrictions including allowed class, race, faction, profession, unique/equip, and other requirements. It does not assess recipient suitability, upgrades, transferability, demand, allocation, surplus, or disposition.",
    inputSchema: z.object({ version: z.literal("retail"), exporterName: nameSchema, exporterRealm: realmSchema, recipientName: nameSchema, recipientRealm: realmSchema, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getGearCandidateRecipientScreen(query)));
  server.registerTool("get_item_allocation", {
    title: "Get deterministic item allocation decision",
    description: "Returns the deterministic Azeroth ERP allocation decision for one explicit-version base item against its currently active STOCK_TARGET demand, if any. Distinguishes confirmed (OBSERVED) from potential (LAST_SEEN) availability, surfaces unresolved (UNKNOWN) account-owned storage explicitly, never routes guild-owned evidence into account surplus, and never treats a missing demand as zero demand. A confirmed floor surplus may still be reported precisely under unresolved evidence, but disposition never recommends the Hellomags sale pipeline while that uncertainty exists. Held-item identity and binding (CONFIRMED and LAST_SEEN tiers reported separately as confirmed/potentialItemStringIdentity and confirmed/potentialBinding row counts; guild rows never contribute): when the confirmed rows' item strings (viewer linkLevel/specID ignored) show variants or include a bare item:<id>, base-item aggregation is not proven and the result is BASE_ITEM_AGGREGATION_UNPROVEN with disposition REQUIRES_REVIEW and no allocated, confirmedDeficit, or confirmedSurplus fields at all. Confirmed bound or binding-unknown rows withhold SEND_HELLOMAGS from a confirmed surplus (REQUIRES_REVIEW, arithmetic unchanged); they are not unresolved evidence. bound=no never certifies that an item is mailable, auctionable, or sale-eligible, and LAST_SEEN identity/binding facts never gate anything.",
    inputSchema: z.object({ version: versionSchema, baseItemId: z.number().int().positive() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getItemAllocation(query)));
  server.registerTool("get_allocation_review", {
    title: "Get account-wide allocation review",
    description: "Returns the deterministic Azeroth ERP account allocation review for one explicit version. 'demanded' lists every active STOCK_TARGET demand with the same allocation result get_item_allocation returns for that item (ordered HOLD_ALLOCATED, REQUIRES_REVIEW, SEND_HELLOMAGS, NO_ACTION, then base item ID; a BASE_ITEM_AGGREGATION_UNPROVEN result is in the REQUIRES_REVIEW group). 'unallocated' lists account-owned base items (character bags, character bank, Warband) with no active demand, ascending base item ID, with confirmed (OBSERVED) and potential (LAST_SEEN) quantities kept separate. Unallocated inventory is NOT surplus: it has no surplus, disposition, or sale recommendation because none can be determined without a demand. Guild-owned evidence is context only and an item held only by a guild is never listed. Nothing unknown is reported as zero: unknown storage is listed once as unresolved storage; an unreported quantity in observed storage is unresolved item-quantity evidence (the storage was observed) and keeps confirmed quantities a floor; an unreported quantity in LAST_SEEN storage is counted in potentialUnknownQuantityRowCount, making potentialQuantity a known floor without affecting confirmed numbers. Each unallocated entry also reports confirmed/potentialItemStringIdentity and confirmed/potentialBinding facts (evidence only; never a disposition), and unallocatedItemStringIdentityCounts counts identity classes over the whole unallocated list, not just the page; entries are never filtered or reordered by class. Both lists are paged independently. 'itemNames' maps each base item ID on the returned demanded page to the item name observed in account-owned evidence (presentation only; an item with no observed name has no key and is identified by its ID). Names are never part of any allocation result and never change allocation, disposition, or counts.",
    inputSchema: z.object({ version: versionSchema, demandedOffset: z.number().int().min(0).optional(), demandedLimit: z.number().int().min(1).max(100).optional(), unallocatedOffset: z.number().int().min(0).optional(), unallocatedLimit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getAllocationReview(query)));
  server.registerTool("get_item_metadata", {
    title: "Get deterministic item metadata",
    description: "Returns game-client-reported metadata facets for up to 100 base item IDs in one explicit version. KNOWN, UNKNOWN, and conflicting evidence remain distinct.",
    inputSchema: z.object({ version: versionSchema, itemIds: z.array(z.number().int().positive()).min(1).max(100) }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getItemMetadata(query)));

  server.registerTool("get_profession_coverage", {
    title: "Get version-scoped profession coverage",
    description: "Returns deterministic account-level profession coverage and gaps for one explicit version. Its provenance is DERIVED from captured character state.",
    inputSchema: z.object({ version: versionSchema }).strict(),
    annotations: toolAnnotations,
  }, async ({ version }) => textResult(readModel().getProfessionCoverage({ version })));
  server.registerTool("get_renown", {
    title: "Get captured character Renown",
    description: "Returns the captured Renown state for one explicit-version character. WoWSync does not currently capture Renown, so the result is intentionally UNKNOWN with its reason.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel().getRenown(query)));

  server.registerTool("list_research_documents", {
    title: "List registered WoW research documents",
    description: "Lists compact metadata and a bounded section outline for registered research only. It never reads caller-supplied filesystem paths or returns document bodies.",
    inputSchema: z.object({ version: z.string().max(64).optional(), patch: z.string().max(64).optional(), season: z.string().max(64).optional(), documentClass: documentClassSchema.optional() }).strict(),
    annotations: toolAnnotations,
  }, async ({ version, patch, season, documentClass }) => {
    const documents = registry.listDocuments(documentClass as ResearchDocumentClass | undefined)
      .filter((document) => (!version || document.version === version) && (!patch || document.patch === patch) && (!season || document.season === season))
      .map((document) => ({ ...documentMetadata(document), sections: document.sections.slice(0, 100).map(({ sectionId, heading, level, parentSectionId }) => ({ sectionId, heading, level, parentSectionId })), sectionsReturned: Math.min(document.sections.length, 100), sectionsTotal: document.sections.length, sectionsTruncated: document.sections.length > 100 }));
    return textResult({ documents, returnedCount: documents.length });
  });
  server.registerTool("search_research", {
    title: "Search registered WoW research",
    description: "Searches registered research headings and bodies and returns compact matching sections. Use get_research_section for one selected section.",
    inputSchema: z.object({ query: z.string().trim().min(1).max(500), version: z.string().max(64).optional(), patch: z.string().max(64).optional(), season: z.string().max(64).optional(), documentClass: documentClassSchema.optional(), limit: limitSchema.max(MAX_RESEARCH_HITS).optional() }).strict(),
    annotations: toolAnnotations,
  }, async ({ query, version, patch, season, documentClass, limit }) => {
    const resolvedLimit = limit ?? DEFAULT_RESEARCH_HITS;
    const candidates = registry.search({ query, version, patch, season, documentClass: documentClass as ResearchDocumentClass | undefined, limit: resolvedLimit + 1 });
    const matches = candidates.slice(0, resolvedLimit);
    return textResult({ matches, returnedCount: matches.length, limit: resolvedLimit, truncated: candidates.length > matches.length });
  });
  server.registerTool("get_research_section", {
    title: "Get one registered research section",
    description: "Returns one registered document section and its citation URLs. IDs are registry IDs, never filesystem paths; long sections are explicitly truncated.",
    inputSchema: z.object({ documentId: z.string().regex(/^[a-z0-9-]+$/).max(128), sectionId: z.string().regex(/^[a-z0-9-]+$/).max(256) }).strict(),
    annotations: toolAnnotations,
  }, async ({ documentId, sectionId }) => {
    const found = registry.getSection(documentId, sectionId);
    if (!found) return safeFailure("RESEARCH_SECTION_NOT_FOUND", "The registered research document or section was not found.");
    const totalCharacters = found.section.markdown.length;
    const markdown = found.section.markdown.slice(0, MAX_SECTION_CHARACTERS);
    return textResult({
      document: documentMetadata(found.document),
      section: {
        sectionId: found.section.sectionId,
        heading: found.section.heading,
        level: found.section.level,
        parentSectionId: found.section.parentSectionId,
        markdown,
        citations: found.section.citations,
      },
      returnedCharacters: markdown.length,
      totalCharacters,
      truncated: markdown.length < totalCharacters,
    });
  });
  server.registerTool("get_research_document", {
    title: "Get one registered WoW research document",
    description: "Returns the bounded Markdown body and metadata for one registered research document. Document IDs resolve only through the fixed registry, never caller-supplied paths.",
    inputSchema: z.object({ documentId: z.string().regex(/^[a-z0-9-]+$/).max(128) }).strict(),
    annotations: toolAnnotations,
  }, async ({ documentId }) => {
    const document = registry.getDocument(documentId);
    if (!document) return safeFailure("RESEARCH_DOCUMENT_NOT_FOUND", "The registered research document was not found.");
    const markdown = document.markdown.slice(0, MAX_DOCUMENT_CHARACTERS);
    return textResult({ document: documentMetadata(document), markdown, returnedCharacters: markdown.length, totalCharacters: document.markdown.length, truncated: markdown.length < document.markdown.length, source: "registered research document" });
  });

  if (foreverProfile) {
    const profileToolNames = ["list_forever_characters", "get_character_state", "get_forever_gear_observation", "get_forever_gear_allocation", "get_character_professions", "get_recipe_reagent_availability", "get_forever_character_quests", "get_character_progression", "get_forever_items", "lookup_forever_knowledge", "get_forever_market_prices", "find_recipe_crafters", "get_character_trainer"];
    for (const exposedName of profileToolNames) {
      const sourceName = exposedName === "list_forever_characters" ? "list_characters" : exposedName === "get_forever_items" ? "get_character_storage" : exposedName;
      const selected = foreverHandlers.get(sourceName);
      if (!selected) continue;
      const config = { ...selected.config };
      const shape = (selected.config.inputSchema as z.ZodObject<z.ZodRawShape> | undefined)?.shape ?? {};
      const profileShape = { ...shape, version: z.literal("forever") };
      if (exposedName === "list_forever_characters") config.inputSchema = z.object({ version: z.literal("forever"), realm: realmSchema.optional(), limit: limitSchema.max(MAX_CHARACTER_LIST).optional() }).strict();
      else if (exposedName === "get_character_professions") config.inputSchema = z.object({ version: z.literal("forever"), name: nameSchema, realm: realmSchema, profession: z.string().trim().min(1).max(80).optional(), includeRecipes: z.boolean().default(false), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().refine((args) => (args.includeRecipes !== true || args.profession !== undefined) && ((args.offset === undefined && args.limit === undefined) || args.includeRecipes === true), "Recipes and recipe paging require includeRecipes:true and a profession.");
      else if (exposedName === "get_forever_items") config.inputSchema = z.object({ version: z.literal("forever"), name: nameSchema.optional(), realm: realmSchema.optional(), storage: z.enum(["bags", "bank"]).optional(), query: z.string().trim().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().refine((args) => (args.query !== undefined && args.name === undefined && args.realm === undefined && args.storage === undefined) || (args.query === undefined && args.name !== undefined && args.realm !== undefined && args.storage !== undefined), "Pass query alone or name, realm, and storage together.");
      else {
        if ("realm" in profileShape) profileShape.realm = realmSchema;
        config.inputSchema = z.object(profileShape).strict();
      }
      registerTool(exposedName, config as never, (async (args: Record<string, unknown>) => {
        let result: unknown;
        if (exposedName === "get_forever_items") result = "query" in args ? await foreverHandlers.get("search_items")!.handler(args) : await foreverHandlers.get("get_character_storage")!.handler(args);
        else if (exposedName === "get_character_professions") result = compactForeverProfessions(await selected.handler({ ...args, version: "forever" }), args);
        else result = await selected.handler({ ...args, version: "forever" });
        if (exposedName === "list_forever_characters") {
          const listed = result as { structuredContent?: { characters?: Array<Record<string, unknown>> } };
          const structured = listed.structuredContent;
          if (structured?.characters) {
            const characters = structured.characters.map((character) => ({ ...character, race: character.race || "UNKNOWN", sex: "UNKNOWN" }));
            result = textResult({ ...structured, characters });
          }
        }
        if (exposedName === "get_character_state") {
          const stateResult = result as { structuredContent?: Record<string, any> };
          const state = stateResult.structuredContent;
          const identity = state?.value?.data?.identity as Record<string, unknown> | undefined;
          if (identity) {
            const character = readModel().listCharacters({ version: "forever", realm: String(args.realm) }).find((entry) => entry.name.toLowerCase() === String(args.name).toLowerCase());
            result = textResult({ ...state!, value: { ...state!.value, data: { ...state!.value.data, identity: { ...identity, race: character?.race || "UNKNOWN", sex: "UNKNOWN" } } } });
          }
        }
        const serialized = JSON.stringify((result as { structuredContent?: unknown })?.structuredContent ?? result);
        return serialized.length <= MAX_DOCUMENT_CHARACTERS ? result : textResult({ error: { code: "RESULT_TOO_LARGE", message: "The result exceeds the 40,000-character Forever MCP limit." }, truncated: true });
      }) as never);
    }
  }

  return {
    server,
    async close() {
      try { await server.close(); } finally { closeStore(); }
    },
  };
}
