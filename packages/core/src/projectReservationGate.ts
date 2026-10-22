import type { AllocationResult } from "./allocation.ts";
import type { ErpProject } from "./erpProjects.ts";
import { parseOwnerKey } from "./sharedStorage.ts";

function itemIdForNeed(need: ErpProject["needs"][number]): number | undefined {
  if (need.kind === "ITEM_ID" && /^[1-9]\d*$/.test(need.resourceKey)) {
    const itemId = Number(need.resourceKey);
    return Number.isSafeInteger(itemId) ? itemId : undefined;
  }
  if (need.kind === "ITEM_REF") {
    const match = /^item:([1-9]\d*)(?::|$)/.exec(need.resourceKey);
    if (match) {
      const itemId = Number(match[1]);
      return Number.isSafeInteger(itemId) ? itemId : undefined;
    }
  }
  return undefined;
}

/**
 * Project reservations are separate player intent from a Retail stock target, but a reserved resource
 * cannot safely be offered to the sale pipeline. This gate leaves the stock-target arithmetic intact,
 * names the overlapping explicit reservations, and removes only the SEND disposition. It does not
 * claim the project has the resource, that the source is accessible, or that a transfer can happen.
 */
export function gateAllocationForProjectReservations(result: AllocationResult, projects: readonly ErpProject[]): AllocationResult {
  if (result.resolution !== "RESOLVED" || result.disposition !== "SEND_HELLOMAGS") return result;
  const baseItemId = result.commodity.baseItemId;
  const reservations = projects.filter((project) => project.version === "retail").flatMap((project) => project.reservations
    .filter((reservation) => reservation.status === "ACTIVE")
    .flatMap((reservation) => {
      const need = project.needs.find((candidate) => candidate.stableId === reservation.needId);
      if (!need || itemIdForNeed(need) !== baseItemId) return [];
      // Guild resources are not personal/account inventory. A guild reservation must not gate a
      // character/Warband sale candidate or imply the player owns guild assets.
      if (need.sourceOwnerKey) {
        const owner = parseOwnerKey(need.sourceOwnerKey);
        if (owner?.kind !== "warband" || owner.version !== "retail") return [];
      } else if (!need.sourceIdentityKey?.startsWith("retail::")) return [];
      return [{ projectTitle: project.title, needLabel: need.label, quantity: reservation.quantity, source: need.sourceIdentityKey ?? "Retail Warband (installation-local)" }];
    }));
  if (!reservations.length) return result;
  const descriptions = reservations.map((entry) => `${entry.projectTitle} (${entry.needLabel}, ${entry.quantity} reserved at ${entry.source})`).join("; ");
  return {
    ...result,
    disposition: "REQUIRES_REVIEW",
    reasons: [
      ...result.reasons.filter((reason) => reason.code !== "SALE_PIPELINE_APPROVED"),
      { code: "PROJECT_RESERVATION_GATES_SALE", detail: `Active project reservations overlap this base item: ${descriptions}. Reservation is player intent, not proof of current supply or transfer access; review the project before treating the stock-target remainder as available for sale.` },
    ],
  };
}
