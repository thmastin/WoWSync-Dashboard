import { MAX_ERP_PROJECT_COLLECTION_ENTRIES } from "@wowsync-dashboard/core/erpLimits.ts";
import type { ErpProjectView, ErpResourceKind, ErpResourceNeed } from "@wowsync-dashboard/core";

export interface MultiNeedResourceDraft {
  readonly clientKey: string;
  readonly kind: ErpResourceKind;
  readonly resourceKey: string;
  readonly label: string;
  readonly requiredQuantity: number;
  readonly sourceIdentityKey?: string;
  readonly destinationIdentityKey?: string;
}

const kinds: readonly ErpResourceKind[] = ["ITEM_REF", "ITEM_ID", "GOLD_COPPER", "CURRENCY", "PROFESSION", "RECIPE"];
const positiveInteger = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));

/** Builds explicit player requirements atomically; it does not assess supply or reserve anything. */
export function buildMultiNeedResourceNeeds(project: ErpProjectView, drafts: readonly MultiNeedResourceDraft[], createId: () => string): ErpResourceNeed[] {
  if (project.status !== "ACTIVE") throw new Error("Only an active project can receive new requirements.");
  if (drafts.length < 2 || drafts.length > 4) throw new Error("Choose between 2 and 4 requirements for one intake.");
  if (project.needs.length + drafts.length > MAX_ERP_PROJECT_COLLECTION_ENTRIES) throw new Error(`This project has room for only ${Math.max(0, MAX_ERP_PROJECT_COLLECTION_ENTRIES - project.needs.length)} more requirement(s).`);
  const keys = new Set<string>();
  const existingIds = new Set(project.needs.map((need) => need.stableId));
  const createdIds = new Set<string>();
  const needs = drafts.map((draft) => {
    if (!draft.clientKey.trim() || keys.has(draft.clientKey)) throw new Error("Each requirement needs a unique local key.");
    keys.add(draft.clientKey);
    if (!kinds.includes(draft.kind)) throw new Error("Choose a supported resource kind.");
    const resourceKey = draft.kind === "GOLD_COPPER" ? "copper" : draft.resourceKey.trim();
    if (!draft.label.trim() || draft.label.trim().length > 160 || resourceKey.length > 512) throw new Error("Each requirement needs a label (up to 160 characters) and a bounded resource key.");
    if (draft.kind !== "GOLD_COPPER" && !resourceKey) throw new Error("Enter a resource key for each non-gold requirement.");
    if ((draft.kind === "ITEM_ID" || draft.kind === "CURRENCY" || draft.kind === "RECIPE") && !positiveInteger(resourceKey)) throw new Error(`${draft.kind.replaceAll("_", " ")} keys must be positive safe integers.`);
    if (draft.kind === "ITEM_REF" && !/^item:[1-9]\d*(?::[^\s]*)?$/.test(resourceKey)) throw new Error("ITEM_REF needs an exact itemString beginning with item:<positive ID>.");
    if (!Number.isSafeInteger(draft.requiredQuantity) || draft.requiredQuantity < 1) throw new Error("Requirement quantities must be positive whole numbers.");
    if (draft.kind === "RECIPE" && draft.requiredQuantity !== 1) throw new Error("Recipe knowledge requirements have quantity 1.");
    for (const identityKey of [draft.sourceIdentityKey, draft.destinationIdentityKey]) {
      if (identityKey && !identityKey.startsWith(`${project.version}::`)) throw new Error("Requirement source and recipient must use the project's game version.");
    }
    const stableId = createId();
    if (!stableId.trim() || existingIds.has(stableId) || createdIds.has(stableId)) throw new Error("Could not create unique requirement IDs. Try again.");
    createdIds.add(stableId);
    return {
      stableId,
      kind: draft.kind,
      resourceKey,
      label: draft.label.trim(),
      requiredQuantity: draft.kind === "RECIPE" ? 1 : draft.requiredQuantity,
      ...(draft.sourceIdentityKey ? { sourceIdentityKey: draft.sourceIdentityKey } : {}),
      ...(draft.destinationIdentityKey ? { destinationIdentityKey: draft.destinationIdentityKey } : {}),
    };
  });
  return needs;
}
