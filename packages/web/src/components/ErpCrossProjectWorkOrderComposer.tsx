import { useMemo, useState } from "react";
import { buildErpNeedReviewSnapshot } from "@wowsync-dashboard/core/erpFulfillmentTriage.ts";
import { ERP_WORK_ORDER_TYPES } from "@wowsync-dashboard/core/erpWorkOrderTypes.ts";
import type { ErpFulfillmentTriage, ErpProjectView, ErpResourceCommitmentSummary, ErpWorkOrder } from "@wowsync-dashboard/core";
import { appendErpWorkOrderBatch, type ErpWorkOrderBatchTaskDraft } from "../api.ts";
import type { CharacterFacts, VersionOrUnknown } from "../types.ts";

type Version = Exclude<VersionOrUnknown, "unknown-version">;
interface Draft { kind: ErpWorkOrder["kind"]; title: string; instructions: string; assignedIdentityKey: string; sourceLeadIdentityKey: string }
const defaultDraft = (label: string): Draft => ({ kind: "INVESTIGATE", title: `Review fulfillment: ${label}`.slice(0, 160), instructions: "Review the current requirement, source evidence, reservations, and version-specific constraints. Decide the next manual step only after checking the game and current account evidence.", assignedIdentityKey: "", sourceLeadIdentityKey: "" });

