import { MAX_ERP_PROJECT_COLLECTION_ENTRIES } from "@wowsync-dashboard/core/erpLimits.ts";
import type { ErpProjectView, ErpWorkOrder } from "@wowsync-dashboard/core";

export const ERP_MANUAL_WORK_ORDER_KINDS: readonly ErpWorkOrder["kind"][] = [
  "INVESTIGATE", "GATHER", "CRAFT", "TRANSFER", "RETRIEVE", "EQUIP", "PURCHASE", "SELL_MANUALLY", "PROVISION", "OTHER",
];

export interface MultiNeedWorkOrderDraft {
  readonly needId: string;
  readonly clientKey: string;
  readonly kind: ErpWorkOrder["kind"];
  readonly title: string;
  readonly instructions: string;
  readonly assignedIdentityKey?: string;
  readonly sourceIdentityKey?: string;
  readonly destinationIdentityKey?: string;
  /** Existing open work-order IDs or `draft:<clientKey>` references to earlier rows. */
  readonly dependsOn?: readonly string[];
}

const terminal = new Set(["COMPLETED", "CANCELLED"]);
const workOrderBoundary = "SYSTEM EVIDENCE BOUNDARY: This saved text is planning intent only. WoWSync did not execute or verify any game action. Unobserved prerequisites, eligibility, ownership, access, routes, prices, and outcomes remain UNKNOWN. Recheck current evidence before acting.";
const kindBoundaries: Record<ErpWorkOrder["kind"], string> = {
  INVESTIGATE: "This investigation task does not prove what was found until new evidence or a player note is recorded.",
  GATHER: "A gather plan does not establish a gathering route, yield, prerequisite, or completed collection.",
  CRAFT: "A craft plan does not establish learned recipe, profession skill, unlocks, required materials, craftability, or output.",
  TRANSFER: "A transfer plan does not establish ownership, binding, character/account relationship, destination access, or a valid transfer route.",
  RETRIEVE: "A retrieval plan does not establish current storage contents, ownership scope, access, or permission.",
  EQUIP: "An equip plan does not establish character eligibility, slot legality, or that the item is an upgrade.",
  PURCHASE: "A purchase plan does not establish stock, seller, route, market price, or affordability.",
  SELL_MANUALLY: "A sale plan does not establish ownership, buyer, current price, or sale completion.",
  PROVISION: "Ownership, access, binding, and a valid route remain UNKNOWN unless separately verified.",
  OTHER: "This plan does not establish prerequisites or completion.",
};

