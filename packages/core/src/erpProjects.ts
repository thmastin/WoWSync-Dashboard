import type { StoredCharacterSummary, StoredSnapshot } from "./store.ts";
import type { AccountCurrencies } from "./wowCurrencies.ts";
import { parseOwnerKey, type SharedStorageProjection } from "./sharedStorage.ts";
import type { WowVersion } from "./types.ts";
import { snapshotObservedAt } from "./chronology.ts";
import type { Freshness } from "./freshness.ts";

export const ERP_PROJECT_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;
export type ErpProjectStatus = typeof ERP_PROJECT_STATUSES[number];
export const ERP_WORK_ORDER_TYPES = ["INVESTIGATE", "GATHER", "CRAFT", "TRANSFER", "EQUIP", "PURCHASE", "SELL_MANUALLY", "PROVISION", "OTHER"] as const;
export type ErpWorkOrderType = typeof ERP_WORK_ORDER_TYPES[number];
export const ERP_WORK_ORDER_STATUSES = ["PLANNED", "IN_PROGRESS", "WAITING_FOR_EVIDENCE", "COMPLETED", "CANCELLED"] as const;
export type ErpWorkOrderStatus = typeof ERP_WORK_ORDER_STATUSES[number];
export const ERP_RESOURCE_KINDS = ["ITEM_ID", "ITEM_REF", "GOLD_COPPER", "CURRENCY", "PROFESSION", "RECIPE"] as const;
export type ErpResourceKind = typeof ERP_RESOURCE_KINDS[number];

/** Explicit player intent. No field here is an observation or proof of possession. */
export interface ErpResourceNeed {
  readonly stableId: string;
  readonly kind: ErpResourceKind;
  /** Base item ID, exact itemString, `copper`, currency ID, profession key, or recipe ID. */
  readonly resourceKey: string;
  readonly label: string;
  readonly requiredQuantity: number;
  /** The character expected to receive/use the resource. */
  readonly destinationIdentityKey?: string;
  /** Explicit character source. Omission means supply is UNKNOWN; no roster/account inference is made. */
  readonly sourceIdentityKey?: string;
  /** Explicit observed shared owner. Retail Warband/guild ownership remains separate from character ownership/access. */
  readonly sourceOwnerKey?: string;
}

export interface ErpReservation {
  readonly stableId: string;
  readonly needId: string;
  readonly sourceIdentityKey?: string;
  readonly sourceOwnerKey?: string;
  readonly quantity: number;
  readonly status: "ACTIVE" | "RELEASED";
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ErpWorkOrder {
  readonly stableId: string;
  readonly kind: ErpWorkOrderType;
  readonly status: ErpWorkOrderStatus;
  readonly title: string;
  readonly instructions?: string;
  readonly assignedIdentityKey?: string;
  readonly sourceIdentityKey?: string;
  readonly destinationIdentityKey?: string;
  readonly resourceNeedIds: readonly string[];
  readonly dependsOn: readonly string[];
  /** Required when status is COMPLETED: user-entered evidence of the manual action/outcome. */
  readonly completionNote?: string;
}

export interface ErpProject {
  readonly stableId: string;
  readonly version: WowVersion;
  readonly title: string;
  readonly objective?: string;
  readonly status: ErpProjectStatus;
  /** Player-entered summary required to mark the project completed. */
  readonly completionNote?: string;
  /** Explicit player priority, 1 (low) through 5 (high); not an inferred recommendation score. */
  readonly priority: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
  readonly needs: readonly ErpResourceNeed[];
  readonly reservations: readonly ErpReservation[];
  readonly workOrders: readonly ErpWorkOrder[];
}

export interface ErpProjectDraft {
  version: WowVersion;
  title: string;
  objective?: string;
  status?: ErpProjectStatus;
  priority?: number;
  needs?: readonly ErpResourceNeed[];
  reservations?: readonly ErpReservation[];
  workOrders?: readonly ErpWorkOrder[];
}

/** Append-only user-intent history. This records Dashboard edits, never inferred game actions. */
export interface ErpProjectEvent {
  readonly eventId: string;
  readonly projectId: string;
  readonly version: WowVersion;
  readonly revision: number;
  readonly occurredAt: number;
  readonly kind: "CREATED" | "UPDATED" | "STATUS_CHANGED";
  readonly changedFields: readonly string[];
  /** Player-recorded task status edits. This is intent history, never game-action evidence. */
  readonly workOrderStatusChanges?: readonly {
    readonly workOrderId: string;
    readonly title: string;
    readonly fromStatus?: ErpWorkOrderStatus;
    readonly toStatus: ErpWorkOrderStatus;
  }[];
  readonly fromStatus?: ErpProjectStatus;
  readonly toStatus: ErpProjectStatus;
}

export class ErpProjectValidationError extends TypeError {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "ErpProjectValidationError"; this.code = code; }
}
export class ErpProjectConflictError extends Error {
  readonly code = "PROJECT_REVISION_CONFLICT";
  constructor() { super("Project changed since it was read; reload the latest revision before saving."); this.name = "ErpProjectConflictError"; }
}

const hasValue = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
function fail(code: string, message: string): never { throw new ErpProjectValidationError(code, message); }

/** Validate complete project documents at every persistence boundary; no unknown keys are used to make decisions. */
export function validateErpProject(value: unknown, identityExists: (identityKey: string) => boolean): asserts value is ErpProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_PROJECT", "Project must be an object.");
  const p = value as ErpProject;
  if (!hasValue(p.stableId) || p.stableId.length > 120) fail("INVALID_PROJECT_ID", "Project ID is missing or too long.");
  if (!(new Set(["classic-era", "tbc-anniversary", "retail", "forever"])).has(p.version)) fail("INVALID_PROJECT_VERSION", "Project requires one explicitly supported game version.");
  if (!hasValue(p.title) || p.title.trim().length > 160) fail("INVALID_PROJECT_TITLE", "Project title must contain 1–160 characters.");
  if (p.objective !== undefined && (typeof p.objective !== "string" || p.objective.length > 2000)) fail("INVALID_PROJECT_OBJECTIVE", "Project objective must be at most 2,000 characters.");
  if (!(ERP_PROJECT_STATUSES as readonly string[]).includes(p.status)) fail("INVALID_PROJECT_STATUS", "Unsupported project status.");
  if (p.status === "COMPLETED" && !hasValue(p.completionNote)) fail("COMPLETION_EVIDENCE_REQUIRED", "A completed project requires a player-entered outcome note.");
  if (p.completionNote !== undefined && (typeof p.completionNote !== "string" || p.completionNote.length > 2000)) fail("INVALID_COMPLETION_NOTE", "Project completion note must be at most 2,000 characters.");
  if (!Number.isInteger(p.priority) || p.priority < 1 || p.priority > 5) fail("INVALID_PROJECT_PRIORITY", "Priority must be an explicit integer from 1 to 5.");
  if (!Number.isSafeInteger(p.createdAt) || !Number.isSafeInteger(p.updatedAt) || !Number.isSafeInteger(p.revision) || p.revision < 1) fail("INVALID_PROJECT_REVISION", "Project timestamps and revision must be valid integers.");
  for (const list of [p.needs, p.reservations, p.workOrders]) if (!Array.isArray(list) || list.length > 200) fail("INVALID_PROJECT_COLLECTION", "Project collections must be arrays of at most 200 entries.");
  const identity = (key: string | undefined, field: string) => {
    if (key === undefined) return;
    if (!hasValue(key) || !key.startsWith(`${p.version}::`) || !identityExists(key)) fail("INVALID_PROJECT_CHARACTER", `${field} must resolve to an observed character in this project's version; membership or transfer access is not implied.`);
  };
  const needIds = new Set<string>();
  for (const n of p.needs) {
    if (!hasValue(n.stableId) || needIds.has(n.stableId)) fail("INVALID_NEED_ID", "Resource need IDs must be non-empty and unique within the project.");
    needIds.add(n.stableId);
    if (!(ERP_RESOURCE_KINDS as readonly string[]).includes(n.kind)) fail("INVALID_RESOURCE_KIND", "Unsupported resource kind.");
    if (!hasValue(n.resourceKey) || n.resourceKey.length > 512 || !hasValue(n.label) || n.label.length > 160) fail("INVALID_RESOURCE_IDENTITY", "Resource key and label are required and bounded.");
    if (!Number.isSafeInteger(n.requiredQuantity) || n.requiredQuantity < 1) fail("INVALID_REQUIRED_QUANTITY", "Required quantity must be a positive integer in the resource's declared unit.");
    if (n.kind === "ITEM_ID" && !/^[1-9]\d*$/.test(n.resourceKey)) fail("INVALID_ITEM_ID", "ITEM_ID resource keys must be positive numeric IDs.");
    if (n.kind === "GOLD_COPPER" && n.resourceKey !== "copper") fail("INVALID_GOLD_KEY", "Gold requirements use the copper unit and resource key 'copper'.");
    if (n.kind === "RECIPE" && (!/^[1-9]\d*$/.test(n.resourceKey) || !Number.isSafeInteger(Number(n.resourceKey)) || n.requiredQuantity !== 1)) fail("INVALID_RECIPE_NEED", "A recipe-knowledge requirement uses one positive safe-integer recipe ID and quantity 1; reagent quantities belong in separate item needs.");
    if (n.kind === "ITEM_REF" && !/^item:[1-9]\d*(?::[^\s]*)?$/.test(n.resourceKey)) fail("INVALID_ITEM_REF", "ITEM_REF must be an exact WoW itemString.");
    if (n.kind === "CURRENCY" && !/^[1-9]\d*$/.test(n.resourceKey)) fail("INVALID_CURRENCY_ID", "CURRENCY resource keys must be positive numeric currency IDs.");
    identity(n.destinationIdentityKey, "Destination character"); identity(n.sourceIdentityKey, "Source character");
    if (n.sourceIdentityKey && n.sourceOwnerKey) fail("AMBIGUOUS_PROJECT_SOURCE", "Choose exactly one character or shared-storage owner as the resource source.");
    if (n.sourceOwnerKey && (!parseOwnerKey(n.sourceOwnerKey) || p.version !== "retail")) fail("INVALID_PROJECT_STORAGE_OWNER", "Shared-storage sources must name a supported Retail Warband or guild owner key; this does not imply character access.");
    if (n.sourceOwnerKey && n.kind !== "ITEM_ID" && n.kind !== "ITEM_REF") fail("INVALID_SHARED_RESOURCE_KIND", "Shared-storage owners can only source item quantity needs; currencies, professions, and recipes are not inferred from storage location.");
  }
  const workIds = new Set<string>();
  for (const w of p.workOrders) {
    if (!hasValue(w.stableId) || workIds.has(w.stableId)) fail("INVALID_WORK_ORDER_ID", "Work order IDs must be non-empty and unique within the project.");
    workIds.add(w.stableId);
    if (!(ERP_WORK_ORDER_TYPES as readonly string[]).includes(w.kind) || !(ERP_WORK_ORDER_STATUSES as readonly string[]).includes(w.status)) fail("INVALID_WORK_ORDER_STATE", "Unsupported work order type or status.");
    if (!hasValue(w.title) || w.title.length > 160 || (w.instructions !== undefined && w.instructions.length > 4000)) fail("INVALID_WORK_ORDER_TEXT", "Work order title/instructions exceed their limits.");
    if (!Array.isArray(w.dependsOn) || !Array.isArray(w.resourceNeedIds)) fail("INVALID_WORK_ORDER_LINKS", "Work order dependencies and resource links must be arrays.");
    identity(w.assignedIdentityKey, "Assigned character"); identity(w.sourceIdentityKey, "Work order source"); identity(w.destinationIdentityKey, "Work order destination");
    for (const id of [...w.dependsOn, ...w.resourceNeedIds]) if (!hasValue(id)) fail("INVALID_WORK_ORDER_LINKS", "Work order links must use non-empty IDs.");
    if (w.resourceNeedIds.some((id) => !needIds.has(id))) fail("UNKNOWN_WORK_ORDER_NEED", "Every work order resource link must refer to a need in this project.");
    if (w.dependsOn.some((id) => !workIds.has(id) && !p.workOrders.some((candidate) => candidate.stableId === id))) fail("UNKNOWN_WORK_ORDER_DEPENDENCY", "Work order dependencies must refer to a work order in this project.");
    if (w.dependsOn.includes(w.stableId)) fail("WORK_ORDER_CYCLE", "A work order cannot depend on itself.");
    if (w.status === "COMPLETED" && !hasValue(w.completionNote)) fail("COMPLETION_EVIDENCE_REQUIRED", "A completed manual work order requires a player-entered completion note.");
    if (w.completionNote !== undefined && w.completionNote.length > 2000) fail("INVALID_COMPLETION_NOTE", "Completion note must be at most 2,000 characters.");
  }
  // Detect dependency cycles independently of client order.
  const byId = new Map(p.workOrders.map((w) => [w.stableId, w]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) fail("WORK_ORDER_CYCLE", "Work order dependencies cannot contain cycles."); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id)?.dependsOn ?? []) { if (!byId.has(dep)) fail("UNKNOWN_WORK_ORDER_DEPENDENCY", "Work order dependencies must refer to a work order in this project."); visit(dep); } visiting.delete(id); visited.add(id); };
  for (const id of byId.keys()) visit(id);
  const reservationIds = new Set<string>();
  for (const r of p.reservations) {
    if (!hasValue(r.stableId) || reservationIds.has(r.stableId)) fail("INVALID_RESERVATION_ID", "Reservation IDs must be non-empty and unique within the project.");
    reservationIds.add(r.stableId);
    if (!needIds.has(r.needId)) fail("UNKNOWN_RESERVATION_NEED", "Reservation must refer to a project resource need.");
    const reservedNeed = p.needs.find((need) => need.stableId === r.needId)!;
    if (reservedNeed.kind === "PROFESSION" || reservedNeed.kind === "RECIPE") fail("NON_QUANTIFIABLE_RESERVATION", "Profession and recipe capability needs cannot be reserved as item quantities.");
    if (!Number.isSafeInteger(r.quantity) || r.quantity < 1 || !(r.status === "ACTIVE" || r.status === "RELEASED")) fail("INVALID_RESERVATION", "Reservation quantity/status is invalid.");
    if (r.sourceIdentityKey && r.sourceOwnerKey) fail("AMBIGUOUS_RESERVATION_SOURCE", "A reservation must name exactly one character or shared-storage owner source.");
    if (r.sourceIdentityKey && (!r.sourceIdentityKey.startsWith(`${p.version}::`) || !identityExists(r.sourceIdentityKey))) fail("INVALID_RESERVATION_SOURCE", "Reservation source must resolve to an observed character in this project's version; this does not prove account membership or transferability.");
    if (r.sourceOwnerKey && (!parseOwnerKey(r.sourceOwnerKey) || p.version !== "retail")) fail("INVALID_RESERVATION_SOURCE", "Shared-storage reservation source must name a Retail Warband or guild owner key.");
    const needSource = reservedNeed.sourceOwnerKey ? `owner:${reservedNeed.sourceOwnerKey}` : reservedNeed.sourceIdentityKey ? `character:${reservedNeed.sourceIdentityKey}` : undefined;
    const reservationSource = r.sourceOwnerKey ? `owner:${r.sourceOwnerKey}` : r.sourceIdentityKey ? `character:${r.sourceIdentityKey}` : undefined;
    if (!needSource || needSource !== reservationSource) fail("RESERVATION_SOURCE_MISMATCH", "Reservation source must exactly match its need's explicitly selected character or storage owner.");
    if (!Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.updatedAt)) fail("INVALID_RESERVATION_TIME", "Reservation timestamps must be valid integers.");
  }
}

