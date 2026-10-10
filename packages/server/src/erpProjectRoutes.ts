import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildErpFulfillmentTriage, buildErpPortfolioFulfillmentReview, buildErpSourceFulfillmentReview, buildErpPortfolioNextActionReview, buildErpNeedReviewSnapshot, buildErpProcurementBudgetPortfolioReview, buildErpProcurementBuyerPortfolioReview, buildErpResourceCommitmentSummary, DashboardReadModel, ErpProjectConflictError, ErpProjectValidationError, ERP_NEED_FULFILLMENT_OPTION_KINDS, ERP_WORK_ORDER_TYPES, WOW_VERSIONS, type ErpNeedFulfillmentOptionKind, type ErpReservation, type ErpWorkOrder, type SnapshotStore, type WowVersion } from "@wowsync-dashboard/core";
import { buildErpNeedObservationChangeReview } from "@wowsync-dashboard/core/erpObservationChanges.ts";

function isVersion(value: string): value is WowVersion { return (WOW_VERSIONS as readonly string[]).includes(value); }

/** Local Dashboard planning-state API. It records intent only and never sends actions to the game. */
export function registerErpProjectRoutes(app: Express, store: SnapshotStore): void {
  const read = (version: WowVersion) => new DashboardReadModel(store).getErpProjects({ version });
  app.get("/api/versions/:version/erp/projects", (req, res) => {
    const { version } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const projects = read(version);
    res.json({ version, projects, resourceCommitments: buildErpResourceCommitmentSummary(projects), observationChanges: buildErpNeedObservationChangeReview(projects, version), fulfillmentTriage: buildErpFulfillmentTriage(projects, version), portfolioFulfillment: buildErpPortfolioFulfillmentReview(projects, version), sourceFulfillment: buildErpSourceFulfillmentReview(projects, version), portfolioNextActions: buildErpPortfolioNextActionReview(projects, version), procurementBudgetReview: buildErpProcurementBudgetPortfolioReview(projects, version), procurementBuyerReview: buildErpProcurementBuyerPortfolioReview(projects, version) });
  });
  app.post("/api/versions/:version/erp/projects", (req, res) => {
    const { version } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const body = req.body ?? {};
    try {
      if (Array.isArray(body.workOrders) && body.workOrders.some((order: unknown) => Boolean(order && typeof order === "object" && "planningBatch" in order))) return res.status(400).json({ error: "Planning batch identity and evidence baselines are assigned only when the server atomically confirms a grouped plan.", code: "PLANNING_BATCH_SERVER_CREATED" });
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
    const replanFrom = req.body?.replanFrom as { batchId?: unknown; needReferences?: unknown } | undefined;
    if (!Array.isArray(updates) || updates.length < 1 || updates.length > 10) return res.status(400).json({ error: "Select work for 1 to 10 projects in one game version.", code: "INVALID_WORK_ORDER_BATCH" });
    const ids = new Set<string>();
    const selectedNeeds = new Set<string>();
    const workOrdersByProject: Array<{ projectId: string; expectedRevision: number; workOrders: ErpWorkOrder[]; reviewSnapshots: NonNullable<ReturnType<typeof buildErpNeedReviewSnapshot>>[]; reservations: Array<ErpReservation | undefined> }> = [];
    const planningBatchId = `erp_batch_${randomUUID()}`;
    const planningBatchReviewedAt = Math.floor(Date.now() / 1000);
    const projectViews = new Map(read(version).map((project) => [project.stableId, project]));
    let validatedReplanFrom: NonNullable<ErpWorkOrder["planningBatch"]>["replanFrom"];
    if (replanFrom !== undefined) {
      if (!replanFrom || typeof replanFrom.batchId !== "string" || !/^erp_batch_[0-9a-f-]{36}$/.test(replanFrom.batchId) || !Array.isArray(replanFrom.needReferences) || replanFrom.needReferences.length < 1 || replanFrom.needReferences.length > 20 || replanFrom.needReferences.some((ref: unknown) => !ref || typeof ref !== "object" || typeof (ref as {projectId?: unknown}).projectId !== "string" || !(ref as {projectId: string}).projectId.trim() || (ref as {projectId: string}).projectId.length > 120 || typeof (ref as {needId?: unknown}).needId !== "string" || !(ref as {needId: string}).needId.trim() || (ref as {needId: string}).needId.length > 120)) return res.status(400).json({ error: "A follow-up must identify one saved batch and 1 to 20 exact project/need references.", code: "INVALID_REPLAN_LINEAGE" });
      const references = replanFrom.needReferences as Array<{ projectId: string; needId: string }>;
      const referenceKeys = references.map((ref) => JSON.stringify([ref.projectId, ref.needId]));
      if (new Set(referenceKeys).size !== referenceKeys.length) return res.status(400).json({ error: "Follow-up requirement references must be unique.", code: "INVALID_REPLAN_LINEAGE" });
      const prior = buildErpPortfolioFulfillmentReview([...projectViews.values()], version, 100).savedPlanningBatches.find((batch) => batch.stableId === replanFrom.batchId);
      if (!prior || prior.version !== version || prior.lineageState === "FOLLOW_UP_CONTEXT_CONFLICT") return res.status(409).json({ error: "The prior planning batch is unavailable or has conflicting follow-up lineage in this version. Refresh the saved-plan review.", code: "REPLAN_SOURCE_BATCH_UNAVAILABLE" });
      for (const ref of references) {
        const reviewed = prior.steps.filter((step) => step.projectId === ref.projectId && step.needId === ref.needId);
        if (!reviewed.length || reviewed.some((step) => (step.workOrderStatus !== "COMPLETED" && step.workOrderStatus !== "CANCELLED") || step.evidenceReview === "NEED_IDENTITY_CHANGED") || !reviewed.some((step) => step.evidenceReview !== "NO_NEWER_OBSERVATION") || prior.state === "CONFLICTING_BATCH_CONTEXT") return res.status(409).json({ error: "Each carried requirement must belong to the selected saved batch, retain its identity, have reviewable later evidence, and have only terminal prior work.", code: "REPLAN_SOURCE_STEP_UNAVAILABLE" });
      }
      validatedReplanFrom = { batchId: replanFrom.batchId, needReferences: references.map(({ projectId, needId }) => ({ projectId, needId })) };
    }
    const pathwayKey = (projectId: string, needId: string) => JSON.stringify([projectId, needId]);
    const currentPathways = new Map(buildErpSourceFulfillmentReview([...projectViews.values()], version).sources.flatMap((source) => source.needs.map((need) => [pathwayKey(need.projectId, need.needId), need.fulfillmentPathways.options] as const)));
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
          let pathwayContext: ErpWorkOrder["pathwayContext"];
          if (task.pathwayKind !== undefined) {
            if (typeof task.pathwayKind !== "string" || !(ERP_NEED_FULFILLMENT_OPTION_KINDS as readonly string[]).includes(task.pathwayKind)) return res.status(400).json({ error: "A reviewed pathway must use a supported current option.", code: "INVALID_WORK_ORDER_PATHWAY" });
            const option = currentPathways.get(pathwayKey(project.stableId, need.stableId))?.find((entry) => entry.kind === task.pathwayKind);
            if (!option) return res.status(409).json({ error: `The reviewed fulfillment pathway for ${need.label} changed or is no longer supported. Refresh the evidence and review again.`, code: "WORK_ORDER_PATHWAY_STALE" });
            pathwayContext = { version, projectRevision: project.revision, needId: need.stableId, kind: option.kind, provenance: option.provenance, reviewedAt: Math.floor(Date.now() / 1000), reason: option.reason.slice(0, 1200), ...(option.observedLocation ? { observedLocation: option.observedLocation } : {}), ...(option.candidateLocations ? { candidateLocations: option.candidateLocations.slice(0, 25) } : {}) };
          }
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
          if (task.reservationSourceIdentityKey !== undefined && task.reservationQuantity === undefined) return res.status(400).json({ error: "A reservation source can be selected only with an explicit reservation quantity.", code: "INVALID_RESERVATION_SOURCE" });
          if (task.reservationQuantity !== undefined) {
            if (!Number.isSafeInteger(task.reservationQuantity) || task.reservationQuantity < 1 || task.reservationQuantity > 1_000_000_000) return res.status(400).json({ error: "A requested reservation quantity must be a positive bounded integer.", code: "INVALID_RESERVATION_REQUEST" });
            const sourceIdentityKey = task.reservationSourceIdentityKey ?? need.sourceIdentityKey;
            const sourceOwnerKey = task.reservationSourceIdentityKey ? undefined : need.sourceOwnerKey;
            const evidence = currentReview.evidence;
            const alternateSource = sourceIdentityKey !== need.sourceIdentityKey || sourceOwnerKey !== need.sourceOwnerKey;
            const candidate = alternateSource && sourceIdentityKey ? currentReview.resourceSourceScreen?.candidates.find((entry) => entry.sourceIdentityKey === sourceIdentityKey && entry.kind === need.kind && entry.resourceKey === need.resourceKey) : undefined;
            const exactRow = candidate?.matchingItems.some((item) => item.itemRef === need.resourceKey && item.state === "OBSERVED" && (item.quantity ?? item.knownLowerBound ?? 0) > 0) ?? false;
            if (alternateSource && (typeof task.reservationSourceIdentityKey !== "string" || task.reservationSourceIdentityKey !== task.provisioningSourceIdentityKey || task.kind !== "PROVISION" || need.kind !== "ITEM_REF" || need.sourceOwnerKey || !need.destinationIdentityKey || !candidate || candidate.state !== "OBSERVED" || candidate.freshness !== "recent" || candidate.reservationState !== "UNRESERVED" || candidate.activeReservationQuantity !== 0 || candidate.unresolvedSections.length || candidate.locations.length !== 2 || candidate.locations.some((location) => location.state !== "OBSERVED" || location.quantity === undefined) || !exactRow)) return res.status(409).json({ error: "Alternate-source reservation requires this PROVISION task's selected exact item source and recent complete quantified evidence. Existing work and stock remain unchanged.", code: "RESERVATION_EVIDENCE_UNAVAILABLE" });
            if (!alternateSource && ((!sourceIdentityKey && !sourceOwnerKey) || need.kind === "PROFESSION" || need.kind === "RECIPE" || !evidence || evidence.freshness !== "recent" || evidence.observedQuantity === undefined || evidence.unresolvedSections.length || evidence.unknownQuantityRowCount || !evidence.sourceSections.length || evidence.sourceSections.some((section) => section.state !== "OBSERVED" || section.completeness?.toLowerCase() !== "complete"))) return res.status(409).json({ error: "Reservation requires a named source and recent, complete, fully quantified observations. Existing work and stock remain unchanged.", code: "RESERVATION_EVIDENCE_UNAVAILABLE" });
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
          const provisioningSourceIdentityKey = task.provisioningSourceIdentityKey;
          if (provisioningSourceIdentityKey !== undefined) {
            if (typeof provisioningSourceIdentityKey !== "string" || task.kind !== "PROVISION" || need.kind !== "ITEM_REF" || need.sourceOwnerKey || !need.destinationIdentityKey?.startsWith(`${version}::`) || !provisioningSourceIdentityKey.startsWith(`${version}::`) || provisioningSourceIdentityKey === need.destinationIdentityKey) return res.status(400).json({ error: "A manual provisioning source requires a PROVISION task for one exact ITEM_REF need, an explicit same-version recipient, and a distinct same-version source.", code: "INVALID_PROVISIONING_SOURCE" });
            const candidate = currentReview.resourceSourceScreen?.candidates.find((entry) => entry.sourceIdentityKey === provisioningSourceIdentityKey && entry.kind === need.kind && entry.resourceKey === need.resourceKey);
            const exactObservedVariant = candidate?.matchingItems.some((item) => item.itemRef === need.resourceKey && item.state === "OBSERVED" && (item.quantity ?? item.knownLowerBound ?? 0) > 0);
            if (!candidate || candidate.state !== "OBSERVED" || candidate.freshness !== "recent" || candidate.reservationState !== "UNRESERVED" || candidate.activeReservationQuantity !== 0 || (candidate.availableObservedLowerBound ?? 0) < 1 || !exactObservedVariant) return res.status(409).json({ error: "A manual provisioning plan requires a current, recent, unreserved source observation of the exact item variant. No task, reservation, or resource change was saved.", code: "PROVISIONING_SOURCE_EVIDENCE_UNAVAILABLE" });
          }
          const boundary = "SYSTEM EVIDENCE BOUNDARY: This is player-authored planning intent only. WoWSync did not execute or verify an in-game action. Recheck current version-specific requirements, evidence, ownership, access, routes, prices, and outcomes manually; unknowns remain UNKNOWN.";
          const instructions = `${task.instructions.trim()}\n\n${boundary}`;
          if (instructions.length > 4000) return res.status(400).json({ error: "Instructions plus the required evidence boundary exceed the work-order limit.", code: "INVALID_WORK_ORDER_TEXT" });
          workOrders.push({ stableId: `erp_work_${randomUUID()}`, kind: task.kind as ErpWorkOrder["kind"], status: "PLANNED", title: task.title.trim(), instructions, resourceNeedIds: [need.stableId], dependsOn: [], planningBatch: { stableId: planningBatchId, reviewedAt: planningBatchReviewedAt, version, ...(validatedReplanFrom ? { replanFrom: validatedReplanFrom } : {}), needEvidence: { resourceKind: need.kind, resourceKey: need.resourceKey, sourceScope: need.sourceOwnerKey ? { kind: "SHARED_OWNER" as const, ownerKey: need.sourceOwnerKey } : need.sourceIdentityKey ? { kind: "CHARACTER" as const, identityKey: need.sourceIdentityKey } : { kind: "UNSCOPED" as const }, ...(currentReview.evidence ? { state: currentReview.evidence.state, freshness: currentReview.evidence.freshness, ...(currentReview.evidence.observedQuantity !== undefined ? { observedQuantity: currentReview.evidence.observedQuantity } : {}), ...(currentReview.evidence.observedAt !== undefined ? { observedAt: currentReview.evidence.observedAt } : {}) } : { state: "UNKNOWN", freshness: "unknown" }) } }, ...(portfolioPrerequisites.length ? { portfolioPrerequisites } : {}), ...(pathwayContext ? { pathwayContext } : {}), ...(assignedIdentityKey ? { assignedIdentityKey } : {}), ...((provisioningSourceIdentityKey ?? need.sourceIdentityKey) ? { sourceIdentityKey: provisioningSourceIdentityKey ?? need.sourceIdentityKey } : {}), ...(sourceLeadIdentityKey ? { investigationSourceLeadIdentityKey: sourceLeadIdentityKey } : {}), ...(need.destinationIdentityKey ? { destinationIdentityKey: need.destinationIdentityKey } : {}), ...(procurementPlan ? { procurementPlan } : {}) });
        }
        workOrdersByProject.push({ projectId: project.stableId, expectedRevision: update.expectedRevision, workOrders, reviewSnapshots, reservations });
      }
      if (totalOrders < 1 || totalOrders > 20) return res.status(400).json({ error: "A grouped update must contain between 1 and 20 work orders.", code: "INVALID_WORK_ORDER_BATCH" });
      if (validatedReplanFrom) {
        const selected = new Set(workOrdersByProject.flatMap((group) => group.workOrders.flatMap((order) => order.resourceNeedIds.map((needId) => JSON.stringify([group.projectId, needId])))));
        if (validatedReplanFrom.needReferences.some((reference) => !selected.has(JSON.stringify([reference.projectId, reference.needId])))) return res.status(400).json({ error: "A confirmed follow-up must include every exact requirement the player carried forward from the prior batch.", code: "REPLAN_LINEAGE_NEED_OMITTED" });
      }
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
  app.post("/api/versions/:version/erp/provisioning-review-batches", (req, res) => {
    const { version } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const { buyerIdentityKey, sourceIdentityKey, resourceKey, tasks } = req.body ?? {};
    if (typeof buyerIdentityKey !== "string" || !buyerIdentityKey.startsWith(`${version}::`) || typeof sourceIdentityKey !== "string" || !sourceIdentityKey.startsWith(`${version}::`) || sourceIdentityKey === buyerIdentityKey || typeof resourceKey !== "string" || !/^item:[1-9]\d*(?::[^\s]*)?$/.test(resourceKey)) return res.status(400).json({ error: "A batch requires one same-version buyer, a different same-version source, and one exact itemString resource identity.", code: "INVALID_PROVISIONING_REVIEW_BATCH" });
    if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 20 || tasks.some((task) => !task || typeof task !== "object" || typeof task.projectId !== "string" || !task.projectId.trim())) return res.status(400).json({ error: "Select 2 to 20 linked requirements across at least two projects for a grouped provisioning review.", code: "INVALID_PROVISIONING_REVIEW_BATCH" });
    const requestedProjectIds = new Set(tasks.map((task) => task.projectId.trim()));
    if (requestedProjectIds.size < 2 || requestedProjectIds.size > 10) return res.status(400).json({ error: "A grouped provisioning review must span 2 to 10 distinct projects.", code: "INVALID_PROVISIONING_REVIEW_BATCH" });
    const knownCharacters = new Set(store.listCharacters(version).map((character) => character.identityKey));
    if (!knownCharacters.has(buyerIdentityKey) || !knownCharacters.has(sourceIdentityKey)) return res.status(409).json({ error: "The buyer and source must both resolve to observed characters in this explicit game version.", code: "PROVISIONING_CHARACTER_UNRESOLVED" });
    const projectViews = new Map(read(version).map((project) => [project.stableId, project]));
    const selectedNeeds = new Set<string>();
    const selectedProjectIds = new Set<string>();
    const selectedProjects = new Map<string, { expectedRevision: number; workOrders: ErpWorkOrder[]; reviewSnapshots: NonNullable<ReturnType<typeof buildErpNeedReviewSnapshot>>[] }>();
    let skippedExistingCount = 0;
    try {
      for (const task of tasks) {
        if (!task || typeof task !== "object" || typeof task.projectId !== "string" || !task.projectId.trim() || typeof task.needId !== "string" || !task.needId.trim() || !Number.isSafeInteger(task.expectedRevision)) return res.status(400).json({ error: "Each review must identify a project, requirement, and expected revision.", code: "INVALID_PROVISIONING_REVIEW_BATCH_TASK" });
        const project = projectViews.get(task.projectId);
        if (!project) return res.status(404).json({ error: "A selected project was not found in this version.", code: "PROJECT_NOT_FOUND" });
        selectedProjectIds.add(project.stableId);
        if (project.status !== "ACTIVE") return res.status(409).json({ error: "A selected project is no longer active; refresh the buyer package.", code: "PROJECT_NOT_ACTIVE" });
        if (project.revision !== task.expectedRevision) return res.status(409).json({ error: "A selected project changed after review. Refresh the buyer package.", code: "ERP_PROJECT_CONFLICT" });
        const needKey = `${project.stableId}:${task.needId}`;
        if (selectedNeeds.has(needKey)) return res.status(400).json({ error: "A requirement may appear only once in one provisioning batch.", code: "DUPLICATE_PROJECT_NEED" });
        selectedNeeds.add(needKey);
        const need = project.needs.find((entry) => entry.stableId === task.needId);
        if (!need || need.kind !== "ITEM_REF" || need.resourceKey !== resourceKey || need.sourceOwnerKey || need.destinationIdentityKey !== buyerIdentityKey) return res.status(409).json({ error: "Every selected requirement must keep the exact same itemString and intended buyer; broad item IDs and owner-scoped needs cannot join this package.", code: "PROVISIONING_NEED_SCOPE_MISMATCH" });
        const review = buildErpNeedReviewSnapshot(project, need.stableId);
        if (!review) return res.status(409).json({ error: "The selected requirement changed; refresh the buyer package.", code: "NEED_REVIEW_STALE" });
        const candidate = review.resourceSourceScreen?.candidates.find((entry) => entry.sourceIdentityKey === sourceIdentityKey && entry.kind === "ITEM_REF" && entry.resourceKey === resourceKey);
        const hasExactObservedItem = candidate?.matchingItems.some((item) => item.itemRef === resourceKey && item.state === "OBSERVED" && (item.quantity ?? item.knownLowerBound ?? 0) > 0) ?? false;
        if (!candidate || candidate.state !== "OBSERVED" || candidate.freshness !== "recent" || candidate.reservationState !== "UNRESERVED" || candidate.activeReservationQuantity !== 0 || (candidate.availableObservedLowerBound ?? 0) < 1 || !hasExactObservedItem) return res.status(409).json({ error: "A recent, positively observed, exact-variant, unreserved source lead is required for every selected buyer requirement.", code: "PROVISIONING_SOURCE_EVIDENCE_UNAVAILABLE" });
        const duplicate = project.workOrders.some((order) => order.kind === "PROVISION" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(need.stableId) && order.sourceIdentityKey === sourceIdentityKey && order.destinationIdentityKey === buyerIdentityKey);
        if (duplicate) { skippedExistingCount++; continue; }
        const exactRows = candidate.matchingItems.filter((item) => item.itemRef === resourceKey && item.state === "OBSERVED" && (item.quantity ?? item.knownLowerBound ?? 0) > 0);
        const observed = exactRows.map((item) => `${item.itemRef} in ${item.section}${item.observedAt !== undefined ? `, observed ${new Date(item.observedAt * 1000).toISOString()}` : ", time UNKNOWN"}${item.quantity !== undefined ? `, quantity ${item.quantity}` : `, at least ${item.knownLowerBound}`}`).join("; ");
        const boundary = `This manual review uses a recent observed location lead for ${sourceIdentityKey}: ${observed}. It does not establish ownership, account membership, access, binding, or a valid transfer route. Recheck both characters and the exact itemString in game. No item is reserved or moved; later changes do not prove this review caused them.`;
        const group = selectedProjects.get(project.stableId) ?? { expectedRevision: project.revision, workOrders: [], reviewSnapshots: [] };
        group.workOrders.push({ stableId: `erp_work_${randomUUID()}`, kind: "PROVISION", status: "PLANNED", title: `Review ${resourceKey} source for ${need.label}`, instructions: boundary, resourceNeedIds: [need.stableId], dependsOn: [], assignedIdentityKey: buyerIdentityKey, sourceIdentityKey, destinationIdentityKey: buyerIdentityKey });
        group.reviewSnapshots.push(review);
        selectedProjects.set(project.stableId, group);
      }
      if (selectedProjectIds.size > 10) return res.status(400).json({ error: "A grouped provisioning review may span at most 10 projects.", code: "INVALID_PROVISIONING_REVIEW_BATCH" });
      if (selectedProjects.size) {
        const updates = [...selectedProjects].map(([projectId, group]) => ({ projectId, expectedRevision: group.expectedRevision, workOrders: group.workOrders, reviewSnapshots: group.reviewSnapshots }));
        const saved = store.appendErpWorkOrdersAtomically(version, updates);
        if (!saved) return res.status(404).json({ error: "A selected project was removed before the grouped update could be committed.", code: "PROJECT_NOT_FOUND" });
      }
      return res.json({ version, projects: read(version).filter((project) => selectedProjectIds.has(project.stableId)), createdCount: [...selectedProjects.values()].reduce((sum, group) => sum + group.workOrders.length, 0), skippedExistingCount, atomic: true });
    } catch (err) {
      if (err instanceof ErpProjectConflictError) return res.status(409).json({ error: err.message, code: err.code });
      if (err instanceof ErpProjectValidationError || err instanceof TypeError) return res.status(400).json({ error: err.message, code: err instanceof ErpProjectValidationError ? err.code : "INVALID_PROVISIONING_REVIEW_BATCH" });
      throw err;
    }
  });
  app.post("/api/versions/:version/erp/reservation-replans", (req, res) => {
    const { version } = req.params;
    if (!isVersion(version)) return res.status(400).json({ error: "A supported explicit version is required.", code: "INVALID_VERSION" });
    const body = req.body ?? {};
    if (!Array.isArray(body.projects) || body.projects.length < 1 || body.projects.length > 10 || body.projects.some((entry: unknown) => !entry || typeof entry !== "object" || typeof (entry as { projectId?: unknown }).projectId !== "string" || !Number.isSafeInteger((entry as { expectedRevision?: unknown }).expectedRevision) || !Array.isArray((entry as { reservations?: unknown }).reservations))) return res.status(400).json({ error: "Provide 1 to 10 project revision snapshots and complete reservation lists.", code: "INVALID_RESERVATION_REPLAN" });
    if (new Set(body.projects.map((entry: { projectId: string }) => entry.projectId)).size !== body.projects.length) return res.status(400).json({ error: "Each project may appear only once in a reservation replan.", code: "INVALID_RESERVATION_REPLAN" });
    let changedReservationCount = 0;
    try {
      const updates = [];
      for (const entry of body.projects as { projectId: string; expectedRevision: number; reservations: unknown[] }[]) {
        const existing = store.getErpProject(entry.projectId);
        if (!existing || existing.version !== version) return res.status(404).json({ error: "A selected project was not found in this version.", code: "PROJECT_NOT_FOUND" });
        if (existing.revision !== entry.expectedRevision) return res.status(409).json({ error: "A selected project changed after review. Reload the current reservation state.", code: "ERP_PROJECT_CONFLICT" });
        if (entry.reservations.length !== existing.reservations.length) return res.status(400).json({ error: "The review must preserve every existing reservation record.", code: "INVALID_RESERVATION_REPLAN" });
        const proposed = new Map<string, { stableId: string; quantity: number; status: string }>();
        for (const value of entry.reservations) {
          if (!value || typeof value !== "object") return res.status(400).json({ error: "Each proposed reservation needs an identity, quantity, and state.", code: "INVALID_RESERVATION_REPLAN" });
          const reservation = value as { stableId?: unknown; quantity?: unknown; status?: unknown };
          if (typeof reservation.stableId !== "string" || !Number.isSafeInteger(reservation.quantity) || !["ACTIVE", "RELEASED"].includes(String(reservation.status)) || proposed.has(reservation.stableId)) return res.status(400).json({ error: "Reservation changes require unique identities, integer quantities, and ACTIVE or RELEASED state.", code: "INVALID_RESERVATION_REPLAN" });
          proposed.set(reservation.stableId, reservation as { stableId: string; quantity: number; status: string });
        }
        if (existing.reservations.some((reservation) => !proposed.has(reservation.stableId))) return res.status(400).json({ error: "Every existing reservation must be included in the frozen review.", code: "INVALID_RESERVATION_REPLAN" });
        const reservations = existing.reservations.map((reservation) => {
          const next = proposed.get(reservation.stableId)!;
          if (next.status !== reservation.status || next.quantity !== reservation.quantity) changedReservationCount++;
          return { ...reservation, quantity: next.quantity, status: next.status as typeof reservation.status };
        });
        updates.push({ projectId: existing.stableId, expectedRevision: entry.expectedRevision, reservations });
      }
      const saved = store.replanErpReservationsAtomically(version, updates);
      if (!saved) return res.status(404).json({ error: "A selected project was removed before the reservation replan could be committed.", code: "PROJECT_NOT_FOUND" });
      return res.json({ version, projects: read(version).filter((project) => saved.some((entry) => entry.stableId === project.stableId)), changedReservationCount, atomic: true });
    } catch (err) {
      if (err instanceof ErpProjectConflictError) return res.status(409).json({ error: err.message, code: err.code });
      if (err instanceof ErpProjectValidationError || err instanceof TypeError) return res.status(400).json({ error: err.message, code: err instanceof ErpProjectValidationError ? err.code : "INVALID_RESERVATION_REPLAN" });
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
