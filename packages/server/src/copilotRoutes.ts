import express, { type Express } from "express";
import { ForeverKnowledgeStore } from "@wowsync-dashboard/core/foreverKnowledgeStore.ts";
import { ForeverPriceStore } from "@wowsync-dashboard/core/foreverPriceStore.ts";
import { foreverPriceTargets } from "@wowsync-dashboard/core/foreverPrices.ts";
import { answerForeverCopilot, collectForeverObservedIds, DashboardReadModel, type CopilotEmphasis, type CopilotObjective, type CopilotRequest, type SnapshotStore } from "@wowsync-dashboard/core";

const OBJECTIVES: readonly CopilotObjective[] = ["IMPROVE_CHARACTER", "MAKE_GOLD", "DEVELOP_PROFESSIONS", "SELF_SUFFICIENCY", "LEVELING", "GEAR"];
const EMPHASES = ["IMMEDIATE_POWER", "SELF_SUFFICIENCY", "BALANCED"] as const;

const shortText = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** Validates a co-pilot request body. Returns an error message or the normalized request. */
export function parseCopilotBody(version: string, body: unknown): { error: string } | { request: CopilotRequest } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a JSON object body." };
  const input = body as Record<string, unknown>;
  if (!shortText(input.question, 2_000)) return { error: '"question" must be a non-empty string of at most 2000 characters.' };
  const request: CopilotRequest = { version, question: String(input.question).trim() };
  if (input.character !== undefined) {
    const character = input.character as Record<string, unknown>;
    if (!character || typeof character !== "object" || !shortText(character.name, 64) || (character.realm !== undefined && !shortText(character.realm, 64))) return { error: '"character" must be {"name": string, "realm"?: string}.' };
    request.character = { name: String(character.name).trim(), ...(character.realm !== undefined ? { realm: String(character.realm).trim() } : {}) };
  }
  if (input.realm !== undefined) {
    if (!shortText(input.realm, 64)) return { error: '"realm" must be a non-empty string.' };
    request.realm = String(input.realm).trim();
  }
  if (input.objectives !== undefined) {
    if (!Array.isArray(input.objectives) || input.objectives.length > OBJECTIVES.length || !input.objectives.every((value) => OBJECTIVES.includes(value as CopilotObjective))) return { error: `"objectives" must be an array of ${OBJECTIVES.join(", ")}.` };
    request.objectives = input.objectives as CopilotObjective[];
  }
  if (input.preferences !== undefined) {
    const preferences = input.preferences as Record<string, unknown>;
    if (!preferences || typeof preferences !== "object") return { error: '"preferences" must be an object.' };
    if (preferences.emphasis !== undefined && !EMPHASES.includes(preferences.emphasis as typeof EMPHASES[number])) return { error: `"preferences.emphasis" must be one of ${EMPHASES.join(", ")}.` };
    if (preferences.avoidSpending !== undefined && typeof preferences.avoidSpending !== "boolean") return { error: '"preferences.avoidSpending" must be a boolean.' };
    if (preferences.goals !== undefined && (!Array.isArray(preferences.goals) || preferences.goals.length > 10 || !preferences.goals.every((goal) => shortText(goal, 200)))) return { error: '"preferences.goals" must be up to 10 strings of at most 200 characters.' };
    request.preferences = { emphasis: preferences.emphasis as CopilotEmphasis | undefined, avoidSpending: preferences.avoidSpending as boolean | undefined, goals: preferences.goals as string[] | undefined };
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) return { error: '"limit" must be an integer from 1 to 20.' };
    request.limit = input.limit;
  }
  return { request };
}

/**
 * Read-only Forever Co-Pilot. POST because questions can be long; it never writes anything.
 * Other versions answer 422 rather than borrowing Forever reasoning.
 */
const marketRegion = () => (process.env.WOWSYNC_FOREVER_REGION ?? "us").toLowerCase();

export function registerCopilotRoutes(app: Express, store: SnapshotStore, knowledge?: ForeverKnowledgeStore, prices?: ForeverPriceStore) {
  // Private Forever knowledge bundle (see docs/FOREVER_COPILOT.md). Loopback API like every other route.
  app.get("/api/versions/forever/knowledge", (_req, res) => {
    if (!knowledge) return res.json({ installed: false, reason: "No knowledge path is configured for this server." });
    res.json(knowledge.status());
  });
  app.get("/api/versions/forever/knowledge/observed-ids", (_req, res) => {
    res.json(collectForeverObservedIds(new DashboardReadModel(store) as never));
  });
  app.put("/api/versions/forever/knowledge", express.raw({ type: "application/octet-stream", limit: "80mb" }), (req, res) => {
    if (!knowledge) return res.status(503).json({ error: "No knowledge path is configured for this server.", code: "KNOWLEDGE_UNCONFIGURED" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "Send the bundle as application/octet-stream.", code: "INVALID_KNOWLEDGE_BUNDLE" });
    try {
      res.json(knowledge.install(req.body.toString("utf8")));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid bundle.", code: "INVALID_KNOWLEDGE_BUNDLE" });
    }
  });

  // Forever Auction House prices (AHledger crowd-sourced scans), installed by the host refresh job.
  app.get("/api/versions/forever/prices", (_req, res) => {
    if (!prices) return res.json({ installed: false, reason: "No price path is configured for this server." });
    res.json(prices.status());
  });
  app.get("/api/versions/forever/prices/targets", (_req, res) => {
    const readModel = new DashboardReadModel(store);
    const index = knowledge?.get();
    const recipeSpells = index ? Object.values(index.bundle.recipesByProfession).flat().flatMap((id) => index.tooltipSpell(id) ?? []) : [];
    res.json({ region: marketRegion(), ...foreverPriceTargets(readModel.listCharacters({ version: "forever" }) as never, collectForeverObservedIds(readModel as never).items, recipeSpells, marketRegion()) });
  });
  app.put("/api/versions/forever/prices", express.raw({ type: "application/octet-stream", limit: "20mb" }), (req, res) => {
    if (!prices) return res.status(503).json({ error: "No price path is configured for this server.", code: "PRICES_UNCONFIGURED" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "Send the price bundle as application/octet-stream.", code: "INVALID_PRICE_BUNDLE" });
    try {
      res.json(prices.install(req.body.toString("utf8")));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid price bundle.", code: "INVALID_PRICE_BUNDLE" });
    }
  });

  app.post("/api/versions/:version/copilot", (req, res) => {
    const version = req.params.version;
    if (version !== "forever") return res.status(422).json({ error: "The co-pilot currently answers Forever questions only.", code: "VERSION_NOT_SUPPORTED" });
    const parsed = parseCopilotBody(version, req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error, code: "INVALID_COPILOT_REQUEST" });
    const answer = answerForeverCopilot(new DashboardReadModel(store), parsed.request, knowledge?.get(), prices?.get(), marketRegion());
    const status = answer.status === "ANSWERED" ? 200 : answer.status === "CHARACTER_NOT_FOUND" || answer.status === "NO_DATA" ? 404 : answer.status === "CHARACTER_AMBIGUOUS" ? 409 : 422;
    res.status(status).json(status === 200 ? answer : { ...answer, error: answer.message ?? answer.status, code: answer.status });
  });
}
