// HTTP routes for Explicit Demand (Azeroth ERP Vertical Slice 1) and Allocation Review (Slice 2).
//
//   GET    /api/versions/:version/demands                        every demand (any status) for one version
//   POST   /api/versions/:version/demands                        create an ACTIVE STOCK_TARGET demand
//   PATCH  /api/versions/:version/demands/:stableId              update requiredQuantity/purpose
//   POST   /api/versions/:version/demands/:stableId/deactivate   set status to INACTIVE (no hard delete)
//   GET    /api/versions/:version/allocation-review              account allocation review (Retail-only, Dashboard UI read)
//
// Demand is durable USER INTENT, not a WoW observation (see core/demand.ts). This is deliberately the
// smallest possible Dashboard-owned surface: no generalized Projects API, no arbitrary SQL/state
// mutation, and MCP never reaches any of these routes (it only ever holds a SnapshotReadStore). The
// allocation-review route is the Dashboard's narrow second consumer of DashboardReadModel (MCP is the first);
// the rest of the Dashboard UI keeps reading the AccountFacts/AccountContext routes.
import type { Express } from "express";
import { DashboardReadModel, DemandConflictError, DemandValidationError, type ExplicitDemand, type SnapshotStore, type VersionOrUnknown } from "@wowsync-dashboard/core";

const MAX_QUERY_LENGTH = 200;

function isKnownVersion(v: string): v is VersionOrUnknown {
  // Demand is Retail-only in Slice 1; the route still validates against every known version so an
  // unrecognized version string gets the same 400 every other /api/versions/:version route gives,
  // rather than a confusing demand-specific error.
  return v === "retail" || v === "classic-era" || v === "tbc-anniversary" || v === "forever" || v === "unknown-version";
}

export function registerDemandRoutes(app: Express, store: SnapshotStore): void {
  app.get("/api/versions/:version/gear-candidates", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    res.json(new DashboardReadModel(store).getGearCandidateEvidence({ version }));
  });
  app.get("/api/versions/:version/gear-allocation", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    const identityKey = req.query.exporterIdentityKey;
    const snapshotIdRaw = req.query.snapshotId;
    const rowOrdinalRaw = req.query.rowOrdinal;
    if (typeof identityKey !== "string" || !identityKey || typeof snapshotIdRaw !== "string" || !/^\d+$/.test(snapshotIdRaw) || typeof rowOrdinalRaw !== "string" || !/^\d+$/.test(rowOrdinalRaw)) return res.status(400).json({ error: "exporterIdentityKey, positive snapshotId, and positive rowOrdinal are required.", code: "INVALID_CANDIDATE_REFERENCE" });
    res.json(new DashboardReadModel(store).analyzeRetailGearCandidate({ version, exporterIdentityKey: identityKey, snapshotId: Number(snapshotIdRaw), rowOrdinal: Number(rowOrdinalRaw) }));
  });
  app.get("/api/versions/:version/demands", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    res.json({ demands: store.listDemands(version) });
  });

  app.post("/api/versions/:version/demands", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    if (version !== "retail") {
      return res.status(400).json({ error: "Explicit demand is Retail-only in this slice.", code: "UNSUPPORTED_VERSION" });
    }
    const body = req.body ?? {};
    try {
      const demand = store.createDemand({
        demandType: body.demandType,
        baseItemId: body.baseItemId,
        requiredQuantity: body.requiredQuantity,
        purpose: body.purpose,
      });
      res.status(201).json({ demand });
    } catch (err) {
      if (err instanceof DemandConflictError) {
        return res.status(409).json({ error: err.message, code: err.code, existingStableId: err.existingStableId });
      }
      if (err instanceof DemandValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  // A mutation names its demand by (route version, stableId). The demand is looked up and checked BEFORE the
  // store is asked to change anything: a demand of another version is not found through this route (404, nothing
  // mutated), and an INACTIVE demand is historical state that is never edited or re-deactivated (409, nothing
  // mutated). There is no reactivation and no hard delete; a new target is a new demand through POST.
  function findDemandForMutation(version: VersionOrUnknown, stableId: string): { demand: ExplicitDemand } | { status: number; body: { error: string; code: string } } {
    const demand = store.listDemands(version).find((d) => d.stableId === stableId);
    if (!demand) return { status: 404, body: { error: "Demand not found", code: "DEMAND_NOT_FOUND" } };
    if (demand.status !== "ACTIVE") return { status: 409, body: { error: "This demand is inactive (removed); it is kept as history and cannot be changed. Set a new target instead.", code: "DEMAND_INACTIVE" } };
    return { demand };
  }

  app.patch("/api/versions/:version/demands/:stableId", (req, res) => {
    const { version, stableId } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    const found = findDemandForMutation(version, stableId);
    if (!("demand" in found)) return res.status(found.status).json(found.body);
    const body = req.body ?? {};
    try {
      const demand = store.updateDemand(stableId, { requiredQuantity: body.requiredQuantity, purpose: body.purpose });
      if (!demand) return res.status(404).json({ error: "Demand not found", code: "DEMAND_NOT_FOUND" });
      res.json({ demand });
    } catch (err) {
      if (err instanceof DemandValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.post("/api/versions/:version/demands/:stableId/deactivate", (req, res) => {
    const { version, stableId } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    const found = findDemandForMutation(version, stableId);
    if (!("demand" in found)) return res.status(found.status).json(found.body);
    const demand = store.deactivateDemand(stableId);
    if (!demand) return res.status(404).json({ error: "Demand not found", code: "DEMAND_NOT_FOUND" });
    res.json({ demand });
  });

  // The Dashboard Allocation tab's read: the SAME DashboardReadModel.getAllocationReview MCP's
  // get_allocation_review serves, over this server's store (a SnapshotStore is a SnapshotReadStore). The route
  // only validates and forwards; it recomputes nothing and returns the ReadValue (data + provenance) as is, so a
  // non-Retail version answers UNKNOWN provenance with no data, exactly as the read model does.
  app.get("/api/versions/:version/allocation-review", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    const paging: Record<string, number | undefined> = {};
    for (const [name, min] of [["demandedOffset", 0], ["demandedLimit", 1], ["unallocatedOffset", 0], ["unallocatedLimit", 1]] as const) {
      const raw = req.query[name];
      if (raw === undefined) continue;
      const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(value) || value < min) {
        return res.status(400).json({ error: `"${name}" must be ${min === 0 ? "a non-negative" : "a positive"} integer.`, code: "INVALID_PAGING" });
      }
      paging[name] = value;
    }
    const rawQ = req.query.q;
    if (rawQ !== undefined && (typeof rawQ !== "string" || rawQ.length > MAX_QUERY_LENGTH)) {
      return res.status(400).json({ error: `"q" must be a single search string of at most ${MAX_QUERY_LENGTH} characters.`, code: "INVALID_QUERY" });
    }
    res.json(new DashboardReadModel(store).getAllocationReview({ version, ...paging, ...(rawQ !== undefined ? { q: rawQ } : {}) }));
  });
}
