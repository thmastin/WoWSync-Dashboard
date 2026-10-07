import { useEffect, useState } from "react";
import { askAccount, fetchAccountContext, fetchGearCandidateEvidence, type GearCandidateRef } from "../api.ts";
import { renderMarkdownLite } from "../markdownLite.tsx";
import type { AskAccountResponse } from "../types.ts";

export default function AskAccountModal({ onClose }: { onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AskAccountResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextSummary, setContextSummary] = useState<string | null>(null);
  const [gearCandidates, setGearCandidates] = useState<Array<GearCandidateRef & { key: string; label: string }>>([]);
  const [gearCandidateKey, setGearCandidateKey] = useState("");

  // A lightweight summary only, never the full context - shows the user
  // what scope the model is working from without dumping ~100KB into the UI.
  useEffect(() => {
    fetchAccountContext()
      .then((ctx) => {
        const versions = Object.keys(ctx.versions);
        const characterCount = Object.values(ctx.versions).reduce((sum, v) => sum + v.characters.length, 0);
        setContextSummary(`Context: ${characterCount} character${characterCount === 1 ? "" : "s"} · ${versions.length} WoW version${versions.length === 1 ? "" : "s"}`);
      })
      .catch(() => setContextSummary(null));
  }, []);

  useEffect(() => {
    let active = true;
    fetchGearCandidateEvidence("retail").then((response) => {
      if (!active) return;
      const refs: Array<GearCandidateRef & { key: string; label: string }> = [];
      for (const character of response.data?.characters ?? []) {
        if (!character.captured || !character.snapshot || !character.sidecar) continue;
        character.sidecar.rows.forEach((row, index) => {
          const item = row.itemID.state === "KNOWN" ? `Item ${row.itemID.value}` : row.itemString.value ?? "Unknown item";
          const ilvl = row.currentItemLevel.state === "KNOWN" ? ` · ilvl ${row.currentItemLevel.value}` : "";
          const ref = { exporterIdentityKey: character.identity.identityKey, snapshotId: character.snapshot!.snapshotId, rowOrdinal: index + 1 };
          refs.push({ ...ref, key: `${ref.exporterIdentityKey}|${ref.snapshotId}|${ref.rowOrdinal}`, label: `${character.identity.name} · ${item}${ilvl} · snapshot ${ref.snapshotId} row ${ref.rowOrdinal}` });
        });
      }
      setGearCandidates(refs);
    }).catch(() => { if (active) setGearCandidates([]); });
    return () => { active = false; };
  }, []);

  async function handleAsk() {
    if (asking) return;
    const trimmed = question.trim();
    if (!trimmed) return;
    setAsking(true);
    setError(null);
    setResult(null);
    try {
      const selectedGearCandidate = gearCandidates.find((candidate) => candidate.key === gearCandidateKey);
      const response = await askAccount(trimmed, selectedGearCandidate);
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Ask My Account</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="modal-hint">
          Experimental. Unlike Developer → Export (which is entirely local), this sends your
          question and the current account context to an external LLM provider for a one-off
          answer. If you select a Retail candidate below, its deterministic allocation result is
          included too. No filesystem paths, credentials, or machine info are sent, and no
          conversation history is kept between questions.
        </p>

        {contextSummary && (
          <div className="muted small" style={{ marginTop: 4 }}>
            {contextSummary}
          </div>
        )}

        {gearCandidates.length > 0 && <label className="ask-gear-candidate">Include deterministic Retail gear analysis (optional)
          <select value={gearCandidateKey} onChange={(event) => setGearCandidateKey(event.target.value)} disabled={asking}>
            <option value="">No gear candidate</option>
            {gearCandidates.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
          </select>
        </label>}

        <textarea
          className="import-textarea ask-textarea"
          rows={3}
          placeholder="e.g. How much gold do I have on TBC Anniversary?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAsk();
          }}
          disabled={asking}
        />

        <div className="modal-actions">
          <button className="primary-button" onClick={handleAsk} disabled={asking || question.trim().length === 0}>
            {asking ? "Asking…" : "Ask"}
          </button>
        </div>

        {error && <div className="import-error">{error}</div>}

        {result && (
          <div className="ask-answer">
            <div className="import-fact-title">Answer</div>
            <div className="ask-answer-body">{renderMarkdownLite(result.answer)}</div>
            {result.gearAllocationRecommendation && <div className="muted small">Deterministic gear result included: {result.gearAllocationRecommendation.replaceAll("_", " ")}</div>}
            <div className="muted small">
              {result.model}
              {result.usage?.totalTokens !== undefined ? ` · ${result.usage.totalTokens} tokens` : ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
