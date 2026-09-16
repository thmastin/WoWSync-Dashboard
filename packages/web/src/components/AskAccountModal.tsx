import { useEffect, useState } from "react";
import { askAccount, fetchAccountContext } from "../api.ts";
import { renderMarkdownLite } from "../markdownLite.tsx";
import type { AskAccountResponse } from "../types.ts";

export default function AskAccountModal({ onClose }: { onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AskAccountResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextSummary, setContextSummary] = useState<string | null>(null);

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

  async function handleAsk() {
    if (asking) return;
    const trimmed = question.trim();
    if (!trimmed) return;
    setAsking(true);
    setError(null);
    setResult(null);
    try {
      const response = await askAccount(trimmed);
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
          answer. Nothing else — no filesystem paths, credentials, or machine info — leaves this
          computer, and no conversation history is kept between questions.
        </p>

        {contextSummary && (
          <div className="muted small" style={{ marginTop: 4 }}>
            {contextSummary}
          </div>
        )}

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
