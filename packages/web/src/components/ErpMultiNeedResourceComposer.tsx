import { useMemo, useState } from "react";
import type { ErpProjectView, ErpResourceKind } from "@wowsync-dashboard/core";
import { MAX_ERP_PROJECT_COLLECTION_ENTRIES } from "@wowsync-dashboard/core/erpLimits.ts";
import type { CharacterFacts } from "../types.ts";
import type { MultiNeedResourceDraft } from "./erpMultiNeedResourceNeeds.ts";

const kinds: readonly ErpResourceKind[] = ["ITEM_REF", "ITEM_ID", "GOLD_COPPER", "CURRENCY", "PROFESSION", "RECIPE"];
interface NeedDraftRow { clientKey: string; kind: ErpResourceKind; resourceKey: string; label: string; quantity: string; sourceIdentityKey: string; destinationIdentityKey: string }
const newRow = (index: number): NeedDraftRow => ({ clientKey: `need-${index}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`, kind: "ITEM_REF", resourceKey: "", label: "", quantity: "1", sourceIdentityKey: "", destinationIdentityKey: "" });

export function ErpMultiNeedResourceComposer({ project, characters, busy, onSave, onCancel }: {
  readonly project: ErpProjectView;
  readonly characters: readonly CharacterFacts[];
  readonly busy: boolean;
  readonly onSave: (drafts: readonly MultiNeedResourceDraft[]) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [rows, setRows] = useState<NeedDraftRow[]>([newRow(0), newRow(1)]);
  const [error, setError] = useState("");
  const sameVersionCharacters = useMemo(() => characters.filter((character) => character.identityKey.startsWith(`${project.version}::`)), [characters, project.version]);
  const remaining = MAX_ERP_PROJECT_COLLECTION_ENTRIES - project.needs.length;
  function update(clientKey: string, patch: Partial<NeedDraftRow>) {
    setRows((current) => current.map((row) => row.clientKey === clientKey ? { ...row, ...patch } : row));
  }
  async function save() {
    setError("");
    const drafts: MultiNeedResourceDraft[] = rows.map((row) => ({
      clientKey: row.clientKey, kind: row.kind, resourceKey: row.kind === "GOLD_COPPER" ? "copper" : row.resourceKey,
      label: row.label, requiredQuantity: Number(row.quantity),
      ...(row.sourceIdentityKey ? { sourceIdentityKey: row.sourceIdentityKey } : {}),
      ...(row.destinationIdentityKey ? { destinationIdentityKey: row.destinationIdentityKey } : {}),
    }));
    if (drafts.some((draft) => !draft.label.trim() || (draft.kind !== "GOLD_COPPER" && !draft.resourceKey.trim()))) { setError("Enter a label and resource key for every requirement; gold uses copper automatically."); return; }
    if (drafts.some((draft) => !Number.isSafeInteger(draft.requiredQuantity) || draft.requiredQuantity < 1)) { setError("Use a positive whole quantity for each requirement."); return; }
    if (rows.length > remaining) { setError(`This project has room for only ${remaining} more requirement(s).`); return; }
    try { await onSave(drafts); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The requirements could not be saved."); }
  }

  return <section className="erp-need-bundle" aria-label={`Multi-need resource composer for ${project.title}`}>
    <h3>Define several project requirements</h3>
    <p>Enter explicit player goals. These rows do not assert that supply exists, reserve resources, or prove a recipe, profession, ownership, access, or transfer route. Each source and intended recipient is optional and version-scoped.</p>
    {remaining < 2 && <p role="status">This project has room for only {Math.max(0, remaining)} more requirement(s), which is not enough for this multi-requirement form. Use the single requirement form or another project.</p>}
    {rows.map((row, index) => <fieldset className="erp-need-bundle-row" key={row.clientKey}><legend>Requirement {index + 1}</legend>
      <label>Resource kind<select value={row.kind} onChange={(event) => update(row.clientKey, { kind: event.target.value as ErpResourceKind, resourceKey: event.target.value === "GOLD_COPPER" ? "copper" : "", quantity: event.target.value === "RECIPE" ? "1" : row.quantity })}>{kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
      <label>{row.kind === "ITEM_REF" ? "Exact itemString" : row.kind === "GOLD_COPPER" ? "Resource key" : row.kind === "PROFESSION" ? "Exact profession name" : row.kind === "RECIPE" ? "Recipe ID" : "Resource key"}<input value={row.kind === "GOLD_COPPER" ? "copper" : row.resourceKey} disabled={row.kind === "GOLD_COPPER"} placeholder={row.kind === "ITEM_REF" ? "item:123:variant" : row.kind === "GOLD_COPPER" ? "copper" : "Exact observed or player-entered key"} onChange={(event) => update(row.clientKey, { resourceKey: event.target.value })} /></label>
      <label>Requirement label<input value={row.label} maxLength={160} onChange={(event) => update(row.clientKey, { label: event.target.value })} /></label>
      <label>{row.kind === "RECIPE" ? "Recipe knowledge (fixed at 1)" : row.kind === "PROFESSION" ? "Required skill" : row.kind === "GOLD_COPPER" ? "Copper" : "Required quantity"}<input type="number" min="1" step="1" value={row.kind === "RECIPE" ? "1" : row.quantity} disabled={row.kind === "RECIPE"} onChange={(event) => update(row.clientKey, { quantity: event.target.value })} /></label>
      <label>Explicit source (optional)<select value={row.sourceIdentityKey} onChange={(event) => update(row.clientKey, { sourceIdentityKey: event.target.value })}><option value="">Source UNKNOWN / not specified</option>{sameVersionCharacters.map((character) => <option key={character.identityKey} value={character.identityKey}>{character.name}{character.surname ? ` ${character.surname}` : ""} — {character.realm}</option>)}</select></label>
      <label>Intended recipient (optional)<select value={row.destinationIdentityKey} onChange={(event) => update(row.clientKey, { destinationIdentityKey: event.target.value })}><option value="">Unassigned</option>{sameVersionCharacters.map((character) => <option key={character.identityKey} value={character.identityKey}>{character.name}{character.surname ? ` ${character.surname}` : ""} — {character.realm}</option>)}</select></label>
      {rows.length > 2 && <button type="button" disabled={busy} onClick={() => setRows((current) => current.filter((entry) => entry.clientKey !== row.clientKey))}>Remove requirement {index + 1}</button>}
    </fieldset>)}
    <p className="erp-form-help">Item variants are preserved exactly as entered. Choosing a source or recipient is planning scope only; it does not establish account membership or access. Evidence and reservations are evaluated after these requirements are saved.</p>
    {error && <p role="alert" className="erp-form-error">{error}</p>}
    <button type="button" disabled={busy || rows.length >= 4 || rows.length >= remaining} onClick={() => setRows((current) => [...current, newRow(current.length)])}>Add another requirement</button>
    <button type="button" className="primary-button" disabled={busy || rows.length < 2 || rows.length > remaining || rows.some((row) => !row.label.trim() || (row.kind !== "GOLD_COPPER" && !row.resourceKey.trim()) || !Number.isSafeInteger(Number(row.quantity)) || Number(row.quantity) < 1)} onClick={() => void save()}>Save {rows.length} requirements</button>
    <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
  </section>;
}
