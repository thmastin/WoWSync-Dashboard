import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildErpFulfillmentTriage, buildErpPortfolioFulfillmentReview, buildErpNeedReviewSnapshot, buildErpProcurementBudgetPortfolioReview, buildErpResourceCommitmentSummary, DashboardReadModel, ErpProjectConflictError, ErpProjectValidationError, ERP_WORK_ORDER_TYPES, WOW_VERSIONS, type ErpReservation, type ErpWorkOrder, type SnapshotStore, type WowVersion } from "@wowsync-dashboard/core";
import { buildErpNeedObservationChangeReview } from "@wowsync-dashboard/core/erpObservationChanges.ts";

function isVersion(value: string): value is WowVersion { return (WOW_VERSIONS as readonly string[]).includes(value); }

/** Local Dashboard planning-state API. It records intent only and never sends actions to the game. */
export function registerErpProjectRoutes(app: Express, store: SnapshotStore): void {
  const read = (version: WowVersion) => new DashboardReadModel(store).getErpProjects({ version });
  app.get("/api/versions/:version/erp/projects", (req, res) => {
    const { version } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const projects = read(version);
    res.json({ version, projects, resourceCommitments: buildErpResourceCommitmentSummary(projects), observationChanges: buildErpNeedObservationChangeReview(projects, version), fulfillmentTriage: buildErpFulfillmentTriage(projects, version), portfolioFulfillment: buildErpPortfolioFulfillmentReview(projects, version), procurementBudgetReview: buildErpProcurementBudgetPortfolioReview(projects, version) });
  });
  app.post("/api/versions/:version/erp/projects", (req, res) => {
    const { version } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const body = req.body ?? {};
    try {
      const project = store.createErpProject({ version, title: body.title, objective: body.objective, priority: body.priority, status: body.status, needs: body.needs, reservations: body.reservations, workOrders: body.workOrders });
      res.status(201).json({ project: new DashboardReadModel(store).getErpProjects({ version }).find((entry) => entry.stableId === project.stableId) });
    } catch (err) {
      if (err instanceof ErpProjectConflictError) return res.status(409).json({ error: err.message, code: err.code });
      if (err instanceof ErpProjectValidationError || err instanceof TypeError) return res.status(400).json({ error: err.message, code: err instanceof ErpProjectValidationError ? err.code : "INVALID_PROJECT" });
      throw err;
    }
  });
  app.post("/api/versions/:version/erp/work-order-batches", (req, res) => {
    const { version } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const updates = req.body?.updates;
    if (!Array.isArray(updates) || updates.length < 1 || updates.length > 10) return res.status(400).json({ error: "Select work for 1 to 10 projects in one game version.", code: "INVALID_WORK_ORDER_BATCH" });
    const ids = new Set<string>();
    const selectedNeeds = new Set<string>();
    const workOrdersByProject: Array<{ projectId: string; expectedRevision: number; workOrders: ErpWorkOrder[]; reviewSnapshots: NonNullable<ReturnType<typeof buildErpNeedReviewSnapshot>>[]; reservations: Array<ErpReservation | undefined> }> = [];
    const projectViews = new Map(read(version).map((project) => [project.stableId, project]));
    const portfolioDependencyGraph = new Map<string, string[]>();
    const needNode = (projectId: string, needId: string) => JSON.stringify([projectId, needId]);
    for (const project of projectViews.values()) for (const order of project.workOrders) {
      for (const needId of order.resourceNeedIds) {
        const node = needNode(project.stableId, needId);
        portfolioDependencyGraph.set(node, [...(portfolioDependencyGraph.get(node) ?? []), ...(order.portfolioPrerequisites ?? []).map((reference) => needNode(reference.projectId, reference.needId))]);
      }
    }
    let totalOrders = 0;
    try {
      for (const update of updates) {
        if (!update || typeof update !== "object" || typeof update.projectId !== "string" || !update.projectId.trim() || !Number.isSafeInteger(update.expectedRevision) || !Array.isArray(update.tasks) || update.tasks.length < 1) return res.status(400).json({ error: "Every project group requires an ID, expected revision, and at least one task.", code: "INVALID_WORK_ORDER_BATCH" });
        if (ids.has(update.projectId)) return res.status(400).json({ error: "Each project may appear only once in a grouped update.", code: "DUPLICATE_PROJECT" });
        ids.add(update.projectId);
        const project = projectViews.get(update.projectId);
        if (!project) return res.status(404).json({ error: "A selected project was not found in this version.", code: "PROJECT_NOT_FOUND" });
        if (project.status !== "ACTIVE") return res.status(409).json({ error: "Refresh and select only active projects before saving grouped work.", code: "PROJECT_NOT_ACTIVE" });
        if (project.revision !== update.expectedRevision) return res.status(409).json({ error: "A selected project changed after review. Refresh the triage before saving.", code: "ERP_PROJECT_CONFLICT" });
        const openNeedIds = new Set(project.workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED").flatMap((order) => order.resourceNeedIds));
        const workOrders: ErpWorkOrder[] = [];
        const reviewSnapshots: NonNullable<ReturnType<typeof buildErpNeedReviewSnapshot>>[] = [];
        const reservations: Array<ErpReservation | undefined> = [];
        for (const task of update.tasks) {
          totalOrders++;
          if (!task || typeof task !== "object" || typeof task.needId !== "string" || typeof task.title !== "string" || typeof task.instructions !== "string" || typeof task.kind !== "string" || !(ERP_WORK_ORDER_TYPES as readonly string[]).includes(task.kind) || task.title.trim().length < 1 || task.title.length > 160 || task.instructions.trim().length < 1 || task.instructions.length > 3500 || !task.reviewSnapshot || typeof task.reviewSnapshot !== "object") return res.status(400).json({ error: "Each grouped task requires a supported work type, bounded title/instructions, and the evidence snapshot reviewed by the player.", code: "INVALID_WORK_ORDER_BATCH_TASK" });
          const needKey = `${project.stableId}:${task.needId}`;
          if (selectedNeeds.has(needKey)) return res.status(400).json({ error: "A requirement may appear only once in a grouped update.", code: "DUPLICATE_PROJECT_NEED" });
          selectedNeeds.add(needKey);
          const need = project.needs.find((entry) => entry.stableId === task.needId);
          if (!need) return res.status(409).json({ error: "A selected requirement changed or was removed. Refresh the triage before saving.", code: "NEED_REVIEW_STALE" });
          if (openNeedIds.has(need.stableId)) return res.status(409).json({ error: "A selected requirement already has an open work order. Refresh the triage before saving.", code: "NEED_ALREADY_HAS_OPEN_WORK" });
          const currentReview = buildErpNeedReviewSnapshot(project, need.stableId);
          if (!currentReview || !isDeepStrictEqual(task.reviewSnapshot, currentReview)) return res.status(409).json({ error: `Evidence or saved source intent for ${need.label} changed after review. Refresh before creating a manual work order.`, code: "NEED_REVIEW_STALE" });
          reviewSnapshots.push(currentReview);
          let portfolioPrerequisites: NonNullable<ErpWorkOrder["portfolioPrerequisites"]> = [];
          if (task.portfolioPrerequisites !== undefined) {
            if (!Array.isArray(task.portfolioPrerequisites) || task.portfolioPrerequisites.length > 10) return res.status(400).json({ error: "A manual step may name at most 10 same-version portfolio prerequisite needs.", code: "INVALID_PORTFOLIO_PREREQUISITES" });
            const refs = new Set<string>();
            for (const reference of task.portfolioPrerequisites) {
              if (!reference || typeof reference.projectId !== "string" || typeof reference.needId !== "string") return res.status(400).json({ error: "Each portfolio prerequisite must name a project and need.", code: "INVALID_PORTFOLIO_PREREQUISITES" });
              const key = needNode(reference.projectId, reference.needId);
              if (refs.has(key) || key === needNode(project.stableId, need.stableId)) return res.status(400).json({ error: "Portfolio prerequisites must be unique and cannot refer to the task's own requirement.", code: "INVALID_PORTFOLIO_PREREQUISITES" });
              refs.add(key);
              const prerequisiteProject = projectViews.get(reference.projectId);
              if (!prerequisiteProject || !prerequisiteProject.needs.some((entry) => entry.stableId === reference.needId)) return res.status(409).json({ error: "A portfolio prerequisite is missing from the explicitly selected game version; refresh the project review.", code: "PORTFOLIO_PREREQUISITE_STALE" });
            }
            portfolioPrerequisites = task.portfolioPrerequisites.map((reference: { projectId: string; needId: string }) => ({ projectId: reference.projectId, needId: reference.needId }));
          }
          const taskNode = needNode(project.stableId, need.stableId);
          portfolioDependencyGraph.set(taskNode, [...(portfolioDependencyGraph.get(taskNode) ?? []), ...portfolioPrerequisites.map((reference) => needNode(reference.projectId, reference.needId))]);
          let reservation: ErpReservation | undefined;
          if (task.reservationQuantity !== undefined) {
            if (!Number.isSafeInteger(task.reservationQuantity) || task.reservationQuantity < 1 || task.reservationQuantity > 1_000_000_000) return res.status(400).json({ error: "A requested reservation quantity must be a positive bounded integer.", code: "INVALID_RESERVATION_REQUEST" });
            const sourceIdentityKey = need.sourceIdentityKey;
            const sourceOwnerKey = need.sourceOwnerKey;
            const evidence = currentReview.evidence;
            if ((!sourceIdentityKey && !sourceOwnerKey) || need.kind === "PROFESSION" || need.kind === "RECIPE" || !evidence || evidence.freshness !== "recent" || evidence.observedQuantity === undefined || evidence.unresolvedSections.length || evidence.unknownQuantityRowCount || !evidence.sourceSections.length || evidence.sourceSections.some((section) => section.state !== "OBSERVED" || section.completeness?.toLowerCase() !== "complete")) return res.status(409).json({ error: "Reservation requires a named source and recent, complete, fully quantified observations. Existing work and stock remain unchanged.", code: "RESERVATION_EVIDENCE_UNAVAILABLE" });
            reservation = { stableId: `erp_reserve_${randomUUID()}`, needId: need.stableId, ...(sourceIdentityKey ? { sourceIdentityKey } : {}), ...(sourceOwnerKey ? { sourceOwnerKey } : {}), quantity: task.reservationQuantity, status: "ACTIVE", createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000) };
          }
          reservations.push(reservation);
          const assignedIdentityKey = task.assignedIdentityKey;
          if (assignedIdentityKey !== undefined && (typeof assignedIdentityKey !== "string" || !store.listCharacters(version).some((character) => character.identityKey === assignedIdentityKey))) return res.status(400).json({ error: "Assigned character must be an observed character identity in this explicit game version.", code: "INVALID_WORK_ORDER_ASSIGNMENT" });
          let procurementPlan: ErpWorkOrder["procurementPlan"];
          if (task.spendingCeilingCopper !== undefined) {
            if (!Number.isSafeInteger(task.spendingCeilingCopper) || task.spendingCeilingCopper < 1 || task.spendingCeilingCopper > 1_000_000_000) return res.status(400).json({ error: "A procurement ceiling must be a positive bounded whole-copper amount.", code: "INVALID_PROCUREMENT_PLAN" });
            if (task.kind !== "PURCHASE" || (need.kind !== "ITEM_ID" && need.kind !== "ITEM_REF") || !assignedIdentityKey || need.sourceIdentityKey !== assignedIdentityKey || need.destinationIdentityKey !== assignedIdentityKey || need.sourceOwnerKey) return res.status(400).json({ error: "A structured purchase plan requires a PURCHASE task and an item need explicitly sourced from and intended for its same-version assigned buyer.", code: "INVALID_PROCUREMENT_PLAN" });
            procurementPlan = { targetNeedId: need.stableId, spendingCeilingCopper: task.spendingCeilingCopper };
          }
          const sourceLeadIdentityKey = task.sourceLeadIdentityKey;
          if (sourceLeadIdentityKey !== undefined && (typeof sourceLeadIdentityKey !== "string" || task.kind !== "INVESTIGATE" || !currentReview.resourceSourceScreen?.candidates.some((candidate) => candidate.sourceIdentityKey === sourceLeadIdentityKey))) return res.status(400).json({ error: "An investigation source lead must match a currently reviewed same-version candidate; it does not establish ownership, access, or transferability.", code: "INVALID_SOURCE_INVESTIGATION_LEAD" });
          const boundary = "SYSTEM EVIDENCE BOUNDARY: This is player-authored planning intent only. WoWSync did not execute or verify an in-game action. Recheck current version-specific requirements, evidence, ownership, access, routes, prices, and outcomes manually; unknowns remain UNKNOWN.";
          const instructions = `${task.instructions.trim()}\n\n${boundary}`;
          if (instructions.length > 4000) return res.status(400).json({ error: "Instructions plus the required evidence boundary exceed the work-order limit.", code: "INVALID_WORK_ORDER_TEXT" });
          workOrders.push({ stableId: `erp_work_${randomUUID()}`, kind: task.kind as ErpWorkOrder["kind"], status: "PLANNED", title: task.title.trim(), instructions, resourceNeedIds: [need.stableId], dependsOn: [], ...(portfolioPrerequisites.length ? { portfolioPrerequisites } : {}), ...(assignedIdentityKey ? { assignedIdentityKey } : {}), ...(need.sourceIdentityKey ? { sourceIdentityKey: need.sourceIdentityKey } : {}), ...(sourceLeadIdentityKey ? { investigationSourceLeadIdentityKey: sourceLeadIdentityKey } : {}), ...(need.destinationIdentityKey ? { destinationIdentityKey: need.destinationIdentityKey } : {}), ...(procurementPlan ? { procurementPlan } : {}) });
        }
        workOrdersByProject.push({ projectId: project.stableId, expectedRevision: update.expectedRevision, workOrders, reviewSnapshots, reservations });
      }
      if (totalOrders < 1 || totalOrders > 20) return res.status(400).json({ error: "A grouped update must contain between 1 and 20 work orders.", code: "INVALID_WORK_ORDER_BATCH" });
      const visiting = new Set<string>(); const visited = new Set<string>();
      const hasCycle = (node: string): boolean => { if (visiting.has(node)) return true; if (visited.has(node)) return false; visiting.add(node); for (const dependency of portfolioDependencyGraph.get(node) ?? []) if (hasCycle(dependency)) return true; visiting.delete(node); visited.add(node); return false; };
      if ([...portfolioDependencyGraph.keys()].some(hasCycle)) return res.status(400).json({ error: "The selected portfolio prerequisites create a dependency cycle. No work or reservation was saved.", code: "PORTFOLIO_DEPENDENCY_CYCLE" });
      const saved = store.appendErpWorkOrdersAtomically(version, workOrdersByProject);
      if (!saved) return res.status(404).json({ error: "A selected project was removed before the grouped update could be committed.", code: "PROJECT_NOT_FOUND" });
      return res.json({ version, projects: read(version).filter((project) => ids.has(project.stableId)), createdCount: totalOrders, atomic: true });
    } catch (err) {
      if (err instanceof ErpProjectConflictError) return res.status(409).json({ error: err.message, code: err.code });
      if (err instanceof ErpProjectValidationError || err instanceof TypeError) return res.status(400).json({ error: err.message, code: err instanceof ErpProjectValidationError ? err.code : "INVALID_WORK_ORDER_BATCH" });
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
