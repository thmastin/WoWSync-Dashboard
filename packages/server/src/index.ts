import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  SqliteSnapshotStore,
  VERSION_LABELS,
  WOW_VERSIONS,
  WowSyncParseError,
  diffSnapshots,
  summarizeTrainerCategory,
  type StoredSnapshot,
  type TrainerUnlock,
  type VersionOrUnknown,
} from "@wowsync-dashboard/core";

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

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "../../../");
const dataDir = process.env.WOWSYNC_DATA_DIR ?? path.join(repoRoot, "data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.WOWSYNC_DB_PATH ?? path.join(dataDir, "wowsync.sqlite");

const store = new SqliteSnapshotStore(dbPath);
const app = express();
app.use(express.json({ limit: "10mb" }));

function isKnownVersion(v: string): v is VersionOrUnknown {
  return (WOW_VERSIONS as readonly string[]).includes(v) || v === "unknown-version";
}

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

const webDist = path.join(repoRoot, "packages", "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 4173);
app.listen(port, () => {
  console.log(`WoWSync Dashboard server listening on http://localhost:${port}`);
  console.log(`Database: ${dbPath}`);
  if (!existsSync(webDist)) {
    console.log(`(Web UI not built yet — run "npm run build:web", or run "npm run dev:web" for the dev server.)`);
  }
});

process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});
