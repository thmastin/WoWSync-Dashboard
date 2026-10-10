import { useState } from "react";
import type { ErpProjectView, ErpResourceCommitmentLine, ErpReservation } from "@wowsync-dashboard/core";
import { replanErpReservations } from "../api.ts";
import type { VersionOrUnknown } from "../types.ts";
import { erpReservationScopeAnchorId } from "./erpObservationChangeQueue.ts";

type ReservationRow = { projectId: string; projectTitle: string; revision: number; needId: string; needLabel: string; kind: ErpResourceCommitmentLine["kind"]; resourceKey: string; sourceIdentityKey?: string; sourceOwnerKey?: string; reservation: ErpReservation; newQuantity: number };

function inScope(project: ErpProjectView, reservation: ErpReservation, line: ErpResourceCommitmentLine) {
  if (project.status === "CANCELLED" || reservation.status !== "ACTIVE") return false;
  if (reservation.sourceIdentityKey !== line.sourceIdentityKey || reservation.sourceOwnerKey !== line.sourceOwnerKey) return false;
  const need = project.needs.find((entry) => entry.stableId === reservation.needId);
  const exactScope = !!need && need.kind === line.kind && need.resourceKey === line.resourceKey;
  const listedOverlap = line.overlappingReservations.some((overlap) => overlap.projectId === project.stableId && overlap.needId === reservation.needId && overlap.reservationId === reservation.stableId);
  return exactScope || listedOverlap;
}