/** Creates player-authored work across active projects using one version-scoped optimistic transaction. */
export function ErpCrossProjectWorkOrderComposer({ version, triage, projects, commitments, characters, busy, onSaved }: { version: Version; triage: ErpFulfillmentTriage; projects: readonly ErpProjectView[]; commitments: ErpResourceCommitmentSummary; characters: readonly CharacterFacts[]; busy: boolean; onSaved: () => void }) {
  const projectById = useMemo(() => new Map(projects.map((project) => [project.stableId, project])), [projects]);
  const candidates = triage.items.filter((row) => row.need && row.version === version && row.projectStatus === "ACTIVE" && row.workOrders.length === 0 && projectById.get(row.projectId)?.needs.some((need) => need.stableId === row.need?.stableId));
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const eligibleCharacters = characters.filter((character) => character.identityKey.startsWith(`${version}::`));
  const keyOf = (projectId: string, needId: string) => `${projectId}\u0000${needId}`;
  const rowFor = (key: string) => candidates.find((row) => keyOf(row.projectId, row.need!.stableId) === key);
  const toggle = (row: typeof candidates[number]) => {
    const key = keyOf(row.projectId, row.need!.stableId);
    setSelected((current) => current.includes(key) ? current.filter((entry) => entry !== key) : current.length >= 20 ? current : [...current, key]);
    setDrafts((current) => ({ ...current, [key]: current[key] ?? defaultDraft(row.need!.label) }));
  };
  const updateDraft = (key: string, patch: Partial<Draft>) => setDrafts((current) => ({ ...current, [key]: { ...current[key]!, ...patch } }));
  async function save() {
    if (!selected.length || saving || busy) return;
    setSaving(true); setError("");
    try {
      const grouped = new Map<string, { projectId: string; expectedRevision: number; tasks: ErpWorkOrderBatchTaskDraft[] }>();
      for (const key of selected) {
        const row = rowFor(key); const draft = drafts[key];
        if (!row?.need || !draft) throw new Error("A selected requirement is no longer available. Refresh the workbench.");
        const project = projectById.get(row.projectId);
        const reviewSnapshot = project && buildErpNeedReviewSnapshot(project, row.need.stableId);
        if (!project || !reviewSnapshot) throw new Error("The current requirement evidence is unavailable. Refresh the workbench before planning.");
        const group = grouped.get(project.stableId) ?? { projectId: project.stableId, expectedRevision: project.revision, tasks: [] };
        group.tasks.push({ needId: row.need.stableId, reviewSnapshot, kind: draft.kind, title: draft.title.trim(), instructions: draft.instructions.trim(), ...(draft.assignedIdentityKey ? { assignedIdentityKey: draft.assignedIdentityKey } : {}), ...(draft.kind === "INVESTIGATE" && draft.sourceLeadIdentityKey ? { sourceLeadIdentityKey: draft.sourceLeadIdentityKey } : {}) });
        grouped.set(project.stableId, group);
      }
      await appendErpWorkOrderBatch(version, [...grouped.values()]);
      setSelected([]); setDrafts({}); onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The grouped plan could not be saved. No partial update was accepted.");
      onSaved();
    } finally { setSaving(false); }
  }
  if (!candidates.length) return null;
  return <section className="erp-cross-project-plan" aria-labelledby="erp-cross-project-plan-title" data-testid="erp-cross-project-plan">
    <h2 id="erp-cross-project-plan-title">Plan manual work across projects</h2>
    <p>Select requirements from this {version} review queue to create one atomic planning update. Each item keeps its project and resource link; no work is executed, resources are not moved, and reservations are unchanged. A stale project or evidence review rejects the whole save.</p>
    <div className="erp-cross-project-candidates">{candidates.map((row) => {
      const need = row.need!; const key = keyOf(row.projectId, need.stableId); const project = projectById.get(row.projectId)!;
      const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
      const exactLine = commitments.items.find((line) => line.version === version && line.kind === need.kind && line.resourceKey === need.resourceKey && (need.sourceIdentityKey ? line.sourceScope === "CHARACTER" && line.sourceIdentityKey === need.sourceIdentityKey : need.sourceOwnerKey ? line.sourceScope === "SHARED_OWNER" && line.sourceOwnerKey === need.sourceOwnerKey : line.sourceScope === "UNKNOWN_SOURCE" && line.contributors.some((entry) => entry.projectId === project.stableId && entry.needId === need.stableId)));
      const displayedEvidence = evidence ? `Current-source evidence: ${evidence.state.replaceAll("_", " ")} · ${evidence.observedQuantity === undefined ? "observed quantity UNKNOWN" : `${evidence.observedQuantity} observed`} · ${evidence.freshness} freshness${evidence.observedAt === undefined ? " · time UNKNOWN" : ` · ${new Date(evidence.observedAt * 1000).toLocaleString()}`}.` : "Current-source evidence: UNKNOWN (no matching evidence row).";
      return <label key={key} className="erp-cross-project-choice"><input type="checkbox" checked={selected.includes(key)} disabled={!selected.includes(key) && selected.length >= 20} onChange={() => toggle(row)} /><span><strong>{project.title} · {need.label}</strong><small>{need.kind} <code>{need.resourceKey}</code> · requires {need.requiredQuantity} · {need.evidenceState.replaceAll("_", " ")} · freshness {need.freshness}</small><small>Source: {need.sourceIdentityKey ?? need.sourceOwnerKey ?? "UNKNOWN"} · destination: {need.destinationIdentityKey ?? "unassigned"}</small><small>{displayedEvidence} {evidence?.unresolvedSections.length ? `Unresolved: ${evidence.unresolvedSections.join(", ")}.` : ""}</small>
        {exactLine ? <small>Same-source exact-scope commitments: {exactLine.activeNeedCount} active needs / {exactLine.activeNeedQuantity} planned units · {exactLine.activeReservationQuantity} exact-scope units reserved · {exactLine.reservationState.replaceAll("_", " ")} · {exactLine.availableObservedLowerBound === undefined ? "unreserved observed lower bound UNKNOWN" : `${exactLine.availableObservedLowerBound} observed lower-bound units not reserved under this scope`} · {exactLine.freshness} freshness. Other contributing projects: {exactLine.contributors.filter((entry) => entry.projectId !== project.stableId || entry.needId !== need.stableId).map((entry) => entry.projectTitle).join(", ") || (exactLine.contributorsTruncated ? "additional contributors omitted by bound" : "none recorded in this exact source/resource scope")}.</small>
          : <small>Combined exact-source commitment line unavailable{commitments.truncated ? " because the commitment summary is bounded" : " for this source and resource"}; reservation and available quantity remain UNKNOWN in this session view.</small>}
        {exactLine?.overlappingReservations.length ? <small>Overlapping reservations need separate review and may not be added{exactLine.overlappingReservationQuantity === undefined ? " (overlapping quantity UNKNOWN)" : ` (${exactLine.overlappingReservationQuantity} overlapping units assessed)`}: {exactLine.overlappingReservations.map((entry) => `${entry.projectTitle} ${entry.quantity} ${entry.kind} ${entry.resourceKey}${entry.ambiguous ? " (scope ambiguous)" : ""}`).join("; ")}.</small> : exactLine?.overlappingResourceKeys.length ? <small>Potentially overlapping planned resource scopes: {exactLine.overlappingResourceKeys.join(", ")}; do not add these quantities into the exact-scope stock line.</small> : null}
      </span></label>;
    })}</div>
    {triage.truncated && <p role="note">This composer lists the returned portion of the fulfillment review queue ({triage.returnedCount} of {triage.totalCount}). Open project details to plan requirements outside this bounded list.</p>}
    {selected.map((key) => { const row = rowFor(key); const draft = drafts[key]; if (!row || !draft) return null; return <fieldset className="erp-cross-project-task" key={key}><legend>{projectById.get(row.projectId)?.title}: {row.need?.label}</legend>
      <label>Manual step type<select value={draft.kind} onChange={(event) => updateDraft(key, { kind: event.target.value as ErpWorkOrder["kind"], sourceLeadIdentityKey: "" })}>{ERP_WORK_ORDER_TYPES.map((kind) => <option key={kind} value={kind}>{kind.replaceAll("_", " ")}</option>)}</select></label>
      <label>Task title<input value={draft.title} maxLength={160} onChange={(event) => updateDraft(key, { title: event.target.value })} /></label>
      <label>Instructions<textarea value={draft.instructions} maxLength={3500} rows={3} onChange={(event) => updateDraft(key, { instructions: event.target.value })} /></label>
      <label>Assigned same-version character<select value={draft.assignedIdentityKey} onChange={(event) => updateDraft(key, { assignedIdentityKey: event.target.value })}><option value="">Unassigned</option>{eligibleCharacters.map((character) => <option key={character.identityKey} value={character.identityKey}>{character.name}{character.surname ? ` ${character.surname}` : ""} · {character.realm}</option>)}</select></label>
      {draft.kind === "INVESTIGATE" && (() => { const screen = projectById.get(row.projectId)?.resourceSourceScreens.find((entry) => entry.needId === row.need?.stableId); return screen?.candidates.length ? <label>Observed source to investigate<select aria-label={`Observed source to investigate for ${row.need?.label}`} value={draft.sourceLeadIdentityKey} onChange={(event) => updateDraft(key, { sourceLeadIdentityKey: event.target.value })}><option value="">No source lead</option>{screen.candidates.map((candidate) => <option key={candidate.sourceIdentityKey} value={candidate.sourceIdentityKey}>{candidate.sourceName}{candidate.sourceSurname ? ` ${candidate.sourceSurname}` : ""} · {candidate.sourceRealm} · {candidate.state} · {candidate.freshness} freshness</option>)}</select><small>A source lead only points to matching location evidence. Account membership, access, and transferability remain UNKNOWN; this creates no movement plan.</small></label> : null; })()}
    </fieldset>; })}
    {error && <p role="alert">{error} The workbench is refreshing so you can review current evidence.</p>}
    <button type="button" className="primary-button" disabled={!selected.length || saving || busy || selected.some((key) => !drafts[key]?.title.trim() || !drafts[key]?.instructions.trim())} onClick={() => void save()}>{saving ? "Saving grouped plan…" : `Create ${selected.length} planned manual step${selected.length === 1 ? "" : "s"}`}</button>
    <small>New work orders remain PLANNED. Project intent and recorded evidence are not proof that an action occurred or a resource is accessible.</small>
  </section>;
}
