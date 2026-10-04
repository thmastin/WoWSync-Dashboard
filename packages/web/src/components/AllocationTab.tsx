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
import type { VersionOrUnknown, AllocationResult, ExplicitDemand, UnallocatedInventoryEntry } from "@wowsync-dashboard/core";
import ErrorNotice from "./ErrorNotice.tsx";

interface AllocationTabProps {
  activeVersion: VersionOrUnknown;
  refreshTick: number;
}

interface DemandFormState {
  mode: "create" | "edit";
  demandId?: string;
  baseItemId: number;
  requiredQuantity: number;
  purpose: string;
}

interface OperationState {
  status: "idle" | "loading" | "success" | "error";
  message?: string;
}

export default function AllocationTab({ activeVersion, refreshTick }: AllocationTabProps) {
  const [demandedOffset, setDemandedOffset] = useState(0);
  const [unallocatedOffset, setUnallocatedOffset] = useState(0);
  const [formState, setFormState] = useState<DemandFormState | null>(null);
  const [operationState, setOperationState] = useState<OperationState>({ status: "idle" });

  const pageSize = 50;
  const query: AllocationReviewQuery = {
    demandedOffset,
    demandedLimit: pageSize,
    unallocatedOffset,
    unallocatedLimit: pageSize,
  };

  const reviewLoad = useAsync(
    (signal) => fetchAllocationReview(activeVersion, query, signal),
    `allocation-${activeVersion}-${demandedOffset}-${unallocatedOffset}`,
    refreshTick,
  );

  const review = reviewLoad.state.data?.data;

  async function handleCreateDemand(input: CreateDemandInput) {
    setOperationState({ status: "loading" });
    try {
      await createDemand(activeVersion, input);
      setOperationState({ status: "success", message: "Target created" });
      setFormState(null);
      setTimeout(() => reviewLoad.retry(), 100);
    } catch (err) {
      setOperationState({ status: "error", message: describeApiError(err) });
    }
  }

  async function handleUpdateDemand(stableId: string, input: UpdateDemandInput) {
    setOperationState({ status: "loading" });
    try {
      await updateDemand(activeVersion, stableId, input);
      setOperationState({ status: "success", message: "Target updated" });
      setFormState(null);
      setTimeout(() => reviewLoad.retry(), 100);
    } catch (err) {
      setOperationState({ status: "error", message: describeApiError(err) });
    }
  }

  async function handleDeactivateDemand(stableId: string) {
    setOperationState({ status: "loading" });
    try {
      await deactivateDemand(activeVersion, stableId);
      setOperationState({ status: "success", message: "Target removed" });
      setFormState(null);
      setTimeout(() => reviewLoad.retry(), 100);
    } catch (err) {
      setOperationState({ status: "error", message: describeApiError(err) });
    }
  }

  if (activeVersion !== "retail") {
    return (
      <div className="allocation-container">
        <p style={{ padding: "20px", color: "#666" }}>Allocation is Retail-only in this version.</p>
      </div>
    );
  }

  if (reviewLoad.state.status === "error") {
    return <ErrorNotice error={reviewLoad.state.error} onRetry={reviewLoad.retry} />;
  }

  if (reviewLoad.state.status === "loading") {
    return <div className="loading">Loading allocation review…</div>;
  }

  if (!review) {
    return <div style={{ padding: "20px", color: "#666" }}>No allocation data available.</div>;
  }

  return (
    <div className="allocation-container" style={{ padding: "20px" }}>
      {operationState.status !== "idle" && (
        <div style={{ padding: "10px", marginBottom: "15px", background: operationState.status === "error" ? "#ffcccc" : "#ccffcc", borderRadius: "4px" }}>
          {operationState.message}
        </div>
      )}

      {review.unresolvedStorage.length > 0 && (
        <div style={{ padding: "10px", marginBottom: "15px", background: "#fffacd", borderRadius: "4px", fontSize: "0.9em" }}>
          <strong>Account Status:</strong> {review.unresolvedStorage.length} storage scope(s) not yet observed. Quantities shown may be incomplete.
        </div>
      )}

      <section style={{ marginBottom: "30px" }}>
        <h2>Your Targets ({review.demanded.totalCount})</h2>
        {review.demanded.items.length === 0 ? (
          <p style={{ color: "#666" }}>No targets set yet. Add one below.</p>
        ) : (
          <div style={{ display: "grid", gap: "12px" }}>
            {review.demanded.items.map((result) => (
              <DemandedItemRow key={result.commodity.baseItemId} result={result} onEdit={(d) => setFormState({ mode: "edit", demandId: d.stableId, baseItemId: result.commodity.baseItemId, requiredQuantity: d.requiredQuantity, purpose: d.purpose || "" })} onDeactivate={(d) => handleDeactivateDemand(d.stableId)} />
            ))}
          </div>
        )}
        {review.demanded.truncated && <p style={{ marginTop: "10px", color: "#666", fontSize: "0.9em" }}>Showing {review.demanded.items.length} of {review.demanded.totalCount} targets</p>}
      </section>

      <section style={{ marginBottom: "30px" }}>
        <h2>Held With No Target ({review.unallocated.totalCount})</h2>
        <p style={{ color: "#666", fontSize: "0.9em" }}>No target set, so surplus is unknown. This is not surplus.</p>
        {review.unallocated.items.length === 0 ? (
          <p style={{ color: "#666" }}>No unallocated items.</p>
        ) : (
          <div style={{ display: "grid", gap: "12px" }}>
            {review.unallocated.items.map((entry) => (
              <UnallocatedItemRow key={entry.baseItemId} entry={entry} onSetTarget={(qty) => handleCreateDemand({ baseItemId: entry.baseItemId, requiredQuantity: qty })} />
            ))}
          </div>
        )}
        {review.unallocated.truncated && <p style={{ marginTop: "10px", color: "#666", fontSize: "0.9em" }}>Showing {review.unallocated.items.length} of {review.unallocated.totalCount} unallocated items</p>}
      </section>

      <section>
        <h2>Add Target</h2>
        <TargetForm onSubmit={handleCreateDemand} onCancel={() => setFormState(null)} />
      </section>
    </div>
  );
}

