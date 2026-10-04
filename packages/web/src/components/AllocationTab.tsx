import { useState } from "react";
import {
  fetchAllocationReview,
  createDemand,
  updateDemand,
  deactivateDemand,
  type AllocationReviewQuery,
  type CreateDemandInput,
  type UpdateDemandInput,
  ApiError,
  describeApiError,
} from "../api.ts";
import { useAsync } from "../useAsync.ts";
import type { VersionOrUnknown, AllocationResult, ExplicitDemand } from "@wowsync-dashboard/core";
import { buildTargetRowViews, buildUnallocatedRowViews, formatCell, type TargetRowView, type UnallocatedRowView } from "../allocationView.ts";
import ErrorNotice from "./ErrorNotice.tsx";

interface AllocationTabProps {
  activeVersion: VersionOrUnknown;
  refreshTick: number;
}

interface OperationState {
  status: "idle" | "loading" | "success" | "error";
  message?: string;
}

export default function AllocationTab({ activeVersion, refreshTick }: AllocationTabProps) {
  const [demandedOffset, setDemandedOffset] = useState(0);
  const [unallocatedOffset, setUnallocatedOffset] = useState(0);
  const [unallocatedSearch, setUnallocatedSearch] = useState("");
  const [operationState, setOperationState] = useState<OperationState>({ status: "idle" });
  const [refetchKey, setRefetchKey] = useState(0);

  const pageSize = 50;
  const query: AllocationReviewQuery = {
    demandedOffset,
    demandedLimit: pageSize,
    unallocatedOffset,
    unallocatedLimit: pageSize,
    q: unallocatedSearch || undefined,
  };

  // Use refetchKey to force a deterministic refetch after mutations
  const reviewLoad = useAsync(
    (signal) => fetchAllocationReview(activeVersion, query, signal),
    `allocation-${activeVersion}-${demandedOffset}-${unallocatedOffset}-${unallocatedSearch}-${refetchKey}`,
    refreshTick,
  );

  const review = reviewLoad.state.data?.data;
  const itemNames = reviewLoad.state.data?.provenance?.itemNames ?? {};

  async function handleCreateDemand(input: CreateDemandInput) {
    setOperationState({ status: "loading" });
    try {
      const result = await createDemand(activeVersion, input);
      setOperationState({ status: "success", message: "Target created" });
      // Reset to first page of demanded items
      setDemandedOffset(0);
      setRefetchKey((k) => k + 1);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      if (apiErr?.code === "DEMAND_CONFLICT") {
        setOperationState({ status: "error", message: `This item already has a target. Edit it instead.` });
      } else {
        setOperationState({ status: "error", message: describeApiError(err) });
      }
    }
  }

  async function handleUpdateDemand(stableId: string, input: UpdateDemandInput) {
    setOperationState({ status: "loading" });
    try {
      await updateDemand(activeVersion, stableId, input);
      setOperationState({ status: "success", message: "Target updated" });
      setRefetchKey((k) => k + 1);
    } catch (err) {
      setOperationState({ status: "error", message: describeApiError(err) });
    }
  }

  async function handleDeactivateDemand(stableId: string) {
    setOperationState({ status: "loading" });
    try {
      await deactivateDemand(activeVersion, stableId);
      setOperationState({ status: "success", message: "Target removed" });
      setRefetchKey((k) => k + 1);
    } catch (err) {
      setOperationState({ status: "error", message: describeApiError(err) });
    }
  }

  if (activeVersion !== "retail") {
    return <div className="allocation-tab-container"><p className="allocation-version-notice">Allocation is Retail-only in this version.</p></div>;
  }

  if (reviewLoad.state.status === "error") {
    return <ErrorNotice error={reviewLoad.state.error} onRetry={reviewLoad.retry} />;
  }

  if (reviewLoad.state.status === "loading") {
    return <div className="loading">Loading allocation review…</div>;
  }

  if (!review) {
    return <div className="allocation-tab-container"><p className="allocation-version-notice">No allocation data available.</p></div>;
  }

  // Build semantic view models
  const targetRows = buildTargetRowViews(review, itemNames);
  const unallocatedRows = buildUnallocatedRowViews(review);

  // Separate CONFLICTING_DEMAND items for special handling
  const conflictingItems = review.demanded.items.filter((r) => r.resolution === "CONFLICTING_DEMAND");
  const inactiveTargets = review.inactiveTargets ?? [];

  return (
    <div className="allocation-tab-container">
      {operationState.status !== "idle" && (
        <div className={`allocation-operation-notice ${operationState.status === "error" ? "error" : "success"}`}>
          {operationState.message}
        </div>
      )}

      {review.unresolvedStorage.length > 0 && (
        <div className="allocation-account-status">
          <strong>Account Status:</strong> {review.unresolvedStorage.length} storage scope(s) not yet observed.
          {review.unresolvedStorage.map((scope) => (
            <div key={`${scope.scope}${scope.identityKey ?? ""}`} className="allocation-unresolved-scope">
              {scope.identityKey ? `Character "${scope.identityKey}" - ` : ""}
              {scope.scope}
            </div>
          ))}{" "}
          Confirmed quantities remain usable, but surplus may require review.
        </div>
      )}

      <section className="allocation-section">
        <h2>Your Targets ({review.demanded.totalCount})</h2>
        {conflictingItems.length > 0 && (
          <div className="allocation-conflicting-warning">
            <strong>⚠️ Conflicting Demands:</strong> Multiple targets exist for these items. Only one active target can exist per item.
            {conflictingItems.map((result) => (
              <div key={result.commodity.baseItemId} className="allocation-conflicting-item">
                Item {result.commodity.baseItemId}
              </div>
            ))}
          </div>
        )}
        {review.demanded.items.filter((r) => r.resolution !== "CONFLICTING_DEMAND").length === 0 ? (
          <p className="allocation-empty-notice">No targets set yet. Add one below.</p>
        ) : (
          <div className="allocation-items-grid">
            {targetRows.map((row) => (
              <TargetRowComponent
                key={row.baseItemId}
                row={row}
                allocationResult={review.demanded.items.find((r) => r.commodity.baseItemId === row.baseItemId)}
                onEdit={() => {
                  // TODO: open edit form with pre-filled data
                }}
                onDeactivate={() => {
                  const demand = review.demanded.items.find((r) => r.commodity.baseItemId === row.baseItemId)?.demand;
                  if (demand) handleDeactivateDemand(demand.stableId);
                }}
              />
            ))}
          </div>
        )}
        {review.demanded.truncated && (
          <div className="allocation-pagination">
            <p className="allocation-pagination-info">
              Showing {review.demanded.items.length} of {review.demanded.totalCount} targets
            </p>
            <div className="allocation-pagination-controls">
              <button
                className="secondary-button"
                onClick={() => setDemandedOffset(Math.max(0, demandedOffset - pageSize))}
                disabled={demandedOffset === 0}
              >
                ← Previous
              </button>
              <button className="secondary-button" onClick={() => setDemandedOffset(demandedOffset + pageSize)}>
                Next →
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="allocation-section">
        <h2>Held With No Target ({review.unallocated.totalCount})</h2>
        <p className="allocation-section-help">No target set, so surplus is unknown. This is not surplus.</p>
        <div className="allocation-search-box">
          <input
            type="text"
            placeholder="Search by item name or ID…"
            value={unallocatedSearch}
            onChange={(e) => {
              setUnallocatedSearch(e.target.value);
              setUnallocatedOffset(0);
            }}
            className="allocation-search-input"
          />
        </div>
        {review.unallocated.items.length === 0 ? (
          <p className="allocation-empty-notice">
            {unallocatedSearch ? "No items match your search." : "No unallocated items."}
          </p>
        ) : (
          <div className="allocation-items-grid">
            {unallocatedRows.map((row) => (
              <UnallocatedRowComponent
                key={row.baseItemId}
                row={row}
                onSetTarget={(qty) => handleCreateDemand({ baseItemId: row.baseItemId, requiredQuantity: qty })}
              />
            ))}
          </div>
        )}
        {review.unallocated.truncated && (
          <div className="allocation-pagination">
            <p className="allocation-pagination-info">
              Showing {review.unallocated.items.length} of {review.unallocated.totalCount} unallocated items
            </p>
            <div className="allocation-pagination-controls">
              <button
                className="secondary-button"
                onClick={() => setUnallocatedOffset(Math.max(0, unallocatedOffset - pageSize))}
                disabled={unallocatedOffset === 0}
              >
                ← Previous
              </button>
              <button className="secondary-button" onClick={() => setUnallocatedOffset(unallocatedOffset + pageSize)}>
                Next →
              </button>
            </div>
          </div>
        )}
      </section>

      {inactiveTargets.length > 0 && (
        <section className="allocation-section">
          <details className="allocation-inactive-details">
            <summary className="allocation-inactive-summary">Where did my target go? ({inactiveTargets.length} removed)</summary>
            <div className="allocation-items-grid">
              {inactiveTargets.map((demand) => (
                <div key={demand.stableId} className="allocation-item-card allocation-inactive-item">
                  <div className="allocation-item-title">Item {demand.commodity.baseItemId}</div>
                  {demand.purpose && <div className="allocation-item-purpose">{demand.purpose}</div>}
                  <div className="allocation-item-meta">Was keeping {demand.requiredQuantity}</div>
                  <button
                    className="secondary-button"
                    onClick={() => handleCreateDemand({ baseItemId: demand.commodity.baseItemId, requiredQuantity: demand.requiredQuantity, purpose: demand.purpose })}
                  >
                    Set New Target
                  </button>
                </div>
              ))}
            </div>
          </details>
        </section>
      )}

      <section className="allocation-section">
        <h2>Add Target by Item ID</h2>
        <p className="allocation-section-help">
          Set a target for an item not currently held. Keep 0 means you want none of this. Confirmed holdings beyond 0 can become surplus when the evidence is sufficient. This is different from Remove target, which means you have not specified what you want.
        </p>
        <AddTargetForm onSubmit={handleCreateDemand} isLoading={operationState.status === "loading"} />
      </section>
    </div>
  );
}

function TargetRowComponent({
  row,
  allocationResult,
  onEdit,
  onDeactivate,
}: {
  row: TargetRowView;
  allocationResult?: AllocationResult;
  onEdit: () => void;
  onDeactivate: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="allocation-item-card">
      <div className="allocation-item-header">
        <div className="allocation-item-title">
          {row.name || `Item ${row.baseItemId}`}
          {row.demand.purpose && <span className="allocation-item-purpose"> ({row.demand.purpose})</span>}
        </div>
        <div className="allocation-item-status">
          <strong>Keep {row.demand.requiredQuantity}</strong> · Have {formatCell(row.confirmedAvailableCell)}
          {row.deficitCell.kind === "numeric" && row.deficitCell.value > 0 && (
            <span className="allocation-deficit"> · Short {row.deficitCell.value}</span>
          )}
          {row.surplusCell.kind === "numeric" && row.surplusCell.value > 0 && (
            <span className="allocation-surplus"> · {row.surplusCell.value} surplus</span>
          )}
          {row.surplusCell.kind === "withheld" && (
            <span className="allocation-surplus-withheld"> · Surplus withheld ({row.surplusCell.reason})</span>
          )}
          {row.deficitCell.kind === "notApplicable" && row.surplusCell.kind === "notApplicable" && <span className="allocation-on-target"> · On target</span>}
        </div>
      </div>

      {row.reasonChips.length > 0 && (
        <div className="allocation-reason-chips">
          {row.reasonChips.map((chip, i) => (
            <span key={i} className="allocation-reason-chip" title={chip.detail}>
              {chip.text}
            </span>
          ))}
        </div>
      )}

      <button className="allocation-expand-button" onClick={() => setIsExpanded(!isExpanded)}>
        {isExpanded ? "▼ Hide" : "▶ Show"} Details
      </button>

      {isExpanded && (
        <div className="allocation-item-detail">
          <div className="allocation-detail-row">
            <span className="allocation-detail-label">Keep:</span>
            <span>{row.demand.requiredQuantity}</span>
          </div>
          <div className="allocation-detail-row">
            <span className="allocation-detail-label">Have (confirmed):</span>
            <span>{formatCell(row.confirmedAvailableCell)}</span>
          </div>
          {row.deficitCell.kind !== "notApplicable" && (
            <div className="allocation-detail-row">
              <span className="allocation-detail-label">Deficit:</span>
              <span>{formatCell(row.deficitCell)}</span>
            </div>
          )}
          {row.surplusCell.kind !== "notApplicable" && (
            <div className="allocation-detail-row">
              <span className="allocation-detail-label">Surplus:</span>
              <span>{formatCell(row.surplusCell)}</span>
            </div>
          )}
          {row.allocatedCell.kind !== "notApplicable" && (
            <div className="allocation-detail-row">
              <span className="allocation-detail-label">Allocated:</span>
              <span>{formatCell(row.allocatedCell)}</span>
            </div>
          )}
          <div className="allocation-detail-row">
            <span className="allocation-detail-label">Disposition:</span>
            <span>{row.disposition}</span>
          </div>
          {row.unresolvedScopes.length > 0 && (
            <div className="allocation-detail-row">
              <span className="allocation-detail-label">Unresolved storage:</span>
              <span>{row.unresolvedScopes.join(", ")}</span>
            </div>
          )}
        </div>
      )}

      <div className="allocation-item-actions">
        <button className="secondary-button" onClick={onEdit}>
          Edit
        </button>
        <button className="secondary-button" onClick={onDeactivate}>
          Remove
        </button>
      </div>
    </div>
  );
}

function UnallocatedRowComponent({ row, onSetTarget }: { row: UnallocatedRowView; onSetTarget: (qty: number) => void }) {
  const [targetQty, setTargetQty] = useState("0");
  const [isExpanded, setIsExpanded] = useState(false);

  const handleSetTarget = () => {
    const qty = parseInt(targetQty, 10);
    if (!Number.isNaN(qty) && qty >= 0) {
      onSetTarget(qty);
      setTargetQty("0");
    }
  };

  return (
    <div className="allocation-item-card">
      <div className="allocation-item-header">
        <div className="allocation-item-title">{row.name || `Item ${row.baseItemId}`}</div>
        <div className="allocation-item-status">
          Held: {formatCell(row.confirmedQuantityCell)}
          {row.potentialQuantityCell.kind === "numeric" && (
            <span className="allocation-historical-evidence"> + {row.potentialQuantityCell.value} last seen (historical)</span>
          )}
        </div>
      </div>

      {row.reasonChips.length > 0 && (
        <div className="allocation-reason-chips">
          {row.reasonChips.map((chip, i) => (
            <span key={i} className="allocation-reason-chip" title={chip.detail}>
              {chip.text}
            </span>
          ))}
        </div>
      )}

      {row.hasUnresolvedEvidence && row.unresolvedScopes.length > 0 && (
        <div className="allocation-unresolved-warning">
          Unresolved: {row.unresolvedScopes.join(", ")}. Confirmed quantity may be incomplete.
        </div>
      )}

      <button className="allocation-expand-button" onClick={() => setIsExpanded(!isExpanded)}>
        {isExpanded ? "▼ Hide" : "▶ Show"} Details
      </button>

      {isExpanded && (
        <div className="allocation-item-detail">
          <div className="allocation-detail-row">
            <span className="allocation-detail-label">Confirmed:</span>
            <span>{formatCell(row.confirmedQuantityCell)}</span>
          </div>
          {row.potentialQuantityCell.kind === "numeric" && (
            <div className="allocation-detail-row">
              <span className="allocation-detail-label">Last seen:</span>
              <span>{row.potentialQuantityCell.value}</span>
            </div>
          )}
          {row.distinctItemStringCount !== undefined && (
            <div className="allocation-detail-row">
              <span className="allocation-detail-label">Item variants:</span>
              <span>{row.distinctItemStringCount} different versions held</span>
            </div>
          )}
        </div>
      )}

      <div className="allocation-set-target-control">
        <label className="allocation-set-target-label">
          Keep:
          <input
            type="number"
            min="0"
            value={targetQty}
            onChange={(e) => setTargetQty(e.target.value)}
            className="allocation-quantity-input"
          />
        </label>
        <button className="primary-button" onClick={handleSetTarget}>
          Set Target
        </button>
      </div>
    </div>
  );
}

function AddTargetForm({ onSubmit, isLoading }: { onSubmit: (input: CreateDemandInput) => void; isLoading: boolean }) {
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  const [purpose, setPurpose] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseInt(itemId, 10);
    const quantity = parseInt(qty, 10);
    if (Number.isNaN(id) || id < 1 || Number.isNaN(quantity) || quantity < 0) return;
    onSubmit({ baseItemId: id, requiredQuantity: quantity, purpose: purpose || undefined });
    setItemId("");
    setQty("");
    setPurpose("");
  };

  return (
    <form onSubmit={handleSubmit} className="allocation-form">
      <div className="allocation-form-row">
        <label className="allocation-form-label">
          Item ID:
          <input
            type="number"
            min="1"
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            className="allocation-form-input"
            required
            disabled={isLoading}
          />
        </label>
      </div>
      <div className="allocation-form-row">
        <label className="allocation-form-label">
          Quantity to Keep:
          <input
            type="number"
            min="0"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="allocation-form-input"
            required
            disabled={isLoading}
          />
        </label>
      </div>
      <div className="allocation-form-row">
        <label className="allocation-form-label">
          Purpose (optional):
          <input
            type="text"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g., crafting, transmog"
            className="allocation-form-input"
            disabled={isLoading}
          />
        </label>
      </div>
      <div className="allocation-form-actions">
        <button type="submit" className="primary-button" disabled={isLoading}>
          {isLoading ? "Creating..." : "Create Target"}
        </button>
      </div>
    </form>
  );
}
