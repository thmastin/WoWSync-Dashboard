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
// mutation, and MCP never reaches any of these routes (it only ever holds a SnapshotReadStore).
import type { Express } from "express";
import { DemandConflictError, DemandValidationError, DashboardReadModel, type SnapshotStore, type VersionOrUnknown } from "@wowsync-dashboard/core";

function isKnownVersion(v: string): v is VersionOrUnknown {
  // Demand is Retail-only in Slice 1; the route still validates against every known version so an
  // unrecognized version string gets the same 400 every other /api/versions/:version route gives,
  // rather than a confusing demand-specific error.
  return v === "retail" || v === "classic-era" || v === "tbc-anniversary" || v === "forever" || v === "unknown-version";
}

export function registerDemandRoutes(app: Express, store: SnapshotStore): void {
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

  app.patch("/api/versions/:version/demands/:stableId", (req, res) => {
    const { version, stableId } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    const body = req.body ?? {};
    try {
      const demand = store.updateDemand(stableId, { requiredQuantity: body.requiredQuantity, purpose: body.purpose });
      if (!demand) return res.status(404).json({ error: "Demand not found", code: "DEMAND_NOT_FOUND" });
      if (demand.gameVersion !== version) return res.status(404).json({ error: "Demand not found", code: "DEMAND_NOT_FOUND" });
      if (demand.status === "INACTIVE") return res.status(409).json({ error: "Cannot update an inactive demand", code: "DEMAND_INACTIVE" });
      res.json({ demand });
    } catch (err) {
      if (err instanceof DemandValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  // Not a delete: deactivation is a reversible status transition (a new demand can be created again),
  // unlike the destructive, confirmation-gated character/shared-storage deletions elsewhere in this API.
  app.post("/api/versions/:version/demands/:stableId/deactivate", (req, res) => {
    const { version, stableId } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });
    const demand = store.deactivateDemand(stableId);
    if (!demand) return res.status(404).json({ error: "Demand not found", code: "DEMAND_NOT_FOUND" });
    if (demand.gameVersion !== version) return res.status(404).json({ error: "Demand not found", code: "DEMAND_NOT_FOUND" });
    if (demand.status === "INACTIVE") return res.status(409).json({ error: "Demand is already inactive", code: "DEMAND_INACTIVE" });
    res.json({ demand });
  });

  // Azeroth ERP Allocation Review: account-wide review for Dashboard UI. Retail-only read-only route.
  app.get("/api/versions/:version/allocation-review", (req, res) => {
    const { version } = req.params;
    if (!isKnownVersion(version)) return res.status(400).json({ error: `Unknown version "${version}"` });

    const demandedOffset = req.query.demandedOffset ? parseInt(req.query.demandedOffset as string, 10) : undefined;
    const demandedLimit = req.query.demandedLimit ? parseInt(req.query.demandedLimit as string, 10) : undefined;
    const unallocatedOffset = req.query.unallocatedOffset ? parseInt(req.query.unallocatedOffset as string, 10) : undefined;
    const unallocatedLimit = req.query.unallocatedLimit ? parseInt(req.query.unallocatedLimit as string, 10) : undefined;

    if (demandedOffset !== undefined && (!Number.isSafeInteger(demandedOffset) || demandedOffset < 0)) {
      return res.status(400).json({ error: "demandedOffset must be a non-negative integer", code: "INVALID_PAGING" });
    }
    if (demandedLimit !== undefined && (!Number.isSafeInteger(demandedLimit) || demandedLimit < 1)) {
      return res.status(400).json({ error: "demandedLimit must be a positive integer", code: "INVALID_PAGING" });
    }
    if (unallocatedOffset !== undefined && (!Number.isSafeInteger(unallocatedOffset) || unallocatedOffset < 0)) {
      return res.status(400).json({ error: "unallocatedOffset must be a non-negative integer", code: "INVALID_PAGING" });
    }
    if (unallocatedLimit !== undefined && (!Number.isSafeInteger(unallocatedLimit) || unallocatedLimit < 1)) {
      return res.status(400).json({ error: "unallocatedLimit must be a positive integer", code: "INVALID_PAGING" });
    }

    const readModel = new DashboardReadModel(store);
    const result = readModel.getAllocationReview({
      version: version as VersionOrUnknown,
      demandedOffset,
      demandedLimit,
      unallocatedOffset,
      unallocatedLimit,
    });

    res.json(result);
  });
}