export function ErpReservationReplanPanel({ version, projects, lines, busy, sourceLabel, onSaved }: { version: VersionOrUnknown; projects: readonly ErpProjectView[]; lines: readonly ErpResourceCommitmentLine[]; busy: boolean; sourceLabel: (line: ErpResourceCommitmentLine) => string; onSaved: () => void }) {
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReservationRow[]>([]);
  const [review, setReview] = useState<{ projects: { stableId: string; revision: number; reservations: ErpProjectView["reservations"] }[]; rows: ReservationRow[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const conflicted = lines.filter((line) => line.sourceScope !== "UNKNOWN_SOURCE" && (line.reservationState === "OVER_RESERVED" || (line.reservationState === "UNKNOWN" && line.overlappingReservationQuantity !== undefined && line.overlappingReservationQuantity > 0 && line.overlappingReservations.length > 0)));
  const keyFor = (line: ErpResourceCommitmentLine) => JSON.stringify([line.version, line.sourceScope, line.sourceIdentityKey, line.sourceOwnerKey, line.kind, line.resourceKey]);
  const selectedLine = conflicted.find((line) => keyFor(line) === selectedLineKey);
  const open = (line: ErpResourceCommitmentLine) => {
    const rows: ReservationRow[] = [];
    for (const project of projects) for (const reservation of project.reservations) if (inScope(project, reservation, line)) {
      const need = project.needs.find((entry) => entry.stableId === reservation.needId)!;
      rows.push({ projectId: project.stableId, projectTitle: project.title, revision: project.revision, needId: need.stableId, needLabel: need.label, kind: need.kind, resourceKey: need.resourceKey, ...(reservation.sourceIdentityKey ? { sourceIdentityKey: reservation.sourceIdentityKey } : {}), ...(reservation.sourceOwnerKey ? { sourceOwnerKey: reservation.sourceOwnerKey } : {}), reservation, newQuantity: reservation.quantity });
    }
    setSelectedLineKey(keyFor(line)); setDraft(rows); setReview(null); setMessage("");
  };
  const change = (projectId: string, stableId: string, value: string) => {
    const quantity = Number(value);
    if (!Number.isSafeInteger(quantity) || quantity < 0) return;
    setDraft((rows) => rows.map((row) => row.projectId === projectId && row.reservation.stableId === stableId ? { ...row, newQuantity: Math.min(quantity, row.reservation.quantity) } : row));
    setReview(null); setMessage("");
  };
  const proposedRows = draft.filter((row) => row.newQuantity !== row.reservation.quantity);
  const prepareReview = () => {
    if (!proposedRows.length) return;
    const byProject = new Map<string, { stableId: string; revision: number; reservations: ErpProjectView["reservations"] }>();
    for (const row of proposedRows) {
      const project = projects.find((entry) => entry.stableId === row.projectId);
      if (!project || project.revision !== row.revision) { setMessage("Project evidence changed while this proposal was open. Reload before reviewing the replan."); return; }
      const update = byProject.get(project.stableId) ?? { stableId: project.stableId, revision: project.revision, reservations: project.reservations };
      update.reservations = update.reservations.map((reservation) => reservation.stableId === row.reservation.stableId ? { ...reservation, quantity: row.newQuantity === 0 ? reservation.quantity : row.newQuantity, status: row.newQuantity === 0 ? "RELEASED" as const : reservation.status } : reservation);
      byProject.set(project.stableId, update);
    }
    setReview({ projects: [...byProject.values()], rows: proposedRows.map((row) => ({ ...row })) }); setMessage("");
  };
  const save = async () => {
    if (!review || busy || saving) return;
    setSaving(true); setMessage("");
    try {
      const result = await replanErpReservations(version, review.projects);
      setMessage(`${result.changedReservationCount} reservation change${result.changedReservationCount === 1 ? "" : "s"} saved atomically across ${result.projects.length} project${result.projects.length === 1 ? "" : "s"}. This updates planning intent only; no resource moved.`);
      setSelectedLineKey(null); setReview(null); setDraft([]); onSaved();
    } catch (error) { setMessage(error instanceof Error ? `${error.message} Reload the latest commitments and review again.` : "The reservation replan failed. Reload the latest commitments and review again."); }
    finally { setSaving(false); }
  };
  const impactedNeedKeys = new Set((review?.rows ?? []).map((row) => `${row.projectId}:${row.needId}`));
  const impactedOrderKeys = new Set<string>();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const project of projects) for (const order of project.workOrders) {
      const orderKey = `${project.stableId}:${order.stableId}`;
      if (impactedOrderKeys.has(orderKey)) continue;
      const linkedNeed = order.resourceNeedIds.some((needId) => impactedNeedKeys.has(`${project.stableId}:${needId}`));
      const linkedPrerequisite = order.portfolioPrerequisites?.some((need) => impactedNeedKeys.has(`${need.projectId}:${need.needId}`)) ?? false;
      const linkedOrder = order.dependsOn.some((workOrderId) => impactedOrderKeys.has(`${project.stableId}:${workOrderId}`));
      if (!linkedNeed && !linkedPrerequisite && !linkedOrder) continue;
      impactedOrderKeys.add(orderKey); expanded = true;
      for (const needId of order.resourceNeedIds) impactedNeedKeys.add(`${project.stableId}:${needId}`);
    }
  }
  const affectedWork = projects.flatMap((project) => project.workOrders.filter((order) => impactedOrderKeys.has(`${project.stableId}:${order.stableId}`)).map((order) => `${project.title}: ${order.title} (${order.status})`));
  return <section className="erp-reservation-replan" aria-labelledby="erp-reservation-replan-title" data-testid="erp-reservation-replan">
    <h2 id="erp-reservation-replan-title">Replan conflicting reservations</h2>
      <p>Known OVER RESERVED groups and explicit base-item/exact-variant overlaps marked UNKNOWN are listed. UNKNOWN overlaps are not treated as confirmed shortages. A reviewed batch may reduce or release existing intent across several projects atomically. It cannot increase or move a reservation, and does not move resources.</p>
    {conflicted.length ? <ul>{conflicted.map((line) => <li id={erpReservationScopeAnchorId(line)} key={keyFor(line)} tabIndex={-1}><span><strong>{line.label}</strong> · {sourceLabel(line)} · {line.activeReservationQuantity} exact-scope units reserved against {line.observedQuantity ?? "UNKNOWN"} observed · {line.freshness} evidence{line.overlappingReservations.length ? " | base/variant overlap; combined availability UNKNOWN" : ""}</span><button type="button" disabled={busy || saving} onClick={() => open(line)}>Review {line.label} reservations</button></li>)}</ul> : <p>No exact-source over-reservation groups are currently established.</p>}
    {selectedLine && <div className="erp-reservation-replan-session" aria-label={`Reservation review for ${selectedLine.label}`}>
      <h3>Proposed changes: {selectedLine.label} at {sourceLabel(selectedLine)}</h3>
      <p>Source scope, resource identity, and project revision are frozen for this review. Enter a lower quantity; set zero to release. Existing released history is retained.</p>
      <ul>{draft.map((row) => <li key={`${row.projectId}:${row.reservation.stableId}`}><label>{row.projectTitle} · {row.needLabel} · planned {row.reservation.quantity}<input aria-label={`New reservation quantity for ${row.projectTitle}: ${row.needLabel}`} type="number" min="0" max={row.reservation.quantity} step="1" value={row.newQuantity} onChange={(event) => change(row.projectId, row.reservation.stableId, event.target.value)} /></label></li>)}</ul>
      <button type="button" disabled={busy || saving || proposedRows.length === 0} onClick={prepareReview}>Review atomic changes</button>
    </div>}
    {review && <div className="erp-reservation-replan-review" aria-label="Frozen reservation replan review" data-testid="erp-reservation-replan-review">
      <h3>Confirm reservation replan</h3>
      <p>This frozen review updates {review.projects.length} project{review.projects.length === 1 ? "" : "s"} and {review.rows.length} existing reservation{review.rows.length === 1 ? "" : "s"}. Revisions are checked again in one database transaction.</p>
      <ul>{review.rows.map((row) => <li key={`${row.projectId}:${row.reservation.stableId}`}><strong>{row.projectTitle}</strong> · {row.needLabel}: {row.reservation.quantity} to {row.newQuantity === 0 ? "RELEASED" : row.newQuantity} · {row.kind} {row.resourceKey} · source {row.sourceIdentityKey ?? row.sourceOwnerKey ?? "UNKNOWN"} · revision {row.revision}</li>)}</ul>
      <p>Affected linked work: {affectedWork.length ? affectedWork.join("; ") : "no directly linked work orders"}. Downstream evidence and readiness will be recalculated after saving. This does not prove access, execution, or task completion.</p>
      <button type="button" disabled={busy || saving} onClick={() => void save()}>{saving ? "Saving reviewed changes…" : "Save reservation replan"}</button>
      <button type="button" disabled={saving} onClick={() => setReview(null)}>Back to proposal</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
