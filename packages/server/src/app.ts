// Route registration, factored out of index.ts so it can be constructed
// directly in tests (an in-process Express app bound to an ephemeral
// port) without going through the process-level bootstrap (env loading,
// SIGINT handling, etc.) in index.ts.
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import {
  VERSION_LABELS,
  WOW_VERSIONS,
  WowSyncParseError,
  diffSnapshots,
  summarizeTrainerCategory,
  type AccountContext,
  type SnapshotStore,
  type StoredSnapshot,
  type TrainerUnlock,
  type VersionOrUnknown,
} from "@wowsync-dashboard/core";
import { askOpenAI, AskError, DEFAULT_MODEL, MAX_QUESTION_LENGTH } from "./llm.ts";

// Attaches a computed, non-authoritative `summary` to each trainer
// category (STORE EVERYTHING, SURFACE WHAT MATTERS): the raw `services`
// array is left completely untouched for drill-down, this only adds a
// derived view alongside it.
function withTrainerSummaries(snapshot: StoredSnapshot): StoredSnapshot {
  return {
    ...snapshot,
    parsed: {
      ...snapshot.parsed,
      trainer: {
        ...snapshot.parsed.trainer,
        categories: snapshot.parsed.trainer.categories.map((category) => ({
          ...category,
          summary: summarizeTrainerCategory(category),
        })),
      },
    },
  };
}

function isKnownVersion(v: string): v is VersionOrUnknown {
  return (WOW_VERSIONS as readonly string[]).includes(v) || v === "unknown-version";
}

export function createApp(store: SnapshotStore, port: number, webDistDir?: string): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/api/versions", (_req, res) => {
    const summaries = store.listVersions();
    const byVersion = new Map(summaries.map((s) => [s.version, s]));
    const all = [...WOW_VERSIONS, "unknown-version" as const].map((version) => {
      const existing = byVersion.get(version);
      return (
        existing ?? {
          version,
          characterCount: 0,
          totalMoneyCopper: 0,
          charactersWithKnownGold: 0,
          totalPlayedSeconds: 0,
          charactersWithKnownPlaytime: 0,
          lastUpdatedAt: undefined,
        }
      );
    });
    res.json({ versions: all, labels: VERSION_LABELS });
  });

  app.get("/api/versions/:version/characters", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    res.json({ characters: store.listCharacters(version) });
  });

  app.get("/api/versions/:version/recent-changes", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ changes: store.recentChanges(version, limit) });
  });

  app.get("/api/versions/:version/account-facts", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    res.json({ facts: store.buildAccountFacts(version) });
  });

  // The canonical "Export Dashboard Context" payload — all three known WoW
  // versions in one deterministic JSON document. This is the exact object
  // the web UI's Copy/Download buttons serialize; there is no separate
  // representation for the API vs. the UI. `?now=<unix seconds>` is an
  // optional override (mainly for reproducible debugging/scripting) —
  // omitted, it defaults to the real wall clock.
  app.get("/api/account-context", (req, res) => {
    const now = req.query.now !== undefined ? Number(req.query.now) : undefined;
    if (now !== undefined && !Number.isFinite(now)) {
      return res.status(400).json({ error: `Invalid "now" query parameter: must be a Unix timestamp in seconds.` });
    }
    res.json(store.buildAccountContext(now));
  });

  // "Ask My Account" (POC). Every request is independent - no conversation
  // history is kept or persisted. The ONLY data that leaves this machine is
  // the system prompt, the current AccountContext JSON, and the user's
  // question, sent once to the configured LLM provider. The API key never
  // reaches the browser; it's read from the server's own environment.
  //
  // The context is retrieved via an actual HTTP call to this server's own
  // GET /api/account-context (not a second, divergent call path) - the
  // exact same canonical document the Copy/Download feature produces. If
  // that call fails, the request fails outright; it never silently falls
  // back to a stale or differently-built context.
  app.post("/api/ask", async (req, res) => {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (question.length === 0) {
      return res.status(400).json({ error: "Missing question." });
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return res.status(400).json({ error: `Question is too long (max ${MAX_QUESTION_LENGTH} characters).` });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error:
          "OPENAI_API_KEY is not configured on the server. Set it in a local .env file (see README) or as an environment variable, then restart the server.",
      });
    }

    let context: AccountContext;
    try {
      const contextRes = await fetch(`http://127.0.0.1:${port}/api/account-context`);
      if (!contextRes.ok) throw new Error(`account-context request returned HTTP ${contextRes.status}`);
      context = (await contextRes.json()) as AccountContext;
    } catch (err) {
      console.error("Ask My Account: failed to retrieve the account context:", err instanceof Error ? err.message : String(err));
      return res.status(502).json({ error: "Could not retrieve the current account context. Try again." });
    }

    const model = process.env.WOWSYNC_LLM_MODEL?.trim() || DEFAULT_MODEL;
    try {
      const result = await askOpenAI(question, context, { apiKey, model });
      const contextSummary = {
        characterCount: Object.values(context.versions).reduce((sum, v) => sum + v.characters.length, 0),
        versions: Object.keys(context.versions),
      };
      res.json({
        answer: result.answer,
        model: result.model,
        contextGeneratedAt: result.contextGeneratedAt,
        contextSummary,
        usage: result.usage,
      });
    } catch (err) {
      if (err instanceof AskError) {
        return res.status(err.status).json({ error: err.publicMessage });
      }
      console.error("Ask My Account: unexpected error:", err instanceof Error ? err.message : String(err));
      res.status(502).json({ error: "The LLM provider request failed unexpectedly." });
    }
  });

  app.get("/api/characters/:identityKey", (req, res) => {
    const character = store.getCharacter(req.params.identityKey);
    if (!character) return res.status(404).json({ error: "Character not found" });
    res.json({ character });
  });

  app.get("/api/characters/:identityKey/snapshots", (req, res) => {
    // Newest first. For each snapshot (other than the oldest), also compute
    // what newly unlocked at the trainer since the immediately preceding
    // one — a small, cheap fact, not an elaborate history feature.
    const raw = store.listSnapshots(req.params.identityKey);
    const snapshots = raw.map((snapshot, i) => {
      const older = raw[i + 1];
      const trainerUnlocksSincePrevious: TrainerUnlock[] | undefined = older
        ? diffSnapshots(older.parsed, snapshot.parsed).trainerUnlocks
        : undefined;
      return { ...withTrainerSummaries(snapshot), trainerUnlocksSincePrevious };
    });
    res.json({ snapshots });
  });

  app.get("/api/snapshots/:id", (req, res) => {
    const snapshot = store.getSnapshot(Number(req.params.id));
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
    res.json({ snapshot: withTrainerSummaries(snapshot) });
  });

  app.post("/api/import", (req, res) => {
    const text = req.body?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "Missing export text. Paste a WOWSYNC v1 export and try again." });
    }
    try {
      const result = store.importSnapshot(text);
      res.json({
        result: {
          ...result,
          snapshot: withTrainerSummaries(result.snapshot),
          previousSnapshot: result.previousSnapshot ? withTrainerSummaries(result.previousSnapshot) : undefined,
        },
      });
    } catch (err) {
      if (err instanceof WowSyncParseError) {
        return res.status(422).json({ error: err.message });
      }
      console.error(err);
      res.status(500).json({ error: "Unexpected error while importing the export." });
    }
  });

  if (webDistDir && existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDistDir, "index.html"));
    });
  }

  return app;
}
