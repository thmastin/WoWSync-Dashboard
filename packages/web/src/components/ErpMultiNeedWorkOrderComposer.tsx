import { useMemo, useState } from "react";
import { MAX_ERP_PROJECT_COLLECTION_ENTRIES } from "@wowsync-dashboard/core/erpLimits.ts";
import type { ErpProjectView, ErpWorkOrder } from "@wowsync-dashboard/core";
import type { CharacterFacts } from "../types.ts";
import { ERP_MANUAL_WORK_ORDER_KINDS, workOrderInstructions, type MultiNeedWorkOrderDraft } from "./erpMultiNeedWorkOrders.ts";

type Need = ErpProjectView["needs"][number];
type DraftFields = Omit<MultiNeedWorkOrderDraft, "needId" | "clientKey" | "kind"> & { readonly kind: ErpWorkOrder["kind"] | "" };

const when = (seconds?: number) => seconds === undefined ? "time UNKNOWN" : Number.isFinite(new Date(seconds * 1000).getTime()) ? new Date(seconds * 1000).toISOString() : "timestamp UNKNOWN";

export function ErpMultiNeedWorkOrderComposer({ project, needs, characters, onSave, onCancel, busy }: {
  readonly project: ErpProjectView;
  readonly needs: readonly Need[];
  readonly characters: readonly CharacterFacts[];
  readonly onSave: (drafts: readonly MultiNeedWorkOrderDraft[]) => Promise<void>;
  readonly onCancel: () => void;
  readonly busy: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [fields, setFields] = useState<Record<string, DraftFields>>({});
  const [error, setError] = useState("");
  const sameVersionCharacters = useMemo(() => characters.filter((character) => character.identityKey.startsWith(`${project.version}::`)), [characters, project.version]);
  const byNeed = new Map(needs.map((need) => [need.stableId, need]));
  const selectedNeeds = selected.flatMap((needId) => byNeed.has(needId) ? [byNeed.get(needId)!] : []);
  const openOrders = project.workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED");
  const remainingSlots = MAX_ERP_PROJECT_COLLECTION_ENTRIES - project.workOrders.length;

  function update(needId: string, patch: Partial<DraftFields>) {
    const need = byNeed.get(needId);
    if (!need) return;
    setFields((current) => {
      const previous = current[needId] ?? { kind: "" as const, title: "", instructions: "" };
      return { ...current, [needId]: { ...previous, ...patch } };
    });
  }
  function toggle(need: Need, checked: boolean) {
    if (checked) update(need.stableId, {});
    else setFields((current) => Object.fromEntries(Object.entries(current).map(([id, draft]) => [id, { ...draft, dependsOn: draft.dependsOn?.filter((dependency) => dependency !== `draft:${need.stableId}`) }])));
    setSelected((current) => {
      if (checked && current.length >= 4) return current;
      return checked ? [...current, need.stableId] : current.filter((id) => id !== need.stableId);
    });
  }
  async function save() {
    setError("");
    if (selectedNeeds.length < 2) { setError("Select at least two requirements."); return; }
    if (selectedNeeds.some((need) => !fields[need.stableId]?.kind)) { setError("Choose a manual work type for each selected requirement."); return; }
    const drafts = selectedNeeds.map((need) => ({ needId: need.stableId, clientKey: need.stableId, ...fields[need.stableId]! })) as MultiNeedWorkOrderDraft[];
    try { await onSave(drafts); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The grouped work-order plan could not be saved."); }
  }

  return <section className="erp-batch-fulfillment" aria-label={`Multi-need work-order composer for ${project.title}`}>
    <h3>Compose manual work orders for several requirements</h3>
    <p>Choose a manual work type for each requirement. These are your planning choices, not system recommendations. Evidence and readiness remain separate, and no in-game action is executed.</p>
    {remainingSlots < 2 && <p role="status">This project has room for only {Math.max(0, remainingSlots)} more work order(s), which is not enough for this multi-task composer. Use the single work-order form or start another project.</p>}
    <fieldset><legend>Requirements (choose 2-4)</legend>{needs.map((need) => {
      const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
      return <label className="erp-batch-need" key={need.stableId}>
        <input type="checkbox" checked={selected.includes(need.stableId)} disabled={!selected.includes(need.stableId) && selected.length >= 4} onChange={(event) => toggle(need, event.target.checked)} />
        <span><strong>{need.label}</strong> · {need.kind} · {need.resourceKey} · need {need.requiredQuantity}<small>{evidence?.state ?? "UNKNOWN"} · {evidence?.freshness ?? "unknown"} freshness · observed {evidence?.observedQuantity ?? "UNKNOWN"} · {evidence?.reservationAssessment ? `${evidence.reservationAssessment.activeQuantity} reserved; ${evidence.reservationAssessment.availableObservedLowerBound ?? "unreserved amount UNKNOWN"} unreserved lower bound` : "reservation state UNKNOWN"} · {when(evidence?.observedAt)}</small></span>
      </label>;
    })}</fieldset>
    {selectedNeeds.map((need, index) => {
      const draft = fields[need.stableId];
      if (!draft) return null;
      const priorTasks = selectedNeeds.slice(0, index);
      return <fieldset className="erp-batch-order-draft" key={need.stableId}><legend>Task for {need.label}</legend>
        <label>Manual work type<select value={draft.kind} onChange={(event) => { const kind = event.target.value as ErpWorkOrder["kind"] | ""; update(need.stableId, { kind, title: kind ? `${kind.replaceAll("_", " ")}: ${need.label}` : "", instructions: kind ? workOrderInstructions(kind, need.label) : "" }); }}><option value="">Choose a work type</option>{ERP_MANUAL_WORK_ORDER_KINDS.map((kind) => <option key={kind} value={kind}>{kind.replaceAll("_", " ")}</option>)}</select></label>
        <label>Task title<input value={draft.title} maxLength={160} onChange={(event) => update(need.stableId, { title: event.target.value })} /></label>
        <label>Manual instructions<textarea value={draft.instructions} maxLength={3500} rows={3} onChange={(event) => update(need.stableId, { instructions: event.target.value })} /></label>
        <label>Assigned character (optional)<select value={draft.assignedIdentityKey ?? ""} onChange={(event) => update(need.stableId, { assignedIdentityKey: event.target.value || undefined })}><option value="">Unassigned</option>{sameVersionCharacters.map((character) => <option key={character.identityKey} value={character.identityKey}>{character.name}{character.surname ? ` ${character.surname}` : ""} — {character.realm}</option>)}</select></label>
        <label>Planned source character (optional)<select value={draft.sourceIdentityKey ?? ""} onChange={(event) => update(need.stableId, { sourceIdentityKey: event.target.value || undefined })}><option value="">Source UNKNOWN / not specified</option>{sameVersionCharacters.map((character) => <option key={character.identityKey} value={character.identityKey}>{character.name}{character.surname ? ` ${character.surname}` : ""} — {character.realm}</option>)}</select></label>
        <label>Intended destination character (optional)<select value={draft.destinationIdentityKey ?? ""} onChange={(event) => update(need.stableId, { destinationIdentityKey: event.target.value || undefined })}><option value="">Destination UNKNOWN / not specified</option>{sameVersionCharacters.map((character) => <option key={character.identityKey} value={character.identityKey}>{character.name}{character.surname ? ` ${character.surname}` : ""} — {character.realm}</option>)}</select></label>
        <label>Prerequisites (optional)<select multiple value={[...(draft.dependsOn ?? [])]} onChange={(event) => update(need.stableId, { dependsOn: Array.from(event.currentTarget.selectedOptions, (option) => option.value) })}>
          {openOrders.map((order) => <option key={order.stableId} value={order.stableId}>Existing: {order.title}</option>)}
          {priorTasks.map((prior) => <option key={prior.stableId} value={`draft:${prior.stableId}`}>This plan: {fields[prior.stableId]?.title ?? prior.label}</option>)}
        </select></label>
        <small>{!draft.kind ? "Select the task type yourself; WoWSync will not choose one from the evidence." : `Work-type guidance for ${draft.kind.replaceAll("_", " ")} is a manual checklist, not a feasibility assessment.`} {draft.kind === "PURCHASE" ? "A price, seller, route, or affordability is not supplied; use the detailed procurement review for a ceiling and quote." : draft.kind === "CRAFT" ? "Recipe inputs, skill, unlocks, and craftability are not inferred." : draft.kind === "TRANSFER" || draft.kind === "PROVISION" ? "Ownership, access, binding, and a valid route remain UNKNOWN until separately verified." : "The saved plan does not establish that its game requirements are met."}</small>
      </fieldset>;
    })}
    <p className="erp-form-help">Saving is one version-scoped project update. Every linked work order remains PLANNED. Dependencies are explicit and can point only to an open existing step or an earlier task in this plan. Re-import evidence before acting; task creation does not reserve resources or assert that anything happened.</p>
    {error && <p role="alert" className="erp-form-error">{error}</p>}
    <button type="button" className="primary-button" disabled={busy || selectedNeeds.length < 2 || selectedNeeds.length > remainingSlots || selectedNeeds.some((need) => !fields[need.stableId]?.kind)} onClick={() => void save()}>Save {selectedNeeds.length} planned work orders</button>
    <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
  </section>;
}