/** Builds a set of player-authored, single-need work orders as one project update. */
export function buildMultiNeedWorkOrders(
  project: ErpProjectView,
  drafts: readonly MultiNeedWorkOrderDraft[],
  createId: () => string,
): ErpWorkOrder[] {
  if (project.status !== "ACTIVE") throw new Error("Only an active project can receive fulfillment work orders.");
  if (drafts.length < 2 || drafts.length > 4) throw new Error("Choose between 2 and 4 requirements for one multi-need plan.");
  if (project.workOrders.length + drafts.length > MAX_ERP_PROJECT_COLLECTION_ENTRIES) throw new Error(`This project has room for only ${Math.max(0, MAX_ERP_PROJECT_COLLECTION_ENTRIES - project.workOrders.length)} more work order(s); refresh or split the plan before saving.`);
  const needIds = new Set<string>();
  const clientKeys = new Set<string>();
  const needs = new Map(project.needs.map((need) => [need.stableId, need]));
  const openNeedIds = new Set(project.workOrders.filter((order) => !terminal.has(order.status)).flatMap((order) => order.resourceNeedIds));
  for (const draft of drafts) {
    const need = needs.get(draft.needId);
    if (!need || needIds.has(draft.needId)) throw new Error("Each selected requirement must exist and appear only once. Refresh the project and try again.");
    if (openNeedIds.has(draft.needId)) throw new Error(`Requirement \"${need.label}\" already has an open work order. Refresh the project before planning it again.`);
    if (!draft.clientKey.trim() || clientKeys.has(draft.clientKey)) throw new Error("Each draft task needs a unique local key.");
    if (!ERP_MANUAL_WORK_ORDER_KINDS.includes(draft.kind)) throw new Error("Choose a supported manual work-order type.");
    if (!draft.title.trim() || draft.title.length > 160 || !draft.instructions.trim() || draft.instructions.length > 4000) throw new Error("Each task needs a title (up to 160 characters) and manual instructions (up to 4,000 characters).");
    for (const identityKey of [draft.assignedIdentityKey, draft.sourceIdentityKey, draft.destinationIdentityKey]) {
      if (identityKey && !identityKey.startsWith(`${project.version}::`)) throw new Error("Assigned character, source, and destination must use the project's game version.");
    }
    needIds.add(draft.needId);
    clientKeys.add(draft.clientKey);
  }

  const ids = new Map(drafts.map((draft) => [draft.clientKey, createId()]));
  if (new Set(ids.values()).size !== ids.size || [...ids.values()].some((stableId) => !stableId.trim() || project.workOrders.some((order) => order.stableId === stableId))) {
    throw new Error("Could not create unique stable work-order IDs. Try again.");
  }
  const seenDrafts = new Set<string>();
  const existingOpen = new Set(project.workOrders.filter((order) => !terminal.has(order.status)).map((order) => order.stableId));
  return drafts.map((draft) => {
    const dependencies = [...new Set(draft.dependsOn ?? [])].map((dependency) => {
      if (existingOpen.has(dependency)) return dependency;
      if (!dependency.startsWith("draft:")) throw new Error("A selected prerequisite is no longer open in this project. Refresh before saving.");
      const key = dependency.slice("draft:".length);
      const stableId = ids.get(key);
      if (!stableId || !seenDrafts.has(key)) throw new Error("A grouped task can depend only on an earlier task in the same plan.");
      return stableId;
    });
    const stableId = ids.get(draft.clientKey)!;
    seenDrafts.add(draft.clientKey);
    const instructions = `${draft.instructions.trim()}\n\n${kindBoundaries[draft.kind]}\n${workOrderBoundary}`;
    if (instructions.length > 4000) throw new Error("The instructions plus required evidence boundary exceed the 4,000-character limit.");
    return {
      stableId,
      kind: draft.kind,
      status: "PLANNED",
      title: draft.title.trim(),
      instructions,
      resourceNeedIds: [draft.needId],
      dependsOn: dependencies,
      ...(draft.assignedIdentityKey ? { assignedIdentityKey: draft.assignedIdentityKey } : {}),
      ...(draft.sourceIdentityKey ? { sourceIdentityKey: draft.sourceIdentityKey } : {}),
      ...(draft.destinationIdentityKey ? { destinationIdentityKey: draft.destinationIdentityKey } : {}),
    };
  });
}

export function workOrderInstructions(kind: ErpWorkOrder["kind"], needLabel: string): string {
  const specific: Record<ErpWorkOrder["kind"], string> = {
    INVESTIGATE: "Check the missing evidence and record what was actually verified.",
    GATHER: "Verify requirements, route, and yield in game before gathering.",
    CRAFT: "Verify the learned recipe, profession skill, reagents, and craft requirements manually.",
    TRANSFER: "Verify ownership, binding, both characters' access, and a valid route before deciding.",
    RETRIEVE: "Verify current storage contents, ownership scope, access, and requirements manually.",
    EQUIP: "Verify current eligibility, slot conflicts, and actual suitability before equipping.",
    PURCHASE: "Verify availability, seller/route, current price, and budget manually.",
    SELL_MANUALLY: "Verify ownership, current price, destination, and sale requirements manually.",
    PROVISION: "Verify the exact item, source, recipient, access, binding, and route manually.",
    OTHER: "Record the intended manual step and the evidence needed to review it.",
  };
  return `Player-authored ${kind.replaceAll("_", " ").toLowerCase()} plan for ${needLabel}. ${specific[kind]} This is planning intent only: no item movement, purchase, craft, equip, gathering, sale, or completion is asserted or executed. Recheck current evidence before acting.`;
}