export type NeedSupplyState = "COVERED_BY_OBSERVED" | "SHORTFALL_OBSERVED" | "POTENTIAL_COVERAGE_LAST_SEEN" | "UNKNOWN" | "UNSUPPORTED_EVIDENCE";
export interface ErpNeedEvidence {
  readonly needId: string;
  readonly state: NeedSupplyState;
  readonly sourceIdentityKey?: string;
  readonly observedQuantity?: number;
  readonly potentialQuantity?: number;
  readonly requiredQuantity: number;
  readonly observedAt?: number;
  readonly freshness: "recent" | "stale" | "unknown";
  readonly sourceOwnerKey?: string;
  readonly ownerScope?: "warband-installation-local" | "guild";
  readonly sourceSections: readonly { section: "character" | "bags" | "character bank" | "currencies" | "shared storage"; state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; observedAt?: number; completeness?: string }[];
  readonly unresolvedSections: readonly string[];
  readonly unknownQuantityRowCount: number;
  readonly observationChange?: ResourceObservationChange;
  readonly reservationAssessment?: {
    readonly state: "UNRESERVED" | "WITHIN_OBSERVED_SUPPLY" | "OVER_RESERVED" | "UNKNOWN";
    readonly activeQuantity: number;
    /** Conservative lower bound after reservations; omitted if the remaining quantity is not established. */
    readonly availableObservedLowerBound?: number;
    readonly reason: string;
  };
  readonly reason: string;
}

export interface ResourceObservationChange {
  readonly state: "CHANGED" | "UNCHANGED" | "UNKNOWN";
  readonly comparisons: readonly { section: "character gold" | "bags" | "character bank"; previousQuantity: number; currentQuantity: number; delta: number; previousObservedAt: number; currentObservedAt: number }[];
  readonly reason: string;
}

function itemId(itemRef: string | undefined): number | undefined {
  const m = itemRef?.match(/^item:(\d+)(?::|$)/); return m ? Number(m[1]) : undefined;
}
function needItemId(need: ErpResourceNeed): number | undefined {
  return need.kind === "ITEM_ID" ? Number(need.resourceKey) : need.kind === "ITEM_REF" ? itemId(need.resourceKey) : undefined;
}
function reservationScopesOverlap(a: ErpResourceNeed, b: ErpResourceNeed): boolean {
  if (a.kind === "ITEM_ID" || a.kind === "ITEM_REF") {
    if (b.kind !== "ITEM_ID" && b.kind !== "ITEM_REF") return false;
    const aId = needItemId(a); const bId = needItemId(b);
    return aId !== undefined && aId === bId && (a.kind === "ITEM_ID" || b.kind === "ITEM_ID" || a.resourceKey === b.resourceKey);
  }
  return a.kind === b.kind && a.resourceKey === b.resourceKey;
}
function sourceScope(source: { sourceIdentityKey?: string; sourceOwnerKey?: string }): string | undefined {
  if (source.sourceIdentityKey && !source.sourceOwnerKey) return `character:${source.sourceIdentityKey}`;
  if (source.sourceOwnerKey && !source.sourceIdentityKey) return `owner:${source.sourceOwnerKey}`;
  return undefined;
}
function overlappingReservations(need: ErpResourceNeed, source: string, version: WowVersion, projects: readonly ErpProject[]): Array<{ quantity: number; ambiguous: boolean; projectId: string; needId: string }> {
  return projects.filter((p) => p.version === version).flatMap((p) => p.reservations
    .filter((r) => r.status === "ACTIVE" && sourceScope(r) === source)
    .flatMap((r) => {
      const candidate = p.needs.find((entry) => entry.stableId === r.needId);
      return candidate && reservationScopesOverlap(need, candidate)
        ? [{ quantity: r.quantity, projectId: p.stableId, needId: candidate.stableId, ambiguous: (need.kind === "ITEM_ID" && candidate.kind === "ITEM_REF") || (need.kind === "ITEM_REF" && candidate.kind === "ITEM_ID") }]
        : [];
    }));
}
function workOrderAllocationConflicts(project: ErpProject, linkedEvidence: readonly ErpNeedEvidence[], allProjects: readonly ErpProject[]): string[] {
  const byId = new Map(linkedEvidence.map((evidence) => [evidence.needId, evidence]));
  const linked = project.needs.filter((need) => byId.has(need.stableId) && need.kind !== "PROFESSION" && need.kind !== "RECIPE");
  const blocked = new Set<string>();
  const groups = new Map<string, ErpResourceNeed[]>();
  const identity = (need: ErpResourceNeed): string => `${need.kind}:${need.resourceKey}`;

  for (const need of linked) {
    const scope = sourceScope(need);
    if (!scope) continue;
    const key = `${scope}|${identity(need)}`;
    groups.set(key, [...(groups.get(key) ?? []), need]);
  }

  // A base item need and an exact-variant need can overlap, but the observed
  // variant quantities cannot safely establish how much of the base is free.
  for (let i = 0; i < linked.length; i++) for (let j = i + 1; j < linked.length; j++) {
    const a = linked[i]!; const b = linked[j]!;
    const aScope = sourceScope(a);
    if (!aScope || aScope !== sourceScope(b)) continue;
    const aEvidence = byId.get(a.stableId)!;
    const bEvidence = byId.get(b.stableId)!;
    if (aEvidence.freshness !== "recent" || aEvidence.state !== "COVERED_BY_OBSERVED" || bEvidence.freshness !== "recent" || bEvidence.state !== "COVERED_BY_OBSERVED") continue;
    if ((a.kind === "ITEM_ID" || a.kind === "ITEM_REF") && (b.kind === "ITEM_ID" || b.kind === "ITEM_REF") &&
      needItemId(a) !== undefined && needItemId(a) === needItemId(b) &&
      (a.kind !== b.kind || (a.kind === "ITEM_ID" && b.kind === "ITEM_REF") || (a.kind === "ITEM_REF" && b.kind === "ITEM_ID"))) {
      blocked.add(a.stableId); blocked.add(b.stableId);
    }
  }

  for (const needs of groups.values()) {
    const representative = needs[0]!;
    const scope = sourceScope(representative)!;
    const evidence = needs.map((need) => byId.get(need.stableId)!);
    if (evidence.some((entry) => entry.freshness !== "recent" || entry.state !== "COVERED_BY_OBSERVED")) continue;
    const required = needs.reduce((sum, need) => sum + need.requiredQuantity, 0);
    const observedValues = new Set(evidence.map((entry) => entry.observedQuantity));
    const observed = observedValues.size === 1 ? evidence[0]?.observedQuantity : undefined;
    const linkedIds = new Set(needs.map((need) => need.stableId));
    const active = overlappingReservations(representative, scope, project.version, allProjects)
      .filter((reservation) => reservation.projectId !== project.stableId || !linkedIds.has(reservation.needId));
    const otherReserved = active.reduce((sum, reservation) => sum + reservation.quantity, 0);
    const unknownReservation = needs.some((need) => {
      const assessment = byId.get(need.stableId)?.reservationAssessment;
      return assessment?.state === "UNKNOWN" && assessment.activeQuantity > 0;
    });
    if (observed === undefined || active.some((reservation) => reservation.ambiguous) || unknownReservation || observed - otherReserved < required) {
      needs.forEach((need) => blocked.add(need.stableId));
    }
  }
  return [...blocked].sort();
}
function newest(snapshots: readonly StoredSnapshot[]): StoredSnapshot | undefined {
  return [...snapshots].sort((a, b) => snapshotObservedAt(b.generatedAt, b.importedAt) - snapshotObservedAt(a.generatedAt, a.importedAt) || b.id - a.id)[0];
}
function previousSnapshot(snapshots: readonly StoredSnapshot[], current: StoredSnapshot): StoredSnapshot | undefined {
  return [...snapshots].filter((snapshot) => snapshot.id !== current.id).sort((a, b) => snapshotObservedAt(b.generatedAt, b.importedAt) - snapshotObservedAt(a.generatedAt, a.importedAt) || b.id - a.id)[0];
}
function sectionItemQuantity(snapshot: StoredSnapshot, sectionName: "bags" | "character bank", need: ErpResourceNeed): number | undefined {
  const section = sectionName === "bags" ? snapshot.parsed.bags : snapshot.parsed.bank;
  if (section.status.state !== "OBSERVED" || section.status.completeness?.toLowerCase() !== "complete") return undefined;
  let quantity = 0;
  for (const row of section.items) {
    if (!row.itemRef || row.qty === undefined) return undefined;
    if (need.kind === "ITEM_REF" ? row.itemRef === need.resourceKey : itemId(row.itemRef) === Number(need.resourceKey)) quantity += row.qty;
  }
  return quantity;
}
function observationChange(need: ErpResourceNeed, previous: StoredSnapshot | undefined, current: StoredSnapshot): ResourceObservationChange {
  if (!previous) return { state: "UNKNOWN", comparisons: [], reason: "Only one export is available; no before/after comparison can be made." };
  const previousAt = snapshotObservedAt(previous.generatedAt, previous.importedAt);
  const currentAt = snapshotObservedAt(current.generatedAt, current.importedAt);
  const comparisons: ResourceObservationChange["comparisons"][number][] = [];
  if (need.kind === "GOLD_COPPER") {
    if (previous.parsed.character.status.state === "OBSERVED" && current.parsed.character.status.state === "OBSERVED" && previous.parsed.character.moneyCopper !== undefined && current.parsed.character.moneyCopper !== undefined) {
      const delta = current.parsed.character.moneyCopper - previous.parsed.character.moneyCopper;
      comparisons.push({ section: "character gold", previousQuantity: previous.parsed.character.moneyCopper, currentQuantity: current.parsed.character.moneyCopper, delta, previousObservedAt: previous.parsed.character.status.observedAt ?? previousAt, currentObservedAt: current.parsed.character.status.observedAt ?? currentAt });
    }
  } else if (need.kind === "ITEM_REF" || need.kind === "ITEM_ID") {
    for (const section of ["bags", "character bank"] as const) {
      const sectionName = section;
      const before = sectionItemQuantity(previous, sectionName, need); const after = sectionItemQuantity(current, sectionName, need);
      if (before === undefined || after === undefined) continue;
      const beforeStatus = sectionName === "bags" ? previous.parsed.bags.status : previous.parsed.bank.status;
      const afterStatus = sectionName === "bags" ? current.parsed.bags.status : current.parsed.bank.status;
      const delta = after - before;
      comparisons.push({ section, previousQuantity: before, currentQuantity: after, delta, previousObservedAt: beforeStatus.observedAt ?? previousAt, currentObservedAt: afterStatus.observedAt ?? currentAt });
    }
  }
  if (!comparisons.length) return { state: "UNKNOWN", comparisons, reason: "No pair of consecutive, complete OBSERVED sections supports a comparable quantity. A change alone would not identify its cause." };
  const changed = comparisons.some((comparison) => comparison.delta !== 0);
  return { state: changed ? "CHANGED" : "UNCHANGED", comparisons, reason: changed ? "One or more complete observed sections changed between exports; the export does not establish whether a project action caused the change." : "Comparable complete observed sections report the same quantity in both exports." };
}
function evidenceFreshness(observedAt: number | undefined, now: number): "recent" | "stale" | "unknown" {
  if (observedAt === undefined) return "unknown";
  const age = now - observedAt;
  if (age < -300) return "unknown";
  return age <= 3 * 86400 ? "recent" : "stale";
}

