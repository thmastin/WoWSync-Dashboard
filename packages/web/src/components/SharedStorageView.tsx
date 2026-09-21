import { useState } from "react";
import { fetchSharedStorage } from "../api.ts";
import {
  EMPTY_DETAIL,
  EMPTY_HEADLINE,
  describeDeletionResult,
  describeIntegrityFailure,
  describeOwnerDeletion,
  isEmptyShared,
  orderedOwners,
  type OwnerDeleteOutcome,
  type OwnerDeletionTarget,
} from "../sharedStorage.ts";
import type { SharedOwnerIdentity, SharedStorageResponse } from "../types.ts";
import { useAsync } from "../useAsync.ts";
import { ItemInfoContext, useItemInfoLoader } from "../useItemInfo.ts";
import DeleteSharedStorageModal from "./DeleteSharedStorageModal.tsx";
import ErrorNotice from "./ErrorNotice.tsx";
import SharedOwnerCard from "./SharedOwnerCard.tsx";

/** The stable id of an owner's card (for links and aria). The Warband has one; guilds are numbered by their sorted position. */
export function ownerAnchorId(owner: SharedOwnerIdentity, guildIndex: number): string {
  return owner.kind === "warband" ? "shared-warband" : `shared-guild-${guildIndex + 1}`;
}

/** A failed load caused by damaged stored data: says so, names the owners, and offers the explicit recovery for each one that can be identified safely. */
export function IntegrityFailureNotice({ error, onRequestClear }: { error: unknown; onRequestClear: (owner: SharedOwnerIdentity) => void }) {
  const failure = describeIntegrityFailure(error);
  if (!failure) return null;
  return (
    <div className="error-notice shared-integrity" role="alert">
      <h3>{failure.heading}</h3>
      <p>{failure.explanation}</p>
      <ul className="compact-list">
        {failure.damaged.map((d) => (
          <li key={d.ownerKey} className="shared-damaged">
            <span>
              <strong>{d.label}</strong> <span className="status-badge status-neutral">Damaged</span>
            </span>
            {d.owner ? (
              <button className="danger-button" onClick={() => onRequestClear(d.owner as SharedOwnerIdentity)} aria-label={`Clear stored history for ${d.label}`}>
                Clear stored history…
              </button>
            ) : (
              <span className="muted small">This owner could not be identified, so it cannot be cleared from here.</span>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">{failure.recovery}</p>
    </div>
  );
}

export type SharedLoadStatus = "loading" | "ready" | "error";

/**
 * The whole Shared Storage surface, purely from props (so every state can be rendered and tested): a loading
 * skeleton, an empty state that does not imply empty storage, the owners, and a load failure - shown as an
 * integrity failure with recovery actions when that is what it is. Existing data stays visible during a refresh.
 */
export function SharedStorageBody({
  status,
  data,
  error,
  flash,
  onRetry,
  onRequestClear,
}: {
  status: SharedLoadStatus;
  data?: SharedStorageResponse;
  error?: unknown;
  /** A status message for the last action (e.g. "Cleared ..."). */
  flash?: string | null;
  onRetry: () => void;
  onRequestClear: (owner: SharedOwnerIdentity) => void;
}) {
  const integrity = status === "error" && error !== undefined && describeIntegrityFailure(error) !== undefined;
  const owners = data ? orderedOwners(data) : [];
  let guildIndex = 0;
  return (
    <div className="shared-page" aria-busy={status === "loading"}>
      <div className="shared-page-header">
        <h2>Shared Storage</h2>
        <p className="muted small">
          Storage that belongs to your account or a guild, not to any one character: the Warband Bank and Guild Banks, reconciled from every export that carried an
          observation of them. It is shown here only; it is not part of any total, item search, or Ask My Account context.
        </p>
      </div>

      {flash && (
        <div className="shared-flash" role="status">
          {flash}
        </div>
      )}

      {status === "error" && integrity && <IntegrityFailureNotice error={error} onRequestClear={onRequestClear} />}
      {status === "error" && !integrity && <ErrorNotice error={error} onRetry={onRetry} />}

      {status === "loading" && !data && (
        <div className="panel shared-skeleton" role="status">
          Loading shared storage…
        </div>
      )}

      {data && isEmptyShared(data) && !integrity && (
        <div className="panel shared-empty">
          <h3>{EMPTY_HEADLINE}</h3>
          <p className="muted">{EMPTY_DETAIL}</p>
        </div>
      )}

      {data && !integrity && (
        <div className="shared-owners">
          {owners.map((owner) => {
            const index = owner.owner.kind === "guild" ? guildIndex++ : 0;
            return <SharedOwnerCard key={owner.owner.ownerKey} owner={owner} anchorId={ownerAnchorId(owner.owner, index)} onRequestClear={onRequestClear} />;
          })}
        </div>
      )}
    </div>
  );
}

/** The Shared Storage tab: loads GET /api/shared-storage, and clears one owner's stored history through the confirmation dialog. */
export default function SharedStorageView() {
  const [reloadTick, setReloadTick] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [pending, setPending] = useState<OwnerDeletionTarget | null>(null);
  const load = useAsync((signal) => fetchSharedStorage(signal), "shared-storage", reloadTick);
  // Shared storage is Retail-only; its item rows are enriched from Retail's game-client metadata (never blocks the view).
  const itemInfo = useItemInfoLoader("retail", reloadTick);

  function finished(target: OwnerDeletionTarget, outcome: Extract<OwnerDeleteOutcome, { kind: "deleted" | "already-gone" }>) {
    setPending(null);
    setFlash(describeDeletionResult(target.owner, outcome));
    setReloadTick((t) => t + 1); // refresh: the owner leaves the view (or the state that changed underneath is shown)
  }

  return (
    <ItemInfoContext.Provider value={itemInfo}>
      <SharedStorageBody
        status={load.state.status}
        data={load.state.data}
        error={load.state.status === "error" ? load.state.error : undefined}
        flash={flash}
        onRetry={load.retry}
        onRequestClear={(owner) => setPending(describeOwnerDeletion(owner))}
      />
      {pending && <DeleteSharedStorageModal target={pending} onClose={() => setPending(null)} onDone={(outcome) => finished(pending, outcome)} />}
    </ItemInfoContext.Provider>
  );
}
