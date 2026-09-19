import { useState } from "react";
import { ApiError, deleteCharacter } from "../api.ts";
import { describeDeletion, isDeleteConfirmed, requiredConfirmationText, type DeleteTarget } from "../deleteConfirmation.ts";

/**
 * Confirmation dialog for permanently deleting one character and its
 * snapshot history. Cancel is the safe/default path: the destructive button
 * stays disabled until the character's exact name has been typed, and
 * clicking the backdrop or pressing Cancel closes without doing anything.
 * All the rules (what to say, when to enable) come from deleteConfirmation.ts.
 */
export default function DeleteCharacterModal({
  target,
  onClose,
  onDeleted,
}: {
  target: DeleteTarget;
  onClose: () => void;
  /** Called after the character is gone (including "was already gone"), so the caller can refresh and leave the now-empty page. */
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = isDeleteConfirmed(typed, target);

  async function handleDelete() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteCharacter(target.identityKey);
      onDeleted();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Already deleted elsewhere: the desired end state is reached.
        onDeleted();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const [character, realm, version, ...explanation] = describeDeletion(target);

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-character-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id="delete-character-title">Delete character?</h2>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        <ul className="delete-summary">
          <li>{character}</li>
          <li>{realm}</li>
          <li>{version}</li>
        </ul>
        {explanation.map((line) => (
          <p key={line} className="modal-hint">
            {line}
          </p>
        ))}

        <label className="delete-confirm-label" htmlFor="delete-confirm-input">
          To confirm, type <strong>{requiredConfirmationText(target)}</strong> below:
        </label>
        <input
          id="delete-confirm-input"
          className="delete-confirm-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={busy}
        />

        {error && <div className="import-error">{error}</div>}

        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} disabled={busy} autoFocus>
            Cancel
          </button>
          <button className="danger-button" onClick={handleDelete} disabled={!confirmed || busy}>
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}
