// Pure semantic presentation layer for ERP Allocation Review.
// All allocation semantics live here, NOT scattered through JSX.
// Typed cell states: numeric | withheld(reason) | notApplicable
// No ?? 0 or || 0 fallbacks that could zero absent/UNKNOWN arithmetic.

import type { AllocationResult, UnallocatedInventoryEntry, ReadValue, AccountAllocationReview, ExplicitDemand } from "@wowsync-dashboard/core";

export type CellState = { kind: "numeric"; value: number } | { kind: "withheld"; reason: string } | { kind: "notApplicable" };

export function numericCell(value: number): CellState {
  return { kind: "numeric", value };
}

export function withheldCell(reason: string): CellState {
  return { kind: "withheld", reason };
}

export function notApplicableCell(): CellState {
  return { kind: "notApplicable" };
}

export function formatCell(cell: CellState): string {
  switch (cell.kind) {
    case "numeric":
      return String(cell.value);
    case "withheld":
      return `—(${cell.reason})`;
    case "notApplicable":
      return "—";
  }
}

export interface TargetRowView {
  baseItemId: number;
  name: string | undefined;
  demand: Pick<ExplicitDemand, "stableId" | "requiredQuantity" | "purpose">;
  allocatedCell: CellState;
  confirmedAvailableCell: CellState;
  deficitCell: CellState;
  surplusCell: CellState;
  disposition: string;
  hasUnresolvedEvidence: boolean;
  unresolvedScopes: string[];
  reasonChips: ReasonChip[];
  gatedBy: string[];
  canShow409?: boolean; // duplicate demand error
}

export interface ReasonChip {
  text: string;
  detail?: string;
}

export interface UnallocatedRowView {
  baseItemId: number;
  name: string | undefined;
  confirmedQuantityCell: CellState;
  potentialQuantityCell: CellState;
  hasUnresolvedEvidence: boolean;
  unresolvedScopes: string[];
  reasonChips: ReasonChip[];
  distinctItemStringCount?: number;
}

export function buildTargetRowViews(review: AccountAllocationReview, itemNames: Record<number, string>): TargetRowView[] {
  const views: TargetRowView[] = [];

  for (const result of review.demanded.items) {
    if (result.resolution === "NO_ACTIVE_DEMAND" || result.resolution === "CONFLICTING_DEMAND") {
      continue;
    }

    const name = itemNames[result.commodity.baseItemId];
    const reasonChips: ReasonChip[] = [];
    const gatedBy: string[] = [];

    // Build reason chips and gates from the result reasons
    for (const reason of result.reasons) {
      if (reason.code === "UNRESOLVED_STORAGE_PRESENT") {
        reasonChips.push({ text: "Unseen storage" });
        gatedBy.push("unresolved");
      } else if (reason.code === "ITEM_QUANTITY_UNKNOWN_PRESENT") {
        reasonChips.push({ text: "Unknown quantity" });
        gatedBy.push("unresolved");
      } else if (reason.code === "BOUND_INVENTORY_PRESENT") {
        reasonChips.push({ text: "Bound", detail: "Some items are account-bound" });
        gatedBy.push("binding");
      } else if (reason.code === "BINDING_UNKNOWN_PRESENT") {
        reasonChips.push({ text: "Binding unknown" });
        gatedBy.push("binding");
      }
    }

    let allocatedCell: CellState;
    let deficitCell: CellState;
    let surplusCell: CellState;
    let confirmedAvailableCell: CellState;

    if (result.resolution === "BASE_ITEM_AGGREGATION_UNPROVEN") {
      allocatedCell = notApplicableCell();
      deficitCell = notApplicableCell();
      surplusCell = notApplicableCell();
      confirmedAvailableCell = numericCell(result.confirmedQuantity);
      reasonChips.push({ text: "UNPROVEN", detail: "Item string variants prevent aggregation" });
    } else if (result.resolution === "RESOLVED") {
      confirmedAvailableCell = numericCell(result.confirmedAvailable);
      allocatedCell = numericCell(result.allocated);

      if (result.confirmedDeficit > 0) {
        deficitCell = numericCell(result.confirmedDeficit);
        surplusCell = notApplicableCell();
      } else if (result.confirmedSurplus > 0) {
        deficitCell = notApplicableCell();
        if (gatedBy.includes("unresolved") || gatedBy.includes("binding")) {
          surplusCell = withheldCell("Needs review");
        } else {
          surplusCell = numericCell(result.confirmedSurplus);
        }
      } else {
        deficitCell = notApplicableCell();
        surplusCell = notApplicableCell();
      }
    } else {
      allocatedCell = notApplicableCell();
      deficitCell = notApplicableCell();
      surplusCell = notApplicableCell();
      confirmedAvailableCell = notApplicableCell();
    }

    views.push({
      baseItemId: result.commodity.baseItemId,
      name,
      demand: result.demand,
      allocatedCell,
      confirmedAvailableCell,
      deficitCell,
      surplusCell,
      disposition: result.disposition,
      hasUnresolvedEvidence: result.hasUnresolvedEvidence,
      unresolvedScopes: result.unresolvedScopes,
      reasonChips,
      gatedBy,
    });
  }

  return views;
}

export function buildUnallocatedRowViews(review: AccountAllocationReview): UnallocatedRowView[] {
  const views: UnallocatedRowView[] = [];

  for (const entry of review.unallocated.items) {
    const reasonChips: ReasonChip[] = [];

    if (entry.hasUnresolvedEvidence) {
      reasonChips.push({ text: "Unresolved evidence" });
    }

    const confirmedCell = numericCell(entry.confirmedQuantity);
    const potentialCell = entry.potentialQuantity > 0 ? numericCell(entry.potentialQuantity) : notApplicableCell();

    views.push({
      baseItemId: entry.baseItemId,
      name: entry.name,
      confirmedQuantityCell: confirmedCell,
      potentialQuantityCell: potentialCell,
      hasUnresolvedEvidence: entry.hasUnresolvedEvidence,
      unresolvedScopes: entry.unresolvedScopes,
      reasonChips,
      distinctItemStringCount: entry.confirmedItemStringIdentity.class !== "UNIFORM_ITEM_STRING" ? (entry as any).distinctItemStringCount : undefined,
    });
  }

  return views;
}
