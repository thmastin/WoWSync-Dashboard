import { useState } from "react";
import { askForeverCopilot } from "../api.ts";
import { renderMarkdownLite } from "../markdownLite.tsx";
import { useDialogBehavior } from "../useDialogBehavior.ts";

const EXAMPLES = [
  "I'm playing Rordin. Look at my character, account, and the game. What are the most valuable things I could do to improve this character, including things I haven't considered?",
  "Look at my Forever stable and tell me how I can make gold using the characters, professions, and resources I actually have.",
];

/** Forever Co-Pilot: ask a goal question, get ranked, evidence-backed recommendations. Read-only. */
export default function ForeverCopilotModal({ onClose }: { onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useDialogBehavior(onClose, !busy);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setQuestion(trimmed);
    setBusy(true);
    setError(null);
    try {
      const result = await askForeverCopilot(trimmed);
      setAnswer(result.markdown);
    } catch (err) {
      setAnswer(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="forever-copilot-title" ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id="forever-copilot-title">Forever Co-Pilot</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close" disabled={busy}>✕</button>
        </div>
        <p className="muted">
          Ask about a character or your whole stable. Answers combine your Forever exports with the Wowhead Forever database and
          label every fact as observed, derived, last-seen, external, or unknown. Read-only: it never moves items or plays for you.
        </p>
        <textarea
          className="ask-textarea"
          rows={3}
          value={question}
          placeholder="What should Rordin do next? How can my stable make gold?"
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="Question for the Forever Co-Pilot"
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
          <button className="primary-button" onClick={() => ask(question)} disabled={busy || !question.trim()}>{busy ? "Thinking…" : "Ask"}</button>
          {EXAMPLES.map((example, index) => (
            <button key={example} className="dev-button" onClick={() => ask(example)} disabled={busy} title={example}>
              {index === 0 ? "Example: improve Rordin" : "Example: stable goldmaking"}
            </button>
          ))}
        </div>
        {error && <div className="error-notice" role="alert">{error}</div>}
        {answer && <div className="ask-answer"><div className="ask-answer-body">{renderMarkdownLite(answer)}</div></div>}
      </div>
    </div>
  );
}