function assessSharedStorageNeed(need: ErpResourceNeed, shared: SharedStorageProjection | undefined, now: number): ErpNeedEvidence {
  const sourceOwnerKey = need.sourceOwnerKey;
  const missing = (reason: string, unresolvedSections: string[] = []): ErpNeedEvidence => ({ needId: need.stableId, state: "UNKNOWN", ...(sourceOwnerKey ? { sourceOwnerKey } : {}), requiredQuantity: need.requiredQuantity, freshness: "unknown", sourceSections: [], unresolvedSections, unknownQuantityRowCount: 0, reason });
  if (!sourceOwnerKey || !parseOwnerKey(sourceOwnerKey)) return missing("No valid explicit shared-storage owner was selected.", ["storage owner identity"]);
  if (need.kind !== "ITEM_ID" && need.kind !== "ITEM_REF") return missing("Shared-storage planning currently evaluates only exact itemString or declared base item ID quantities; other resources remain UNKNOWN.", ["shared-storage resource projection"]);
  const owner = sourceOwnerKey === "retail::warband::local" ? shared?.warband : shared?.guilds.find((candidate) => candidate.ownerKey === sourceOwnerKey);
  if (!owner) return missing("The selected shared-storage owner has no stored observation. Unobserved storage is not empty.", ["shared-storage observation"]);
  if (!owner.current) return missing("The selected owner has no informative shared-storage observation.", ["shared-storage observation"]);
  const current = owner.current;
  const freshness = evidenceFreshness(current.effectiveObservedAt, now);
  const observedAt = current.effectiveObservedAt;
  const sourceState = current.liveAtExport ? "OBSERVED" as const : "LAST_SEEN" as const;
  const sourceSection = { section: "shared storage" as const, state: owner.conflict ? "UNKNOWN" as const : sourceState, observedAt, completeness: current.completeness };
  const ownerScope = owner.owner.kind === "guild" ? "guild" as const : "warband-installation-local" as const;
  const base = { needId: need.stableId, sourceOwnerKey, ownerScope, requiredQuantity: need.requiredQuantity, observedAt, freshness, sourceSections: [sourceSection], unknownQuantityRowCount: 0 };
  if (owner.conflict) return { ...base, state: "UNKNOWN", unresolvedSections: ["conflicting top-time storage observations"], reason: `The selected ${ownerScope === "guild" ? "guild" : "installation-local Warband"} owner has conflicting content at the newest observation time; no winner is assumed.` };
  let observedQuantity = 0;
  let potentialQuantity = 0;
  let unknownQuantityRowCount = 0;
  let unidentifiedRows = 0;
  for (const row of current.content.items) {
    if (!row.itemRef) { unidentifiedRows++; continue; }
    const matches = need.kind === "ITEM_REF" ? row.itemRef === need.resourceKey : itemId(row.itemRef) === Number(need.resourceKey);
    if (!matches) continue;
    if (row.qty === undefined) { unknownQuantityRowCount++; continue; }
    if (sourceState === "OBSERVED") observedQuantity += row.qty; else potentialQuantity += row.qty;
  }
  const inaccessibleTabs = owner.owner.kind === "guild" && (current.coverage.inaccessibleTabs.length > 0 || current.coverage.unconfirmedTabs.length > 0 || current.coverage.unidentifiedTabs > 0);
  const exhaustive = current.completeness === "complete" && !inaccessibleTabs && unidentifiedRows === 0 && unknownQuantityRowCount === 0 && (current.content.itemsKnownEmpty || current.content.items.length > 0);
  if (sourceState === "LAST_SEEN") return { ...base, state: potentialQuantity >= need.requiredQuantity && potentialQuantity > 0 ? "POTENTIAL_COVERAGE_LAST_SEEN" : "UNKNOWN", ...(potentialQuantity > 0 ? { potentialQuantity } : {}), unresolvedSections: ["historical shared-storage evidence"], reason: `LAST_SEEN ${ownerScope === "guild" ? "guild-owned" : "installation-local Warband"} storage contains ${potentialQuantity} observed matching units; this is historical potential, not current supply or character access.` };
  if (observedQuantity >= need.requiredQuantity) return { ...base, state: "COVERED_BY_OBSERVED", observedQuantity, unresolvedSections: exhaustive ? [] : ["shared-storage completeness is partial or unconfirmed"], reason: `The selected ${ownerScope === "guild" ? "guild" : "installation-local Warband"} storage observation contains at least ${observedQuantity} matching units. This identifies a location and quantity only; it does not establish personal ownership, character access, or a transfer route.` };
  if (!exhaustive) return { ...base, state: "UNKNOWN", ...(observedQuantity > 0 ? { observedQuantity } : {}), ...(potentialQuantity > 0 ? { potentialQuantity } : {}), unresolvedSections: [current.completeness !== "complete" ? "partial shared-storage observation" : "inaccessible, unconfirmed, or unidentified storage contents"], unknownQuantityRowCount, reason: `The selected shared-storage observation is incomplete; it cannot establish an overall shortfall. ${ownerScope === "guild" ? "Guild contents remain guild-owned and access is not inferred." : "The Warband is installation-local and is not a Battle.net account identity."}` };
  return { ...base, state: "SHORTFALL_OBSERVED", observedQuantity, unresolvedSections: [], reason: `The complete observed ${ownerScope === "guild" ? "guild" : "installation-local Warband"} storage contains ${observedQuantity} matching units against ${need.requiredQuantity} required. This is a source-scope shortfall only; it does not identify personal ownership or a usable transfer route.` };
}

