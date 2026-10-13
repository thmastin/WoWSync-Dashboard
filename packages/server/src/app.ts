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
  DashboardReadModel,
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
import { hostGuard } from "./net.ts";
import { integrityErrorBody, registerSharedStorageRoutes } from "./sharedStorageRoutes.ts";
import { registerDemandRoutes } from "./demandRoutes.ts";
import { registerErpProjectRoutes } from "./erpProjectRoutes.ts";
import { registerErpChangeProposalRoutes } from "./erpChangeProposalRoutes.ts";
import { registerCopilotRoutes } from "./copilotRoutes.ts";
import { ForeverKnowledgeStore } from "@wowsync-dashboard/core/foreverKnowledgeStore.ts";
import { ForeverPriceStore } from "@wowsync-dashboard/core/foreverPriceStore.ts";

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
  /** File holding the private Forever knowledge bundle used by the co-pilot (optional). */
  foreverKnowledgePath?: string;
  /** File holding the Forever Auction House price bundle (AHledger), optional. */
  foreverPricesPath?: string;
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
  registerErpProjectRoutes(app, store);
  registerCopilotRoutes(app, store, options.foreverKnowledgePath ? new ForeverKnowledgeStore(options.foreverKnowledgePath) : undefined, options.foreverPricesPath ? new ForeverPriceStore(options.foreverPricesPath) : undefined);
  registerErpChangeProposalRoutes(app, store, selfOrigin);

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
    // HTTP-layer default of 20 when the query is omitted (keeps existing API clients bounded).
    // AccountFacts uses store.recentChanges(version) with no limit so realm scoping can see the full set.
    // An invalid limit must be an error, not a silently empty or truncated list.
    let limit = 20;
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
  // Account view of Retail currencies for ONE version, per currencyID: every character's value and state.
  // Account-wide currencies (isAccountWide) are reported once in `account`, never summed; character-scoped totals
  // sum KNOWN values only and are omitted when nothing is known (UNKNOWN is never zero).
  app.get("/api/versions/:version/currencies", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    res.json(store.listVersionCurrencies(version));
  });

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

  app.get("/api/characters/:identityKey", (req, res) => {
    const character = store.getCharacter(req.params.identityKey);
    if (!character) return res.status(404).json({ error: "Character not found", code: "CHARACTER_NOT_FOUND" });
    res.json({ character });
  });

  app.get("/api/characters/:identityKey/forever-gear-observation", (req, res) => {
    const character = store.getCharacter(req.params.identityKey);
    if (!character) return res.status(404).json({ error: "Character not found", code: "CHARACTER_NOT_FOUND" });
    const result = new DashboardReadModel(store).getForeverGearObservation({ version: character.version, name: character.name, realm: character.realm });
    if (result.status !== "FOUND") return res.status(404).json({ error: "Forever gear observation is not available for this character.", code: result.status });
    res.json(result);
  });

  app.get("/api/characters/:identityKey/forever-crafted-upgrade-assessment", (req, res) => {
    const character = store.getCharacter(req.params.identityKey);
    if (!character) return res.status(404).json({ error: "Character not found", code: "CHARACTER_NOT_FOUND" });
    if (character.version !== "forever") return res.status(404).json({ error: "Forever crafted-upgrade assessments are not available for this client version.", code: "VERSION_NOT_SUPPORTED" });
    let snapshotId: number | undefined;
    if (req.query.snapshotId !== undefined) {
      if (typeof req.query.snapshotId !== "string" || !/^\d+$/.test(req.query.snapshotId)) return res.status(400).json({ error: 'Invalid "snapshotId" query parameter: expected a positive integer.' });
      snapshotId = Number(req.query.snapshotId);
      if (!Number.isSafeInteger(snapshotId) || snapshotId < 1) return res.status(400).json({ error: 'Invalid "snapshotId" query parameter: expected a positive integer.' });
    }
    let result: ReturnType<DashboardReadModel["getForeverCraftedUpgradeAssessment"]>;
    try {
      result = new DashboardReadModel(store).getForeverCraftedUpgradeAssessment({ version: "forever", name: character.name, realm: character.realm, ...(snapshotId !== undefined ? { snapshotId } : {}) });
    } catch (error) {
      if (error instanceof TypeError) return res.status(400).json({ error: error.message, code: "INVALID_SNAPSHOT_SELECTION" });
      throw error;
    }
    res.json(result);
  });

  app.get("/api/characters/:identityKey/forever-quests", (req, res) => {
    const character = store.getCharacter(req.params.identityKey);
    if (!character) return res.status(404).json({ error: "Character not found", code: "CHARACTER_NOT_FOUND" });
    if (character.version !== "forever") return res.status(404).json({ error: "Forever quest observations are not available for this client version.", code: "VERSION_NOT_SUPPORTED" });
    let snapshotId: number | undefined;
    if (req.query.snapshotId !== undefined) {
      if (typeof req.query.snapshotId !== "string" || !/^\d+$/.test(req.query.snapshotId)) return res.status(400).json({ error: 'Invalid "snapshotId" query parameter: expected a positive integer.' });
      snapshotId = Number(req.query.snapshotId);
      if (!Number.isSafeInteger(snapshotId) || snapshotId < 1) return res.status(400).json({ error: 'Invalid "snapshotId" query parameter: expected a positive integer.' });
    }
    let result: ReturnType<DashboardReadModel["getForeverQuestObservation"]>;
    try {
      result = new DashboardReadModel(store).getForeverQuestObservation({ version: character.version, name: character.name, realm: character.realm, ...(snapshotId !== undefined ? { snapshotId } : {}) });
    } catch (error) {
      if (error instanceof TypeError) return res.status(400).json({ error: error.message, code: "INVALID_SNAPSHOT_SELECTION" });
      throw error;
    }
    if (result.status !== "FOUND") return res.status(404).json({ error: "Forever quest observations are not available for this character.", code: result.status });
    res.json(result);
  });

  app.get("/api/characters/:identityKey/forever-gear-allocation", (req, res) => {
    const character = store.getCharacter(req.params.identityKey);
    if (!character) return res.status(404).json({ error: "Character not found", code: "CHARACTER_NOT_FOUND" });
    if (character.version !== "forever") return res.status(404).json({ error: "Forever allocation is not available for this client version.", code: "VERSION_NOT_SUPPORTED" });
    const result = new DashboardReadModel(store).getForeverGearAllocation({ version: character.version, name: character.name, realm: character.realm });
    if (result.status !== "FOUND") return res.status(404).json({ error: "Forever allocation evidence is not available for this character.", code: result.status });
    res.json(result);
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

  // Retail currencies for one character, from the structured SavedVariables section stored with its snapshots:
  // state OBSERVED (latest snapshot, fresh), LAST_SEEN (older list, with its date) or UNKNOWN (never exported one -
  // `currencies` is null, never an empty/zero list). Absent fields are null.
  app.get("/api/characters/:identityKey/currencies", (req, res) => {
    const body = store.getCharacterCurrencies(req.params.identityKey);
    if (!body) return res.status(404).json({ error: "Character not found", code: "CHARACTER_NOT_FOUND" });
    res.json(body);
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
    // Optional structured data that travels with the text (the bridge's `currencies`, from WoWSyncDB ... sections.currencies).
    // It never changes how the text is parsed; the store validates it and reports what it did in result.currencies.
    const currencies: unknown = req.body?.currencies;
    const characterState: unknown = req.body?.characterState;
    const equipmentObservation: unknown = req.body?.equipmentObservation;
    const foreverGearObservation: unknown = req.body?.foreverGearObservation;
    try {
      const result = store.importSnapshot(text, { ...(currencies == null ? {} : { currencies }), ...(characterState == null ? {} : { characterState }), ...(equipmentObservation == null ? {} : { equipmentObservation }), ...(foreverGearObservation == null ? {} : { foreverGearObservation }) });
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
  registerDemandRoutes(app, store);

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
