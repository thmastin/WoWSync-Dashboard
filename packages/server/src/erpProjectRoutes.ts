import type { Express } from "express";
import { buildErpResourceCommitmentSummary, DashboardReadModel, ErpProjectConflictError, ErpProjectValidationError, WOW_VERSIONS, type SnapshotStore, type WowVersion } from "@wowsync-dashboard/core";

function isVersion(value: string): value is WowVersion { return (WOW_VERSIONS as readonly string[]).includes(value); }

/** Local Dashboard planning-state API. It records intent only and never sends actions to the game. */
export function registerErpProjectRoutes(app: Express, store: SnapshotStore): void {
  const read = (version: WowVersion) => new DashboardReadModel(store).getErpProjects({ version });
  app.get("/api/versions/:version/erp/projects", (req, res) => {
    const { version } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const projects = read(version);
    res.json({ version, projects, resourceCommitments: buildErpResourceCommitmentSummary(projects) });
  });
  app.post("/api/versions/:version/erp/projects", (req, res) => {
    const { version } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const body = req.body ?? {};
    try {
      const project = store.createErpProject({ version, title: body.title, objective: body.objective, priority: body.priority, status: body.status, needs: body.needs, reservations: body.reservations, workOrders: body.workOrders });
      res.status(201).json({ project: new DashboardReadModel(store).getErpProjects({ version }).find((entry) => entry.stableId === project.stableId) });
    } catch (err) {
      if (err instanceof ErpProjectValidationError || err instanceof TypeError) return res.status(400).json({ error: err.message, code: err instanceof ErpProjectValidationError ? err.code : "INVALID_PROJECT" });
      throw err;
    }
  });
  app.put("/api/versions/:version/erp/projects/:stableId", (req, res) => {
    const { version, stableId } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const existing = store.getErpProject(stableId);
    if (!existing || existing.version !== version) return res.status(404).json({ error: "Project not found in this version.", code: "PROJECT_NOT_FOUND" });
    const body = req.body ?? {};
    if (!Number.isSafeInteger(body.expectedRevision) || !body.project || typeof body.project !== "object") return res.status(400).json({ error: "expectedRevision and a complete project document are required.", code: "INVALID_PROJECT_UPDATE" });
    try {
      const submitted = body.project;
      const next = {
        stableId, version, createdAt: existing.createdAt, updatedAt: existing.updatedAt, revision: existing.revision,
        title: submitted.title, objective: submitted.objective, status: submitted.status, completionNote: submitted.completionNote, priority: submitted.priority,
        needs: submitted.needs, reservations: submitted.reservations, workOrders: submitted.workOrders,
      };
      const project = store.updateErpProject(next, body.expectedRevision);
      if (!project) return res.status(404).json({ error: "Project not found.", code: "PROJECT_NOT_FOUND" });
      res.json({ project: read(version).find((entry) => entry.stableId === stableId) });
    } catch (err) {
      if (err instanceof ErpProjectConflictError) return res.status(409).json({ error: err.message, code: err.code });
      if (err instanceof ErpProjectValidationError || err instanceof TypeError) return res.status(400).json({ error: err.message, code: err instanceof ErpProjectValidationError ? err.code : "INVALID_PROJECT" });
      throw err;
    }
  });
  app.patch("/api/versions/:version/erp/projects/:stableId/status", (req, res) => {
    const { version, stableId } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const existing = store.getErpProject(stableId);
    if (!existing || existing.version !== version) return res.status(404).json({ error: "Project not found in this version.", code: "PROJECT_NOT_FOUND" });
    try {
      const project = store.setErpProjectStatus(stableId, req.body?.status, req.body?.expectedRevision);
      if (!project) return res.status(404).json({ error: "Project not found.", code: "PROJECT_NOT_FOUND" });
      res.json({ project: read(version).find((entry) => entry.stableId === stableId) });
    } catch (err) {
      if (err instanceof ErpProjectConflictError) return res.status(409).json({ error: err.message, code: err.code });
      if (err instanceof ErpProjectValidationError || err instanceof TypeError) return res.status(400).json({ error: err.message, code: err instanceof ErpProjectValidationError ? err.code : "INVALID_PROJECT" });
      throw err;
    }
  });
}
