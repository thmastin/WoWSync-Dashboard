import { useMemo, useState } from "react";
import { fetchForeverGearAllocation, type ForeverGearAllocationApi } from "../api.ts";
import { buildForeverGearReview, describeForeverAssessment, filterForeverGearReview, gearReviewSummary } from "../foreverGearReview.ts";
import { useAsync } from "../useAsync.ts";
import { formatAbsoluteTime } from "../format.ts";
import type { CharacterFacts } from "../types.ts";
import { characterDisplayName } from "@wowsync-dashboard/core/identity.ts";

type Read = { identityKey: string; name: string; surname?: string; realm: string; result?: ForeverGearAllocationApi; error?: string };
const dispositionLabel: Record<string, string> = {
  EQUIP_CANDIDATE: "Worth checking on this character",
  KEEP: "Keep with current holder for review",
  POSSIBLE_OTHER_CHARACTER: "Possible fit for this character",
  NOT_AN_UPGRADE_ON_OBSERVED_METRICS: "No advantage in observed metrics",
  INSUFFICIENT_EVIDENCE: "Evidence is insufficient",
};

export default function ForeverGearReview({ characters, refreshTick, onOpenCharacter }: {
  characters: CharacterFacts[];
  refreshTick: number;
  onOpenCharacter: (identityKey: string) => void;
}) {
  const rosterKey = characters.map((c) => c.identityKey).sort().join("|");
  const load = useAsync(async (signal) => {
    const reads = await Promise.all(characters.map(async (character): Promise<Read> => {
      try {
        const result = await fetchForeverGearAllocation(character.identityKey, signal);
        return { identityKey: character.identityKey, name: character.name, ...(character.surname ? { surname: character.surname } : {}), realm: character.realm, result };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return { identityKey: character.identityKey, name: character.name, ...(character.surname ? { surname: character.surname } : {}), realm: character.realm, error: String(error) };
      }
    }));
    return reads;
  }, rosterKey, refreshTick);
  const reads = load.state.data ?? [];
  const groups = useMemo(() => buildForeverGearReview(reads.flatMap((r) => r.result ? [{ recipientIdentityKey: r.identityKey, result: r.result }] : [])), [reads]);
  const summary = gearReviewSummary(groups);
  const [recipient, setRecipient] = useState("");
  const [disposition, setDisposition] = useState("");
  const [query, setQuery] = useState("");
  const recipientOptions = characters.filter((c) => !recipient || c.identityKey === recipient);
  const filteredGroups = filterForeverGearReview(groups, { recipientIdentityKey: recipient, disposition, query });
  const failed = reads.filter((r) => r.error || r.result?.status !== "FOUND" || r.result.value?.data?.version !== "forever" || r.result.value.data.ruleset !== "forever-70291-allocation-screen-v2");

  return <section className="forever-review-page" aria-labelledby="forever-review-title">
    <div className="detail-card forever-review-intro">
      <div><p className="eyebrow">Forever · build 70291 allocation review</p><h2 id="forever-review-title">Gear opportunities across this roster</h2>
        <p>Compare each observed candidate against each character’s own evidence. This is a review queue: a recorded stat advantage is not by itself an equip recommendation, and a possible recipient is not proof of ownership access or a transfer route.</p></div>
      <button type="button" onClick={load.retry}>Refresh review</button>
    </div>
    <div className="forever-review-summary" aria-label="Gear review summary">
      <div><strong>{summary.itemCount}</strong><span>exact item/source groups</span></div>
      <div><strong>{summary.recipientRows}</strong><span>recipient assessments</span></div>
      <div><strong>{summary.conditional}</strong><span>conditional candidate screens</span></div>
      <div><strong>{summary.insufficient}</strong><span>insufficient-evidence outcomes</span></div>
    </div>
    <p className="muted small">Roster scope: {characters.length} Forever character{characters.length === 1 ? "" : "s"} in the selected realm view. Same realm does not establish account membership, shared storage, or mail/trade access. No bank rows are inferred from missing bank observations.</p>
    {load.state.status === "loading" && !load.state.data && <p role="status">Loading recipient assessments for the Forever roster…</p>}
    {load.state.status === "error" && <p role="alert">Could not load the roster review: {String(load.state.error)} <button onClick={load.retry}>Retry</button></p>}
    {failed.length > 0 && <details className="detail-card"><summary>Some character assessments are unavailable ({failed.length})</summary><ul>{failed.map((r) => <li key={r.identityKey}>{characterDisplayName(r)} ({r.realm}): {r.error ?? (r.result?.status !== "FOUND" ? `The endpoint returned ${r.result?.status ?? "no response"}.` : "The response did not contain the expected Forever 70291 allocation data.")}</li>)}</ul></details>}
    <div className="forever-review-controls">
      <label>Recipient <select value={recipient} onChange={(e) => setRecipient(e.target.value)}><option value="">All observed characters</option>{characters.map((c) => <option key={c.identityKey} value={c.identityKey}>{characterDisplayName(c)} · {c.realm}</option>)}</select></label>
      <label>Assessment <select value={disposition} onChange={(e) => setDisposition(e.target.value)}><option value="">All outcomes</option>{Object.entries(dispositionLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="forever-review-search">Find item or character <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, item variant, character…" /></label>
    </div>
    {filteredGroups.length === 0 && load.state.status === "ready" && <div className="detail-card"><h3>No matching gear assessments</h3><p>{groups.length === 0 && characters.length === 0 ? "There are no Forever characters in this realm view." : groups.length === 0 && failed.length > 0 ? "No usable allocation data was returned for the available characters. Refresh or open a character to inspect the response; this is not an empty-inventory result." : groups.length === 0 ? "No allocation rows are supported by the current Forever observations. This does not establish that the characters own no other gear; inaccessible banks remain unknown." : "Change or clear a filter to see other assessments."}</p></div>}
    <div className="forever-review-list">{filteredGroups.map((group) => <article className="detail-card forever-review-item" key={group.key}>
      <header><div><h3>{group.itemLabel}</h3><p className="muted small">{group.itemRef ? `Exact observed variant: ${group.itemRef}` : "Exact item variant UNKNOWN; this row is kept separate by recipient."}</p></div><span className="evidence-chip">{group.recipients.length} recipient{group.recipients.length === 1 ? "" : "s"} screened</span></header>
      <p><strong>Observed source:</strong> {group.sourceLabel}{group.sourceContextDiffers
        ? " · source location or freshness differs between recipient reads; inspect each assessment below."
        : ` · ${group.location === "CARRIED_INVENTORY" ? "carried inventory" : group.location === "EQUIPPED" ? "equipped" : "location UNKNOWN"} · ${group.provenance}. ${group.observedAt ? `Observed ${formatAbsoluteTime(group.observedAt)} (${group.freshness}).` : `Timestamp UNKNOWN (${group.freshness}).`}`}</p>
      <button type="button" className="link-button" onClick={() => onOpenCharacter(group.sourceIdentityKey)}>Open source character</button>
      <div className="forever-review-recipient-list">{group.recipients.map((row, rowIndex) => <section key={`${row.identityKey}:${row.disposition}:${rowIndex}`} className="forever-review-recipient">
        <div className="forever-review-recipient-heading"><h4>{characterDisplayName(row)} · {row.realm}</h4><span className={`forever-disposition disposition-${row.disposition.toLowerCase()}`}>{dispositionLabel[row.disposition] ?? row.disposition}</span><button type="button" className="link-button" onClick={() => onOpenCharacter(row.identityKey)}>Open character</button></div>
        {row.conflicting && <p className="forever-review-conflict" role="alert"><strong>Conflicting assessments for this exact item and character.</strong> Review both evidence rows below; do not treat either outcome as an instruction.</p>}
        <p>{row.evidence.reasons.join(" ") || "No explanatory reason was supplied."}</p>
        <p className="muted small">Source evidence: {row.source.location === "CARRIED_INVENTORY" ? "carried inventory" : row.source.location === "EQUIPPED" ? "equipped" : "location UNKNOWN"} · {row.source.provenance} · {row.source.observedAt ? formatAbsoluteTime(row.source.observedAt) : "timestamp UNKNOWN"} ({row.source.freshness}). {characterDisplayName(row)}'s snapshot is {row.recipientEvidence.freshness}{row.recipientEvidence.observedAt ? ` · observed ${formatAbsoluteTime(row.recipientEvidence.observedAt)}` : " · timestamp UNKNOWN"}; equipment is {row.recipientEvidence.equipment.state}{row.recipientEvidence.equipment.observedAt ? ` · observed ${formatAbsoluteTime(row.recipientEvidence.equipment.observedAt)} (${row.recipientEvidence.equipment.freshness ?? "freshness UNKNOWN"})` : " · timestamp UNKNOWN"}. Class {row.recipientEvidence.class ? `${row.recipientEvidence.class.value} (${row.recipientEvidence.class.provenance})` : "UNKNOWN"}; level {row.recipientEvidence.level ? `${row.recipientEvidence.level.value} (${row.recipientEvidence.level.provenance})` : "UNKNOWN"}.</p>
        <p className="muted small">Eligibility: {describeForeverAssessment(row.evidence.eligibility)} · suitability: {describeForeverAssessment(row.evidence.suitability)} · transferability: {describeForeverAssessment(row.evidence.transferability)}. Evidence: {describeForeverAssessment(row.evidence.provenance)} · confidence {row.evidence.confidence.toLowerCase()}.</p>
        {row.comparison?.rawComparisons.map((comparison, index) => <p className="muted small" key={`${comparison.slot}:${comparison.equippedItemRef}:${index}`}>Observed comparison for slot {comparison.slot} against {comparison.equippedItemRef}: {describeForeverAssessment(comparison.classification)}. {comparison.reason} This is a metric comparison, not a complete upgrade verdict.</p>)}
        {row.evidence.whatWouldChange.length > 0 && <details><summary>What evidence would improve this assessment</summary><ul>{row.evidence.whatWouldChange.map((fact, index) => <li key={`${index}:${fact}`}>{fact}</li>)}</ul></details>}
      </section>)}</div>
    </article>)}</div>
    <p className="muted small">A carried item is shown at its observed location, not treated as account-owned. This review does not recommend a mail, trade, or bank transfer. LAST_SEEN observations retain their historical label; missing evidence stays UNKNOWN.</p>
  </section>;
}
