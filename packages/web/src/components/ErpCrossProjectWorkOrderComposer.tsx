import { useMemo, useState } from "react";
import { buildErpNeedReviewSnapshot } from "@wowsync-dashboard/core/erpFulfillmentTriage.ts";
import { ERP_WORK_ORDER_TYPES } from "@wowsync-dashboard/core/erpWorkOrderTypes.ts";
import type { ErpFulfillmentTriage, ErpProjectView, ErpResourceCommitmentSummary, ErpWorkOrder } from "@wowsync-dashboard/core";
import { appendErpWorkOrderBatch, type ErpWorkOrderBatchTaskDraft } from "../api.ts";
import type { CharacterFacts, VersionOrUnknown } from "../types.ts";

type Version = Exclude<VersionOrUnknown, "unknown-version">;
interface Draft { kind: ErpWorkOrder["kind"]; title: string; instructions: string; assignedIdentityKey: string; sourceLeadIdentityKey: string; provisioningSourceIdentityKey: string; reservationSourceIdentityKey: string; reservationQuantity: string; spendingCeilingCopper: string; prerequisiteKeys: string[] }
interface PreparedTask { needId: string; task: ErpWorkOrderBatchTaskDraft; needLabel: string; requirementSourceLabel: string; workSourceLabel: string; assignedLabel: string; destinationLabel: string; evidenceText: string; sourceRowsText?: string; prerequisiteLabels: string[] }
interface PreparedGroup { projectId: string; projectTitle: string; expectedRevision: number; tasks: PreparedTask[] }
const defaultDraft = (label: string): Draft => ({ kind: "INVESTIGATE", title: `Review fulfillment: ${label}`.slice(0, 160), instructions: "Review the current requirement, source evidence, reservations, and version-specific constraints. Decide the next manual step only after checking the game and current account evidence.", assignedIdentityKey: "", sourceLeadIdentityKey: "", provisioningSourceIdentityKey: "", reservationSourceIdentityKey: "", reservationQuantity: "0", spendingCeilingCopper: "", prerequisiteKeys: [] });

function eligibleProvisioningSources(project: ErpProjectView, needId: string, version: Version) {
  const need = project.needs.find((entry) => entry.stableId === needId);
  if (!need || need.kind !== "ITEM_REF" || need.sourceOwnerKey || !need.destinationIdentityKey?.startsWith(`${version}::`)) return [];
  return (project.resourceSourceScreens.find((entry) => entry.needId === needId)?.candidates ?? []).filter((candidate) =>
    candidate.sourceIdentityKey !== need.destinationIdentityKey && candidate.sourceIdentityKey.startsWith(`${version}::`) && candidate.kind === "ITEM_REF" && candidate.resourceKey === need.resourceKey && candidate.state === "OBSERVED" && candidate.freshness === "recent" && candidate.reservationState === "UNRESERVED" && candidate.activeReservationQuantity === 0 && (candidate.availableObservedLowerBound ?? 0) > 0 && candidate.matchingItems.some((item) => item.itemRef === need.resourceKey && item.state === "OBSERVED" && (item.quantity ?? item.knownLowerBound ?? 0) > 0),
  );
}

function selectedProvisioningSourceNote(project: ErpProjectView, needId: string, sourceIdentityKey: string, version: Version): string | undefined {
  const candidate = eligibleProvisioningSources(project, needId, version).find((entry) => entry.sourceIdentityKey === sourceIdentityKey);
  const need = project.needs.find((entry) => entry.stableId === needId);
  if (!candidate || !need) return undefined;
  const rows = candidate.matchingItems.filter((item) => item.itemRef === need.resourceKey && item.state === "OBSERVED" && (item.quantity ?? item.knownLowerBound ?? 0) > 0);
  const rowEvidence = rows.slice(0, 3).map((item) => `${item.itemRef} in ${item.section} (${item.quantity !== undefined ? `${item.quantity} observed` : `at least ${item.knownLowerBound} observed`}${item.observedAt !== undefined ? ` at ${new Date(item.observedAt * 1000).toISOString()}` : ", time UNKNOWN"})`).join("; ");
  return `Player-selected source evidence at plan time: ${candidate.sourceName} on ${candidate.sourceRealm} (${sourceIdentityKey}) had ${rowEvidence}${rows.length > 3 ? `; ${rows.length - 3} additional matching rows omitted` : ""}. The source screen was ${candidate.freshness} freshness, OBSERVED, and showed no recorded reservation for this candidate. This is a location lead only; ownership, account membership, access, binding, transferability, and route remain UNKNOWN. Selecting this lead does not itself reserve or move the observed item. Any separately requested reservation in this batch applies to the requirement's named source. Recheck both characters and the exact variant before any manual action.`;
}