/** Compare explicit project needs to one explicitly selected character's latest evidence only. */
export function assessErpNeed(need: ErpResourceNeed, snapshots: readonly StoredSnapshot[], now: number, currencies?: AccountCurrencies, version?: WowVersion): ErpNeedEvidence {
  const sourceIdentityKey = need.sourceIdentityKey;
  const missing = (reason: string, unresolvedSections: string[] = []): ErpNeedEvidence => ({ needId: need.stableId, state: need.kind === "ITEM_ID" || need.kind === "ITEM_REF" || need.kind === "GOLD_COPPER" || need.kind === "CURRENCY" || need.kind === "PROFESSION" || need.kind === "RECIPE" ? "UNKNOWN" : "UNSUPPORTED_EVIDENCE", ...(sourceIdentityKey ? { sourceIdentityKey } : {}), requiredQuantity: need.requiredQuantity, freshness: "unknown", sourceSections: [], unresolvedSections, unknownQuantityRowCount: 0, reason });
  if (!sourceIdentityKey) return missing("No explicit source character was selected; roster co-location does not prove account ownership.");
  if (need.kind === "CURRENCY") {
    if (currencies?.version !== "retail") return missing("Structured currency evidence is currently supported only for Retail; other client versions remain UNKNOWN.", ["version-scoped currency evidence"]);
    if (!/^[1-9]\d*$/.test(need.resourceKey)) return missing("Currency resource key must be a positive numeric ID.", ["currency identity"]);
    const entry = currencies.currencies.find((candidate) => candidate.currencyID === Number(need.resourceKey));
    if (!entry) return missing(`Currency ID ${need.resourceKey} has no captured description or quantity for this version. An absent list entry is not a zero balance.`, ["currency entry"]);
    if (entry.scope === "ACCOUNT") return missing(`Currency ${entry.name ?? need.resourceKey} is marked account-wide. Its observed shared balance does not establish this character's access or ownership.`, ["character access to account-wide currency"]);
    if (entry.scope !== "CHARACTER") return missing(`Currency ${entry.name ?? need.resourceKey} has conflicting or unknown ownership scope.`, ["currency ownership scope"]);
    const character = entry.characters.find((candidate) => candidate.identityKey === sourceIdentityKey);
    if (!character || character.state === "UNKNOWN" || character.listed !== true || !character.currency) return missing(`Currency ${entry.name ?? need.resourceKey} was not affirmatively listed for the selected character; absence is not zero.`, ["selected character currency observation"]);
    const value = character.currency.quantity;
    const at = character.observedAt ?? undefined;
    const freshness = evidenceFreshness(at, now);
    const sourceSection = { section: "currencies" as const, state: character.state, ...(at !== undefined ? { observedAt: at } : {}) };
    if (value === null) return { ...missing(`Currency ${entry.name ?? need.resourceKey} is listed, but its quantity was not captured.`, ["currency quantity"]), sourceIdentityKey, ...(at !== undefined ? { observedAt: at } : {}), freshness, sourceSections: [sourceSection] };
    if (character.state === "LAST_SEEN") return { needId: need.stableId, sourceIdentityKey, state: value >= need.requiredQuantity ? "POTENTIAL_COVERAGE_LAST_SEEN" : "UNKNOWN", potentialQuantity: value, requiredQuantity: need.requiredQuantity, ...(at !== undefined ? { observedAt: at } : {}), freshness, sourceSections: [sourceSection], unresolvedSections: ["historical currency evidence"], unknownQuantityRowCount: 0, reason: `LAST_SEEN character-scoped ${entry.name ?? `currency ${need.resourceKey}`} quantity ${value}; required ${need.requiredQuantity}. This is historical potential, not current supply.` };
    return { needId: need.stableId, sourceIdentityKey, state: value >= need.requiredQuantity ? "COVERED_BY_OBSERVED" : "SHORTFALL_OBSERVED", observedQuantity: value, requiredQuantity: need.requiredQuantity, ...(at !== undefined ? { observedAt: at } : {}), freshness, sourceSections: [sourceSection], unresolvedSections: [], unknownQuantityRowCount: 0, reason: `OBSERVED character-scoped ${entry.name ?? `currency ${need.resourceKey}`} quantity ${value}; required ${need.requiredQuantity}. Account-wide access and other characters are not included.` };
  }
  if (need.kind === "RECIPE" && version !== "retail") return { ...missing(`Structured learned-recipe evidence is currently supported only for Retail; ${version ?? "the selected version"} remains UNKNOWN.`, ["version-scoped recipe evidence"]), state: "UNSUPPORTED_EVIDENCE", sourceIdentityKey };
  const snapshot = newest(snapshots);
  if (!snapshot) return missing("The selected source character has no imported observation.");
  const change = observationChange(need, previousSnapshot(snapshots, snapshot), snapshot);
  const observedAt = snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt);
  const freshness = evidenceFreshness(observedAt, now);
  const characterSource = { section: "character" as const, state: snapshot.parsed.character.status.state, ...(snapshot.parsed.character.status.observedAt !== undefined ? { observedAt: snapshot.parsed.character.status.observedAt } : {}), ...(snapshot.parsed.character.status.completeness ? { completeness: snapshot.parsed.character.status.completeness } : {}) };
  if (need.kind === "RECIPE") {
    const section = snapshot.parsed.characterState?.professionRecipes;
    const sectionData = section?.data as Record<string, unknown> | undefined;
    const professionRows = Array.isArray(sectionData?.professions) ? sectionData.professions as Array<Record<string, unknown>> : [];
    const matches = professionRows.flatMap((profession) => {
      const recipes = Array.isArray(profession.recipes) ? profession.recipes as Array<Record<string, unknown>> : [];
      return recipes.filter((recipe) => recipe.recipeID === Number(need.resourceKey)).map((recipe) => ({ profession, recipe }));
    });
    const sourceAt = section?.observedAt ?? section?.status.observedAt;
    const rowTimes = matches.flatMap(({ profession, recipe }) => recipe.evidence === "OBSERVED"
      ? [recipe.observedAt, profession.observedAt].filter((value): value is number => typeof value === "number")
      : [recipe.lastSeenAt, profession.lastSeenAt, recipe.observedAt, profession.observedAt].filter((value): value is number => typeof value === "number"));
    const evidenceAt = rowTimes.length ? Math.max(...rowTimes) : sourceAt;
    const recipeFreshness = evidenceFreshness(evidenceAt, now);
    const currentEvidence = section?.status.state === "OBSERVED" ? matches.filter(({ profession, recipe }) => profession.evidence === "OBSERVED" && recipe.evidence === "OBSERVED") : [];
    const observedStates = new Set(currentEvidence.map(({ recipe }) => recipe.learnedState).filter((state) => state === "OBSERVED_TRUE" || state === "OBSERVED_FALSE"));
    const hasHistoricalMatch = matches.some(({ profession, recipe }) => recipe.evidence === "LAST_SEEN" || profession.evidence === "LAST_SEEN");
    const recipeSourceState: "OBSERVED" | "LAST_SEEN" | "UNKNOWN" = section?.status.state === "OBSERVED" ? "OBSERVED" : section?.status.state === "LAST_SEEN" || hasHistoricalMatch ? "LAST_SEEN" : "UNKNOWN";
    const recipeSource = { section: "character" as const, state: recipeSourceState, ...(evidenceAt !== undefined ? { observedAt: evidenceAt } : {}), ...(section?.completeness ? { completeness: section.completeness } : {}) };
    if (observedStates.size === 1) {
      const learned = observedStates.has("OBSERVED_TRUE");
      return { needId: need.stableId, sourceIdentityKey, state: learned ? "COVERED_BY_OBSERVED" : "SHORTFALL_OBSERVED", observedQuantity: learned ? 1 : 0, requiredQuantity: 1, ...(evidenceAt !== undefined ? { observedAt: evidenceAt } : {}), freshness: recipeFreshness, sourceSections: [recipeSource], unresolvedSections: [], unknownQuantityRowCount: 0, reason: `Retail's structured recipe observation reports recipe ${need.resourceKey} as ${learned ? "learned" : "not learned"} for this character. Candidate recipe coverage is partial; this exact ID had an explicit learned-state result. This does not establish current profession skill, unlock requirements, reagents, or that crafting is presently possible.` };
    }
    if (observedStates.size > 1) return { ...missing(`Retail recipe ${need.resourceKey} has contradictory current learned-state rows; no result is selected.`, ["conflicting recipe evidence"]), sourceIdentityKey, ...(evidenceAt !== undefined ? { observedAt: evidenceAt } : {}), freshness: recipeFreshness, sourceSections: [recipeSource] };
    const lastSeenLearned = matches.some(({ profession, recipe }) => recipe.learnedState === "OBSERVED_TRUE" && (recipe.evidence === "LAST_SEEN" || profession.evidence === "LAST_SEEN" || section?.status.state === "LAST_SEEN"));
    if (lastSeenLearned) return { needId: need.stableId, sourceIdentityKey, state: "POTENTIAL_COVERAGE_LAST_SEEN", potentialQuantity: 1, requiredQuantity: 1, ...(evidenceAt !== undefined ? { observedAt: evidenceAt } : {}), freshness: recipeFreshness, sourceSections: [{ ...recipeSource, state: "LAST_SEEN" }], unresolvedSections: ["historical recipe learned state"], unknownQuantityRowCount: 0, reason: `Recipe ${need.resourceKey} was recorded as learned in LAST_SEEN evidence. It is historical potential only; current knowledge, skill, unlocks, and craftability have not been verified.` };
    const reason = !section?.data ? "No structured Retail recipe-learning observation is available for this character." : matches.length === 0 ? `Recipe ${need.resourceKey} is absent from a candidate list whose completeness is explicitly UNKNOWN; absence does not mean unlearned.` : "The exact recipe row has UNKNOWN, failed, or non-current learned-state evidence.";
    return { ...missing(reason, ["exact recipe learned-state result"]), sourceIdentityKey, ...(evidenceAt !== undefined ? { observedAt: evidenceAt } : {}), freshness: recipeFreshness, sourceSections: [recipeSource] };
  }
  if (need.kind === "GOLD_COPPER") {
    const amount = snapshot.parsed.character.moneyCopper;
    if (amount === undefined || characterSource.state === "UNKNOWN") return { ...missing("Gold was not reported as observed in the selected character's latest export."), sourceIdentityKey, observedAt, freshness, sourceSections: [characterSource] };
    const observed = characterSource.state === "OBSERVED";
    const goldObservedAt = characterSource.observedAt ?? observedAt;
    const goldFreshness = evidenceFreshness(goldObservedAt, now);
    const state: NeedSupplyState = observed ? amount >= need.requiredQuantity ? "COVERED_BY_OBSERVED" : "SHORTFALL_OBSERVED" : amount >= need.requiredQuantity ? "POTENTIAL_COVERAGE_LAST_SEEN" : "UNKNOWN";
    return { needId: need.stableId, sourceIdentityKey, state, ...(observed ? { observedQuantity: amount } : { potentialQuantity: amount }), requiredQuantity: need.requiredQuantity, observedAt: goldObservedAt, freshness: goldFreshness, sourceSections: [characterSource], unresolvedSections: observed ? [] : ["historical character values"], unknownQuantityRowCount: 0, observationChange: change, reason: `${observed ? "Observed" : "LAST_SEEN"} ${amount} copper; required ${need.requiredQuantity}. This is a snapshot, not a live balance (${goldFreshness} freshness).` };
  }
  if (need.kind !== "ITEM_ID" && need.kind !== "ITEM_REF" && need.kind !== "PROFESSION") return { ...missing(`${need.kind} requirements are stored as explicit intent, but this branch has no version-validated supply projection for that evidence type.`), sourceIdentityKey, observedAt, freshness };
  if (need.kind === "PROFESSION") {
    const section = snapshot.parsed.professions;
    const professionObservedAt = section.status.state === "OBSERVED" ? section.status.observedAt ?? observedAt : section.status.observedAt;
    const professionFreshness = evidenceFreshness(professionObservedAt, now);
    const professionSource = { section: "character" as const, state: section.status.state, ...(professionObservedAt !== undefined ? { observedAt: professionObservedAt } : {}), ...(section.status.completeness ? { completeness: section.status.completeness } : {}) };
    if (section.status.state === "UNKNOWN") return { ...missing("Profession evidence was not observed for the selected character."), sourceIdentityKey, ...(professionObservedAt !== undefined ? { observedAt: professionObservedAt } : {}), freshness: professionFreshness, sourceSections: [professionSource], unresolvedSections: ["professions"] };
    const profession = section.entries.find((entry) => entry.name.trim().toLocaleLowerCase() === need.resourceKey.trim().toLocaleLowerCase());
    if (!profession && section.status.state === "OBSERVED" && section.status.completeness?.toLowerCase() === "complete") {
      return { needId: need.stableId, sourceIdentityKey, state: "SHORTFALL_OBSERVED", observedQuantity: 0, requiredQuantity: need.requiredQuantity, observedAt: professionObservedAt, freshness: professionFreshness, sourceSections: [{ section: "character", state: "OBSERVED", observedAt: professionObservedAt, completeness: section.status.completeness }], unresolvedSections: [], unknownQuantityRowCount: 0, observationChange: change, reason: `The complete observed profession list contains no exact name match for “${need.resourceKey}”. No profession equivalence or recipe ability is inferred.` };
    }
    if (!profession || profession.skill === undefined) return { ...missing(`No skill value is available for the exact profession name “${need.resourceKey}” in this ${section.status.completeness ?? "unqualified"} profession observation.`), sourceIdentityKey, ...(professionObservedAt !== undefined ? { observedAt: professionObservedAt } : {}), freshness: professionFreshness, sourceSections: [professionSource], unresolvedSections: ["matching profession skill"] };
    const observed = section.status.state === "OBSERVED";
    const state: NeedSupplyState = observed ? profession.skill >= need.requiredQuantity ? "COVERED_BY_OBSERVED" : "SHORTFALL_OBSERVED" : profession.skill >= need.requiredQuantity ? "POTENTIAL_COVERAGE_LAST_SEEN" : "UNKNOWN";
    return { needId: need.stableId, sourceIdentityKey, state, ...(observed ? { observedQuantity: profession.skill } : { potentialQuantity: profession.skill }), requiredQuantity: need.requiredQuantity, ...(professionObservedAt !== undefined ? { observedAt: professionObservedAt } : {}), freshness: professionFreshness, sourceSections: [professionSource], unresolvedSections: observed ? [] : ["historical profession evidence"], unknownQuantityRowCount: 0, observationChange: change, reason: `${section.status.state === "OBSERVED" ? "Observed" : "LAST_SEEN"} exact profession name “${profession.name}” at skill ${profession.skill}; required threshold ${need.requiredQuantity}. This confirms skill only, not a recipe or craftability.` };
  }
  let observedQuantity = 0; let potentialQuantity = 0; let unknownQuantityRowCount = 0;
  const unresolvedSections: string[] = [];
  let anyObserved = false;
  const sourceSections: ErpNeedEvidence["sourceSections"][number][] = [];
  for (const [name, section] of [["bags", snapshot.parsed.bags], ["character bank", snapshot.parsed.bank]] as const) {
    sourceSections.push({ section: name, state: section.status.state, ...(section.status.observedAt !== undefined ? { observedAt: section.status.observedAt } : {}), ...(section.status.completeness ? { completeness: section.status.completeness } : {}) });
    if (section.status.state === "UNKNOWN") { unresolvedSections.push(name); continue; }
    const target = section.status.state === "OBSERVED" ? "observed" : "potential";
    if (target === "observed") anyObserved = true;
    for (const row of section.items) {
      const matches = need.kind === "ITEM_REF" ? row.itemRef === need.resourceKey : itemId(row.itemRef) === Number(need.resourceKey);
      if (!matches) { if (!row.itemRef) unresolvedSections.push(`${name}: unidentified item row`); continue; }
      if (row.qty === undefined) { unknownQuantityRowCount++; continue; }
      if (target === "observed") observedQuantity += row.qty; else potentialQuantity += row.qty;
    }
  }
  const allCurrentSectionsComplete = [snapshot.parsed.bags, snapshot.parsed.bank].every((section) => section.status.state === "OBSERVED" && section.status.completeness?.toLowerCase() === "complete");
  if (!anyObserved) unresolvedSections.push("no currently observed storage section");
  if (!allCurrentSectionsComplete) unresolvedSections.push("storage completeness is partial or unconfirmed");
  const unresolved = unresolvedSections.length > 0 || unknownQuantityRowCount > 0 || !anyObserved;
  let state: NeedSupplyState;
  if (observedQuantity >= need.requiredQuantity) state = "COVERED_BY_OBSERVED";
  else if (observedQuantity + potentialQuantity >= need.requiredQuantity && potentialQuantity > 0) state = "POTENTIAL_COVERAGE_LAST_SEEN";
  else if (unresolved) state = "UNKNOWN";
  else state = "SHORTFALL_OBSERVED";
  const evidenceTimes = sourceSections.filter((source) => source.state !== "UNKNOWN" && source.observedAt !== undefined).map((source) => source.observedAt!);
  const oldestEvidenceAt = evidenceTimes.length ? Math.min(...evidenceTimes) : observedAt;
  const currentEvidenceAges = sourceSections.filter((source) => source.state === "OBSERVED").map((source) => evidenceFreshness(source.observedAt ?? observedAt, now));
  const evidenceFreshnessState = currentEvidenceAges.includes("unknown") ? "unknown" : currentEvidenceAges.includes("stale") ? "stale" : currentEvidenceAges.length ? "recent" : "unknown";
  return {
    needId: need.stableId, sourceIdentityKey, state,
    ...(anyObserved ? { observedQuantity } : {}), ...(potentialQuantity > 0 ? { potentialQuantity } : {}), requiredQuantity: need.requiredQuantity, observationChange: change,
    observedAt: oldestEvidenceAt, freshness: evidenceFreshnessState, sourceSections, unresolvedSections: [...new Set(unresolvedSections)].sort(), unknownQuantityRowCount,
    reason: state === "COVERED_BY_OBSERVED" ? `Observed at least ${observedQuantity} matching item quantity in the selected character's currently observed bags/bank; required ${need.requiredQuantity}. Evidence is ${evidenceFreshnessState}.`
      : state === "POTENTIAL_COVERAGE_LAST_SEEN" ? `Current observations show ${observedQuantity}; LAST_SEEN adds ${potentialQuantity} possible quantity. Historical evidence is not current supply.`
      : state === "SHORTFALL_OBSERVED" ? `Observed ${observedQuantity} matching item quantity against ${need.requiredQuantity} required, and both personal storage sections were marked complete in this capture.`
      : `Current evidence cannot establish the full supply total (${observedQuantity} directly observed${potentialQuantity ? `, ${potentialQuantity} LAST_SEEN` : ""}); unresolved: ${unresolvedSections.join(", ") || "item quantities"}.`,
  };
}

