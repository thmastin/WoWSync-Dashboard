import { useEffect, useMemo, useState } from "react";
import { fetchGearAllocation, fetchGearCandidateEvidence, type GearCandidateEvidenceApi } from "../api.ts";
import type { VersionOrUnknown } from "../types.ts";
import { useAsync } from "../useAsync.ts";
import ErrorNotice from "./ErrorNotice.tsx";

type Ref = { exporterIdentityKey: string; snapshotId: number; rowOrdinal: number; label: string };

export default function GearAllocationPanel({ version, refreshTick }: { version: VersionOrUnknown; refreshTick: number }) {
  const candidates = useAsync((signal) => fetchGearCandidateEvidence(version, signal), `gear-candidates:${version}`, refreshTick);
  const refs = useMemo<Ref[]>(() => {
    const result: Ref[] = [];
    for (const character of candidates.state.data?.data?.characters ?? []) {
      if (!character.captured || !character.snapshot || !character.sidecar) continue;
      const snapshot = character.snapshot;
      character.sidecar.rows.forEach((row, index) => {
        const id = row.itemID.state === "KNOWN" ? `Item ${row.itemID.value}` : row.itemString.value ?? "Unknown item";
        const ilvl = row.currentItemLevel.state === "KNOWN" ? ` · ilvl ${row.currentItemLevel.value}` : "";
        const loc = row.baseEquipLocation.state === "KNOWN" ? ` · ${row.baseEquipLocation.value}` : "";
        result.push({ exporterIdentityKey: character.identity.identityKey, snapshotId: snapshot.snapshotId, rowOrdinal: index + 1, label: `${character.identity.name} · snapshot ${snapshot.snapshotId} · row ${index + 1} · ${id}${ilvl}${loc} · ${row.observationState}` });
      });
    }
    return result;
  }, [candidates.state.data]);
  const [selectedKey, setSelectedKey] = useState("");
  useEffect(() => { if (!refs.some((ref) => `${ref.exporterIdentityKey}|${ref.snapshotId}|${ref.rowOrdinal}` === selectedKey)) setSelectedKey(refs[0] ? `${refs[0].exporterIdentityKey}|${refs[0].snapshotId}|${refs[0].rowOrdinal}` : ""); }, [refs, selectedKey]);
  const selected = refs.find((ref) => `${ref.exporterIdentityKey}|${ref.snapshotId}|${ref.rowOrdinal}` === selectedKey);
  const analysis = useAsync((signal) => selected ? fetchGearAllocation(version, selected, signal) : Promise.resolve(null), `gear-allocation:${version}:${selectedKey}`, refreshTick);

  return <section className="allocation-section gear-allocation-panel" aria-labelledby="gear-allocation-heading">
    <header><h2 id="gear-allocation-heading">Gear allocation</h2><p>Retail candidates are compared with retained per-specialization equipment evidence. Unknown evidence stays visible.</p></header>
    {candidates.state.status === "loading" && <p>Loading captured Retail candidates…</p>}
    {candidates.state.status === "error" && <ErrorNotice error={candidates.state.error} onRetry={candidates.retry} />}
    {candidates.state.status === "ready" && refs.length === 0 && <p>No captured candidate rows are available. Missing candidate evidence is not an empty inventory.</p>}
    {refs.length > 0 && <label>Candidate from captured snapshot <select value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>{refs.map((ref) => { const key = `${ref.exporterIdentityKey}|${ref.snapshotId}|${ref.rowOrdinal}`; return <option key={key} value={key}>{ref.label}</option>; })}</select></label>}
    {selected && <p className="muted">This selection references one evidence row in snapshot {selected.snapshotId}; it does not identify a persistent physical item.</p>}
    {analysis.state.status === "loading" && selected && <p>Analyzing retained per-spec evidence…</p>}
    {analysis.state.status === "error" && <ErrorNotice error={analysis.state.error} onRetry={analysis.retry} />}
    {analysis.state.status === "ready" && analysis.state.data?.value && <>
      <h3>{analysis.state.data.value.recommendation.replaceAll("_", " ")}</h3>
      <p>Candidate {analysis.state.data.value.candidate.itemID ?? "?"}{analysis.state.data.value.candidate.itemLevel !== undefined ? ` · ilvl ${analysis.state.data.value.candidate.itemLevel}` : " · ilvl unknown"} · {analysis.state.data.value.candidate.validity.replaceAll("_", " ")}</p>
      <ul>{analysis.state.data.value.assessments.map((entry) => <li key={`${entry.character.identityKey ?? entry.character.name}:${entry.spec.specID}`}>
        <strong>{entry.character.name} · {entry.spec.name} ({entry.spec.role})</strong> — {entry.eligibility.replaceAll("_", " ")} · suitability {entry.suitability.replaceAll("_", " ")} · primary stat {entry.primaryStatSuitability.toLowerCase()}. {entry.comparison.replaceAll("_", " ")}{entry.deltaItemLevel !== undefined ? ` (${entry.deltaItemLevel > 0 ? "+" : ""}${entry.deltaItemLevel} ilvl)` : ""}. {entry.reasons.join(" ")}
        <div className="muted">Current snapshot observation: {entry.currentSnapshotObservation.state.toLowerCase()}{entry.currentSnapshotObservation.sourceSnapshotId !== undefined ? ` · snapshot ${entry.currentSnapshotObservation.sourceSnapshotId}` : ""}. {entry.currentSnapshotObservation.reason}</div>
        <div className="muted">Latest stored equipment observation: {entry.latestStoredObservation.state.toLowerCase()}{entry.latestStoredObservation.sourceSnapshotId !== undefined ? ` · snapshot ${entry.latestStoredObservation.sourceSnapshotId}` : ""}. {entry.latestStoredObservation.reason}</div>
        {entry.retained.state === "QUALIFIED" && <div className="muted">Retained spec equipment: snapshot {entry.retained.snapshotId}, tuple {entry.retained.observedAt}/{entry.retained.capture}/{entry.retained.revision}. Latest stored observation is reported separately.</div>}
      </li>)}</ul>
      {analysis.state.data.value.excludedRecipients.map((entry) => <p key={entry.identityKey}><strong>{entry.name} · {entry.realm}</strong> — UNKNOWN: {entry.reason}</p>)}
      <p className="muted">Dashboard characters are installation-local; membership in one Battle.net account is not established.</p>
      <details><summary>Evidence limits</summary><ul>{analysis.state.data.value.limitations.map((item) => <li key={item}>{item}</li>)}</ul></details>
    </>}
    {candidates.state.status === "ready" && candidates.state.data?.provenance.warning && <p className="muted">{candidates.state.data.provenance.warning}</p>}
  </section>;
}