/** Creates player-authored work across active projects using one version-scoped optimistic transaction. */
export function ErpCrossProjectWorkOrderComposer({ version, triage, projects, commitments, characters, busy, onSaved }: { version: Version; triage: ErpFulfillmentTriage; projects: readonly ErpProjectView[]; commitments: ErpResourceCommitmentSummary; characters: readonly CharacterFacts[]; busy: boolean; onSaved: () => void }) {
  const projectById = useMemo(() => new Map(projects.map((project) => [project.stableId, project])), [projects]);
  const candidates = triage.items.filter((row) => row.need && row.version === version && row.projectStatus === "ACTIVE" && row.workOrders.length === 0 && projectById.get(row.projectId)?.needs.some((need) => need.stableId === row.need?.stableId));
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState<PreparedGroup[] | null>(null);
  const eligibleCharacters = characters.filter((character) => character.identityKey.startsWith(`${version}::`));
  const keyOf = (projectId: string, needId: string) => JSON.stringify([projectId, needId]);
  const rowFor = (key: string) => candidates.find((row) => keyOf(row.projectId, row.need!.stableId) === key);
  const hasPackageCycle = useMemo(() => {
    const selectedSet = new Set(selected); const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (key: string): boolean => { if (visiting.has(key)) return true; if (visited.has(key)) return false; visiting.add(key); for (const next of drafts[key]?.prerequisiteKeys ?? []) if (selectedSet.has(next) && visit(next)) return true; visiting.delete(key); visited.add(key); return false; };
    return selected.some(visit);
  }, [drafts, selected]);
  const toggle = (row: typeof candidates[number]) => {
    const key = keyOf(row.projectId, row.need!.stableId);
    if (selected.includes(key) && Object.entries(drafts).some(([draftKey, draft]) => draftKey !== key && selected.includes(draftKey) && draft.prerequisiteKeys.includes(key))) {
      setError("This requirement is a prerequisite for another selected step. Remove that prerequisite link before removing the step from the package.");
      return;
    }
    setError(""); setReview(null);
    setSelected((current) => current.includes(key) ? current.filter((entry) => entry !== key) : current.length >= 20 ? current : [...current, key]);
    setDrafts((current) => {
      return selected.includes(key) ? current : { ...current, [key]: current[key] ?? defaultDraft(row.need!.label) };
    });
  };
  const updateDraft = (key: string, patch: Partial<Draft>) => { setReview(null); setDrafts((current) => ({ ...current, [key]: { ...current[key]!, ...patch } })); };
  function prepareReview() {
    if (!selected.length || saving || busy) return;
    setError("");
    try {
      const grouped = new Map<string, PreparedGroup>();
      for (const key of selected) {
        const row = rowFor(key); const draft = drafts[key];
        if (!row?.need || !draft) throw new Error("A selected requirement is no longer available. Refresh the workbench.");
        const project = projectById.get(row.projectId);
        const reviewSnapshot = project && buildErpNeedReviewSnapshot(project, row.need.stableId);
        if (!project || !reviewSnapshot) throw new Error("The current requirement evidence is unavailable. Refresh the workbench before planning.");
        const group = grouped.get(project.stableId) ?? { projectId: project.stableId, projectTitle: project.title, expectedRevision: project.revision, tasks: [] };
        const reservationQuantity = Number(draft.reservationQuantity);
        if (!Number.isSafeInteger(reservationQuantity) || reservationQuantity < 0) throw new Error("Reservation quantity must be zero or a positive whole number.");
        const ceiling = draft.kind === "PURCHASE" && draft.spendingCeilingCopper.trim() ? Number(draft.spendingCeilingCopper) : undefined;
        if (ceiling !== undefined && (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 1_000_000_000)) throw new Error("Purchase ceiling must be a positive whole-copper amount.");
        const portfolioPrerequisites = draft.prerequisiteKeys.flatMap((dependencyKey) => { const prerequisite = rowFor(dependencyKey); return prerequisite ? [{ projectId: prerequisite.projectId, needId: prerequisite.need!.stableId }] : []; });
        const sourceNote = draft.kind === "PROVISION" && draft.provisioningSourceIdentityKey ? selectedProvisioningSourceNote(project, row.need.stableId, draft.provisioningSourceIdentityKey, version) : undefined;
        const instructions = [draft.instructions.trim(), sourceNote].filter(Boolean).join("\n\n");
        if (instructions.length > 3500) throw new Error("The saved player instructions plus exact source evidence exceed this work-order's text limit. Shorten the instructions and retry.");
        const alternateReservationSource = draft.kind === "PROVISION" && draft.reservationSourceIdentityKey && draft.reservationSourceIdentityKey !== row.need.sourceIdentityKey ? draft.reservationSourceIdentityKey : undefined;
        if (alternateReservationSource && alternateReservationSource !== draft.provisioningSourceIdentityKey) throw new Error("An alternate-source reservation must match the selected manual provisioning source.");
        const task = { needId: row.need.stableId, reviewSnapshot, kind: draft.kind, title: draft.title.trim(), instructions, ...(portfolioPrerequisites.length ? { portfolioPrerequisites } : {}), ...(draft.assignedIdentityKey ? { assignedIdentityKey: draft.assignedIdentityKey } : {}), ...(draft.kind === "INVESTIGATE" && draft.sourceLeadIdentityKey ? { sourceLeadIdentityKey: draft.sourceLeadIdentityKey } : {}), ...(draft.kind === "PROVISION" && draft.provisioningSourceIdentityKey ? { provisioningSourceIdentityKey: draft.provisioningSourceIdentityKey } : {}), ...(alternateReservationSource ? { reservationSourceIdentityKey: alternateReservationSource } : {}), ...(reservationQuantity > 0 ? { reservationQuantity } : {}), ...(ceiling !== undefined ? { spendingCeilingCopper: ceiling } : {}) } satisfies ErpWorkOrderBatchTaskDraft;
        const selectedSource = draft.kind === "PROVISION" ? draft.provisioningSourceIdentityKey : draft.kind === "INVESTIGATE" ? draft.sourceLeadIdentityKey : undefined;
        const sourceCandidate = selectedSource ? project.resourceSourceScreens.find((screen) => screen.needId === row.need!.stableId)?.candidates.find((candidate) => candidate.sourceIdentityKey === selectedSource) : undefined;
        const sourceRows = sourceCandidate?.matchingItems.filter((item) => item.itemRef === row.need!.resourceKey && item.state === "OBSERVED") ?? [];
        const evidence = project.needEvidence.find((entry) => entry.needId === row.need!.stableId);
        const prerequisiteLabels = draft.prerequisiteKeys.map((dependencyKey) => { const prerequisite = rowFor(dependencyKey); return prerequisite ? `${projectById.get(prerequisite.projectId)?.title}: ${prerequisite.need?.label}` : dependencyKey; });
        const sourceRowsText = sourceRows.slice(0, 3).map((item) => {
          const quantity = item.quantity !== undefined ? `${item.quantity} observed` : `at least ${item.knownLowerBound ?? "UNKNOWN"} observed`;
          const timestamp = item.observedAt === undefined ? ", time UNKNOWN" : ` at ${new Date(item.observedAt * 1000).toLocaleString()}`;
          return `${item.itemRef} in ${item.section} (${quantity}${timestamp})`;
        }).join("; ");
        const evidenceText = evidence ? `${evidence.state.replaceAll("_", " ")}, ${evidence.freshness} freshness${evidence.observedAt === undefined ? ", time UNKNOWN" : `, observed ${new Date(evidence.observedAt * 1000).toLocaleString()}`}${evidence.unresolvedSections.length ? `; unresolved sections: ${evidence.unresolvedSections.join(", ")}` : ""}` : "UNKNOWN";
        group.tasks.push({
          needId: row.need.stableId, task, needLabel: row.need.label,
          requirementSourceLabel: row.need.sourceIdentityKey ? characterLabel(row.need.sourceIdentityKey) : row.need.sourceOwnerKey ?? "UNKNOWN",
          workSourceLabel: selectedSource ? characterLabel(selectedSource) : row.need.sourceIdentityKey ? characterLabel(row.need.sourceIdentityKey) : row.need.sourceOwnerKey ?? "not specified",
          assignedLabel: characterLabel(draft.assignedIdentityKey), destinationLabel: characterLabel(row.need.destinationIdentityKey),
          evidenceText, ...(sourceRowsText ? { sourceRowsText } : {}), prerequisiteLabels,
        });
        grouped.set(project.stableId, group);
      }
      setReview([...grouped.values()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The plan could not be prepared for review.");
    }
  }
  async function save() {
    if (!review?.length || saving || busy) return;
    setSaving(true); setError("");
    try {
      await appendErpWorkOrderBatch(version, review.map(({ projectId, expectedRevision, tasks }) => ({ projectId, expectedRevision, tasks: tasks.map(({ task }) => task) })));
      setSelected([]); setDrafts({}); setReview(null); onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The grouped plan could not be saved. No partial update was accepted.");
      setReview(null); onSaved();
    } finally { setSaving(false); }
  }
  const characterLabel = (identityKey: string | undefined) => {
    if (!identityKey) return "UNKNOWN";
    const character = eligibleCharacters.find((entry) => entry.identityKey === identityKey);
    return character ? `${character.name}${character.surname ? ` ${character.surname}` : ""} · ${character.realm}` : identityKey;
  };
  if (!candidates.length) return null;
  return <section className="erp-cross-project-plan" aria-labelledby="erp-cross-project-plan-title" data-testid="erp-cross-project-plan">
    <h2 id="erp-cross-project-plan-title">Plan manual work across projects</h2>
    <p>Select requirements from this {version} review queue to create one atomic planning update. You may explicitly request a reservation when one exact source has recent, complete, fully quantified evidence. Requests are planning commitments only: no work is executed, inventory is unchanged, and overlapping or over-capacity requests reject the whole save.</p>
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
    {selected.map((key) => { const row = rowFor(key); const draft = drafts[key]; if (!row || !draft?.kind) return null; const need = row.need!; const project = projectById.get(row.projectId)!; const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId); const availableReservations = project.reservations.filter((entry) => entry.status === "ACTIVE" && entry.needId === need.stableId).reduce((sum, entry) => sum + entry.quantity, 0); const line = commitments.items.find((entry) => entry.version === version && entry.kind === need.kind && entry.resourceKey === need.resourceKey && (need.sourceIdentityKey ? entry.sourceScope === "CHARACTER" && entry.sourceIdentityKey === need.sourceIdentityKey : need.sourceOwnerKey ? entry.sourceScope === "SHARED_OWNER" && entry.sourceOwnerKey === need.sourceOwnerKey : false)); const selectedReservationSource = draft.kind === "PROVISION" && draft.reservationSourceIdentityKey ? project.resourceSourceScreens.find((screen) => screen.needId === need.stableId)?.candidates.find((candidate) => candidate.sourceIdentityKey === draft.reservationSourceIdentityKey) : undefined; const alternateReservation = Boolean(selectedReservationSource && selectedReservationSource.sourceIdentityKey !== need.sourceIdentityKey); const reservationMaximum = alternateReservation ? Math.min(selectedReservationSource?.availableObservedLowerBound ?? 0, Math.max(0, need.requiredQuantity - availableReservations)) : Math.min(line?.availableObservedLowerBound ?? 0, Math.max(0, need.requiredQuantity - availableReservations)); const alternateReservationSafe = Boolean(alternateReservation && selectedReservationSource?.state === "OBSERVED" && selectedReservationSource.freshness === "recent" && selectedReservationSource.reservationState === "UNRESERVED" && selectedReservationSource.activeReservationQuantity === 0 && selectedReservationSource.unresolvedSections.length === 0 && selectedReservationSource.locations.length === 2 && selectedReservationSource.locations.every((location) => location.state === "OBSERVED" && location.quantity !== undefined) && selectedReservationSource.matchingItems.some((item) => item.itemRef === need.resourceKey && item.state === "OBSERVED" && (item.quantity ?? item.knownLowerBound ?? 0) > 0)); const reservationSafe = (need.kind === "ITEM_ID" || need.kind === "ITEM_REF" || need.kind === "GOLD_COPPER" || need.kind === "CURRENCY") && (alternateReservation ? alternateReservationSafe : Boolean(need.sourceIdentityKey || need.sourceOwnerKey) && !commitments.truncated && line?.freshness === "recent" && line.reservationState !== "UNKNOWN" && line.reservationState !== "OVER_RESERVED" && !line.overlappingReservations.length && !line.overlappingResourceKeys.length && line.unresolvedSections.length === 0 && line.sourceSections.length > 0 && line.sourceSections.every((section) => section.state === "OBSERVED" && section.completeness?.toLowerCase() === "complete") && evidence?.freshness === "recent" && !evidence.unresolvedSections.length && evidence.unknownQuantityRowCount === 0) && reservationMaximum > 0; const itemNeed = need.kind === "ITEM_ID" || need.kind === "ITEM_REF"; const structuredPurchase = itemNeed && Boolean(need.sourceIdentityKey && need.destinationIdentityKey && need.sourceIdentityKey === need.destinationIdentityKey && need.sourceIdentityKey.startsWith(`${version}::`)); const buyerMatches = draft.assignedIdentityKey === need.sourceIdentityKey && draft.assignedIdentityKey === need.destinationIdentityKey; const purchaseCeiling = draft.spendingCeilingCopper.trim() ? Number(draft.spendingCeilingCopper) : undefined; const purchaseReady = draft.kind !== "PURCHASE" || !structuredPurchase || (buyerMatches && purchaseCeiling !== undefined && Number.isSafeInteger(purchaseCeiling) && purchaseCeiling > 0 && purchaseCeiling <= 1_000_000_000); return <fieldset className="erp-cross-project-task" key={key}><legend>{project.title}: {need.label}</legend>
      <label>Manual step type<select value={draft.kind} onChange={(event) => updateDraft(key, { kind: event.target.value as ErpWorkOrder["kind"], sourceLeadIdentityKey: "", provisioningSourceIdentityKey: "", reservationSourceIdentityKey: "", reservationQuantity: "0", ...(event.target.value !== "PURCHASE" ? { spendingCeilingCopper: "" } : {}), ...(event.target.value === "PURCHASE" && structuredPurchase ? { assignedIdentityKey: need.sourceIdentityKey! } : {}) })}>{ERP_WORK_ORDER_TYPES.map((kind) => <option key={kind} value={kind}>{kind.replaceAll("_", " ")}</option>)}</select></label>
      <label>Task title<input value={draft.title} maxLength={160} onChange={(event) => updateDraft(key, { title: event.target.value })} /></label>
      <label>Instructions<textarea value={draft.instructions} maxLength={3500} rows={3} onChange={(event) => updateDraft(key, { instructions: event.target.value })} /></label>
      {draft.kind === "PROVISION" && eligibleProvisioningSources(project, need.stableId, version).length > 0 && <label>Source for planning reservation (optional)<select aria-label={`Reservation source for ${need.label}`} value={draft.reservationSourceIdentityKey} onChange={(event) => updateDraft(key, { reservationSourceIdentityKey: event.target.value, reservationQuantity: "0" })}><option value="">Requirement's named source only</option>{eligibleProvisioningSources(project, need.stableId, version).map((candidate) => <option key={candidate.sourceIdentityKey} value={candidate.sourceIdentityKey}>{candidate.sourceName} · {candidate.sourceRealm} · exact item observed</option>)}</select><small>An alternate reservation is available only when it matches the selected PROVISION source. It records a planning commitment against that observed location; it does not establish ownership, account access, transferability, or movement.</small></label>}
      {reservationSafe ? <label>Optional quantity to reserve from observed supply<input aria-label={`Optional reservation quantity for ${need.label}`} type="number" min="0" max={reservationMaximum} step="1" value={draft.reservationQuantity} onChange={(event) => updateDraft(key, { reservationQuantity: event.target.value })} /><small>0 means no reservation. Current maximum for this individual need at {selectedReservationSource?.sourceName ?? "the named source"}: {reservationMaximum}; grouped requests are checked together by the server. A reservation records intent and does not move, lock, or consume items.</small></label> : <small>Reservation unavailable: a recent complete exact-source quantity and clear non-overlapping commitment scope are required. Missing or incomplete storage remains UNKNOWN.</small>}
      <label>Assigned same-version character<select value={draft.assignedIdentityKey} onChange={(event) => updateDraft(key, { assignedIdentityKey: event.target.value })}><option value="">Unassigned</option>{eligibleCharacters.map((character) => <option key={character.identityKey} value={character.identityKey}>{character.name}{character.surname ? ` ${character.surname}` : ""} · {character.realm}</option>)}</select></label>
      {draft.kind === "PURCHASE" && structuredPurchase ? <label>Maximum total purchase budget (copper)<input aria-label={`Purchase spending ceiling for ${need.label}`} type="number" min="1" max="1000000000" step="1" value={draft.spendingCeilingCopper} onChange={(event) => updateDraft(key, { spendingCeilingCopper: event.target.value })} required /><small>Buyer must be the explicitly named same-version source and recipient ({need.sourceIdentityKey}). The ceiling is player intent, not a market quote, current price, affordability check, or purchase. Existing gold need and reservations remain separate.</small></label> : draft.kind === "PURCHASE" ? <small>This need does not name the same observed-version character as both source and intended buyer. A structured procurement ceiling is unavailable; keep the manual purchase review conditional.</small> : null}
      {draft.kind === "INVESTIGATE" && (() => { const screen = projectById.get(row.projectId)?.resourceSourceScreens.find((entry) => entry.needId === row.need?.stableId); return screen?.candidates.length ? <label>Observed source to investigate<select aria-label={`Observed source to investigate for ${row.need?.label}`} value={draft.sourceLeadIdentityKey} onChange={(event) => updateDraft(key, { sourceLeadIdentityKey: event.target.value })}><option value="">No source lead</option>{screen.candidates.map((candidate) => <option key={candidate.sourceIdentityKey} value={candidate.sourceIdentityKey}>{candidate.sourceName}{candidate.sourceSurname ? ` ${candidate.sourceSurname}` : ""} · {candidate.sourceRealm} · {candidate.state} · {candidate.freshness} freshness</option>)}</select><small>A source lead only points to matching location evidence. Account membership, access, and transferability remain UNKNOWN; this creates no movement plan.</small></label> : null; })()}
      {draft.kind === "PROVISION" && (() => { const sources = eligibleProvisioningSources(project, need.stableId, version); return sources.length ? <label>Observed source for manual provisioning<select aria-label={`Observed source for manual provisioning for ${need.label}`} value={draft.provisioningSourceIdentityKey} onChange={(event) => updateDraft(key, { provisioningSourceIdentityKey: event.target.value, reservationSourceIdentityKey: "", reservationQuantity: "0" })}><option value="">No selected source lead</option>{sources.map((candidate) => <option key={candidate.sourceIdentityKey} value={candidate.sourceIdentityKey}>{candidate.sourceName}{candidate.sourceSurname ? ` ${candidate.sourceSurname}` : ""} · {candidate.sourceRealm} · exact item observed {candidate.freshness}, available lower bound {candidate.availableObservedLowerBound}</option>)}</select><small>The server rechecks the exact itemString, freshness, and recorded reservations when the batch saves. This is a location lead only: ownership, account membership, recipient access, binding, transferability, and route remain UNKNOWN. Selecting the lead does not itself reserve or move the item; an optional reservation may be scoped to this same selected source.</small></label> : <small>No recent, positively observed, unreserved exact-variant source lead is available for this need. A generic manual provisioning plan remains possible, but it cannot name an alternative source.</small>; })()}
      {selected.length > 1 && <label>Portfolio prerequisites (optional)<select multiple aria-label={`Portfolio prerequisites for ${need.label}`} value={draft.prerequisiteKeys.filter((dependency) => selected.includes(dependency))} onChange={(event) => updateDraft(key, { prerequisiteKeys: Array.from(event.currentTarget.selectedOptions, (option) => option.value) })}>{selected.filter((dependency) => dependency !== key).flatMap((dependency) => { const prerequisite = rowFor(dependency); return prerequisite ? <option key={dependency} value={dependency}>{projectById.get(prerequisite.projectId)?.title}: {prerequisite.need!.label}</option> : []; })}</select><small>Choose earlier package requirements that must be observed as met before this step is ready. Work-order completion notes do not satisfy this evidence gate.</small></label>}
    </fieldset>; })}
    {hasPackageCycle && <p role="alert">Portfolio prerequisites contain a cycle. Remove one or more links before saving the package.</p>}
    {error && <p role="alert">{error} The workbench is refreshing so you can review current evidence.</p>}
    {!review && <button type="button" className="primary-button" disabled={!selected.length || hasPackageCycle || saving || busy || selected.some((key) => { const row = rowFor(key); const draft = drafts[key]; if (!row?.need || !draft?.title.trim() || !draft.instructions.trim()) return true; const need = row.need; const itemNeed = need.kind === "ITEM_ID" || need.kind === "ITEM_REF"; const structured = itemNeed && Boolean(need.sourceIdentityKey && need.destinationIdentityKey && need.sourceIdentityKey === need.destinationIdentityKey && need.sourceIdentityKey.startsWith(`${version}::`)); if (draft.kind !== "PURCHASE" || !structured) return false; const ceiling = Number(draft.spendingCeilingCopper); return draft.assignedIdentityKey !== need.sourceIdentityKey || !Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 1_000_000_000; })} onClick={prepareReview}>Review {selected.length} planned manual step{selected.length === 1 ? "" : "s"}</button>}
    {review && <section className="erp-cross-project-plan-review" aria-label="Review planned work batch" data-testid="erp-cross-project-plan-review">
      <h3>Review the complete planning request</h3>
      <p>This frozen batch contains the exact task drafts and evidence snapshots below. The server rechecks project revisions, need evidence, selected sources, reservation capacity, and purchase fields in one transaction. If evidence changes after review, the submitted snapshot is rejected as stale and no part of the batch is saved. This does not perform a game action.</p>
      <ol>{review.flatMap((group) => group.tasks.map((prepared) => {
        const { task, needLabel, requirementSourceLabel, workSourceLabel, assignedLabel, destinationLabel, evidenceText, sourceRowsText, prerequisiteLabels } = prepared;
        return <li key={`${group.projectId}:${prepared.needId}`}>
          <strong>{group.projectTitle}: {task.kind.replaceAll("_", " ")} · {needLabel}</strong> (project revision {group.expectedRevision})<br />
          Task title: {task.title}. Instructions: {task.instructions}<br />
          Requirement source: {requirementSourceLabel}; selected work source: {workSourceLabel}; assigned character: {assignedLabel}; intended destination: {destinationLabel}.<br />
          {sourceRowsText ? <>Selected exact-item location evidence: {sourceRowsText}.<br /></> : null}
          Current requirement evidence at review: {evidenceText}.<br />
          {task.reservationQuantity !== undefined ? `Separate planning reservation requested: ${task.reservationQuantity} from ${task.reservationSourceIdentityKey ? characterLabel(task.reservationSourceIdentityKey) : requirementSourceLabel}. This records intent only; it does not reserve in game or establish access. ` : "No reservation requested. "}{task.spendingCeilingCopper !== undefined ? `Player-entered spending ceiling: ${task.spendingCeilingCopper} copper; this is not a price or affordability check. ` : ""}{prerequisiteLabels.length ? `Prerequisite evidence gates: ${prerequisiteLabels.join("; ")}.` : "No portfolio prerequisite links."}<br />
          <small>Planned work remains player intent. Task completion and resource movement require later evidence.</small>
        </li>;
      }))}</ol>
      <button type="button" disabled={busy || saving} onClick={() => setReview(null)}>Back to edit</button>
      <button type="button" className="primary-button" disabled={busy || saving} onClick={() => void save()}>{saving ? "Saving grouped plan…" : `Confirm and create ${review.reduce((sum, group) => sum + group.tasks.length, 0)} planned manual steps`}</button>
    </section>}
    <small>New work orders remain PLANNED. Project intent and recorded evidence are not proof that an action occurred or a resource is accessible.</small>
  </section>;
}