export interface ErpProjectView extends ErpProject {
  readonly history: readonly ErpProjectEvent[];
  readonly historyEventCount: number;
  readonly historyTruncated: boolean;
  readonly needEvidence: readonly ErpNeedEvidence[];
  readonly resourceSourceScreens: readonly ErpResourceSourceScreen[];
  readonly workOrderReadiness: readonly ErpWorkOrderReadiness[];
  readonly workOrderProgress: readonly ErpWorkOrderProgress[];
  readonly reservationReview: readonly { reservationId: string; state: "WITHIN_OBSERVED_SUPPLY" | "EXCEEDS_OBSERVED_SUPPLY" | "SUPPLY_UNKNOWN"; reservedQuantity: number; observedQuantity?: number; reason: string }[];
}

export interface ErpResourceSourceLocation {
  readonly section: "bags" | "character bank";
  readonly state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
  readonly observedAt?: number;
  readonly completeness?: string;
  /** Exact quantity only when the section is completely identified and quantified. */
  readonly quantity?: number;
  /** Known positive matching quantity when total section contents are incomplete. */
  readonly knownLowerBound?: number;
}

export interface ErpResourceSourceItem {
  readonly itemRef: string;
  readonly section: "bags" | "character bank";
  readonly state: "OBSERVED" | "LAST_SEEN";
  readonly quantity?: number;
  readonly knownLowerBound?: number;
  readonly observedAt?: number;
}

export interface ErpResourceSourceCandidate {
  readonly sourceIdentityKey: string;
  readonly sourceName: string;
  readonly sourceSurname?: string;
  readonly sourceRealm: string;
  readonly needId: string;
  readonly kind: "ITEM_ID" | "ITEM_REF";
  readonly resourceKey: string;
  readonly state: "OBSERVED" | "LAST_SEEN";
  readonly observedQuantity?: number;
  readonly potentialQuantity?: number;
  readonly activeReservationQuantity: number;
  readonly reservationState: "UNRESERVED" | "WITHIN_OBSERVED_SUPPLY" | "OVER_RESERVED" | "UNKNOWN";
  readonly availableObservedLowerBound?: number;
  readonly freshness: "recent" | "stale" | "unknown";
  readonly observedAt?: number;
  readonly locations: readonly ErpResourceSourceLocation[];
  readonly matchingItems: readonly ErpResourceSourceItem[];
  readonly unresolvedSections: readonly string[];
  /** Roster co-location never establishes these cross-character facts. */
  readonly accountMembership: "UNKNOWN";
  readonly access: "UNKNOWN";
  readonly transferability: "UNKNOWN";
  readonly reason: string;
}

export interface ErpResourceSourceScreen {
  readonly needId: string;
  readonly destinationIdentityKey: string;
  readonly scannedCharacterCount: number;
  readonly unresolvedCharacterCount: number;
  readonly candidateCount: number;
  readonly candidatesTruncated: boolean;
  readonly candidates: readonly ErpResourceSourceCandidate[];
}

const ERP_RESOURCE_SOURCE_CANDIDATE_LIMIT = 25;

export interface ErpResourceCommitmentLine {
  readonly version: WowVersion;
  readonly sourceScope: "CHARACTER" | "SHARED_OWNER" | "UNKNOWN_SOURCE";
  readonly sourceIdentityKey?: string;
  readonly sourceOwnerKey?: string;
  readonly kind: ErpResourceKind;
  readonly resourceKey: string;
  readonly label: string;
  /** Planned need quantities are intent and are kept separate from observed supply and reservations. */
  readonly activeNeedCount: number;
  readonly activeNeedQuantity: number;
  readonly pausedNeedCount: number;
  readonly pausedNeedQuantity: number;
  readonly otherPlanNeedCount: number;
  /** Active reservations recorded on needs with this exact identity. */
  readonly activeReservationQuantity: number;
  /** Active reservations found on overlapping base/variant scopes; do not add across overlapping rows. */
  readonly overlappingReservationQuantity?: number;
  readonly reservationState: "UNRESERVED" | "WITHIN_OBSERVED_SUPPLY" | "OVER_RESERVED" | "UNKNOWN";
  readonly availableObservedLowerBound?: number;
  readonly observedQuantity?: number;
  readonly potentialQuantity?: number;
  readonly observedAt?: number;
  readonly freshness: "recent" | "stale" | "unknown";
  readonly needStates: Readonly<Record<NeedSupplyState, number>>;
  readonly sourceSections: readonly ErpNeedEvidence["sourceSections"][number][];
  readonly unresolvedSections: readonly string[];
  /** Other resource keys with which this source/item scope may overlap. Do not total these rows together. */
  readonly overlappingResourceKeys: readonly string[];
  readonly contributorCount: number;
  readonly contributors: readonly { projectId: string; projectTitle: string; projectStatus: ErpProjectStatus; priority: number; needId: string; label: string; requiredQuantity: number; destinationIdentityKey?: string; activeReservationQuantity: number }[];
  readonly contributorsTruncated: boolean;
}

export interface ErpResourceCommitmentSummary {
  readonly items: readonly ErpResourceCommitmentLine[];
  readonly totalCount: number;
  readonly returnedCount: number;
  readonly truncated: boolean;
  readonly linesWithReservations: number;
  readonly unknownSourceLines: number;
  readonly overlappingScopeLines: number;
}

/** Groups explicit plans by source and exact identity; observed stock is represented once, never summed across projects. */
export function buildErpResourceCommitmentSummary(projects: readonly ErpProjectView[], limit = 100): ErpResourceCommitmentSummary {
  const groups = new Map<string, Array<{ project: ErpProjectView; need: ErpResourceNeed; evidence: ErpNeedEvidence; activeReservationQuantity: number }>>();
  for (const project of projects) for (const need of project.needs) {
    const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
    if (!evidence) continue;
    const explicitSourceScope = sourceScope(need);
    const key = JSON.stringify([project.version, explicitSourceScope ?? `unknown:${project.stableId}:${need.stableId}`, need.kind, need.resourceKey]);
    const activeReservationQuantity = project.reservations.filter((reservation) => reservation.status === "ACTIVE" && reservation.needId === need.stableId).reduce((sum, reservation) => sum + reservation.quantity, 0);
    groups.set(key, [...(groups.get(key) ?? []), { project, need, evidence, activeReservationQuantity }]);
  }
  const entries = [...groups.values()].map((group): ErpResourceCommitmentLine => {
    const first = group[0]!;
    const evidence = group.map((entry) => entry.evidence);
    const observed = new Set(evidence.map((entry) => entry.observedQuantity));
    const potential = new Set(evidence.map((entry) => entry.potentialQuantity));
    const freshnesses = new Set(evidence.map((entry) => entry.freshness));
    const reservationStates = new Set(evidence.map((entry) => entry.reservationAssessment?.state ?? "UNKNOWN"));
    const reservationQuantities = new Set(evidence.map((entry) => entry.reservationAssessment?.activeQuantity));
    const reservationAvailable = new Set(evidence.map((entry) => entry.reservationAssessment?.availableObservedLowerBound));
    const needStates = Object.fromEntries((['COVERED_BY_OBSERVED', 'SHORTFALL_OBSERVED', 'POTENTIAL_COVERAGE_LAST_SEEN', 'UNKNOWN', 'UNSUPPORTED_EVIDENCE'] as const).map((state) => [state, evidence.filter((entry) => entry.state === state).length])) as Record<NeedSupplyState, number>;
    const sections = evidence.flatMap((entry) => entry.sourceSections);
    const unresolvedSections = [...new Set(evidence.flatMap((entry) => entry.unresolvedSections))].sort();
    const identityId = first.need.kind === "ITEM_ID" ? Number(first.need.resourceKey) : first.need.kind === "ITEM_REF" ? needItemId(first.need) : undefined;
    const explicitSource = sourceScope(first.need);
    const overlaps = identityId === undefined || !explicitSource ? [] : projects.flatMap((project) => project.needs.filter((need) => {
      if (sourceScope(need) !== explicitSource || need.resourceKey === first.need.resourceKey && need.kind === first.need.kind || needItemId(need) !== identityId) return false;
      // ITEM_REF is always an exact identity, including the bare item:<id> form.
      // Only a base ITEM_ID overlaps its matching ITEM_REF scopes, as used by reservation assessment.
      return first.need.kind !== need.kind;
    }).map((need) => need.resourceKey));
    const contributors = group.map(({ project, need, activeReservationQuantity }) => ({ projectId: project.stableId, projectTitle: project.title, projectStatus: project.status, priority: project.priority, needId: need.stableId, label: need.label, requiredQuantity: need.requiredQuantity, ...(need.destinationIdentityKey ? { destinationIdentityKey: need.destinationIdentityKey } : {}), activeReservationQuantity })).sort((a, b) => b.priority - a.priority || a.projectTitle.localeCompare(b.projectTitle) || a.needId.localeCompare(b.needId));
    const active = group.filter((entry) => entry.project.status === "ACTIVE");
    const paused = group.filter((entry) => entry.project.status === "PAUSED");
    const other = group.filter((entry) => entry.project.status !== "ACTIVE" && entry.project.status !== "PAUSED");
    const activeReservationQuantity = group.reduce((sum, entry) => sum + entry.activeReservationQuantity, 0);
    const assessedReservationQuantity = reservationQuantities.size === 1 ? [...reservationQuantities][0] : undefined;
    const overlappingReservationQuantity = assessedReservationQuantity !== undefined && assessedReservationQuantity >= activeReservationQuantity ? assessedReservationQuantity - activeReservationQuantity : undefined;
    return {
      version: first.project.version,
      sourceScope: first.need.sourceIdentityKey ? "CHARACTER" : first.need.sourceOwnerKey ? "SHARED_OWNER" : "UNKNOWN_SOURCE",
      ...(first.need.sourceIdentityKey ? { sourceIdentityKey: first.need.sourceIdentityKey } : {}),
      ...(first.need.sourceOwnerKey ? { sourceOwnerKey: first.need.sourceOwnerKey } : {}),
      kind: first.need.kind, resourceKey: first.need.resourceKey, label: first.need.label,
      activeNeedCount: active.length, activeNeedQuantity: active.reduce((sum, entry) => sum + entry.need.requiredQuantity, 0),
      pausedNeedCount: paused.length, pausedNeedQuantity: paused.reduce((sum, entry) => sum + entry.need.requiredQuantity, 0), otherPlanNeedCount: other.length,
      activeReservationQuantity,
      ...(overlappingReservationQuantity !== undefined && overlappingReservationQuantity > 0 ? { overlappingReservationQuantity } : {}),
      reservationState: reservationStates.size === 1 && (assessedReservationQuantity === undefined || assessedReservationQuantity >= activeReservationQuantity) ? [...reservationStates][0]! as ErpResourceCommitmentLine['reservationState'] : "UNKNOWN",
      ...(reservationAvailable.size === 1 && evidence[0]?.reservationAssessment?.availableObservedLowerBound !== undefined ? { availableObservedLowerBound: evidence[0].reservationAssessment.availableObservedLowerBound } : {}),
      ...(observed.size === 1 && evidence[0]?.observedQuantity !== undefined ? { observedQuantity: evidence[0].observedQuantity } : {}),
      ...(potential.size === 1 && evidence[0]?.potentialQuantity !== undefined ? { potentialQuantity: evidence[0].potentialQuantity } : {}),
      ...(new Set(evidence.map((entry) => entry.observedAt)).size === 1 && evidence[0]?.observedAt !== undefined ? { observedAt: evidence[0].observedAt } : {}),
      freshness: freshnesses.size === 1 ? [...freshnesses][0]! : "unknown", needStates,
      sourceSections: [...new Map(sections.map((section) => [JSON.stringify(section), section])).values()],
      unresolvedSections,
      overlappingResourceKeys: [...new Set(overlaps)].sort(), contributorCount: contributors.length,
      contributors: contributors.slice(0, 25), contributorsTruncated: contributors.length > 25,
    };
  }).sort((a, b) => a.sourceScope.localeCompare(b.sourceScope) || (a.sourceIdentityKey ?? a.sourceOwnerKey ?? "").localeCompare(b.sourceIdentityKey ?? b.sourceOwnerKey ?? "") || a.kind.localeCompare(b.kind) || a.resourceKey.localeCompare(b.resourceKey));
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 100;
  const items = entries.slice(0, safeLimit);
  return { items, totalCount: entries.length, returnedCount: items.length, truncated: items.length < entries.length, linesWithReservations: entries.filter((line) => line.activeReservationQuantity > 0 || (line.overlappingReservationQuantity ?? 0) > 0).length, unknownSourceLines: entries.filter((line) => line.sourceScope === "UNKNOWN_SOURCE").length, overlappingScopeLines: entries.filter((line) => line.overlappingResourceKeys.length > 0).length };
}

