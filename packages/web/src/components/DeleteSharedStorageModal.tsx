import { useState } from "react";
import { deleteSharedStorageOwner } from "../api.ts";
import { isOwnerDeletionConfirmed, performOwnerDelete, type OwnerDeleteOutcome, type OwnerDeletionTarget } from "../sharedStorage.ts";
import { useDialogBehavior } from "../useDialogBehavior.ts";

/**
 * The dialog for clearing ONE owner's stored shared-storage history. Presentational: the caller owns the
 * typed text, the busy flag and the messages (see DeleteSharedStorageModal). The destructive button stays
 * disabled until the exact required text is typed; Cancel is the default focus and Escape closes.
 */
export function SharedDeleteDialogView({
  target,
  typed,
  onTyped,
  busy,
  error,
  alreadyGone,
  onCancel,
  onConfirm,
  onAcknowledge,
}: {
  target: OwnerDeletionTarget;
  typed: string;
  onTyped: (value: string) => void;
  busy: boolean;
  error: string | null;
  alreadyGone: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onAcknowledge: () => void;
}) {
  const ref = useDialogBehavior(alreadyGone ? onAcknowledge : onCancel, !busy);
  const confirmed = isOwnerDeletionConfirmed(typed, target);

  if (alreadyGone) {
    return (
      <div className="modal-backdrop">
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="shared-delete-title" ref={ref}>
          <div className="modal-header">
            <h2 id="shared-delete-title">Already cleared</h2>
          </div>
          <p className="modal-hint">{alreadyGone}</p>
          <div className="modal-actions">
            <button className="primary-button" onClick={onAcknowledge} autoFocus>
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="shared-delete-title" aria-describedby="shared-delete-warning" ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id="shared-delete-title">{target.title}</h2>
          <button className="icon-button" onClick={onCancel} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        <ul className="delete-summary">
          {target.summary.map((row) => (
            <li key={row.label}>
              {row.label}: {row.label === "GuildClubID" ? <span className="shared-mono">{row.value}</span> : row.value}
            </li>
          ))}
        </ul>
        <p className="shared-warning" id="shared-delete-warning">
          {target.warning}
        </p>
        {target.consequences.map((line) => (
          <p key={line} className="modal-hint">
            {line}
          </p>
        ))}

        <label className="delete-confirm-label" htmlFor="shared-delete-input">
          To confirm, type <strong className="shared-mono">{target.requiredText}</strong> below:
        </label>
        <input
          id="shared-delete-input"
          className="delete-confirm-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          disabled={busy}
        />

        {error && (
          <div className="import-error" role="alert">
            {error}
          </div>
        )}

        <div className="modal-actions">
          <button className="secondary-button" onClick={onCancel} disabled={busy} autoFocus>
            Cancel
          </button>
          <button className="danger-button" onClick={onConfirm} disabled={!confirmed || busy}>
            {busy ? "Clearing…" : "Clear stored history"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The stateful dialog. `onDone` runs once the history is confirmed cleared (or the server itself said it already was). */
export default function DeleteSharedStorageModal({
  target,
  onClose,
  onDone,
}: {
  target: OwnerDeletionTarget;
  onClose: () => void;
  onDone: (outcome: Extract<OwnerDeleteOutcome, { kind: "deleted" | "already-gone" }>) => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyGone, setAlreadyGone] = useState<string | null>(null);

  async function confirm() {
    if (busy || !isOwnerDeletionConfirmed(typed, target)) return;
    setBusy(true);
    setError(null);
    const outcome = await performOwnerDelete(target.owner, deleteSharedStorageOwner);
    if (outcome.kind === "deleted") {
      onDone(outcome);
      return;
    }
    setBusy(false);
    if (outcome.kind === "already-gone") {
      setAlreadyGone(outcome.message); // honest: this action removed nothing; the user acknowledges, then the view refreshes
      return;
    }
    setError(outcome.message); // a failed clearing is shown as a failure; the dialog stays open
  }

  return (
    <SharedDeleteDialogView
      target={target}
      typed={typed}
      onTyped={setTyped}
      busy={busy}
      error={error}
      alreadyGone={alreadyGone}
      onCancel={onClose}
      onConfirm={confirm}
      onAcknowledge={() => onDone({ kind: "already-gone", message: alreadyGone ?? "" })}
    />
  );
}
