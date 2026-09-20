import { useState } from "react";
import { deleteCharacter } from "../api.ts";
import { describeDeletion, isDeleteConfirmed, requiredConfirmationText, type DeleteTarget } from "../deleteConfirmation.ts";
import { performDelete } from "../deleteFlow.ts";

/**
 * Confirmation dialog for permanently deleting one character and its
 * snapshot history. Cancel is the safe/default path: the destructive button
 * stays disabled until the character's exact name has been typed, and
 * clicking the backdrop or pressing Cancel closes without doing anything.
 * All the rules (what to say, when to enable) come from deleteConfirmation.ts;
 * what a server reply MEANS comes from deleteFlow.ts, so a failed deletion
 * can never look like a successful one.
 */
export default function DeleteCharacterModal({
  target,
  onClose,
  onDeleted,
}: {
  target: DeleteTarget;
  onClose: () => void;
  /** Called only after the character is confirmed gone (deleted, or the server itself said it no longer exists), so the caller can refresh and leave the page. */
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyGone, setAlreadyGone] = useState<string | null>(null);
  const confirmed = isDeleteConfirmed(typed, target);

  async function handleDelete() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await performDelete(target.identityKey, deleteCharacter);
    if (outcome.kind === "deleted") {
      onDeleted();
      return;
    }
    setBusy(false);
    if (outcome.kind === "already-gone") {
      // Honest about it: this action removed nothing. The user acknowledges, then the page refreshes.
      setAlreadyGone(outcome.message);
      return;
    }
    setError(outcome.message); // a failed deletion is shown as a failure - the dialog stays open
  }

  const [character, realm, version, ...explanation] = describeDeletion(target);

  if (alreadyGone) {
    return (
      <div className="modal-backdrop">
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-character-title">
          <div className="modal-header">
            <h2 id="delete-character-title">Character already gone</h2>
          </div>
          <p className="modal-hint">{alreadyGone}</p>
          <div className="modal-actions">
            <button className="primary-button" onClick={onDeleted} autoFocus>
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

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

        {error && (
          <div className="import-error" role="alert">
            {error}
          </div>
        )}

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