export interface ErpWorkOrderReadiness {
  readonly workOrderId: string;
  readonly state: "PROJECT_NOT_ACTIVE" | "TERMINAL" | "BLOCKED_BY_DEPENDENCY" | "OBSERVED_RESOURCE_SHORTFALL" | "MANUAL_SUPPLY_STEP_RECOMMENDED" | "RESOURCE_ALLOCATION_REQUIRES_REVIEW" | "WAITING_FOR_EVIDENCE" | "OBSERVATION_CHANGED_REQUIRES_REVIEW" | "READY_FOR_PLAYER_REVIEW";
  readonly blockingWorkOrderIds: readonly string[];
  readonly unresolvedNeedIds: readonly string[];
  readonly actionTargetNeedIds: readonly string[];
  readonly changedNeedIds: readonly string[];
  readonly capabilityChecks?: readonly ErpCraftingCapabilityCheck[];
  readonly reason: string;
}

export interface ErpCraftingCapabilityCheck {
  readonly needId: string;
  readonly kind: "PROFESSION" | "RECIPE";
  readonly state: "SUPPORTED_FOR_ASSIGNEE" | "ASSIGNED_CHARACTER_MISSING" | "SOURCE_NOT_SELECTED" | "SOURCE_DIFFERS_FROM_ASSIGNEE" | "REQUIREMENT_NOT_MET" | "EVIDENCE_UNKNOWN";
  readonly assignedIdentityKey?: string;
  readonly evidenceSourceIdentityKey?: string;
  readonly reason: string;
}

export interface ErpWorkOrderProgress {
  readonly workOrderId: string;
  readonly recordedStatus: ErpWorkOrderStatus;
  readonly completionRecorded: boolean;
  readonly linkedNeedState: "NO_LINKED_NEEDS" | "ALL_CURRENTLY_MET" | "CURRENT_SHORTFALL" | "MIXED_CURRENT_EVIDENCE" | "STALE_OR_UNKNOWN" | "RESOURCE_ALLOCATION_REQUIRES_REVIEW";
  readonly observationChange: "CHANGED" | "UNCHANGED" | "UNKNOWN";
  readonly reconciliation: "PLAYER_RECORDED_COMPLETE" | "COMPLETION_CONFLICTS_WITH_LINKED_SHORTFALL" | "CURRENT_LINKED_NEEDS_MET" | "CURRENT_LINKED_NEEDS_UNMET" | "MIXED_LINKED_EVIDENCE" | "OBSERVATION_CHANGED_CAUSE_UNKNOWN" | "INSUFFICIENT_EVIDENCE" | "NO_LINKED_NEEDS" | "RESOURCE_ALLOCATION_REQUIRES_REVIEW";
  readonly coveredNeedIds: readonly string[];
  readonly shortfallNeedIds: readonly string[];
  readonly unresolvedNeedIds: readonly string[];
  readonly allocationConflictNeedIds: readonly string[];
  readonly changedNeedIds: readonly string[];
  readonly transferObservationReviews?: readonly ErpTransferObservationReview[];
  readonly reason: string;
}

export interface ErpTransferSideObservation {
  readonly identityKey?: string;
  readonly state: "COMPARABLE_CHANGED" | "COMPARABLE_UNCHANGED" | "UNKNOWN";
  readonly observedAt?: number;
  readonly freshness: Freshness;
  readonly comparisons: readonly ResourceObservationChange["comparisons"][number][];
  readonly reason: string;
}

export interface ErpTransferObservationReview {
  readonly needId: string;
  readonly kind: "ITEM_ID" | "ITEM_REF";
  readonly resourceKey: string;
  readonly source: ErpTransferSideObservation;
  readonly destination: ErpTransferSideObservation;
  readonly state: "BOTH_SIDES_CHANGED" | "SOURCE_ONLY_CHANGED" | "DESTINATION_ONLY_CHANGED" | "NO_COMPARABLE_CHANGE" | "EVIDENCE_UNKNOWN" | "IDENTITY_CONFLICT";
  readonly interpretation: "CAUSE_UNKNOWN";
  readonly reason: string;
}

function transferSideObservation(need: ErpResourceNeed, identityKey: string | undefined, project: ErpProject, snapshotsFor: (identityKey: string) => readonly StoredSnapshot[], now: number, currencies?: AccountCurrencies): ErpTransferSideObservation {
  if (!identityKey) return { state: "UNKNOWN", freshness: "unknown", comparisons: [], reason: "No explicit source/destination character is recorded." };
  if (!identityKey.startsWith(`${project.version}::`)) return { identityKey, state: "UNKNOWN", freshness: "unknown", comparisons: [], reason: "The planned character identity does not match the project's version; no cross-version observation is used." };
  const evidence = assessErpNeed({ ...need, sourceIdentityKey: identityKey, sourceOwnerKey: undefined }, snapshotsFor(identityKey), now, currencies, project.version);
  const comparisons = evidence.observationChange?.comparisons ?? [];
  const freshness = evidence.freshness;
  const state = freshness !== "recent" || evidence.observationChange?.state === "UNKNOWN" ? "UNKNOWN" as const
    : evidence.observationChange?.state === "CHANGED" ? "COMPARABLE_CHANGED" as const : "COMPARABLE_UNCHANGED" as const;
  return {
    identityKey, state, freshness, ...(evidence.observedAt !== undefined ? { observedAt: evidence.observedAt } : {}), comparisons,
    reason: state === "COMPARABLE_CHANGED" ? "A recent comparable observation changed this resource scope; cause is unknown."
      : state === "COMPARABLE_UNCHANGED" ? "Recent comparable observations show no quantity change in this resource scope."
      : evidence.reason,
  };
}

function transferObservationReviews(project: ErpProject, order: ErpWorkOrder, snapshotsFor: (identityKey: string) => readonly StoredSnapshot[], now: number, currencies?: AccountCurrencies): ErpTransferObservationReview[] {
  if (order.kind !== "TRANSFER") return [];
  return order.resourceNeedIds.flatMap((needId) => {
    const need = project.needs.find((entry) => entry.stableId === needId);
    if (!need || (need.kind !== "ITEM_ID" && need.kind !== "ITEM_REF")) return [];
    const sharedOwnerSourceConflict = Boolean(need.sourceOwnerKey && order.sourceIdentityKey);
    const sourceConflict = Boolean(order.sourceIdentityKey && need.sourceIdentityKey && order.sourceIdentityKey !== need.sourceIdentityKey);
    const destinationConflict = Boolean(order.destinationIdentityKey && need.destinationIdentityKey && order.destinationIdentityKey !== need.destinationIdentityKey);
    const sourceIdentityKey = order.sourceIdentityKey ?? need.sourceIdentityKey;
    const destinationIdentityKey = order.destinationIdentityKey ?? need.destinationIdentityKey;
    // A character named on a transfer task cannot replace an explicitly shared-storage owner
    // recorded on the need. Keep the mismatch visible and never query that character as source.
    const source = need.sourceOwnerKey
      ? { state: "UNKNOWN" as const, freshness: "unknown" as const, comparisons: [], reason: sharedOwnerSourceConflict
        ? "The linked need names a shared-storage owner, while the work order names a character source. These scopes conflict; no character inventory was compared as the owner source."
        : "The linked need names a shared-storage owner. Shared-owner observations cannot be paired as a character inventory source." }
      : transferSideObservation(need, sourceIdentityKey, project, snapshotsFor, now, currencies);
    const destination = transferSideObservation(need, destinationIdentityKey, project, snapshotsFor, now, currencies);
    const changedSource = source.state === "COMPARABLE_CHANGED";
    const changedDestination = destination.state === "COMPARABLE_CHANGED";
    const identityConflict = sharedOwnerSourceConflict || sourceConflict || destinationConflict || Boolean(sourceIdentityKey && destinationIdentityKey && sourceIdentityKey === destinationIdentityKey);
    const state: ErpTransferObservationReview["state"] = identityConflict ? "IDENTITY_CONFLICT"
      : source.state === "UNKNOWN" || destination.state === "UNKNOWN" ? "EVIDENCE_UNKNOWN"
      : changedSource && changedDestination ? "BOTH_SIDES_CHANGED"
      : changedSource ? "SOURCE_ONLY_CHANGED"
      : changedDestination ? "DESTINATION_ONLY_CHANGED"
      : "NO_COMPARABLE_CHANGE";
    const identityScopeLimit = need.kind === "ITEM_ID" ? "These deltas group all observed itemString variants under the declared base item ID; they do not prove the same exact variant changed. " : "The resource scope is the exact declared itemString. ";
    const reason = identityScopeLimit + (state === "IDENTITY_CONFLICT" ? sharedOwnerSourceConflict
      ? "The resource need's shared-storage owner conflicts with the work order's character source. Clarify the source scope; character inventory deltas were not used as shared-owner evidence."
      : "The work order and linked need disagree on source/destination, or both sides resolve to the same character; clarify the plan before interpreting observations."
      : state === "EVIDENCE_UNKNOWN" ? "A source or destination identity, recent observation, or comparable complete item scope is missing. No movement conclusion is supported."
      : state === "BOTH_SIDES_CHANGED" ? "Both explicitly named characters have recent comparable changes for this resource scope. The observations do not establish that the changes are related or that a transfer occurred."
      : state === "SOURCE_ONLY_CHANGED" ? "Only the explicitly named source changed in comparable evidence. Disappearance does not establish transfer, consumption, sale, or cause."
      : state === "DESTINATION_ONLY_CHANGED" ? "Only the explicitly named destination changed in comparable evidence. Appearance does not establish transfer, ownership, or cause."
      : "Recent comparable observations show no quantity change for this resource scope; this does not prove that no unobserved action occurred.");
    return [{ needId, kind: need.kind, resourceKey: need.resourceKey, source, destination, state, interpretation: "CAUSE_UNKNOWN" as const, reason }];
  });
}

function applyReservationAssessment(need: ErpResourceNeed, evidence: ErpNeedEvidence, allProjects: readonly ErpProject[], version: WowVersion): ErpNeedEvidence {
  const scope = sourceScope(need);
  if (!scope) return { ...evidence, reservationAssessment: { state: "UNKNOWN", activeQuantity: 0, reason: "No explicit source character or shared-storage owner was selected; roster co-location does not prove ownership or access." } };
  const reservations = overlappingReservations(need, scope, version, allProjects);
  const activeQuantity = reservations.reduce((sum, reservation) => sum + reservation.quantity, 0);
  const ambiguous = reservations.some((reservation) => reservation.ambiguous);
  const completeSupply = evidence.unresolvedSections.length === 0 && evidence.unknownQuantityRowCount === 0;
  const overReserved = evidence.observedQuantity !== undefined && activeQuantity > evidence.observedQuantity;
  const capabilityResource = need.kind === "PROFESSION" || need.kind === "RECIPE";
  const state = capabilityResource || ambiguous || evidence.observedQuantity === undefined || (overReserved && !completeSupply)
    ? "UNKNOWN" as const
    : overReserved ? "OVER_RESERVED" as const
    : activeQuantity ? "WITHIN_OBSERVED_SUPPLY" as const : "UNRESERVED" as const;
  const availableObservedLowerBound = !ambiguous && evidence.observedQuantity !== undefined && activeQuantity <= evidence.observedQuantity
    ? evidence.observedQuantity - activeQuantity : undefined;
  const reason = capabilityResource ? "Profession and recipe capabilities are not countable inventory units; reservations cannot be reconciled as quantities."
    : ambiguous ? "Base item and exact-variant reservations overlap; their combined quantity cannot be allocated safely."
    : state === "OVER_RESERVED" ? `Active reservations total ${activeQuantity}, exceeding ${evidence.observedQuantity} observed. Resolve the competing plans; inventory is unchanged.`
    : state === "UNKNOWN" ? "Reservation availability is unknown because the source or relevant supply evidence is incomplete."
    : activeQuantity ? `At least ${availableObservedLowerBound} observed units remain outside ${activeQuantity} explicitly reserved units; this is not proof of transferability or a live balance.`
    : evidence.observedQuantity !== undefined ? `No active reservations; ${evidence.observedQuantity} units are observed at this source, subject to freshness and completeness.`
    : "No explicit source supply is available to assess reservations.";
  return { ...evidence, reservationAssessment: { state, activeQuantity, ...(availableObservedLowerBound !== undefined ? { availableObservedLowerBound } : {}), reason } };
}

function resourceSourceLocations(snapshot: StoredSnapshot, need: ErpResourceNeed): ErpResourceSourceLocation[] {
  const locations: ErpResourceSourceLocation[] = [];
  for (const [name, section] of [["bags", snapshot.parsed.bags], ["character bank", snapshot.parsed.bank]] as const) {
    let matched = 0;
    let sectionHasUnknownRows = false;
    for (const row of section.items) {
      if (!row.itemRef) { sectionHasUnknownRows = true; continue; }
      const matches = need.kind === "ITEM_REF" ? row.itemRef === need.resourceKey : itemId(row.itemRef) === Number(need.resourceKey);
      if (!matches) continue;
      if (row.qty === undefined) sectionHasUnknownRows = true;
      else matched += row.qty;
    }
    const complete = section.status.state !== "UNKNOWN" && section.status.completeness?.toLowerCase() === "complete" && !sectionHasUnknownRows;
    locations.push({ section: name, state: section.status.state, ...(section.status.observedAt !== undefined ? { observedAt: section.status.observedAt } : {}), ...(section.status.completeness ? { completeness: section.status.completeness } : {}), ...(complete ? { quantity: matched } : matched > 0 ? { knownLowerBound: matched } : {}) });
  }
  return locations;
}

