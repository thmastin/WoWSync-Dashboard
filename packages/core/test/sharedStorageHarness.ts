// Shared harness for the shared-storage STORE tests (C2 persistence, C3 deletion): a file-backed store
// plus a second raw connection (to look at the real tables and install failure triggers), a pinned wall
// clock, and small corpus builders. Not a test file (the test glob is *.test.ts).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import type { OwnerProjection, ProjectedObservation, SharedStorageProjection } from "../src/sharedStorage.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import type { TabSpec } from "./sharedStorageBuilders.ts";
import { renderExport, type ExportSpec } from "./sharedStorageExports.ts";

const dir = fileURLToPath(new URL("fixtures/", import.meta.url));
export const VIREK_1 = readFileSync(`${dir}sanitized/virek-warband-last-seen-1789965184.wowsync.txt`, "utf8");
export const VIREK_2 = readFileSync(`${dir}sanitized/virek-warband-last-seen-1789965777.wowsync.txt`, "utf8");

export const CLOCK_MS = 1_800_000_000_000; // after every export in this file
export const NOW = 1_800_000_100;
export const WARBAND_KEY = "retail::warband::local";
export const VIREK_KEY = "retail::cairne::virek";

// --- harness -----------------------------------------------------------------------------------------

export function harness() {
  mock.timers.enable({ apis: ["Date"], now: CLOCK_MS });
  const folder = mkdtempSync(join(tmpdir(), "wowsync-shared-"));
  const path = join(folder, "shared.sqlite");
  let store = new SqliteSnapshotStore(path);
  const raw = new DatabaseSync(path);
  const all = <T>(sql: string, ...params: (string | number)[]) => raw.prepare(sql).all(...params) as unknown as T[];
  const count = (table: string) => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  return {
    get store() {
      return store;
    },
    path,
    raw,
    all,
    imp: (spec: ExportSpec) => store.importSnapshot(renderExport(spec)),
    counts: () => ({
      characters: count("characters"),
      snapshots: count("snapshots"),
      observations: count("shared_observations"),
      sources: count("shared_observation_sources"),
    }),
    /** Closes and reopens the store on the same file (a server restart); `between` runs while it is closed. */
    reopen(between?: () => void) {
      store.close();
      between?.();
      store = new SqliteSnapshotStore(path);
    },
    cleanup() {
      try {
        raw.close();
        store.close();
        rmSync(folder, { recursive: true, force: true });
      } finally {
        mock.timers.reset();
      }
    },
  };
}
export type Harness = ReturnType<typeof harness>;

export function withHarness(fn: (h: Harness) => void): void {
  const h = harness();
  try {
    fn(h);
  } finally {
    h.cleanup();
  }
}

export const T = 1_790_000_000; // base observation time
export const mats = (qty = 5): Array<[string, number]> => [["Linen Cloth", qty]];
export const WIDE: TabSpec[] = [
  { id: 1, name: "Materials", items: [["Linen Cloth", 40]] },
  { id: 2, name: "Consumables", items: [["Health Potion", 10]] },
  { id: 3, name: "Officers", items: [["Officer Sword", 1]] },
  { id: 4, name: "Raid", items: [["Raid Flask", 20]] },
];
export const NARROW: TabSpec[] = [
  { id: 1, name: "Materials", items: [["Linen Cloth", 45]] },
  { id: 2, name: "Consumables", items: [["Health Potion", 10]] },
  { id: 3, name: "Officers", state: "INACCESSIBLE" },
  { id: 4, name: "Raid", state: "INACCESSIBLE" },
];

/** Order-independent, snapshot-id-independent summary of a projection (ids depend on arrival order; nothing else may). */
export function normalized(p: SharedStorageProjection): string {
  const obs = (o?: ProjectedObservation) =>
    o && {
      identity: o.identity,
      effective: o.effectiveObservedAt,
      completeness: o.completeness,
      hash: o.contentHash,
      hashVersion: o.contentHashVersion,
      live: o.liveAtExport,
      carrierStates: o.carrierStates,
      characters: o.sourceCharacterKeys,
      sources: o.sources
        .map((s) => [s.exportObservedAt, s.sourceIdentityKey, s.sourceName, s.sourceRealm, s.carrierState, s.snapshotVisit ?? "-"].join("|"))
        .sort(),
    };
  const owner = (o?: OwnerProjection) =>
    o && {
      ownerKey: o.ownerKey,
      current: obs(o.current),
      latestPartial: obs(o.latestPartial),
      broader: obs(o.broaderCoverageEarlier),
      conflict: o.conflict && { at: o.conflict.effectiveObservedAt, others: o.conflict.others.map(obs).sort((a, b) => a!.identity.localeCompare(b!.identity)) },
      counts: o.observationCount,
    };
  return JSON.stringify({ warband: owner(p.warband), guilds: p.guilds.map(owner) });
}
