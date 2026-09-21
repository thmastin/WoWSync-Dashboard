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
  SharedStorageIntegrityError,
  WowSyncParseError,
  diffSnapshots,
  summarizeTrainerCategory,
  type AccountContext,
  type ItemMetadataResponse,
  type SnapshotStore,
  type StoredSnapshot,
  type TrainerUnlock,
  type VersionOrUnknown,
} from "@wowsync-dashboard/core";
import { askOpenAI, AskError, DEFAULT_MODEL, MAX_QUESTION_LENGTH } from "./llm.ts";
import { hostGuard } from "./net.ts";
import { integrityErrorBody, registerSharedStorageRoutes } from "./sharedStorageRoutes.ts";

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

export interface CreateAppOptions {
  /**
   * Where THIS server can reach itself (used by /api/ask to fetch its own
   * /api/account-context). Defaults to http://127.0.0.1:<port>; index.ts derives
   * it from the actual bind address (see net.ts loopbackOrigin).
   */
  selfOrigin?: string;
  /**
   * When set, only requests whose Host header (and, for state-changing
   * requests, Origin header) name one of these hostnames are served - a
   * DNS-rebinding guard for loopback binds (see net.ts hostGuard). Leave
   * unset when deliberately listening beyond loopback.
   */
  allowedHosts?: readonly string[];
}

export function createApp(store: SnapshotStore, port: number, webDistDir?: string, options: CreateAppOptions = {}): Express {
  const app = express();
  const selfOrigin = options.selfOrigin ?? `http://127.0.0.1:${port}`;
  if (options.allowedHosts) app.use(hostGuard(options.allowedHosts));
  app.use(express.json({ limit: "10mb" }));

  app.get("/api/versions", (_req, res) => {
    const summaries = store.listVersions();
    const byVersion = new Map(summaries.map((s) => [s.version, s]));
    const all = [...WOW_VERSIONS, "unknown-version" as const].map((version) => {
      const existing = byVersion.get(version);
      return (
        // A version with no characters has no gold/playtime totals at all - not "0" (see VersionSummary).
        existing ?? {
          version,
          characterCount: 0,
          charactersWithKnownGold: 0,
          charactersWithKnownPlaytime: 0,
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
    // An invalid limit must be an error, not a silently empty or truncated list.
    let limit: number | undefined;
    if (req.query.limit !== undefined) {
      const raw = req.query.limit;
      limit = typeof raw === "string" ? Number(raw) : NaN; // limit[]=1 / limit[a]=1 are arrays/objects, not a number
      if (typeof raw !== "string" || !/^\d+$/.test(raw) || limit < 1 || limit > 500) {
        return res.status(400).json({ error: 'Invalid "limit" query parameter: expected an integer from 1 to 500.' });
      }
    }
    res.json({ changes: store.recentChanges(version, limit) });
  });

  app.get("/api/versions/:version/account-facts", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    res.json({ facts: store.buildAccountFacts(version) });
  });

  // Item metadata (enrichment, never observation truth): the resolved, game-client-reported static facts per
  // base item id for ONE game version, with the Dashboard-derived expansion label. An item with no evidence is
  // absent (all facets UNKNOWN). A pure read; it changes no stored observation and is not part of any total,
  // search, diff, AccountContext or LLM context.
  app.get("/api/versions/:version/item-metadata", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    const body: ItemMetadataResponse = { schema: "item-metadata-1", version, items: store.listItemMetadata(version) };
    res.json(body);
  });

  // The canonical "Export Dashboard Context" payload — every known WoW
  // version in one deterministic JSON document. This is the exact object
  // the web UI's Copy/Download buttons serialize; there is no separate
  // representation for the API vs. the UI. `?now=<unix seconds>` is an
  // optional override (mainly for reproducible debugging/scripting) —
  // omitted, it defaults to the real wall clock.
  app.get("/api/account-context", (req, res) => {
    const rawNow = req.query.now;
    // An empty value ("?now=") would otherwise become 0 (the epoch), and an array/object is not a timestamp.
    const now = rawNow !== undefined ? (typeof rawNow === "string" && rawNow.trim() !== "" ? Number(rawNow) : NaN) : undefined;
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
      const contextRes = await fetch(`${selfOrigin}/api/account-context`);
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
    if (!character) return res.status(404).json({ error: "Character not found", code: "CHARACTER_NOT_FOUND" });
    res.json({ character });
  });

  // Permanently deletes ONE character and its entire snapshot history.
  //
  // Deliberately hard to trigger by accident: the request must carry a JSON
  // body whose `confirmIdentityKey` exactly equals the identity key in the
  // URL, so a stray/replayed/mistyped DELETE can never remove anything - a
  // caller has to state, twice, which character it means. There is no
  // bulk/wildcard form (the key is matched exactly, as data - never as a
  // pattern), so this can only ever affect a single character.
  //   400 - missing/malformed body or a confirmation that doesn't match
  //   404 - no such character (already deleted, or never existed)
  //   200 - { deleted: { identityKey, version, realm, name, snapshotsDeleted } }
  app.delete("/api/characters/:identityKey", (req, res) => {
    const { identityKey } = req.params;
    const confirm: unknown = req.body?.confirmIdentityKey;
    if (typeof confirm !== "string" || confirm.length === 0) {
      return res.status(400).json({
        error: 'Deleting a character requires confirmation: send {"confirmIdentityKey": "<identity key>"} in the request body, matching the key in the URL.',
      });
    }
    if (confirm !== identityKey) {
      return res.status(400).json({ error: "Confirmation does not match the character being deleted. Nothing was deleted." });
    }
    const deleted = store.deleteCharacter(identityKey);
    // The code lets a client tell "this server says the character is gone" from any other 404 (wrong server, proxy, old build).
    if (!deleted) {
      return res
        .status(404)
        .json({ error: "Character not found (it may already have been deleted).", code: "CHARACTER_NOT_FOUND" });
    }
    res.json({ deleted });
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
      // A damaged shared-storage journal blocks an import that touches that owner (the whole import is rolled back).
      if (err instanceof SharedStorageIntegrityError) {
        return res.status(500).json(integrityErrorBody(err, "The export was NOT imported."));
      }
      console.error(err);
      res.status(500).json({ error: "Unexpected error while importing the export." });
    }
  });

  registerSharedStorageRoutes(app, store);

  // Unknown API paths are JSON 404s like every other API error - never
  // Express's default HTML page (which the web client cannot tell from a
  // real answer).
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found.", code: "NOT_FOUND" });
  });

  if (webDistDir && existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDistDir, "index.html"));
    });
  }

  // Final error handler: every failure is JSON, and never leaks a stack
  // trace or filesystem path (Express's default page includes both).
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { type?: string; status?: number; statusCode?: number; message?: string } | null;
    if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON." });
    if (e?.type === "entity.too.large") return res.status(413).json({ error: "Request body is too large." });
    const status = e?.status ?? e?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      // e.g. a malformed percent-encoded URL: the client's mistake, said briefly.
      return res.status(status).json({ error: "Bad request." });
    }
    console.error("Unhandled server error:", e?.message ?? String(err));
    res.status(500).json({ error: "Internal server error." });
  });

  return app;
}