function resourceSourceItems(snapshot: StoredSnapshot, need: ErpResourceNeed): ErpResourceSourceItem[] {
  const matched = new Map<string, ErpResourceSourceItem & { hasUnknownQuantity: boolean }>();
  for (const [sectionName, section] of [["bags", snapshot.parsed.bags], ["character bank", snapshot.parsed.bank]] as const) {
    if (section.status.state === "UNKNOWN") continue;
    for (const row of section.items) {
      if (!row.itemRef) continue;
      const matches = need.kind === "ITEM_REF" ? row.itemRef === need.resourceKey : itemId(row.itemRef) === Number(need.resourceKey);
      if (!matches) continue;
      const key = `${sectionName}\u0000${section.status.state}\u0000${row.itemRef}`;
      const existing = matched.get(key);
      matched.set(key, {
        itemRef: row.itemRef, section: sectionName, state: section.status.state,
        ...(section.status.observedAt !== undefined ? { observedAt: section.status.observedAt } : {}),
        quantity: (existing?.quantity ?? 0) + (row.qty ?? 0),
        hasUnknownQuantity: Boolean(existing?.hasUnknownQuantity || row.qty === undefined),
      });
    }
  }
  return [...matched.values()].map(({ hasUnknownQuantity, quantity, ...item }) => ({ ...item, ...(hasUnknownQuantity ? ((quantity ?? 0) > 0 ? { knownLowerBound: quantity! } : {}) : { quantity }) })).sort((a, b) => a.section.localeCompare(b.section) || a.itemRef.localeCompare(b.itemRef) || a.state.localeCompare(b.state));
}

function resourceSourceScreens(project: ErpProject, snapshotsFor: (identityKey: string) => readonly StoredSnapshot[], allProjects: readonly ErpProject[], now: number, currencies: AccountCurrencies | undefined, candidateSources: readonly StoredCharacterSummary[]): ErpResourceSourceScreen[] {
  const sameVersionCandidates = candidateSources.filter((character) => character.version === project.version);
  return project.needs.flatMap((need) => {
    const destinationIdentityKey = need.destinationIdentityKey;
    if (!destinationIdentityKey || (need.kind !== "ITEM_ID" && need.kind !== "ITEM_REF")) return [];
    const sources = sameVersionCandidates.filter((character) => character.identityKey !== destinationIdentityKey);
    let unresolvedCharacterCount = 0;
    const candidates: ErpResourceSourceCandidate[] = [];
    for (const character of sources) {
      const snapshots = snapshotsFor(character.identityKey);
      const candidateNeed: ErpResourceNeed = { ...need, sourceIdentityKey: character.identityKey, sourceOwnerKey: undefined };
      const rawEvidence = assessErpNeed(candidateNeed, snapshots, now, currencies, project.version);
      const evidence = applyReservationAssessment(candidateNeed, rawEvidence, allProjects, project.version);
      const latest = newest(snapshots);
      const locations = latest ? resourceSourceLocations(latest, candidateNeed) : [];
      const matchingItems = latest ? resourceSourceItems(latest, candidateNeed) : [];
      const currentComplete = locations.length === 2 && locations.every((location) => location.state === "OBSERVED" && location.quantity !== undefined);
      if (!currentComplete || evidence.freshness !== "recent" || evidence.state === "UNKNOWN") unresolvedCharacterCount++;
      const observedQuantity = evidence.observedQuantity;
      const potentialQuantity = evidence.potentialQuantity;
      if (!(observedQuantity !== undefined && observedQuantity > 0) && !(potentialQuantity !== undefined && potentialQuantity > 0)) continue;
      const provenance = observedQuantity !== undefined && observedQuantity > 0 ? "OBSERVED" as const : "LAST_SEEN" as const;
      candidates.push({
        sourceIdentityKey: character.identityKey, sourceName: character.name, ...(character.surname ? { sourceSurname: character.surname } : {}), sourceRealm: character.realm,
        needId: need.stableId, kind: need.kind, resourceKey: need.resourceKey, state: provenance,
        ...(observedQuantity !== undefined && observedQuantity > 0 ? { observedQuantity } : {}), ...(potentialQuantity !== undefined && potentialQuantity > 0 ? { potentialQuantity } : {}),
        activeReservationQuantity: evidence.reservationAssessment?.activeQuantity ?? 0, reservationState: evidence.reservationAssessment?.state ?? "UNKNOWN",
        ...(evidence.reservationAssessment?.availableObservedLowerBound !== undefined ? { availableObservedLowerBound: evidence.reservationAssessment.availableObservedLowerBound } : {}),
        freshness: evidence.freshness, ...(evidence.observedAt !== undefined ? { observedAt: evidence.observedAt } : {}), locations, matchingItems,
        unresolvedSections: evidence.unresolvedSections, accountMembership: "UNKNOWN", access: "UNKNOWN", transferability: "UNKNOWN",
        reason: `${provenance === "OBSERVED" ? "A matching quantity was observed" : "A matching quantity was recorded only in historical evidence"} on this same-version character. This source screen does not establish account membership, access, or a transfer route.${evidence.unresolvedSections.length ? ` Unresolved evidence: ${evidence.unresolvedSections.join(", ")}.` : ""}`,
      });
    }
    candidates.sort((a, b) => (a.state === b.state ? 0 : a.state === "OBSERVED" ? -1 : 1) || a.sourceRealm.localeCompare(b.sourceRealm) || a.sourceName.localeCompare(b.sourceName) || a.sourceIdentityKey.localeCompare(b.sourceIdentityKey));
    return [{ needId: need.stableId, destinationIdentityKey, scannedCharacterCount: sources.length, unresolvedCharacterCount, candidateCount: candidates.length, candidatesTruncated: candidates.length > ERP_RESOURCE_SOURCE_CANDIDATE_LIMIT, candidates: candidates.slice(0, ERP_RESOURCE_SOURCE_CANDIDATE_LIMIT) }];
  });
}