function DemandedItemRow({ result, onEdit, onDeactivate }: { result: AllocationResult; onEdit: (d: ExplicitDemand) => void; onDeactivate: (d: ExplicitDemand) => void }) {
  if (result.resolution === "NO_ACTIVE_DEMAND" || result.resolution === "CONFLICTING_DEMAND") {
    return null;
  }

  const demand = result.demand;
  const confirmed = result.confirmedAvailable;
  const allocated = result.allocated;
  const surplus = result.confirmedSurplus;
  const deficit = result.confirmedDeficit;

  let statusText = "";
  if (deficit > 0) {
    statusText = `Keep ${allocated} · Have ${confirmed} · Short ${deficit}`;
  } else if (surplus > 0) {
    statusText = `Keep ${allocated} · Have ${confirmed} · Surplus ${surplus}`;
  } else {
    statusText = `Keep ${allocated} · Have ${confirmed} · On target`;
  }

  return (
    <div style={{ padding: "12px", border: "1px solid #ddd", borderRadius: "4px", background: "#f9f9f9" }}>
      <div style={{ fontWeight: "bold", marginBottom: "8px" }}>Item {demand.commodity.baseItemId} {demand.purpose && `(${demand.purpose})`}</div>
      <div style={{ marginBottom: "8px", color: "#666" }}>{statusText}</div>
      <div style={{ fontSize: "0.9em", color: "#999", marginBottom: "8px" }}>Disposition: {result.disposition}</div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button style={{ padding: "6px 12px", fontSize: "0.9em" }} onClick={() => onEdit(demand)}>
          Edit
        </button>
        <button style={{ padding: "6px 12px", fontSize: "0.9em" }} onClick={() => onDeactivate(demand)}>
          Remove
        </button>
      </div>
    </div>
  );
}

function UnallocatedItemRow({ entry, onSetTarget }: { entry: UnallocatedInventoryEntry; onSetTarget: (qty: number) => void }) {
  const [targetQty, setTargetQty] = useState("0");

  return (
    <div style={{ padding: "12px", border: "1px solid #ddd", borderRadius: "4px", background: "#f9f9f9" }}>
      <div style={{ fontWeight: "bold", marginBottom: "8px" }}>
        {entry.name || `Item ${entry.baseItemId}`}
      </div>
      <div style={{ marginBottom: "8px", color: "#666" }}>Held: {entry.confirmedQuantity}</div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          Keep:
          <input type="number" min="0" value={targetQty} onChange={(e) => setTargetQty(e.target.value)} style={{ width: "80px", padding: "4px" }} />
        </label>
        <button style={{ padding: "6px 12px", fontSize: "0.9em" }} onClick={() => onSetTarget(parseInt(targetQty, 10) || 0)}>
          Set Target
        </button>
      </div>
    </div>
  );
}

function TargetForm({ onSubmit, onCancel }: { onSubmit: (input: CreateDemandInput) => void; onCancel: () => void }) {
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  const [purpose, setPurpose] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemId || !qty) return;
    setIsSubmitting(true);
    try {
      onSubmit({ baseItemId: parseInt(itemId, 10), requiredQuantity: parseInt(qty, 10), purpose: purpose || undefined });
    } finally {
      setIsSubmitting(false);
      setItemId("");
      setQty("");
      setPurpose("");
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ padding: "12px", border: "1px solid #ddd", borderRadius: "4px", background: "#f9f9f9" }}>
      <div style={{ marginBottom: "12px" }}>
        <label style={{ display: "block", marginBottom: "4px", fontWeight: "bold" }}>
          Item ID:
        </label>
        <input type="number" min="1" value={itemId} onChange={(e) => setItemId(e.target.value)} style={{ width: "100%", padding: "8px", boxSizing: "border-box" }} required />
      </div>
      <div style={{ marginBottom: "12px" }}>
        <label style={{ display: "block", marginBottom: "4px", fontWeight: "bold" }}>
          Quantity to Keep:
        </label>
        <input type="number" min="0" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: "100%", padding: "8px", boxSizing: "border-box" }} required />
      </div>
      <div style={{ marginBottom: "12px" }}>
        <label style={{ display: "block", marginBottom: "4px", fontWeight: "bold" }}>
          Purpose (optional):
        </label>
        <input type="text" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g., crafting, transmog" style={{ width: "100%", padding: "8px", boxSizing: "border-box" }} />
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button type="submit" disabled={isSubmitting} style={{ padding: "8px 16px" }}>
          {isSubmitting ? "Creating..." : "Create Target"}
        </button>
        <button type="button" onClick={onCancel} style={{ padding: "8px 16px" }}>
          Cancel
        </button>
      </div>
    </form>
  );
}
