import type { Express, Response } from "express";
import { erpChangeDigest, ErpProjectConflictError, type ErpChangeOperation, type ErpChangeProposal, type SnapshotStore, type WowVersion } from "@wowsync-dashboard/core";
import { DashboardReadModel, WOW_VERSIONS } from "@wowsync-dashboard/core";

const TTL_SECONDS = 30 * 60;
const MAX_MUTATION_BYTES = 64_000;
const isVersion = (value: string): value is WowVersion => (WOW_VERSIONS as readonly string[]).includes(value);
const asRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function targetFor(proposal: ErpChangeProposal): { method: string; path: string; body: Record<string, unknown> } {
  const base = `/api/versions/${encodeURIComponent(proposal.version)}/erp`;
  const body = proposal.mutation as Record<string, unknown>;
  switch (proposal.operation) {
    case "CREATE_PROJECT": return { method: "POST", path: `${base}/projects`, body };
    case "UPDATE_PROJECT_PLAN": {
      const projectId = proposal.projectIds[0]!;
      return { method: "PUT", path: `${base}/projects/${encodeURIComponent(projectId)}`, body: body.body as Record<string, unknown> };
    }
    case "SET_PROJECT_STATUS": {
      const projectId = proposal.projectIds[0]!;
      return { method: "PATCH", path: `${base}/projects/${encodeURIComponent(projectId)}/status`, body: body.body as Record<string, unknown> };
    }
    case "APPEND_WORK_ORDER_BATCH": return { method: "POST", path: `${base}/work-order-batches`, body };
    case "REPLAN_RESERVATIONS": return { method: "POST", path: `${base}/reservation-replans`, body };
  }
}

function deriveTarget(operation: ErpChangeOperation, mutation: Record<string, unknown>): { projectIds: string[]; expectedRevisions: Record<string, number> } {
  if (operation === "CREATE_PROJECT") return { projectIds: [], expectedRevisions: {} };
  if (operation === "UPDATE_PROJECT_PLAN" || operation === "SET_PROJECT_STATUS") {
    const projectId = typeof mutation.projectId === "string" ? mutation.projectId : undefined;
    const requestBody = mutation.body;
    const revision = asRecord(requestBody) ? requestBody.expectedRevision : undefined;
    if (!projectId || !Number.isSafeInteger(revision) || (revision as number) < 1) throw new TypeError("A project update must identify one project and its positive expected revision.");
    if (operation === "UPDATE_PROJECT_PLAN") {
      const project = asRecord(requestBody) ? requestBody.project : undefined;
      if (!asRecord(project) || project.stableId !== projectId || project.version === undefined) throw new TypeError("The proposed project must retain its exact stable identity.");
    }
    return { projectIds: [projectId], expectedRevisions: { [projectId]: revision as number } };
  }
  const key = operation === "APPEND_WORK_ORDER_BATCH" ? "updates" : "projects";
  const updates = mutation[key];
  if (!Array.isArray(updates) || updates.length < 1 || updates.length > 10) throw new TypeError("A grouped proposal must contain 1 to 10 project updates.");
  const projectIds: string[] = [];
  const expectedRevisions: Record<string, number> = {};
  for (const entry of updates) {
    if (!asRecord(entry) || typeof entry.projectId !== "string" || !Number.isSafeInteger(entry.expectedRevision) || (entry.expectedRevision as number) < 1 || projectIds.includes(entry.projectId)) throw new TypeError("Each grouped update must identify a distinct project and positive expected revision.");
    projectIds.push(entry.projectId);
    expectedRevisions[entry.projectId] = entry.expectedRevision as number;
  }
  return { projectIds, expectedRevisions };
}

function httpError(res: Response, status: number, code: string, error: string) {
  return res.status(status).json({ error, code });
}