/** Read-time projection; recorded plans never mutate or claim observed inventory. */
export function evaluateErpProject(project: ErpProject, snapshotsFor: (identityKey: string) => readonly StoredSnapshot[], allProjects: readonly ErpProject[], now = Math.floor(Date.now() / 1000), currencies?: AccountCurrencies, sharedStorage?: SharedStorageProjection, candidateSources: readonly StoredCharacterSummary[] = []): Omit<ErpProjectView, "history" | "historyEventCount" | "historyTruncated"> {
  const needEvidence = project.needs.map((need) => {
    const raw = need.sourceOwnerKey ? assessSharedStorageNeed(need, sharedStorage, now) : assessErpNeed(need, need.sourceIdentityKey ? snapshotsFor(need.sourceIdentityKey) : [], now, currencies, project.version);
    return applyReservationAssessment(need, raw, allProjects, project.version);
  });
  const needEvidenceById = new Map(needEvidence.map((evidence) => [evidence.needId, evidence]));
  const workOrderReadiness: ErpWorkOrderReadiness[] = project.workOrders.map((order) => {
    const capabilityChecks: ErpCraftingCapabilityCheck[] = order.kind === "CRAFT" ? order.resourceNeedIds.flatMap<ErpCraftingCapabilityCheck>((needId): ErpCraftingCapabilityCheck[] => {
      const need = project.needs.find((entry) => entry.stableId === needId);
      if (!need || (need.kind !== "PROFESSION" && need.kind !== "RECIPE")) return [];
      const evidence = needEvidenceById.get(needId);
      const context = need.kind === "RECIPE" ? `Exact recipe ${need.resourceKey}` : `Exact profession “${need.resourceKey}” at skill ${need.requiredQuantity}`;
      if (!order.assignedIdentityKey) return [{ needId, kind: need.kind, state: "ASSIGNED_CHARACTER_MISSING", evidenceSourceIdentityKey: need.sourceIdentityKey, reason: `${context} cannot be screened against a crafter until a character is assigned.` }];
      if (!need.sourceIdentityKey) return [{ needId, kind: need.kind, state: "SOURCE_NOT_SELECTED", assignedIdentityKey: order.assignedIdentityKey, reason: `${context} has no character-specific evidence source; other roster observations are not substituted.` }];
      if (need.sourceIdentityKey !== order.assignedIdentityKey) return [{ needId, kind: need.kind, state: "SOURCE_DIFFERS_FROM_ASSIGNEE", assignedIdentityKey: order.assignedIdentityKey, evidenceSourceIdentityKey: need.sourceIdentityKey, reason: `${context} was observed for a different character than the assigned crafter; character capabilities are not shared across the roster.` }];
      if (!evidence || evidence.freshness !== "recent") return [{ needId, kind: need.kind, state: "EVIDENCE_UNKNOWN", assignedIdentityKey: order.assignedIdentityKey, evidenceSourceIdentityKey: need.sourceIdentityKey, reason: `${context} evidence is missing, historical, stale, or has unknown freshness for the assigned character.` }];
      if (evidence.state === "COVERED_BY_OBSERVED") return [{ needId, kind: need.kind, state: "SUPPORTED_FOR_ASSIGNEE", assignedIdentityKey: order.assignedIdentityKey, evidenceSourceIdentityKey: need.sourceIdentityKey, reason: `${context} is directly observed recently for the assigned character. This supports only the recorded skill/learned fact, not unlocks or craftability.` }];
      if (evidence.state === "SHORTFALL_OBSERVED") return [{ needId, kind: need.kind, state: "REQUIREMENT_NOT_MET", assignedIdentityKey: order.assignedIdentityKey, evidenceSourceIdentityKey: need.sourceIdentityKey, reason: `Current evidence does not meet ${context} for the assigned character.` }];
      return [{ needId, kind: need.kind, state: "EVIDENCE_UNKNOWN", assignedIdentityKey: order.assignedIdentityKey, evidenceSourceIdentityKey: need.sourceIdentityKey, reason: evidence.reason }];
    }) : [];
    const base = { workOrderId: order.stableId, blockingWorkOrderIds: [] as string[], unresolvedNeedIds: [] as string[], actionTargetNeedIds: [] as string[], changedNeedIds: [] as string[], ...(capabilityChecks.length ? { capabilityChecks } : {}) };
    const linkedEvidence = order.resourceNeedIds.map((needId) => needEvidenceById.get(needId)!).filter(Boolean);
    const staleOrUnknown = linkedEvidence.filter((evidence) => evidence.state !== "COVERED_BY_OBSERVED" || evidence.freshness === "stale" || evidence.freshness === "unknown");
    const changedNeedEvidence = linkedEvidence.filter((evidence) => evidence.observationChange?.comparisons.some((comparison) => comparison.delta !== 0));
    if (order.status === "CANCELLED") return { ...base, state: "TERMINAL", reason: "This work order is cancelled in the saved plan; cancellation is not an in-game action." };
    if (order.status === "COMPLETED") {
      if (changedNeedEvidence.length && changedNeedEvidence.every((evidence) => evidence.freshness !== "stale" && evidence.freshness !== "unknown")) {
        const unresolvedNeedIds = staleOrUnknown.map((evidence) => evidence.needId);
        return { ...base, state: "OBSERVATION_CHANGED_REQUIRES_REVIEW", changedNeedIds: changedNeedEvidence.map((evidence) => evidence.needId), unresolvedNeedIds, reason: `This work order is marked complete by the player, and a current comparable observation changed for linked needs: ${changedNeedEvidence.map((evidence) => evidence.needId).join(", ")}. Review the outcome; the change does not prove this work order caused it or independently verify completion.${unresolvedNeedIds.length ? ` Linked evidence also remains unknown, historical, incomplete, or stale for: ${unresolvedNeedIds.join(", ")}.` : ""}` };
      }
      return { ...base, state: "TERMINAL", unresolvedNeedIds: staleOrUnknown.map((evidence) => evidence.needId), reason: `This work order is marked complete by the player in the saved plan. Its note is not automatic game verification${staleOrUnknown.length ? `; current linked evidence remains unknown, historical, incomplete, or stale for ${staleOrUnknown.map((evidence) => evidence.needId).join(", ")}` : ""}.` };
    }
    if (project.status !== "ACTIVE") return { ...base, state: "PROJECT_NOT_ACTIVE", reason: `The project is ${project.status}; no next action is presented until the player resumes an active project.` };
    const blockingWorkOrderIds = order.dependsOn.filter((dependencyId) => project.workOrders.find((candidate) => candidate.stableId === dependencyId)?.status !== "COMPLETED");
    if (blockingWorkOrderIds.length) return { ...base, state: "BLOCKED_BY_DEPENDENCY", blockingWorkOrderIds, reason: `Complete and record these prerequisite work orders first: ${blockingWorkOrderIds.join(", ")}. A cancelled prerequisite does not satisfy a dependency.` };
    const unmetCapabilities = capabilityChecks.filter((check) => check.state === "REQUIREMENT_NOT_MET");
    if (unmetCapabilities.length) return { ...base, state: "OBSERVED_RESOURCE_SHORTFALL", unresolvedNeedIds: unmetCapabilities.map((check) => check.needId), reason: `${unmetCapabilities.map((check) => check.reason).join(" ")} This is a character capability shortfall, not a substitute crafter recommendation.` };
    const unresolvedCapabilities = capabilityChecks.filter((check) => check.state !== "SUPPORTED_FOR_ASSIGNEE");
    if (unresolvedCapabilities.length) return { ...base, state: "WAITING_FOR_EVIDENCE", unresolvedNeedIds: unresolvedCapabilities.map((check) => check.needId), reason: `Crafting capability evidence is not matched to the assigned character: ${unresolvedCapabilities.map((check) => check.reason).join(" ")}` };
    const observedShortfalls = staleOrUnknown.filter((evidence) => evidence.state === "SHORTFALL_OBSERVED" && evidence.freshness === "recent");
    const manualSupplyTargets = observedShortfalls.filter((evidence) => {
      const need = project.needs.find((candidate) => candidate.stableId === evidence.needId);
      return need && (need.kind === "ITEM_ID" || need.kind === "ITEM_REF") && (order.kind === "GATHER" || order.kind === "PURCHASE");
    });
    const nonActionShortfalls = observedShortfalls.filter((evidence) => !manualSupplyTargets.includes(evidence));
    if (nonActionShortfalls.length) return { ...base, state: "OBSERVED_RESOURCE_SHORTFALL", unresolvedNeedIds: nonActionShortfalls.map((evidence) => evidence.needId), reason: `A current observation records a shortfall for ${nonActionShortfalls.map((evidence) => evidence.needId).join(", ")}. Review the source and replan before acting.` };
    const waiting = staleOrUnknown.filter((evidence) => evidence.state !== "SHORTFALL_OBSERVED" || evidence.freshness !== "recent");
    if (waiting.length) return { ...base, state: "WAITING_FOR_EVIDENCE", unresolvedNeedIds: waiting.map((evidence) => evidence.needId), reason: `Required plan evidence is unknown, historical, incomplete, or stale for: ${waiting.map((evidence) => evidence.needId).join(", ")}. Refresh observations or resolve the missing evidence before treating this step as ready.` };
    const reservationConflicts = workOrderAllocationConflicts(project, linkedEvidence, allProjects);
    if (reservationConflicts.length) return { ...base, state: "RESOURCE_ALLOCATION_REQUIRES_REVIEW", unresolvedNeedIds: reservationConflicts, reason: `The combined linked needs, ambiguous overlapping item scopes, or active saved reservations cannot be supported by independent observed supply for: ${reservationConflicts.join(", ")}. Reservations record player intent; they do not lock or prove possession of resources. Reconcile the quantities and item scopes before treating this work order as ready; no resource was moved or consumed.` };
    if (manualSupplyTargets.length) return { ...base, state: "MANUAL_SUPPLY_STEP_RECOMMENDED", actionTargetNeedIds: manualSupplyTargets.map((evidence) => evidence.needId), reason: `Current complete source evidence is below the planned quantity for ${manualSupplyTargets.map((evidence) => evidence.needId).join(", ")}. This saved ${order.kind.toLowerCase()} step is a player-reviewed option for addressing that gap; the system does not establish a gathering route, purchase availability, price, or action completion, and executes nothing.` };
    if (changedNeedEvidence.length) return { ...base, state: "OBSERVATION_CHANGED_REQUIRES_REVIEW", changedNeedIds: changedNeedEvidence.map((evidence) => evidence.needId), reason: `A comparable observation changed for linked needs: ${changedNeedEvidence.map((evidence) => evidence.needId).join(", ")}. Review the new amounts; a change alone does not establish that this work order caused it or that the planned step is complete.` };
    const actionLimit = order.kind === "TRANSFER" ? " An observed source location does not establish access or a transfer route." : order.kind === "EQUIP" ? " These resource checks do not establish equip eligibility or upgrade value." : order.kind === "CRAFT" ? " Learned recipe state and listed materials do not establish current skill, unlocks, or craftability." : " This is not an execution command or proof that all game prerequisites are met.";
    return { ...base, state: "READY_FOR_PLAYER_REVIEW", reason: `No incomplete plan dependency or linked resource-evidence blocker is recorded.${actionLimit}` };
  });
  const workOrderProgress: ErpWorkOrderProgress[] = project.workOrders.map((order) => {
    const linked = order.resourceNeedIds.map((needId) => needEvidenceById.get(needId)!).filter(Boolean);
    const allocationConflictNeedIds = workOrderAllocationConflicts(project, linked, allProjects);
    const current = linked.filter((evidence) => evidence.freshness === "recent");
    const coveredNeedIds = current.filter((evidence) => evidence.state === "COVERED_BY_OBSERVED").map((evidence) => evidence.needId);
    const shortfallNeedIds = current.filter((evidence) => evidence.state === "SHORTFALL_OBSERVED").map((evidence) => evidence.needId);
    const unresolvedNeedIds = linked.filter((evidence) => evidence.freshness !== "recent" || (evidence.state !== "COVERED_BY_OBSERVED" && evidence.state !== "SHORTFALL_OBSERVED")).map((evidence) => evidence.needId);
    const changedNeedIds = linked.filter((evidence) => evidence.observationChange?.state === "CHANGED").map((evidence) => evidence.needId);
    const comparedNeedIds = linked.filter((evidence) => evidence.observationChange?.state === "UNCHANGED").map((evidence) => evidence.needId);
    const observationChange: ErpWorkOrderProgress["observationChange"] = changedNeedIds.length ? "CHANGED" : linked.length > 0 && comparedNeedIds.length === linked.length ? "UNCHANGED" : "UNKNOWN";
    const linkedNeedState: ErpWorkOrderProgress["linkedNeedState"] = !linked.length ? "NO_LINKED_NEEDS"
      : unresolvedNeedIds.length ? "STALE_OR_UNKNOWN"
      : coveredNeedIds.length && shortfallNeedIds.length ? "MIXED_CURRENT_EVIDENCE"
      : shortfallNeedIds.length ? "CURRENT_SHORTFALL"
      : allocationConflictNeedIds.length ? "RESOURCE_ALLOCATION_REQUIRES_REVIEW"
      : "ALL_CURRENTLY_MET";
    let reconciliation: ErpWorkOrderProgress["reconciliation"];
    if (order.status === "COMPLETED" && shortfallNeedIds.length) reconciliation = "COMPLETION_CONFLICTS_WITH_LINKED_SHORTFALL";
    else if (order.status === "COMPLETED") reconciliation = "PLAYER_RECORDED_COMPLETE";
    else if (!linked.length) reconciliation = "NO_LINKED_NEEDS";
    else if (linkedNeedState === "MIXED_CURRENT_EVIDENCE") reconciliation = "MIXED_LINKED_EVIDENCE";
    else if (linkedNeedState === "STALE_OR_UNKNOWN") reconciliation = "INSUFFICIENT_EVIDENCE";
    else if (linkedNeedState === "CURRENT_SHORTFALL") reconciliation = "CURRENT_LINKED_NEEDS_UNMET";
    else if (allocationConflictNeedIds.length) reconciliation = "RESOURCE_ALLOCATION_REQUIRES_REVIEW";
    else if (observationChange === "CHANGED") reconciliation = "OBSERVATION_CHANGED_CAUSE_UNKNOWN";
    else if (linkedNeedState === "ALL_CURRENTLY_MET") reconciliation = "CURRENT_LINKED_NEEDS_MET";
    else reconciliation = "INSUFFICIENT_EVIDENCE";
    const reason = reconciliation === "PLAYER_RECORDED_COMPLETE"
      ? "The player marked this work order complete in the saved plan. Linked resource evidence is reported separately and does not verify which action occurred."
      : reconciliation === "COMPLETION_CONFLICTS_WITH_LINKED_SHORTFALL"
        ? `The player marked this work order complete, but current linked needs still show a shortfall: ${shortfallNeedIds.join(", ")}. Review these records; this does not prove the task failed or identify the cause.`
        : reconciliation === "CURRENT_LINKED_NEEDS_MET"
          ? `Current linked resource requirements are covered by recent observations: ${coveredNeedIds.join(", ")}. This establishes current resource state only, not completion or the action that produced it.`
          : reconciliation === "CURRENT_LINKED_NEEDS_UNMET"
            ? `Recent linked observations show resource shortfalls: ${shortfallNeedIds.join(", ")}. Review the plan; no missing or unobserved quantity is treated as zero.`
            : reconciliation === "MIXED_LINKED_EVIDENCE"
              ? `Recent linked observations are mixed: covered needs ${coveredNeedIds.join(", ")}; shortfall needs ${shortfallNeedIds.join(", ")}. No single completion conclusion is supported.`
              : reconciliation === "OBSERVATION_CHANGED_CAUSE_UNKNOWN"
                ? `Comparable linked resource observations changed for ${changedNeedIds.join(", ")}. The export does not establish whether this work order caused the change or whether its action occurred.`
                  : reconciliation === "NO_LINKED_NEEDS"
                    ? "No resource requirements are linked to this work order, so import evidence cannot assess its outcome."
      : reconciliation === "RESOURCE_ALLOCATION_REQUIRES_REVIEW"
        ? `Recent covered linked needs share or ambiguously identify observed source quantities for: ${allocationConflictNeedIds.join(", ")}. Their combined independent availability is not established. Reservations record player intent; they do not lock inventory or prove possession.`
        : `Linked resource evidence is stale, incomplete, unsupported, or unknown for: ${unresolvedNeedIds.join(", ")}. Refresh or clarify evidence before drawing an outcome.`;
    const transferReviews = transferObservationReviews(project, order, snapshotsFor, now, currencies);
    return { workOrderId: order.stableId, recordedStatus: order.status, completionRecorded: order.status === "COMPLETED", linkedNeedState, observationChange, reconciliation, coveredNeedIds, shortfallNeedIds, unresolvedNeedIds, allocationConflictNeedIds, changedNeedIds, ...(transferReviews.length ? { transferObservationReviews: transferReviews } : {}), reason };
  });
  const reservationReview: Array<ErpProjectView["reservationReview"][number]> = [];
  for (const reservation of project.reservations.filter((r) => r.status === "ACTIVE")) {
    const ownNeed = project.needs.find((n) => n.stableId === reservation.needId)!;
    const reservationScope = sourceScope(reservation);
    if (!reservationScope) continue;
    const reservations = overlappingReservations(ownNeed, reservationScope, project.version, allProjects);
    const totalReserved = reservations.reduce((sum, entry) => sum + entry.quantity, 0);
    const ambiguousItemScope = reservations.some((entry) => entry.ambiguous);
    const supply = reservation.sourceOwnerKey ? assessSharedStorageNeed(ownNeed, sharedStorage, now) : assessErpNeed(ownNeed, reservation.sourceIdentityKey ? snapshotsFor(reservation.sourceIdentityKey) : [], now, currencies, project.version);
    const state = ownNeed.kind === "PROFESSION" || ownNeed.kind === "RECIPE" || supply.observedQuantity === undefined || ambiguousItemScope || (totalReserved > supply.observedQuantity && supply.unresolvedSections.length > 0)
      ? "SUPPLY_UNKNOWN"
      : totalReserved <= supply.observedQuantity ? "WITHIN_OBSERVED_SUPPLY" : "EXCEEDS_OBSERVED_SUPPLY";
    reservationReview.push({ reservationId: reservation.stableId, state, reservedQuantity: totalReserved, ...(supply.observedQuantity !== undefined ? { observedQuantity: supply.observedQuantity } : {}), reason: ambiguousItemScope ? `Reservations for base item ${needItemId(ownNeed)} and exact item variants overlap, but their quantities cannot be reconciled safely.` : state === "WITHIN_OBSERVED_SUPPLY" ? `Explicit reservations total ${totalReserved}; the selected source has ${supply.observedQuantity} observed at ${supply.freshness} freshness. Intent does not establish access or transferability.` : state === "EXCEEDS_OBSERVED_SUPPLY" ? `Reservations total ${totalReserved}, exceeding ${supply.observedQuantity} observed. Replanning is needed; no inventory is changed.` : `Supply for ${ownNeed.label} at the selected source is UNKNOWN; the reservation is intent, not possession.` });
  }
  return { ...project, needEvidence, resourceSourceScreens: resourceSourceScreens(project, snapshotsFor, allProjects, now, currencies, candidateSources), workOrderReadiness, workOrderProgress, reservationReview };
}