export function registerErpChangeProposalRoutes(app: Express, store: SnapshotStore, selfOrigin: string): void {
  app.get("/api/versions/:version/erp/change-proposals", (req, res) => {
    if (!isVersion(req.params.version)) return httpError(res, 400, "INVALID_VERSION", "Select one supported game version.");
    res.json({ version: req.params.version, proposals: store.listErpChangeProposals(req.params.version) });
  });

  app.post("/api/versions/:version/erp/change-proposals", (req, res) => {
    const version = req.params.version;
    if (!isVersion(version)) return httpError(res, 400, "INVALID_VERSION", "Select one supported game version.");
    const body = req.body;
    if (!asRecord(body) || typeof body.proposalId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.proposalId) || !["CREATE_PROJECT", "UPDATE_PROJECT_PLAN", "SET_PROJECT_STATUS", "APPEND_WORK_ORDER_BATCH", "REPLAN_RESERVATIONS"].includes(String(body.operation)) || !asRecord(body.mutation) || typeof body.rationale !== "string" || !body.rationale.trim() || body.rationale.length > 2_000) return httpError(res, 400, "INVALID_CHANGE_PROPOSAL", "The proposal must include an ID, explicit operation, mutation object, and concise rationale.");
    const operation = body.operation as ErpChangeOperation;
    const mutationText = JSON.stringify(body.mutation);
    if (Buffer.byteLength(mutationText, "utf8") > MAX_MUTATION_BYTES) return httpError(res, 413, "PROPOSAL_TOO_LARGE", "The proposed change exceeds the 64 KB limit.");
    try {
      const { projectIds, expectedRevisions } = deriveTarget(operation, body.mutation);
      if (operation === "UPDATE_PROJECT_PLAN" && asRecord(body.mutation.project) && body.mutation.project.version !== version) return httpError(res, 400, "VERSION_MISMATCH", "The proposed project must remain in the selected version.");
      const current = new Map(store.listErpProjects(version).map((project) => [project.stableId, project]));
      for (const projectId of projectIds) {
        const project = current.get(projectId);
        if (!project) return httpError(res, 404, "PROJECT_NOT_FOUND", `Project ${projectId} was not found in ${version}.`);
        if (project.revision !== expectedRevisions[projectId]) return httpError(res, 409, "PROJECT_REVISION_CONFLICT", `Project ${projectId} is now revision ${project.revision}; refresh it before proposing a change.`);
      }
      const createdAt = Math.floor(Date.now() / 1000);
      const basis = { version, operation, projectIds, expectedRevisions, rationale: body.rationale.trim(), mutation: JSON.parse(mutationText) as Record<string, unknown> };
      const proposal: ErpChangeProposal = {
        proposalId: `proposal_${body.proposalId.toLowerCase()}`, ...basis,
        digest: erpChangeDigest(basis), status: "PENDING", createdAt, expiresAt: createdAt + TTL_SECONDS,
      };
      const saved = store.createErpChangeProposal(proposal);
      return res.status(201).json({ proposal: saved, playerAction: "Open Projects & Work Orders in this version, inspect the exact change, and approve it there before asking MCP to commit it." });
    } catch (error) {
      if (error instanceof ErpProjectConflictError) return httpError(res, 409, error.code, error.message);
      if (error instanceof TypeError) return httpError(res, 400, "INVALID_CHANGE_PROPOSAL", error.message);
      throw error;
    }
  });

  app.post("/api/versions/:version/erp/change-proposals/:proposalId/approve", (req, res) => {
    const { version, proposalId } = req.params;
    if (!isVersion(version)) return httpError(res, 400, "INVALID_VERSION", "Select one supported game version.");
    const proposal = store.getErpChangeProposal(proposalId);
    if (!proposal || proposal.version !== version) return httpError(res, 404, "PROPOSAL_NOT_FOUND", "This change proposal was not found in the selected version.");
    if (req.body?.digest !== proposal.digest) return httpError(res, 409, "PROPOSAL_DIGEST_MISMATCH", "The approval does not match the exact proposal shown. Nothing was approved.");
    if (proposal.expiresAt <= Math.floor(Date.now() / 1000)) return httpError(res, 410, "PROPOSAL_EXPIRED", "This proposal expired. Request a fresh review from MCP.");
    for (const projectId of proposal.projectIds) {
      const current = store.getErpProject(projectId);
      if (!current || current.version !== version || current.revision !== proposal.expectedRevisions[projectId]) return httpError(res, 409, "PROJECT_REVISION_CONFLICT", "A project changed after this proposal was prepared. Refresh and request a new proposal.");
    }
    const approved = store.transitionErpChangeProposal(proposalId, version, "PENDING", "APPROVED", { approvedAt: Math.floor(Date.now() / 1000), outcome: "Approved by an explicit Dashboard action for this exact digest." });
    if (!approved) return httpError(res, 409, "PROPOSAL_NOT_PENDING", "This proposal is no longer awaiting approval.");
    return res.json({ proposal: approved, message: "Approved exact change. Ask the Operations conversation to commit this proposal." });
  });

  app.post("/api/versions/:version/erp/change-proposals/:proposalId/reject", (req, res) => {
    const { version, proposalId } = req.params;
    if (!isVersion(version)) return httpError(res, 400, "INVALID_VERSION", "Select one supported game version.");
    const proposal = store.getErpChangeProposal(proposalId);
    if (!proposal || proposal.version !== version) return httpError(res, 404, "PROPOSAL_NOT_FOUND", "This change proposal was not found in the selected version.");
    if (req.body?.digest !== proposal.digest) return httpError(res, 409, "PROPOSAL_DIGEST_MISMATCH", "The response does not match the exact proposal shown.");
    const rejected = store.transitionErpChangeProposal(proposalId, version, "PENDING", "REJECTED", { completedAt: Math.floor(Date.now() / 1000), outcome: "Rejected by an explicit Dashboard action." });
    if (!rejected) return httpError(res, 409, "PROPOSAL_NOT_PENDING", "This proposal is no longer awaiting approval.");
    return res.json({ proposal: rejected, message: "Proposal rejected. No project change was made." });
  });

  app.post("/api/versions/:version/erp/change-proposals/:proposalId/commit", async (req, res) => {
    const { version, proposalId } = req.params;
    if (!isVersion(version)) return httpError(res, 400, "INVALID_VERSION", "Select one supported game version.");
    const proposal = store.getErpChangeProposal(proposalId);
    if (!proposal || proposal.version !== version) return httpError(res, 404, "PROPOSAL_NOT_FOUND", "This approved proposal was not found in the selected version.");
    if (req.body?.digest !== proposal.digest) return httpError(res, 409, "PROPOSAL_DIGEST_MISMATCH", "The commit does not match the exact approved payload.");
    if (proposal.status === "COMMITTED") return res.json({ proposal, result: proposal.result, replay: true });
    if (proposal.status === "COMMITTING") return httpError(res, 409, "COMMIT_OUTCOME_UNKNOWN", "A previous commit attempt may have reached the project store. It was not replayed; inspect the project before requesting a fresh proposal.");
    if (proposal.status !== "APPROVED") return httpError(res, 409, "APPROVAL_REQUIRED", "A separate Dashboard approval is required before this proposal can be committed.");
    if (proposal.expiresAt <= Math.floor(Date.now() / 1000)) return httpError(res, 410, "PROPOSAL_EXPIRED", "Approval expired. Request a fresh proposal.");
    for (const projectId of proposal.projectIds) {
      const current = store.getErpProject(projectId);
      if (!current || current.version !== version || current.revision !== proposal.expectedRevisions[projectId]) return httpError(res, 409, "PROJECT_REVISION_CONFLICT", "The project changed after approval. Nothing was committed; refresh and request a new proposal.");
    }
    const claimed = store.transitionErpChangeProposal(proposalId, version, "APPROVED", "COMMITTING", { outcome: "Commit claimed; safe to execute once." });
    if (!claimed) return httpError(res, 409, "PROPOSAL_NOT_APPROVED", "The proposal was already consumed or changed.");
    const target = targetFor(proposal);
    try {
      const url = new URL(target.path, selfOrigin);
      const response = await fetch(url, { method: target.method, headers: { "content-type": "application/json", host: url.host, origin: url.origin }, body: JSON.stringify(target.body), signal: AbortSignal.timeout(30_000) });
      const responseText = await response.text();
      const parsed = responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
      if (!response.ok) {
        store.transitionErpChangeProposal(proposalId, version, "COMMITTING", "FAILED", { completedAt: Math.floor(Date.now() / 1000), outcome: `Server validation rejected the approved proposal with HTTP ${response.status}; no retry is authorized.` });
        return res.status(response.status).json({ ...parsed, proposalId, approvalConsumed: true });
      }
      const completedAt = Math.floor(Date.now() / 1000);
      const result = parsed as Record<string, unknown>;
      const committed = store.transitionErpChangeProposal(proposalId, version, "COMMITTING", "COMMITTED", { completedAt, result, outcome: "Approved proposal committed through the existing version-scoped Dashboard validation route." });
      if (!committed) return httpError(res, 500, "COMMIT_AUDIT_FAILED", "The change was sent, but its completion could not be durably recorded. Inspect the project before any retry.");
      return res.json({ proposal: committed, result, replay: false });
    } catch {
      // Leave COMMITTING as a durable fail-closed marker: a retry must not duplicate a mutation.
      return httpError(res, 503, "COMMIT_OUTCOME_UNKNOWN", "The commit result could not be confirmed. The proposal is locked against replay; inspect the project before proceeding.");
    }
  });
}
