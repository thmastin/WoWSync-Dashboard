import { useEffect, useState } from "react";
import type { ErpNeedEvidence, ErpProject, ErpProjectStatus, ErpResourceCommitmentLine, ErpResourceNeed, ErpResourceSourceCandidate, ErpResourceSourceScreen, ErpSourceFulfillmentReview, ErpWorkOrder } from "@wowsync-dashboard/core";
import { buildErpNeedReviewSnapshot } from "@wowsync-dashboard/core/erpFulfillmentTriage.ts";
import { appendErpProvisioningReviewBatch, appendErpWorkOrderBatch, createErpProject, fetchErpProjects, fetchSharedStorage, setErpProjectStatus, updateErpProject, type ErpWorkOrderBatchTaskDraft } from "../api.ts";
import { ErpProjectHistory } from "./ErpProjectHistory.tsx";
import { ErpWorkOrderReadinessLine } from "./ErpWorkOrderReadinessLine.tsx";
import { ErpWorkOrderProgressLine } from "./ErpWorkOrderProgressLine.tsx";
import { ErpWorkOrderActions } from "./ErpWorkOrderActions.tsx";
import { buildErpWorkOrderQueue, type ErpQueueFilter } from "./erpWorkOrderQueue.ts";
import { buildFulfillmentReviewWorkOrder } from "./erpFulfillmentReview.ts";
import { ErpMultiNeedWorkOrderComposer } from "./ErpMultiNeedWorkOrderComposer.tsx";
import { ErpMultiNeedResourceComposer } from "./ErpMultiNeedResourceComposer.tsx";
import { ErpObservationChangeQueue } from "./ErpObservationChangeQueue.tsx";
import { buildMultiNeedWorkOrders, type MultiNeedWorkOrderDraft } from "./erpMultiNeedWorkOrders.ts";
import { buildMultiNeedResourceNeeds, type MultiNeedResourceDraft } from "./erpMultiNeedResourceNeeds.ts";
import { erpNeedAnchorId } from "./erpObservationChangeQueue.ts";
import { findErpUnworkedNeeds } from "./erpUnworkedNeeds.ts";
import { ErpPortfolioNextActionPanel } from "./ErpPortfolioNextActionPanel.tsx";
import { ErpPortfolioFulfillmentPanel } from "./ErpPortfolioFulfillmentPanel.tsx";
import { ErpProcurementBudgetPanel } from "./ErpProcurementBudgetPanel.tsx";
import { ErpProcurementBuyerPanel } from "./ErpProcurementBuyerPanel.tsx";
import { ErpReservationReplanPanel } from "./ErpReservationReplanPanel.tsx";
import { ErpCrossProjectWorkOrderComposer } from "./ErpCrossProjectWorkOrderComposer.tsx";
import { erpWorkOrderAnchorId } from "./erpObservationChangeQueue.ts";
import { isValidAdjustedReservationQuantity, maxAdjustedReservationQuantity } from "./erpReservationAdjustment.ts";
import { useAsync } from "../useAsync.ts";
import type { CharacterFacts, VersionOrUnknown } from "../types.ts";

type Version = Exclude<VersionOrUnknown, "unknown-version">;
const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const when = (seconds?: number) => seconds ? new Date(seconds * 1000).toLocaleString() : "time unavailable";
function formatStorageLocations(evidence: ErpNeedEvidence | undefined): string | undefined {
  const sections = evidence?.sourceSections.filter((section) => section.section === "bags" || section.section === "character bank") ?? [];
  if (!sections.length) return undefined;
  return sections.map((section) => {
    const quantity = section.matchingQuantity !== undefined ? `${section.matchingQuantity} matching ${section.matchingQuantity === 1 ? "unit" : "units"}`
      : section.matchingPotentialQuantity !== undefined ? `${section.matchingPotentialQuantity} matching ${section.matchingPotentialQuantity === 1 ? "unit" : "units"} LAST_SEEN`
        : section.state === "UNKNOWN" ? "contents UNKNOWN" : "matching quantity UNKNOWN";
    return `${section.section}: ${section.state} · ${quantity} · seen ${when(section.observedAt)}`;
  }).join("; ");
}
const stateText: Record<string, string> = {
  COVERED_BY_OBSERVED: "Covered by observed supply", SHORTFALL_OBSERVED: "Observed shortfall",
  POTENTIAL_COVERAGE_LAST_SEEN: "Possible supply is historical", UNKNOWN: "Supply unknown",
  UNSUPPORTED_EVIDENCE: "Evidence not available for this resource type",
  WITHIN_OBSERVED_SUPPLY: "Reservations fit observed supply", EXCEEDS_OBSERVED_SUPPLY: "Reservations exceed observed supply",
  SUPPLY_UNKNOWN: "Reservation supply unknown",
};
const recipeStateText: Record<string, string> = {
  ...stateText,
  COVERED_BY_OBSERVED: "Recipe learned (observed)",
  SHORTFALL_OBSERVED: "Recipe not learned (observed)",
  POTENTIAL_COVERAGE_LAST_SEEN: "Recipe learned in historical evidence",
};

export default function ErpProjectsWorkbench({ version, refreshTick, characters, onRefresh }: { version: VersionOrUnknown; refreshTick: number; characters: CharacterFacts[]; onRefresh: () => void }) {
  const load = useAsync((signal) => version === "unknown-version" ? Promise.resolve(undefined) : fetchErpProjects(version, signal), version, refreshTick);
  const sharedLoad = useAsync((signal) => version === "retail" ? fetchSharedStorage(signal) : Promise.resolve(undefined), version, refreshTick);
  const [title, setTitle] = useState(""); const [objective, setObjective] = useState(""); const [priority, setPriority] = useState("3");
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [queueFilter, setQueueFilter] = useState<ErpQueueFilter>("ATTENTION"); const [queueQuery, setQueueQuery] = useState("");
  const [pendingQuoteFocus, setPendingQuoteFocus] = useState<{ projectId: string; workOrderId: string } | null>(null);
  const [portfolioPrefill, setPortfolioPrefill] = useState<{ projectId: string; needId: string; pathwayKind: import("@wowsync-dashboard/core").ErpNeedFulfillmentOptionKind } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [batchProjectId, setBatchProjectId] = useState<string | null>(null);
  const [multiOrderProjectId, setMultiOrderProjectId] = useState<string | null>(null);
  const [needBundleProjectId, setNeedBundleProjectId] = useState<string | null>(null);
  const [batchNeedIds, setBatchNeedIds] = useState<string[]>([]);
  const [batchAssigned, setBatchAssigned] = useState("");
  const [batchDependencyIds, setBatchDependencyIds] = useState<string[]>([]);
  const [prefilledNeedId, setPrefilledNeedId] = useState<string | null>(null);
  const [needKind, setNeedKind] = useState<ErpResourceNeed["kind"]>("ITEM_REF"); const [resourceKey, setResourceKey] = useState("");
  const [needLabel, setNeedLabel] = useState(""); const [quantity, setQuantity] = useState("1"); const [source, setSource] = useState(""); const [destination, setDestination] = useState("");
  const [orderTitle, setOrderTitle] = useState(""); const [orderInstructions, setOrderInstructions] = useState(""); const [orderKind, setOrderKind] = useState<ErpWorkOrder["kind"]>("INVESTIGATE"); const [assigned, setAssigned] = useState(""); const [orderSource, setOrderSource] = useState(""); const [orderDestination, setOrderDestination] = useState(""); const [outputKind, setOutputKind] = useState<"ITEM_REF" | "ITEM_ID">("ITEM_REF"); const [outputKey, setOutputKey] = useState(""); const [outputLabel, setOutputLabel] = useState(""); const [outputQuantity, setOutputQuantity] = useState("1");
  const [orderNeedIds, setOrderNeedIds] = useState<string[]>([]); const [orderDependencyIds, setOrderDependencyIds] = useState<string[]>([]); const [outputObservationIdentityKey, setOutputObservationIdentityKey] = useState(""); const [purchaseTargetNeedId, setPurchaseTargetNeedId] = useState(""); const [purchaseCeilingCopper, setPurchaseCeilingCopper] = useState(""); const [purchaseBudgetNeedId, setPurchaseBudgetNeedId] = useState("");
  const usableVersion = version !== "unknown-version";
  useEffect(() => {
    if (!pendingQuoteFocus || queueFilter !== "ALL_OPEN" || queueQuery !== "") return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`erp-queue-quote-${encodeURIComponent(pendingQuoteFocus.projectId)}-${encodeURIComponent(pendingQuoteFocus.workOrderId)}`);
      target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
      target?.focus({ preventScroll: true });
      setPendingQuoteFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingQuoteFocus, queueFilter, queueQuery]);
  const chars = characters.filter((c) => c.identityKey.startsWith(`${version}::`));
  const name = (key?: string) => key ? (() => { const c = chars.find((x) => x.identityKey === key); return c ? `${c.name}${c.surname ? ` ${c.surname}` : ""} — ${c.realm}` : "Unresolved character"; })() : "Not assigned";
  const sharedOwners = [sharedLoad.state.data?.warband, ...(sharedLoad.state.data?.guilds ?? [])].filter((owner): owner is NonNullable<typeof owner> => owner !== null && owner !== undefined);
  const storageOwnerName = (ownerKey: string) => {
    const owner = sharedOwners.find((entry) => entry.owner.ownerKey === ownerKey);
    if (!owner) return `Shared owner ${ownerKey} (not currently observed)`;
    return owner.owner.kind === "guild" ? `Guild ${owner.owner.guildName ?? owner.owner.guildClubId}` : "Retail Warband (installation-local)";
  };
  const sourceName = (need: ErpResourceNeed) => need.sourceOwnerKey ? storageOwnerName(need.sourceOwnerKey) : name(need.sourceIdentityKey);

  async function run(action: () => Promise<unknown>) { setBusy(true); setError(""); setNotice(""); try { await action(); onRefresh(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save the project."); } finally { setBusy(false); } }
  function clearPrefilledManualSupply() {
    setPrefilledNeedId(null);
    setEditingOrderId(null); setOrderKind("INVESTIGATE"); setOrderTitle(""); setOrderInstructions(""); setAssigned(""); setOrderSource(""); setOrderDestination(""); setOrderNeedIds([]); setOrderDependencyIds([]); setOutputKey(""); setOutputLabel(""); setOutputQuantity("1"); setOutputObservationIdentityKey(""); setPurchaseTargetNeedId(""); setPurchaseCeilingCopper(""); setPurchaseBudgetNeedId("");
  }
  function toggleProjectForms(projectId: string) {
    clearPrefilledManualSupply();
    setEditing((current) => current === projectId ? null : projectId);
  }
  async function create(e: React.FormEvent) {
    e.preventDefault(); if (!usableVersion || !title.trim()) return;
    await run(async () => { await createErpProject(version, { title: title.trim(), objective: objective.trim() || undefined, priority: Number(priority) }); setTitle(""); setObjective(""); });
  }
  async function mutate(project: import("@wowsync-dashboard/core").ErpProjectView, patch: Partial<ErpProject>) {
    await run(() => updateErpProject({ ...project, ...patch, updatedAt: Math.floor(Date.now() / 1000) }));
  }
  function unworkedReviewNeeds(project: import("@wowsync-dashboard/core").ErpProjectView) {
    return project.needs.filter((need) => {
      const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
      const hasOpenOrder = project.workOrders.some((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(need.stableId));
      return !hasOpenOrder && evidence?.state !== "COVERED_BY_OBSERVED";
    });
  }
  async function createFulfillmentReview(project: import("@wowsync-dashboard/core").ErpProjectView) {
    try {
      const order = buildFulfillmentReviewWorkOrder(project, { stableId: id(), needIds: batchNeedIds, recordedAt: Math.floor(Date.now() / 1000), ...(batchAssigned ? { assignedIdentityKey: batchAssigned } : {}), dependsOn: batchDependencyIds });
      await mutate(project, { workOrders: [...project.workOrders, order] });
      setBatchNeedIds([]); setBatchDependencyIds([]); setBatchAssigned(""); setBatchProjectId(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the grouped fulfillment review."); }
  }
  async function createChangedObservationReview(project: import("@wowsync-dashboard/core").ErpProjectView, needIds: readonly string[]): Promise<boolean> {
    setBusy(true); setError("");
    try {
      const order = buildFulfillmentReviewWorkOrder(project, { stableId: id(), needIds, recordedAt: Math.floor(Date.now() / 1000), requireChangedEvidence: true });
      await updateErpProject({ ...project, workOrders: [...project.workOrders, order], updatedAt: Math.floor(Date.now() / 1000) });
      onRefresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the changed-observation review.");
      return false;
    } finally { setBusy(false); }
  }
  async function createMultiNeedPlan(project: import("@wowsync-dashboard/core").ErpProjectView, drafts: readonly MultiNeedWorkOrderDraft[]) {
    setBusy(true); setError("");
    try {
      const orders = buildMultiNeedWorkOrders(project, drafts, id);
      await updateErpProject({ ...project, workOrders: [...project.workOrders, ...orders], updatedAt: Math.floor(Date.now() / 1000) });
      setMultiOrderProjectId(null); onRefresh();
    } catch (cause) { throw cause; }
    finally { setBusy(false); }
  }
  async function addMultiNeedRequirements(project: import("@wowsync-dashboard/core").ErpProjectView, drafts: readonly MultiNeedResourceDraft[]) {
    setBusy(true); setError("");
    try {
      const needs = buildMultiNeedResourceNeeds(project, drafts, id);
      await updateErpProject({ ...project, needs: [...project.needs, ...needs], updatedAt: Math.floor(Date.now() / 1000) });
      setNeedBundleProjectId(null); onRefresh();
    } catch (cause) { throw cause; }
    finally { setBusy(false); }
  }
  async function addNeed(e: React.FormEvent, project: import("@wowsync-dashboard/core").ErpProjectView) {
    e.preventDefault(); const q = Number(quantity); if ((needKind !== "GOLD_COPPER" && !resourceKey.trim()) || !needLabel.trim() || !Number.isSafeInteger(q) || q < 1) return;
    const sourceFields = source.startsWith("owner::") ? { sourceOwnerKey: source.slice("owner::".length) } : source ? { sourceIdentityKey: source } : {};
    const need: ErpResourceNeed = { stableId: id(), kind: needKind, resourceKey: needKind === "GOLD_COPPER" ? "copper" : resourceKey.trim(), label: needLabel.trim(), requiredQuantity: needKind === "RECIPE" ? 1 : q, ...sourceFields, ...(destination ? { destinationIdentityKey: destination } : {}) };
    await mutate(project, { needs: [...project.needs, need] }); setResourceKey(""); setNeedLabel(""); setQuantity("1");
  }
  async function addOrder(e: React.FormEvent, project: import("@wowsync-dashboard/core").ErpProjectView) {
    e.preventDefault(); if (!orderTitle.trim()) return;
    const outputRequested = orderKind === "CRAFT" && (outputKey.trim().length > 0 || outputLabel.trim().length > 0);
    const quantity = Number(outputQuantity);
    if (outputRequested && (!outputKey.trim() || !outputLabel.trim() || !Number.isSafeInteger(quantity) || quantity < 1)) { setError("A planned craft output needs an item key, label, and positive whole quantity."); return; }
    const plannedOutput = outputRequested ? { kind: outputKind, resourceKey: outputKey.trim(), label: outputLabel.trim(), quantity } : undefined;
    const procurementRequested = orderKind === "PURCHASE" && Boolean(purchaseTargetNeedId || purchaseCeilingCopper || purchaseBudgetNeedId);
    const ceiling = Number(purchaseCeilingCopper);
    if (procurementRequested && (!purchaseTargetNeedId || !assigned || !Number.isSafeInteger(ceiling) || ceiling < 1)) { setError("Procurement review requires an item target, an assigned buyer, and a positive whole-copper spending ceiling."); return; }
    const budgetNeed = purchaseBudgetNeedId ? project.needs.find((need) => need.stableId === purchaseBudgetNeedId) : undefined;
    if (purchaseBudgetNeedId && (!budgetNeed || budgetNeed.kind !== "GOLD_COPPER" || budgetNeed.sourceIdentityKey !== assigned || budgetNeed.destinationIdentityKey !== assigned)) { setError("A procurement budget link must be a GOLD_COPPER need explicitly sourced from and intended for the assigned buyer."); return; }
    const procurementPlan = procurementRequested ? { targetNeedId: purchaseTargetNeedId, spendingCeilingCopper: ceiling, ...(budgetNeed ? { budgetNeedId: budgetNeed.stableId } : {}) } : undefined;
    const resourceNeedIds = [...new Set([...orderNeedIds, ...(procurementPlan ? [procurementPlan.targetNeedId, ...(procurementPlan.budgetNeedId ? [procurementPlan.budgetNeedId] : [])] : [])])];
    const existing = editingOrderId ? project.workOrders.find((entry) => entry.stableId === editingOrderId) : undefined;
    const preserveQuote = procurementPlan && existing?.procurementPlan?.targetNeedId === procurementPlan.targetNeedId;
    const order: ErpWorkOrder = { stableId: existing?.stableId ?? id(), kind: orderKind, status: existing?.status ?? "PLANNED", title: orderTitle.trim(), resourceNeedIds, dependsOn: orderDependencyIds, ...(existing?.completionNote ? { completionNote: existing.completionNote } : {}), ...(plannedOutput ? { plannedOutput } : {}), ...(plannedOutput && outputObservationIdentityKey ? { outputObservationIdentityKey } : {}), ...(procurementPlan ? { procurementPlan: { ...procurementPlan, ...(preserveQuote && existing.procurementPlan?.playerQuote ? { playerQuote: existing.procurementPlan.playerQuote } : {}) } } : {}), ...(orderInstructions.trim() ? { instructions: orderInstructions.trim() } : {}), ...(assigned ? { assignedIdentityKey: assigned } : {}), ...(orderSource ? { sourceIdentityKey: orderSource } : {}), ...(orderDestination ? { destinationIdentityKey: orderDestination } : {}), ...(orderKind === "INVESTIGATE" && existing?.investigationSourceLeadIdentityKey ? { investigationSourceLeadIdentityKey: existing.investigationSourceLeadIdentityKey } : {}) };
    await mutate(project, { workOrders: existing ? project.workOrders.map((entry) => entry.stableId === existing.stableId ? order : entry) : [...project.workOrders, order] }); setOrderTitle(""); setOrderInstructions(""); setAssigned(""); setOrderSource(""); setOrderDestination(""); setOrderNeedIds([]); setOrderDependencyIds([]); setOutputKey(""); setOutputLabel(""); setOutputQuantity("1"); setOutputObservationIdentityKey(""); setPurchaseTargetNeedId(""); setPurchaseCeilingCopper(""); setPurchaseBudgetNeedId(""); setPrefilledNeedId(null); setEditingOrderId(null);
  }
  function editOrder(project: import("@wowsync-dashboard/core").ErpProjectView, order: ErpWorkOrder) {
    clearPrefilledManualSupply(); setEditing(project.stableId); setEditingOrderId(order.stableId); setOrderKind(order.kind); setOrderTitle(order.title); setOrderInstructions(order.instructions ?? ""); setAssigned(order.assignedIdentityKey ?? ""); setOrderSource(order.sourceIdentityKey ?? ""); setOrderDestination(order.destinationIdentityKey ?? ""); setOrderNeedIds(order.resourceNeedIds.filter((needId) => needId !== order.procurementPlan?.targetNeedId && needId !== order.procurementPlan?.budgetNeedId)); setOrderDependencyIds([...order.dependsOn]); setOutputKind(order.plannedOutput?.kind ?? "ITEM_REF"); setOutputKey(order.plannedOutput?.resourceKey ?? ""); setOutputLabel(order.plannedOutput?.label ?? ""); setOutputQuantity(String(order.plannedOutput?.quantity ?? 1)); setOutputObservationIdentityKey(order.outputObservationIdentityKey ?? ""); setPurchaseTargetNeedId(order.procurementPlan?.targetNeedId ?? ""); setPurchaseCeilingCopper(order.procurementPlan ? String(order.procurementPlan.spendingCeilingCopper) : ""); setPurchaseBudgetNeedId(order.procurementPlan?.budgetNeedId ?? "");
  }
  function prefillManualSupply(project: import("@wowsync-dashboard/core").ErpProjectView, need: ErpResourceNeed, kind: "GATHER" | "PURCHASE") {
    const character = need.sourceIdentityKey;
    const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
    const activeDuplicate = project.workOrders.some((order) => order.kind === kind && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(need.stableId));
    const reservationAllowsStep = evidence?.reservationAssessment?.state === "UNRESERVED" || evidence?.reservationAssessment?.state === "WITHIN_OBSERVED_SUPPLY";
    if (project.status !== "ACTIVE" || !project.needs.some((entry) => entry.stableId === need.stableId) || evidence?.state !== "SHORTFALL_OBSERVED" || evidence.freshness !== "recent" || !reservationAllowsStep || !character || need.sourceOwnerKey || !character.startsWith(`${project.version}::`) || (need.destinationIdentityKey && need.destinationIdentityKey !== character) || (kind === "PURCHASE" && need.destinationIdentityKey !== character) || activeDuplicate) return;
    setEditing(project.stableId); setPrefilledNeedId(need.stableId); setOrderKind(kind); setOrderTitle(`${kind === "GATHER" ? "Gather" : "Purchase"}: ${need.label}`);
    setOrderInstructions(kind === "GATHER"
      ? `Player-reviewed gathering plan for ${need.label}. This observed shortfall does not establish a gathering route, source location, yield, or completion. Verify current requirements in game; no action is executed.`
      : `Player-reviewed purchase plan for ${need.label}. This observed shortfall does not establish availability, vendor or auction route, market price, affordability, or completion. The form requires a player-set upper spending ceiling for procurement review; it is not a price quote. No purchase is executed.`);
    setAssigned(character); setOrderSource(""); setOrderDestination(""); setOrderNeedIds([need.stableId]); setOrderDependencyIds([]); setPurchaseTargetNeedId(kind === "PURCHASE" && need.destinationIdentityKey === character ? need.stableId : ""); setPurchaseCeilingCopper(""); setPurchaseBudgetNeedId("");
  }
  function prefillCraftReview(project: import("@wowsync-dashboard/core").ErpProjectView, need: ErpResourceNeed) {
    const character = need.sourceIdentityKey;
    const activeDuplicate = project.workOrders.some((order) => order.kind === "CRAFT" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(need.stableId));
    if (project.status !== "ACTIVE" || need.kind !== "RECIPE" || !character || need.sourceOwnerKey || !character.startsWith(`${project.version}::`) || activeDuplicate) return;
    clearPrefilledManualSupply(); setEditing(project.stableId); setPrefilledNeedId(need.stableId); setOrderKind("CRAFT"); setOrderTitle(`Review craft plan: ${need.label}`);
    setOrderInstructions(`Player-controlled craft planning for exact recipe ${need.resourceKey}. The linked evidence checks recorded recipe knowledge only; this does not establish profession skill, unlocks, reagents, craftability, output, or completion. Add separately observed material needs and verify all game requirements manually. No craft action is executed.`);
    setAssigned(character); setOrderSource(""); setOrderDestination(need.destinationIdentityKey ?? ""); setOrderNeedIds([need.stableId]); setOrderDependencyIds([]); setNeedKind("ITEM_REF"); setResourceKey(""); setNeedLabel(""); setQuantity("1"); setSource(character); setDestination(character);
  }
  async function addSourceInvestigation(project: import("@wowsync-dashboard/core").ErpProjectView, need: ErpResourceNeed, candidate: ErpResourceSourceCandidate) {
    if (!need.destinationIdentityKey) return;
    const exists = project.workOrders.some((order) => order.kind === "INVESTIGATE" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(need.stableId) && order.sourceIdentityKey === candidate.sourceIdentityKey && order.destinationIdentityKey === need.destinationIdentityKey);
    if (exists) return;
    const itemEvidence = candidate.matchingItems.map((item) => `${item.itemRef} (${item.state} in ${item.section}${item.observedAt !== undefined ? `, seen ${when(item.observedAt)}` : ", time unavailable"}${item.quantity !== undefined ? `, quantity ${item.quantity}` : item.knownLowerBound !== undefined ? `, at least ${item.knownLowerBound}` : ", quantity UNKNOWN"})`);
    const evidenceTime = when(candidate.observedAt);
    const freshness = candidate.freshness;
    const variants = itemEvidence.length ? itemEvidence.join("; ") : "no exact itemString was resolved";
    const unresolved = candidate.unresolvedSections.length ? ` Unresolved source sections: ${candidate.unresolvedSections.join(", ")}.` : "";
    const instructions = `Refresh and verify this possible source before planning any movement. ${candidate.sourceName} on ${candidate.sourceRealm} has ${candidate.freshness} source freshness (conservative relevant-section evidence timestamp ${evidenceTime}); matching item evidence: ${variants}.${unresolved} Account membership, source access, recipient access, and a valid transfer route are UNKNOWN. This INVESTIGATE task does not authorize or perform a transfer. Record the actual checked characters, item, route, and result in a completion note; leave unsupported outcomes UNKNOWN.`;
    const order: ErpWorkOrder = {
      stableId: id(), kind: "INVESTIGATE", status: "PLANNED", title: `Verify possible source for ${need.label}`,
      instructions, resourceNeedIds: [need.stableId], dependsOn: [], assignedIdentityKey: need.destinationIdentityKey,
      sourceIdentityKey: candidate.sourceIdentityKey, destinationIdentityKey: need.destinationIdentityKey,
    };
    await mutate(project, { workOrders: [...project.workOrders, order] });
  }
  async function addProvisioningReview(project: import("@wowsync-dashboard/core").ErpProjectView, need: ErpResourceNeed, candidate: ErpResourceSourceCandidate) {
    const recipient = need.destinationIdentityKey;
    const observedItem = candidate.matchingItems.some((item) => item.state === "OBSERVED" && (item.quantity ?? item.knownLowerBound ?? 0) > 0);
    const blocker = project.status !== "ACTIVE" ? "The project must be active." : !recipient ? "Choose an intended recipient first." : recipient === candidate.sourceIdentityKey ? "The observed source is already the intended recipient." : need.sourceOwnerKey ? "This need already names an owner-scoped source." : !recipient.startsWith(`${project.version}::`) || !candidate.sourceIdentityKey.startsWith(`${project.version}::`) ? "Source and recipient must resolve in this game version." : candidate.state !== "OBSERVED" ? "Current observed source evidence is required." : candidate.freshness !== "recent" ? "Recent source evidence is required." : candidate.reservationState !== "UNRESERVED" || candidate.activeReservationQuantity !== 0 ? "The source quantity has a reservation conflict or unknown availability." : !observedItem ? "An exact positively observed matching item is required." : undefined;
    if (blocker) { setError(`Cannot create provisioning review: ${blocker}`); return; }
    const duplicate = project.workOrders.some((order) => order.kind === "PROVISION" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(need.stableId) && order.sourceIdentityKey === candidate.sourceIdentityKey && order.destinationIdentityKey === recipient);
    if (duplicate) return;
    const exactItems = candidate.matchingItems.filter((item) => item.state === "OBSERVED" && (item.quantity ?? item.knownLowerBound ?? 0) > 0).map((item) => `${item.itemRef} in ${item.section}${item.observedAt ? `, observed ${when(item.observedAt)}` : ""}${item.quantity !== undefined ? `, quantity ${item.quantity}` : item.knownLowerBound !== undefined ? `, at least ${item.knownLowerBound}` : ""}`).join("; ");
    const order: ErpWorkOrder = {
      stableId: id(), kind: "PROVISION", status: "PLANNED", title: `Review provisioning ${need.label} to ${name(recipient)}`,
      instructions: `Possible source evidence: ${candidate.sourceName} on ${candidate.sourceRealm} has recent observed matching item evidence: ${exactItems}. The player selected this character as the source to investigate for this manual provisioning review. This does not replace or change the resource need's existing planned source, prove ownership, account membership, character access, binding, or a valid transfer route. Verify both characters, current item location and variant, and a supported route in game before deciding whether to move anything. No item is reserved or moved. No transfer is executed. Later source and recipient observation changes remain non-causal and cannot prove this plan caused them.`,
      resourceNeedIds: [need.stableId], dependsOn: [], assignedIdentityKey: recipient,
      sourceIdentityKey: candidate.sourceIdentityKey, destinationIdentityKey: recipient,
    };
    await mutate(project, { workOrders: [...project.workOrders, order] });
  }
  function prefillSharedRetrieval(project: import("@wowsync-dashboard/core").ErpProjectView, need: ErpResourceNeed, evidence: import("@wowsync-dashboard/core").ErpNeedEvidence | undefined) {
    const recipient = need.destinationIdentityKey;
    const ownerIsVersionScoped = project.version === "retail" && need.sourceOwnerKey?.startsWith(`${project.version}::`);
    const observedOwnerQuantity = evidence?.sourceSections.some((section) => section.section === "shared storage" && section.state === "OBSERVED") && evidence.observedQuantity !== undefined && evidence.observedQuantity > 0;
    const reservationAllowsReview = evidence?.reservationAssessment?.state === "UNRESERVED" || evidence?.reservationAssessment?.state === "WITHIN_OBSERVED_SUPPLY";
    if (project.status !== "ACTIVE" || !ownerIsVersionScoped || !recipient || !recipient.startsWith(`${project.version}::`) || !observedOwnerQuantity || evidence?.freshness !== "recent" || !reservationAllowsReview || (evidence.reservationAssessment?.availableObservedLowerBound ?? 0) < 1) return;
    const duplicate = project.workOrders.some((order) => order.kind === "RETRIEVE" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(need.stableId) && order.assignedIdentityKey === recipient);
    if (duplicate) return;
    const ownerLabel = evidence.ownerScope === "guild" ? "guild-owned storage" : evidence.ownerScope === "warband-installation-local" ? "installation-local Warband storage" : "shared storage with unknown scope";
    const ownershipNotice = evidence.ownerScope === "guild" ? "Guild items remain guild-owned." : evidence.ownerScope === "warband-installation-local" ? "Warband evidence is installation-local and does not identify a Battle.net account." : "The ownership scope is unknown.";
    clearPrefilledManualSupply(); setEditing(project.stableId); setPrefilledNeedId(need.stableId); setOrderKind("RETRIEVE"); setOrderTitle(`Review retrieval of ${need.label}`);
    setOrderInstructions(`The latest ${evidence.freshness} shared-storage observation records at least ${evidence.observedQuantity} matching units (${need.kind} ${need.resourceKey}) in ${ownerLabel} at ${when(evidence.observedAt)}. This is only the quantity in observed contents and may not cover inaccessible or unscanned storage; it does not establish current access or permission. ${ownershipNotice} Verify the owner, current contents, access, and game requirements before taking any action. No retrieval is executed. Later bag/storage changes do not prove retrieval or causation.`);
    setAssigned(recipient); setOrderSource(""); setOrderDestination(recipient); setOrderNeedIds([need.stableId]); setOrderDependencyIds([]);
  }
  function personalBankRetrievalFacts(project: import("@wowsync-dashboard/core").ErpProjectView, need: ErpResourceNeed, evidence: import("@wowsync-dashboard/core").ErpNeedEvidence | undefined) {
    if (!evidence || need.kind !== "ITEM_REF" || !need.sourceIdentityKey || need.sourceOwnerKey || need.destinationIdentityKey !== need.sourceIdentityKey || !need.sourceIdentityKey.startsWith(`${project.version}::`)) return undefined;
    const bags = evidence.sourceSections.find((section) => section.section === "bags");
    const bank = evidence.sourceSections.find((section) => section.section === "character bank");
    const ownReservationQuantity = project.reservations.filter((reservation) => reservation.status === "ACTIVE" && reservation.needId === need.stableId && reservation.sourceIdentityKey === need.sourceIdentityKey).reduce((sum, reservation) => sum + reservation.quantity, 0);
    const activeReservationQuantity = evidence.reservationAssessment?.activeQuantity ?? 0;
    const reservationsAreScopedToThisNeed = evidence.reservationAssessment?.state === "UNRESERVED" || (evidence.reservationAssessment?.state === "WITHIN_OBSERVED_SUPPLY" && ownReservationQuantity > 0 && activeReservationQuantity === ownReservationQuantity);
    if (project.status !== "ACTIVE" || evidence.freshness !== "recent" || bags?.state !== "OBSERVED" || bags.completeness?.toLowerCase() !== "complete" || bags.matchingQuantity === undefined || bank?.state !== "OBSERVED" || bank.completeness?.toLowerCase() !== "complete" || bank.matchingQuantity === undefined || bank.matchingQuantity < 1 || bags.matchingQuantity >= need.requiredQuantity || !reservationsAreScopedToThisNeed) return undefined;
    return { bags, bank, bagGap: need.requiredQuantity - bags.matchingQuantity, plannedQuantity: Math.min(bank.matchingQuantity, need.requiredQuantity - bags.matchingQuantity) };
  }
  function prefillPersonalBankRetrieval(project: import("@wowsync-dashboard/core").ErpProjectView, need: ErpResourceNeed, evidence: import("@wowsync-dashboard/core").ErpNeedEvidence | undefined) {
    const facts = personalBankRetrievalFacts(project, need, evidence);
    const character = need.sourceIdentityKey;
    if (!facts || !character) return;
    const duplicate = project.workOrders.some((order) => order.kind === "RETRIEVE" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(need.stableId) && order.assignedIdentityKey === character);
    if (duplicate) return;
    clearPrefilledManualSupply(); setEditing(project.stableId); setPrefilledNeedId(need.stableId); setOrderKind("RETRIEVE"); setOrderTitle(`Review personal-bank retrieval: ${need.label}`);
    setOrderInstructions(`Recent complete OBSERVED sections show ${facts.bags.matchingQuantity} matching ${facts.bags.matchingQuantity === 1 ? "unit" : "units"} in ${name(character)} bags and ${facts.bank.matchingQuantity} in that character's personal bank (${need.kind} ${need.resourceKey}). The bag requirement is short by ${facts.bagGap}; the bank observation contains ${facts.plannedQuantity} exact ${facts.plannedQuantity === 1 ? "unit" : "units"} to consider for a manual retrieval review. This is a planning comparison, not proof of current access, bank interaction, or retrieval. Verify the character, exact item variant, location, and current state in game. No action is executed; later changes do not prove this work order caused them.`);
    setAssigned(character); setOrderSource(character); setOrderDestination(character); setOrderNeedIds([need.stableId]); setOrderDependencyIds([]);
  }
  async function setWorkOrderStatus(project: import("@wowsync-dashboard/core").ErpProjectView, order: ErpWorkOrder, status: ErpWorkOrder["status"]) {
    await mutate(project, { workOrders: project.workOrders.map((entry) => entry.stableId === order.stableId ? { ...entry, status } : entry) });
  }
  async function finishOrder(project: import("@wowsync-dashboard/core").ErpProjectView, order: ErpWorkOrder) {
    const note = window.prompt("Record what you manually did or observed. This note is required to mark the work order complete.");
    if (!note?.trim()) return;
    await mutate(project, { workOrders: project.workOrders.map((w) => w.stableId === order.stableId ? { ...w, status: "COMPLETED", completionNote: note.trim() } : w) });
  }
  function focusWorkOrderQueue() {
    const target = document.getElementById("erp-work-order-queue-title");
    target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    target?.focus({ preventScroll: true });
  }
  function focusProcurementQuote(projectId: string, workOrderId: string) {
    setPendingQuoteFocus({ projectId, workOrderId });
    setQueueFilter("ALL_OPEN");
    setQueueQuery("");
  }
  function focusProcurementNeed(projectId: string, needId: string) {
    const target = document.getElementById(erpNeedAnchorId(projectId, needId));
    target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  }
  async function planBuyerSourcePackage(buyerIdentityKey: string, resourceKey: string, source: import("@wowsync-dashboard/core").ErpProcurementSourceLead) {
    if (!usableVersion || !load.state.data) return;
    const projectsById = new Map(load.state.data.projects.map((project) => [project.stableId, project]));
    const references = [...new Map(source.needReferences.map((reference) => [`${reference.projectId}:${reference.needId}`, reference])).values()];
    const tasks = references.flatMap((reference) => {
      const project = projectsById.get(reference.projectId);
      const need = project?.needs.find((entry) => entry.stableId === reference.needId);
      return project && need?.kind === "ITEM_REF" && need.resourceKey === resourceKey && need.destinationIdentityKey === buyerIdentityKey
        ? [{ projectId: project.stableId, expectedRevision: project.revision, needId: need.stableId }]
        : [];
    });
    const projectCount = new Set(tasks.map((task) => task.projectId)).size;
    if (tasks.length < 2 || tasks.length !== references.length || tasks.length > 20 || projectCount > 10) {
      setError("The source package no longer matches 2–20 active same-version buyer requirements across at most 10 projects. Refresh the review before planning.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await appendErpProvisioningReviewBatch(version, { buyerIdentityKey, resourceKey, sourceIdentityKey: source.sourceIdentityKey, tasks });
      setNotice(`${result.createdCount} manual provisioning review(s) added across ${result.projects.length} project(s); ${result.skippedExistingCount} matching review(s) already existed. No item was moved or reserved.`);
      onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the grouped provisioning reviews."); }
    finally { setBusy(false); }
  }
  async function planSourceLeadBatch(source: ErpSourceFulfillmentReview["sources"][number], lead: ErpSourceFulfillmentReview["sources"][number]["alternativeLocations"][number], mode: "INVESTIGATE" | "PROVISION") {
    if (!usableVersion || !load.state.data) return;
    const projectsById = new Map(load.state.data.projects.map((project) => [project.stableId, project]));
    const sourceLeadIdentityKey = lead.sourceIdentityKey;
    const uniqueReferences = [...new Map(lead.needReferences.map((reference) => [`${reference.projectId}:${reference.needId}`, reference])).values()];
    const groups = new Map<string, { projectId: string; expectedRevision: number; tasks: ErpWorkOrderBatchTaskDraft[] }>();
    let skipped = 0;
    const skippedReasons = new Map<string, number>();
    for (const reference of uniqueReferences) {
      const project = projectsById.get(reference.projectId);
      const need = project?.needs.find((entry) => entry.stableId === reference.needId);
      const screen = project?.resourceSourceScreens.find((entry) => entry.needId === reference.needId);
      const leadIsCurrent = screen?.candidates.some((candidate) => candidate.sourceIdentityKey === sourceLeadIdentityKey && candidate.kind === source.kind && candidate.resourceKey === source.resourceKey);
      const hasOpenWork = project?.workOrders.some((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(reference.needId));
      const snapshot = project && need ? buildErpNeedReviewSnapshot(project, need.stableId) : undefined;
      const provisionEvidenceValid = mode !== "PROVISION" || (source.kind === "ITEM_REF" && need?.kind === "ITEM_REF" && !need.sourceOwnerKey && lead.state === "OBSERVED" && lead.freshness === "recent" && lead.reservationState === "UNRESERVED" && lead.activeReservationQuantity === 0 && (lead.availableObservedLowerBound ?? 0) > 0 && lead.matchingItems.some((item) => item.itemRef === need.resourceKey && item.state === "OBSERVED" && (item.quantity ?? item.knownLowerBound ?? 0) > 0));
      const reason = !project ? "missing-project" : project.status !== "ACTIVE" ? "not-active" : !need?.destinationIdentityKey ? "no-recipient" : need.destinationIdentityKey === sourceLeadIdentityKey ? "recipient-is-lead" : !need.destinationIdentityKey.startsWith(`${version}::`) ? "wrong-version" : !leadIsCurrent ? "lead-not-current-for-need" : !provisionEvidenceValid ? "provision-evidence-unavailable" : hasOpenWork ? "open-work" : !snapshot ? "snapshot-unavailable" : undefined;
      if (reason) { skipped++; skippedReasons.set(reason, (skippedReasons.get(reason) ?? 0) + 1); continue; }
      if (!project || !need || !snapshot) continue;
      const group = groups.get(project.stableId) ?? { projectId: project.stableId, expectedRevision: project.revision, tasks: [] };
      const instructions = mode === "PROVISION"
        ? `Player-selected possible source: ${lead.sourceName} on ${lead.sourceRealm}. The current source screen observed the exact ITEM_REF ${need.resourceKey} recently, with no recorded reservations against this source review. This does not establish ownership, account membership, recipient access, binding, transferability, or a valid route, and the observation can become stale. Recheck both characters and the exact item variant in game before deciding whether any provisioning action is possible. No item is reserved or moved, and no action is executed.`
        : `Recheck the exact ${need.kind} resource ${need.resourceKey} at the currently observed location lead before deciding any manual action. This saved candidate does not establish account membership, ownership, current access, binding, transferability, or a route. Verify requirements and both characters in game; record only what was directly confirmed. No item is reserved or moved, and no action is executed.`;
      group.tasks.push({ needId: need.stableId, reviewSnapshot: snapshot, kind: mode, title: mode === "PROVISION" ? `Review provisioning ${need.label} to ${name(need.destinationIdentityKey)}` : `Verify possible source for ${need.label}`, instructions, ...(mode === "INVESTIGATE" ? { sourceLeadIdentityKey } : { provisioningSourceIdentityKey: sourceLeadIdentityKey }), ...(chars.some((character) => character.identityKey === need.destinationIdentityKey) ? { assignedIdentityKey: need.destinationIdentityKey } : {}) });
      groups.set(project.stableId, group);
    }
    const taskCount = [...groups.values()].reduce((sum, group) => sum + group.tasks.length, 0);
    if (taskCount < 2 || taskCount > 20 || groups.size > 10) {
      const labels: Record<string, string> = { "missing-project": "project unavailable", "not-active": "project not active", "no-recipient": "recipient not selected", "recipient-is-lead": "lead is already the recipient", "wrong-version": "recipient belongs to another version", "lead-not-current-for-need": "lead no longer matches this need", "provision-evidence-unavailable": "exact, recent, unreserved item evidence unavailable", "open-work": "unfinished work already exists", "snapshot-unavailable": "need review unavailable" };
      const reasons = [...skippedReasons].map(([reason, count]) => `${count} ${labels[reason] ?? "need skipped"}`).join(", ");
      setError(`This lead matches ${taskCount} currently eligible requirement${taskCount === 1 ? "" : "s"} out of ${uniqueReferences.length}${reasons ? `; ${reasons}` : ""}. At least two eligible needs are required. The limit is 20 needs across 10 projects.`);
      return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await appendErpWorkOrderBatch(version as Version, [...groups.values()]);
      setNotice(`${result.createdCount} ${mode === "PROVISION" ? "manual provisioning review" : "source investigation work order"}${result.createdCount === 1 ? "" : "s"} saved across ${result.projects.length} projects${skipped ? `; ${skipped} linked needs were skipped because their project, recipient, evidence lead, or open-work state no longer qualifies` : ""}. No resource was reserved or moved.`);
      onRefresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the grouped source investigation reviews."); }
    finally { setBusy(false); }
  }
  async function recordProcurementQuote(project: import("@wowsync-dashboard/core").ErpProjectView, order: ErpWorkOrder) {
    if (order.kind !== "PURCHASE" || !order.procurementPlan || order.status === "COMPLETED" || order.status === "CANCELLED") return;
    const target = project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId)?.procurementAssessment?.targetNeed;
    const observedGap = target?.state === "SHORTFALL_OBSERVED" && target.observedQuantity !== undefined ? Math.max(1, target.requiredQuantity - target.observedQuantity) : undefined;
    const defaultQuantity = observedGap ?? target?.requiredQuantity ?? 1;
    const rawAmount = window.prompt("Total player-reported quote in whole copper for the quantity below (not verified by WoWSync)");
    if (rawAmount === null) return;
    if (!/^\d+$/.test(rawAmount.trim())) { setError("Enter a non-negative whole-copper amount; leave the prompt blank to cancel."); return; }
    const amountCopper = Number(rawAmount);
    if (!Number.isSafeInteger(amountCopper) || amountCopper < 0) { setError("Enter a non-negative whole-copper amount."); return; }
    const rawQuantity = window.prompt("How many units does that total quote cover?", String(defaultQuantity));
    if (rawQuantity === null) return;
    const quantity = Number(rawQuantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) { setError("Enter a positive whole quantity covered by the quote."); return; }
    const sourceNote = window.prompt("Where did you check this price? Optional note only; WoWSync will not verify the source.")?.trim().slice(0, 120);
    const procurementPlan = { ...order.procurementPlan, playerQuote: { amountCopper, quantity, recordedAt: Math.floor(Date.now() / 1000), ...(sourceNote ? { sourceNote } : {}) } };
    await mutate(project, { workOrders: project.workOrders.map((entry) => entry.stableId === order.stableId ? { ...entry, procurementPlan } : entry) });
  }

  if (load.state.status === "loading" && !load.state.data) return <div className="loading">Loading projects…</div>;
  if (load.state.status === "error" && !load.state.data) return <section className="erp-workbench"><h1>Projects &amp; Work Orders</h1><p role="alert">{load.state.error instanceof Error ? load.state.error.message : "Projects could not be loaded."}</p><button onClick={load.retry}>Retry</button></section>;
  const projects = load.state.data?.projects ?? [];
  const queue = buildErpWorkOrderQueue(projects, queueFilter).filter((entry) => {
    const needle = queueQuery.trim().toLocaleLowerCase();
    return !needle || `${entry.project.title} ${entry.order.title} ${entry.order.kind} ${name(entry.order.assignedIdentityKey)} ${entry.readiness?.state ?? "unknown"} ${entry.progress?.reconciliation ?? "unknown"}`.toLocaleLowerCase().includes(needle);
  });
  const queueTotal = buildErpWorkOrderQueue(projects, "ALL_OPEN").length;
  const queueAttention = buildErpWorkOrderQueue(projects, "ATTENTION").length;
  const unworkedNeeds = findErpUnworkedNeeds(projects);
  const commitments = load.state.data?.resourceCommitments;
  return <section className="erp-workbench">
      <header className="erp-workbench-header"><div><p className="eyebrow">{String(version).toUpperCase()} · PLANNING</p><h1>Projects &amp; Work Orders</h1><p>Record goals, resource needs, reservations, and manual next steps against this version's observed characters.</p></div><span className="erp-scope-note">Version isolated · no game actions are executed</span></header>
    <aside className="erp-evidence-note"><strong>Evidence boundary:</strong> a project is player intent. Character co-location does not establish account membership or transfer access. Unknown or inaccessible storage is not treated as empty. Completing a work order requires a player-entered note; it does not itself verify the game outcome.</aside>
    {usableVersion && load.state.data?.portfolioFulfillment && load.state.data.sourceFulfillment && <ErpPortfolioFulfillmentPanel review={load.state.data.portfolioFulfillment} sourceReview={load.state.data.sourceFulfillment} characterName={name} busy={busy} onPlanSourceLeadBatch={planSourceLeadBatch} onPlanNeed={(projectId, needId, pathwayKind) => setPortfolioPrefill({ projectId, needId, pathwayKind })} />}
    {usableVersion && load.state.data?.procurementBudgetReview && <ErpProcurementBudgetPanel review={load.state.data.procurementBudgetReview} characterName={name} onOpenProject={(projectId) => { const target = document.getElementById(`erp-project-title-${encodeURIComponent(projectId)}`); target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }); target?.focus({ preventScroll: true }); }} onReviewOrder={focusProcurementQuote} />}
    {usableVersion && load.state.data?.procurementBuyerReview && <ErpProcurementBuyerPanel review={load.state.data.procurementBuyerReview} characterName={name} onReviewOrder={focusProcurementQuote} onReviewNeed={focusProcurementNeed} onPlanSourcePackage={planBuyerSourcePackage} />}
    {usableVersion && load.state.data?.portfolioNextActions && <ErpPortfolioNextActionPanel review={load.state.data.portfolioNextActions} />}
    {usableVersion && load.state.data?.fulfillmentTriage && commitments && <ErpCrossProjectWorkOrderComposer version={version as Version} triage={load.state.data.fulfillmentTriage} sourceReview={load.state.data.sourceFulfillment} projects={projects} commitments={commitments} characters={chars} busy={busy} onSaved={onRefresh} prefillNeed={portfolioPrefill} onPrefillConsumed={() => setPortfolioPrefill(null)} />}
    {usableVersion && <section className="erp-work-order-queue" aria-labelledby="erp-work-order-queue-title"><h2 id="erp-work-order-queue-title" tabIndex={-1}>Work order review queue</h2><p>Unfinished work orders from active projects, plus unfinished tasks in projects marked complete, ordered by evidence needing attention and then project priority. Review a work order here or open its project. Status and completion-note actions update the player-authored plan only; they do not perform or verify game actions.</p><div className="erp-queue-controls"><label>Queue view<select aria-label="Work order queue view" value={queueFilter} onChange={(event) => setQueueFilter(event.target.value as ErpQueueFilter)}><option value="ATTENTION">Needs attention</option><option value="ALL_OPEN">All unfinished work</option></select></label><label>Search work orders<input type="search" aria-label="Search work orders" value={queueQuery} onChange={(event) => setQueueQuery(event.target.value)} placeholder="Project, task, character, evidence" /></label><span aria-live="polite">Showing {queue.length} of {queueFilter === "ATTENTION" ? queueAttention : queueTotal} work orders · {queueAttention} need attention</span></div>{queue.length ? <ol>{queue.map(({ project, order, readiness, progress, needsAttention }) => <li key={`${project.stableId}:${order.stableId}`} data-testid={`erp-queue-order-${project.stableId}-${order.stableId}`}><div><strong>{order.title}</strong> <span className="erp-status">{order.kind} · {order.status} · project priority {project.priority}</span><p>{project.title} · project {project.status.toLowerCase()} · Assigned: {name(order.assignedIdentityKey)}</p><p><strong>{readiness?.state.replaceAll("_", " ") ?? "Readiness UNKNOWN"}</strong>{progress ? ` · ${progress.reconciliation.replaceAll("_", " ")}` : " · progress UNKNOWN"}{needsAttention ? " · review needed" : " · ready for player review"}</p><p>{readiness?.reason ?? "Readiness assessment is unavailable."} {progress?.reason ?? "Progress evidence is unavailable."}{project.status === "COMPLETED" ? " The project is marked complete by the player, but this work order is not terminal." : ""}</p></div><div className="erp-queue-actions">{order.procurementPlan && <button id={`erp-queue-quote-${encodeURIComponent(project.stableId)}-${encodeURIComponent(order.stableId)}`} disabled={busy || order.status === "COMPLETED" || order.status === "CANCELLED"} onClick={() => void recordProcurementQuote(project, order)}>Record quote...</button>}<ErpWorkOrderActions order={order} disabled={busy} onStatus={(status) => void setWorkOrderStatus(project, order, status)} onComplete={() => void finishOrder(project, order)} /><button type="button" onClick={() => { const target = document.getElementById(`erp-project-title-${encodeURIComponent(project.stableId)}`); target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }); target?.focus({ preventScroll: true }); }}>Open project</button></div></li>)}</ol> : <p>{queueQuery.trim() ? "No work orders match this search." : queueFilter === "ATTENTION" ? "No unfinished work orders currently require evidence review." : "No unfinished work orders are recorded for this version."}</p>}</section>}
    {version !== "unknown-version" && <ErpObservationChangeQueue projects={projects} version={version} characterName={name} formatTime={when} busy={busy} onPlanInvestigation={createChangedObservationReview} />}
    {usableVersion && <UnworkedNeedPanel needs={unworkedNeeds} sourceName={sourceName} openProject={(projectId) => { const target = document.getElementById(`erp-project-title-${encodeURIComponent(projectId)}`); target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }); target?.focus({ preventScroll: true }); }} />}
    {commitments && <ResourceCommitmentPanel lines={commitments.items} totalCount={commitments.totalCount} truncated={commitments.truncated} sourceLabel={(line) => line.sourceScope === "CHARACTER" ? name(line.sourceIdentityKey) : line.sourceScope === "SHARED_OWNER" ? sourceName({ stableId: "", kind: line.kind, resourceKey: line.resourceKey, label: line.label, requiredQuantity: 1, sourceOwnerKey: line.sourceOwnerKey }) : "Source unknown (not combined)"} characterName={name} openNeed={focusProcurementNeed} openProject={(projectId) => { const target = document.getElementById(`erp-project-title-${encodeURIComponent(projectId)}`); target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce").matches ? "instant" : "smooth", block: "start" }); target?.focus({ preventScroll: true }); }} />}
    {usableVersion && commitments && <ErpReservationReplanPanel version={version} projects={projects} lines={commitments.items} busy={busy} sourceLabel={(line) => line.sourceScope === "CHARACTER" ? name(line.sourceIdentityKey) : line.sourceScope === "SHARED_OWNER" ? sourceName({ stableId: "", kind: line.kind, resourceKey: line.resourceKey, label: line.label, requiredQuantity: 1, sourceOwnerKey: line.sourceOwnerKey }) : "Source unknown (not combined)"} onSaved={onRefresh} />}
    {error && <p role="alert" className="erp-form-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!usableVersion ? <p>This version has no project persistence scope.</p> : <form className="erp-create-form" onSubmit={create}><h2>Start a project</h2><label>Project title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} required /></label><label>Objective<textarea value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={2000} rows={2} /></label><label>Priority<select value={priority} onChange={(e) => setPriority(e.target.value)}>{[1,2,3,4,5].map((n) => <option key={n} value={n}>{n}{n === 1 ? " · low" : n === 5 ? " · high" : ""}</option>)}</select></label><button className="primary-button" disabled={busy}>Create project</button></form>}
    {!projects.length ? <div className="erp-empty">No {version} projects yet. Start with a character goal, crafting requirement, provisioning task, or investigation.</div> : <div className="erp-project-list">{projects.map((p) => <article id={`erp-project-${encodeURIComponent(p.stableId)}`} className="erp-project-card" key={p.stableId}>
      <header className="erp-project-title"><div><span className={`erp-status erp-status-${p.status.toLowerCase()}`}>{p.status.replaceAll("_", " ")}</span><h2 id={`erp-project-title-${encodeURIComponent(p.stableId)}`} tabIndex={-1}>{p.title}</h2>{p.objective && <p>{p.objective}</p>}</div><div className="erp-project-actions"><label>Priority <select value={p.priority} onChange={(e) => void mutate(p, { priority: Number(e.target.value) })}>{[1,2,3,4,5].map((n) => <option key={n}>{n}</option>)}</select></label>{p.status !== "COMPLETED" && <button disabled={busy} onClick={() => void run(() => setErpProjectStatus(p, p.status === "ACTIVE" ? "PAUSED" : "ACTIVE"))}>{p.status === "ACTIVE" ? "Pause" : "Resume"}</button>}</div></header>
      <div className="erp-project-meta">Revision {p.revision} · Updated {when(p.updatedAt)} · Explicit priority, not a computed ranking</div>
      <section className="erp-fulfillment-snapshot" aria-label={`Fulfillment snapshot for ${p.title}`} data-testid="erp-fulfillment-snapshot">
        <h3>Fulfillment snapshot</h3>
        <p><strong>{p.fulfillment.state.replaceAll("_", " ")}</strong> · player project status {p.fulfillment.projectStatus.toLowerCase()}</p>
        <ul>
          <li>{p.fulfillment.currentObservedCoverageCount} requirements currently covered by selected-source observations</li>
          <li>{p.fulfillment.currentObservedShortfallCount} current observed gaps · {p.fulfillment.historicalOrStaleEvidenceCount} historical or stale · {p.fulfillment.unresolvedEvidenceCount} unresolved</li>
          <li>{p.fulfillment.activeWorkOrderCount} open manual work orders · {p.fulfillment.changedObservationCauseUnknownCount} changed observations with cause unknown</li>
          <li>{(p.fulfillment.reservationReviewStates.EXCEEDS_OBSERVED_SUPPLY ?? 0) + (p.fulfillment.reservationReviewStates.SUPPLY_UNKNOWN ?? 0)} reservations need review</li>
        </ul>
        <p>{p.fulfillment.reason}</p>
        <small>Evidence and saved plans only. Requirement coverage does not mean resources are unreserved or accessible, work was performed, or the project is complete.</small>
      </section>
      <ErpProjectHistory events={p.history} totalCount={p.historyEventCount} truncated={p.historyTruncated} />
      {p.status === "ACTIVE" && unworkedReviewNeeds(p).length >= 2 && <>
      {multiOrderProjectId === p.stableId ? <ErpMultiNeedWorkOrderComposer project={p} needs={unworkedReviewNeeds(p)} characters={chars} busy={busy} onSave={(drafts) => createMultiNeedPlan(p, drafts)} onCancel={() => setMultiOrderProjectId(null)} /> : <button type="button" disabled={busy} onClick={() => { setBatchProjectId(null); setMultiOrderProjectId(p.stableId); }}>Compose fulfillment work orders</button>}
      <section className="erp-batch-fulfillment" aria-label={`Multi-need fulfillment planner for ${p.title}`}>
        <h3>Plan several uncovered requirements together</h3>
        <p>This creates one shared INVESTIGATE work order covering several unresolved needs. Use “Compose fulfillment work orders” above to create a separate task type for each need.</p>
        {batchProjectId !== p.stableId ? <button type="button" disabled={busy} onClick={() => { setBatchProjectId(p.stableId); setBatchNeedIds([]); setBatchDependencyIds([]); setBatchAssigned(""); }}>Create one grouped investigation</button> : <div className="erp-batch-fulfillment-form">
          <fieldset><legend>Requirements to review (up to 4)</legend>{unworkedReviewNeeds(p).map((need) => {
            const evidence = p.needEvidence.find((entry) => entry.needId === need.stableId);
            const checked = batchNeedIds.includes(need.stableId);
            return <label className="erp-batch-need" key={need.stableId}><input type="checkbox" checked={checked} disabled={!checked && batchNeedIds.length >= 4} onChange={(event) => setBatchNeedIds((current) => event.target.checked ? [...current, need.stableId] : current.filter((id) => id !== need.stableId))} /><span><strong>{need.label}</strong> · {need.kind} · need {need.requiredQuantity}<small>{evidence?.state.replaceAll("_", " ") ?? "Evidence UNKNOWN"} · {evidence?.freshness ?? "unknown"} freshness · source {sourceName(need)}{evidence?.reservationAssessment ? ` · ${evidence.reservationAssessment.activeQuantity} reserved` : " · reservation UNKNOWN"}</small></span></label>;
          })}</fieldset>
          <label>Assigned reviewer (optional)<select aria-label="Assigned reviewer for grouped fulfillment review" value={batchAssigned} onChange={(event) => setBatchAssigned(event.target.value)}><option value="">Unassigned</option>{chars.map((character) => <option key={character.identityKey} value={character.identityKey}>{name(character.identityKey)}</option>)}</select></label>
          {p.workOrders.some((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED") && <label>Prerequisite work orders (optional)<select multiple aria-label="Grouped review prerequisites" value={batchDependencyIds} onChange={(event) => setBatchDependencyIds(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}>{p.workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED").map((order) => <option key={order.stableId} value={order.stableId}>{order.title}</option>)}</select></label>}
          <p className="erp-form-help">The review records player intent and linked requirements in one project update. It does not infer access, ownership, routes, recipe inputs, purchases, gathering results, crafting, or completion. Reassess after importing newer observations.</p>
          <button type="button" className="primary-button" disabled={busy || batchNeedIds.length < 2} onClick={() => void createFulfillmentReview(p)}>Create review for {batchNeedIds.length} needs</button><button type="button" disabled={busy} onClick={() => { setBatchProjectId(null); setBatchNeedIds([]); setBatchDependencyIds([]); setBatchAssigned(""); }}>Cancel</button>
        </div>}
      </section>
      </>}
      <h3>Resource needs &amp; reservations</h3>{p.status === "ACTIVE" && (needBundleProjectId === p.stableId ? <ErpMultiNeedResourceComposer project={p} characters={chars} busy={busy} onSave={(drafts) => addMultiNeedRequirements(p, drafts)} onCancel={() => setNeedBundleProjectId(null)} /> : <button type="button" disabled={busy} onClick={() => setNeedBundleProjectId(p.stableId)}>Define several requirements</button>)}{p.needs.length ? <ul className="erp-need-list">{p.needs.map((n) => { const ev = p.needEvidence.find((x) => x.needId === n.stableId); const personalBankFacts = personalBankRetrievalFacts(p, n, ev); const reservation = p.reservations.filter((r) => r.needId === n.stableId && r.status === "ACTIVE"); const review = p.reservationReview.find((x) => reservation.some((r) => r.stableId === x.reservationId)); const available = ev?.reservationAssessment?.availableObservedLowerBound; const sourceScreen = p.resourceSourceScreens.find((screen) => screen.needId === n.stableId); const reservationAvailability = (r: (typeof reservation)[number]) => { const exactNeedSource = (r.sourceIdentityKey && r.sourceIdentityKey === n.sourceIdentityKey && !r.sourceOwnerKey) || (r.sourceOwnerKey && r.sourceOwnerKey === n.sourceOwnerKey && !r.sourceIdentityKey); if (exactNeedSource) { const complete = ev?.freshness === "recent" && ev.observedQuantity !== undefined && !ev.unresolvedSections.length && ev.unknownQuantityRowCount === 0 && ev.sourceSections.length > 0 && ev.sourceSections.every((section) => section.state === "OBSERVED" && section.completeness?.toLowerCase() === "complete"); return { remaining: complete ? available : undefined, state: complete ? ev?.reservationAssessment?.state : "UNKNOWN" }; } const candidate = r.sourceIdentityKey ? sourceScreen?.candidates.find((entry) => entry.sourceIdentityKey === r.sourceIdentityKey && entry.kind === n.kind && entry.resourceKey === n.resourceKey) : undefined; const complete = candidate?.state === "OBSERVED" && candidate.freshness === "recent" && !candidate.unresolvedSections.length && candidate.locations.length === 2 && candidate.locations.every((location) => location.state === "OBSERVED" && location.completeness?.toLowerCase() === "complete" && location.quantity !== undefined); return { remaining: complete ? candidate?.availableObservedLowerBound : undefined, state: complete ? candidate?.reservationState : "UNKNOWN" }; }; const reservationAllowsStep = ev?.reservationAssessment?.state === "UNRESERVED" || ev?.reservationAssessment?.state === "WITHIN_OBSERVED_SUPPLY"; const confirmedItemGap = ev?.state === "SHORTFALL_OBSERVED" && ev.freshness === "recent" && reservationAllowsStep && (n.kind === "ITEM_ID" || n.kind === "ITEM_REF") && Boolean(n.sourceIdentityKey && !n.sourceOwnerKey && n.sourceIdentityKey.startsWith(`${p.version}::`)); const activeGather = p.workOrders.some((order) => order.kind === "GATHER" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(n.stableId)); const activePurchase = p.workOrders.some((order) => order.kind === "PURCHASE" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(n.stableId)); const activeCraftReview = p.workOrders.some((order) => order.kind === "CRAFT" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(n.stableId)); const canPlanCraftReview = n.kind === "RECIPE" && Boolean(n.sourceIdentityKey && !n.sourceOwnerKey && n.sourceIdentityKey.startsWith(`${p.version}::`)) && p.status === "ACTIVE"; const canPlanGather = confirmedItemGap && (!n.destinationIdentityKey || n.destinationIdentityKey === n.sourceIdentityKey); const canPlanPurchase = confirmedItemGap && n.destinationIdentityKey === n.sourceIdentityKey; const canPlanSharedRetrieval = p.status === "ACTIVE" && p.version === "retail" && Boolean(n.sourceOwnerKey?.startsWith("retail::") && n.destinationIdentityKey?.startsWith("retail::") && ev?.sourceSections.some((section) => section.section === "shared storage" && section.state === "OBSERVED") && ev.observedQuantity !== undefined && ev.observedQuantity > 0 && ev.freshness === "recent" && (ev.reservationAssessment?.state === "UNRESERVED" || ev.reservationAssessment?.state === "WITHIN_OBSERVED_SUPPLY") && (ev.reservationAssessment.availableObservedLowerBound ?? 0) > 0); const activeRetrieval = p.workOrders.some((order) => order.kind === "RETRIEVE" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(n.stableId) && order.assignedIdentityKey === n.destinationIdentityKey); return <li id={erpNeedAnchorId(p.stableId, n.stableId)} tabIndex={-1} key={n.stableId}><div><strong>{n.label}</strong> <span>({n.kind}: {n.resourceKey}, {n.kind === "PROFESSION" ? "skill threshold" : "need"} {n.requiredQuantity})</span><p>{(n.kind === "RECIPE" ? recipeStateText : stateText)[ev?.state ?? "UNKNOWN"]}: {ev?.reason ?? "Supply not assessed."}</p>{ev?.observationChange && <p className="erp-change-note"><strong>Since prior export:</strong> {ev.observationChange.comparisons.length ? ev.observationChange.comparisons.map((c) => `${c.section}: ${c.previousQuantity} → ${c.currentQuantity} (${c.delta > 0 ? "+" : ""}${c.delta})`).join("; ") : "no comparable complete observations"}. {ev.observationChange.reason}</p>}<small>Source: {sourceName(n)} · Evidence {when(ev?.observedAt)} · {ev?.freshness ?? "unknown"} freshness</small>{formatStorageLocations(ev) && <small>Observed storage locations: {formatStorageLocations(ev)}</small>}{ev?.reservationAssessment && <small>Across version-scoped plans: {ev.reservationAssessment.activeQuantity} reserved · {available === undefined ? "remaining supply unknown" : `at least ${available} unreserved units observed`}. {ev.reservationAssessment.reason}</small>}{n.destinationIdentityKey && <small>Intended recipient: {name(n.destinationIdentityKey)} (intent only)</small>}{sourceScreen && <ResourceSourceScreenView screen={sourceScreen} disabled={busy} plannedSourceIdentityKey={n.sourceIdentityKey} sourceChangeBlocked={reservation.length > 0 || activePurchase} sourceChangeBlockReason={reservation.length > 0 ? "Release active reservations before changing the planned source." : "An open purchase plan is buyer-scoped; use the provisioning review to record this source lead without changing that purchase plan."} onChooseSource={(sourceIdentityKey) => void mutate(p, { needs: p.needs.map((entry) => entry.stableId === n.stableId ? { ...entry, sourceIdentityKey, sourceOwnerKey: undefined } : entry) })} onCreateInvestigation={(candidate) => void addSourceInvestigation(p, n, candidate)} existingInvestigation={(candidate) => p.workOrders.some((order) => order.kind === "INVESTIGATE" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(n.stableId) && order.sourceIdentityKey === candidate.sourceIdentityKey && order.destinationIdentityKey === n.destinationIdentityKey)} onCreateProvisioning={(candidate) => void addProvisioningReview(p, n, candidate)} existingProvisioning={(candidate) => p.workOrders.some((order) => order.kind === "PROVISION" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(n.stableId) && order.sourceIdentityKey === candidate.sourceIdentityKey && order.destinationIdentityKey === n.destinationIdentityKey)} />}</div><span className="erp-status">{reservation.length ? `${review?.reservedQuantity ?? reservation.reduce((sum, r) => sum + r.quantity, 0)} reserved across overlapping plans · ${stateText[review?.state ?? "SUPPLY_UNKNOWN"]}` : "No reservation in this project"}</span>{canPlanGather && !activeGather && <button disabled={busy || p.status !== "ACTIVE"} onClick={() => prefillManualSupply(p, n, "GATHER")}>Plan manual gather step</button>}{canPlanGather && activeGather && <small>An active GATHER step is already linked to this need.</small>}{canPlanPurchase && !activePurchase && <button disabled={busy || p.status !== "ACTIVE"} onClick={() => prefillManualSupply(p, n, "PURCHASE")}>Plan manual purchase step</button>}{canPlanPurchase && activePurchase && <small>An active PURCHASE step is already linked to this need.</small>}{canPlanCraftReview && !activeCraftReview && <button disabled={busy} onClick={() => prefillCraftReview(p, n)}>Plan manual craft review</button>}{canPlanCraftReview && activeCraftReview && <small>An active CRAFT review is already linked to this recipe need.</small>}{canPlanSharedRetrieval && !activeRetrieval && <button disabled={busy} onClick={() => prefillSharedRetrieval(p, n, ev)}>Plan manual shared-storage retrieval review</button>}{canPlanSharedRetrieval && activeRetrieval && <small>An active RETRIEVE review is already linked to this need.</small>}{personalBankFacts && !activeRetrieval && <button disabled={busy} onClick={() => prefillPersonalBankRetrieval(p, n, ev)}>Plan manual personal-bank retrieval review</button>}{personalBankFacts && activeRetrieval && <small>An active personal-bank RETRIEVE review is already linked to this character and need.</small>}{reservation.map((r) => { const sourceAssessment = reservationAvailability(r); const maxQuantity = maxAdjustedReservationQuantity(r.quantity, sourceAssessment.remaining); const sourceLabel = r.sourceIdentityKey ? name(r.sourceIdentityKey) : r.sourceOwnerKey ?? "UNKNOWN source"; return <span key={r.stableId} className="erp-reservation-actions"><small>Reservation source: {sourceLabel} · source assessment: {sourceAssessment.state ?? "UNKNOWN"}</small><button disabled={busy} title={sourceAssessment.remaining === undefined ? "Remaining supply at this reservation’s source is unavailable or insufficiently established; this reservation may be reduced, but not increased." : `At most ${maxQuantity} units based on the remaining observed lower bound at this reservation’s source.`} onClick={() => { const raw = window.prompt(`New reservation quantity (1–${maxQuantity}); this changes planning intent only`, String(r.quantity)); if (raw === null) return; const amount = Number(raw); if (!isValidAdjustedReservationQuantity(amount, r.quantity, maxQuantity)) { setError(`Enter a whole quantity from 1 to ${maxQuantity}. Current evidence does not support a larger reservation.`); return; } if (amount === r.quantity) return; void mutate(p, { reservations: p.reservations.map((entry) => entry.stableId === r.stableId ? { ...entry, quantity: amount, updatedAt: Math.floor(Date.now()/1000) } : entry) }); }}>Adjust {r.quantity}</button><button disabled={busy} onClick={() => void mutate(p, { reservations: p.reservations.map((entry) => entry.stableId === r.stableId ? { ...entry, status: "RELEASED", updatedAt: Math.floor(Date.now()/1000) } : entry) })}>Release {r.quantity}</button></span>; })}{!reservation.length && (n.sourceIdentityKey || n.sourceOwnerKey) && (n.kind === "ITEM_ID" || n.kind === "ITEM_REF" || n.kind === "GOLD_COPPER" || n.kind === "CURRENCY") && <button disabled={busy || available === undefined || available < 1} title="Reserve only from the observed unreserved quantity" onClick={() => { const qty = window.prompt("Quantity to reserve from this explicitly selected source", "1"); const amount = Number(qty); if (!Number.isSafeInteger(amount) || amount < 1 || available === undefined || amount > available) { setError(`Reservation exceeds the observed unreserved amount (${available ?? "unknown"}).`); return; } void mutate(p, { reservations: [...p.reservations, { stableId: id(), needId: n.stableId, ...(n.sourceOwnerKey ? { sourceOwnerKey: n.sourceOwnerKey } : { sourceIdentityKey: n.sourceIdentityKey! }), quantity: amount, status: "ACTIVE", createdAt: Math.floor(Date.now()/1000), updatedAt: Math.floor(Date.now()/1000) }] }); }}>Reserve</button>}</li>; })}</ul> : <p>No resource requirements recorded.</p>}
      {editing === p.stableId && (!prefilledNeedId || p.needs.some((need) => need.stableId === prefilledNeedId && need.kind === "RECIPE")) && <form className="erp-inline-form" onSubmit={(e) => void addNeed(e, p)}><h4>Add a resource requirement</h4><label>Kind<select value={needKind} onChange={(e) => setNeedKind(e.target.value as ErpResourceNeed["kind"])}>{["ITEM_REF","ITEM_ID","GOLD_COPPER","CURRENCY","PROFESSION","RECIPE"].map((x) => <option key={x}>{x}</option>)}</select></label><label>Resource key<input value={resourceKey} onChange={(e) => setResourceKey(e.target.value)} placeholder={needKind === "ITEM_REF" ? "item:123:variant" : needKind === "ITEM_ID" ? "123" : needKind === "CURRENCY" ? "Retail currency ID, e.g. 1822" : needKind === "GOLD_COPPER" ? "(uses copper)" : needKind === "PROFESSION" ? "exact observed profession name" : "recipe ID (Retail evidence only)"} disabled={needKind === "GOLD_COPPER"} required={needKind !== "GOLD_COPPER"} /></label><label>Label<input value={needLabel} onChange={(e) => setNeedLabel(e.target.value)} required /></label><label>{needKind === "PROFESSION" ? "Required skill" : needKind === "GOLD_COPPER" ? "Copper" : needKind === "RECIPE" ? "Recipe knowledge" : "Quantity"}<input type="number" min="1" step="1" value={needKind === "RECIPE" ? "1" : quantity} onChange={(e) => setQuantity(e.target.value)} disabled={needKind === "RECIPE"} required /></label><label>Source character or shared owner<select value={source} onChange={(e) => setSource(e.target.value)}><option value="">None — supply UNKNOWN</option><optgroup label="Characters">{chars.map((c) => <option key={c.identityKey} value={c.identityKey}>{name(c.identityKey)}</option>)}</optgroup>{version === "retail" && (needKind === "ITEM_ID" || needKind === "ITEM_REF") && sharedOwners.length > 0 && <optgroup label="Observed shared-storage owners">{sharedOwners.map((owner) => <option key={owner.owner.ownerKey} value={`owner::${owner.owner.ownerKey}`}>{owner.owner.kind === "guild" ? `Guild ${owner.owner.guildName ?? owner.owner.guildClubId}` : "Warband (installation-local)"}</option>)}</optgroup>}</select></label><label>Intended recipient<select value={destination} onChange={(e) => setDestination(e.target.value)}><option value="">Unassigned</option>{chars.map((c) => <option key={c.identityKey} value={c.identityKey}>{name(c.identityKey)}</option>)}</select></label><p className="erp-form-help">ITEM_REF tracks an exact item variant. ITEM_ID groups by base ID for explicit commodity planning and does not establish equipment interchangeability. Profession needs compare exact observed name and skill only; they do not prove craftability. Recipe needs use exact Retail learned-state evidence only and do not prove current skill, recipe unlocks, or reagents. Currency planning uses only explicitly observed, character-scoped Retail balances; account-wide balances and unsupported client versions remain UNKNOWN. Retail Warband and guild owners are separate source scopes; observed contents do not prove character access or a transfer route, and guild assets remain guild-owned.</p><button className="primary-button" disabled={busy}>Add requirement</button><button type="button" onClick={() => setEditing(null)}>Close</button></form>}
      <div className="erp-card-actions"><button onClick={() => toggleProjectForms(p.stableId)}>{editing === p.stableId ? "Hide forms" : "Add requirement / work order"}</button><button disabled={busy || p.status === "COMPLETED"} onClick={() => { const note = window.prompt("Completion note: summarize the observed project outcome."); if (!note?.trim()) return; void mutate(p, { status: "COMPLETED", completionNote: note.trim() }); }}>Complete project…</button></div>
      <h3>Manual work orders</h3>{p.workOrders.length ? <ol className="erp-work-order-list">{p.workOrders.map((w) => <li id={erpWorkOrderAnchorId(p.stableId, w.stableId)} tabIndex={-1} key={w.stableId}><div><strong>{w.title}</strong> <span className="erp-status">{w.kind} · {w.status}</span><ErpWorkOrderReadinessLine readiness={p.workOrderReadiness.find((entry) => entry.workOrderId === w.stableId)} characterName={name} storageOwnerName={storageOwnerName} /><ErpWorkOrderProgressLine progress={p.workOrderProgress.find((entry) => entry.workOrderId === w.stableId)} characterName={name} storageOwnerName={storageOwnerName} />{w.instructions && <p>{w.instructions}</p>}<small>Assigned: {name(w.assignedIdentityKey)} · Planned source: {name(w.sourceIdentityKey)} · Intended destination: {name(w.destinationIdentityKey)}{w.completionNote ? ` · Completion note: ${w.completionNote}` : ""}</small>{w.investigationSourceLeadIdentityKey && <small className="erp-source-lead">Observed source lead to investigate: {name(w.investigationSourceLeadIdentityKey)}. It was a matching location observation when planned; current status must be checked again. Account membership, access, and transferability remain UNKNOWN. This lead is not a transfer plan.</small>}</div><div>{w.status !== "COMPLETED" && w.status !== "CANCELLED" && <><button disabled={busy} onClick={() => editOrder(p, w)}>Edit plan</button><button type="button" onClick={focusWorkOrderQueue}>Manage in review queue</button></>}</div></li>)}</ol> : <p>No manual work orders recorded.</p>}
      {editing === p.stableId && <form className="erp-inline-form" onSubmit={(e) => void addOrder(e, p)}><h4>{editingOrderId ? "Edit manual work order" : "Add a manual next action"}</h4><label>Action type<select value={orderKind} onChange={(e) => setOrderKind(e.target.value as ErpWorkOrder["kind"])}>{["INVESTIGATE","GATHER","CRAFT","TRANSFER","RETRIEVE","EQUIP","PURCHASE","SELL_MANUALLY","PROVISION","OTHER"].map((x) => <option key={x}>{x}</option>)}</select></label><label>Action<input value={orderTitle} onChange={(e) => setOrderTitle(e.target.value)} required /></label><label>Manual instructions<textarea value={orderInstructions} onChange={(e) => setOrderInstructions(e.target.value)} maxLength={4000} rows={3} /></label><label>Assigned character<select value={assigned} onChange={(e) => { setAssigned(e.target.value); setPurchaseTargetNeedId(""); setPurchaseCeilingCopper(""); setPurchaseBudgetNeedId(""); }}><option value="">Unassigned</option>{chars.map((c) => <option key={c.identityKey} value={c.identityKey}>{name(c.identityKey)}</option>)}</select></label><label>Planned source character<select value={orderSource} onChange={(e) => setOrderSource(e.target.value)}><option value="">Unknown / not specified</option>{chars.map((c) => <option key={c.identityKey} value={c.identityKey}>{name(c.identityKey)}</option>)}</select></label><label>Intended destination character<select value={orderDestination} onChange={(e) => setOrderDestination(e.target.value)}><option value="">Unknown / not specified</option>{chars.map((c) => <option key={c.identityKey} value={c.identityKey}>{name(c.identityKey)}</option>)}</select></label>{orderKind === "CRAFT" && <fieldset><legend>Planned craft output (player intent)</legend><label>Item identity<select value={outputKind} onChange={(e) => setOutputKind(e.target.value as "ITEM_REF" | "ITEM_ID")}><option value="ITEM_REF">Exact itemString</option><option value="ITEM_ID">Base item ID</option></select></label><label>{outputKind === "ITEM_REF" ? "Exact itemString" : "Base item ID"}<input value={outputKey} onChange={(e) => setOutputKey(e.target.value)} placeholder={outputKind === "ITEM_REF" ? "item:123:variant" : "123"} /></label><label>Output label<input value={outputLabel} onChange={(e) => setOutputLabel(e.target.value)} /></label><label>Planned quantity<input type="number" min="1" step="1" value={outputQuantity} onChange={(e) => setOutputQuantity(e.target.value)} /></label><label>Character inventory to check<select aria-label="Character inventory to check for planned craft output" value={outputObservationIdentityKey} onChange={(e) => setOutputObservationIdentityKey(e.target.value)}><option value="">Use unambiguous crafter or destination; otherwise leave UNKNOWN</option>{chars.map((c) => <option key={c.identityKey} value={c.identityKey}>{name(c.identityKey)}</option>)}</select></label><p className="erp-form-help">Choose the character whose observed inventory should be checked for this planned output. This is separate from the intended recipient and does not claim that crafting or a transfer occurred. It does not establish a known recipe output or craftability.</p></fieldset>}{orderKind === "PURCHASE" && <fieldset><legend>Procurement review (player intent)</legend><label>Item target need<select value={purchaseTargetNeedId} onChange={(e) => setPurchaseTargetNeedId(e.target.value)}><option value="">Choose an item need</option>{p.needs.filter((need) => (need.kind === "ITEM_ID" || need.kind === "ITEM_REF") && need.sourceIdentityKey === assigned && need.destinationIdentityKey === assigned).map((need) => <option key={need.stableId} value={need.stableId}>{need.label} ({need.kind}: {need.resourceKey})</option>)}</select></label><label>Spending ceiling (copper)<input aria-label="Spending ceiling (copper)" type="number" min="1" step="1" value={purchaseCeilingCopper} onChange={(e) => setPurchaseCeilingCopper(e.target.value)} required={Boolean(purchaseTargetNeedId)} /></label><label>Explicit gold budget need (optional)<select value={purchaseBudgetNeedId} onChange={(e) => setPurchaseBudgetNeedId(e.target.value)}><option value="">No separate planned budget need</option>{p.needs.filter((need) => need.kind === "GOLD_COPPER" && need.sourceIdentityKey === assigned && need.destinationIdentityKey === assigned).map((need) => <option key={need.stableId} value={need.stableId}>{need.label} ({need.requiredQuantity} copper planned)</option>)}</select></label><p className="erp-form-help">The item target must belong to the assigned buyer and name that buyer as its intended recipient. The ceiling is a player-set upper bound, not itself a need or reservation. An optional linked gold need is separate intent; reserve it separately from its requirement row. Gross observed gold is shown separately; market/vendor availability, current price, routes, unreserved spending power, and affordability remain UNKNOWN. Nothing is purchased.</p></fieldset>}
<label>Linked resource needs<select multiple value={orderNeedIds} onChange={(e) => setOrderNeedIds(Array.from(e.currentTarget.selectedOptions, (option) => option.value))}>{p.needs.map((need) => <option key={need.stableId} value={need.stableId}>{need.label}</option>)}</select></label>{orderKind === "CRAFT" && <p className="erp-form-help">Declare each material as its own resource need in the adjacent requirement form, with the assigned crafter selected as its explicit source, then link it above. Reservations remain separate player intent and can be recorded only against observed unreserved supply. Recipe evidence is not a reagent list, and no inputs are generated or assumed.</p>}<label>Prerequisite work orders<select multiple value={orderDependencyIds} onChange={(e) => setOrderDependencyIds(Array.from(e.currentTarget.selectedOptions, (option) => option.value))}>{p.workOrders.filter((order) => order.stableId !== editingOrderId && order.status !== "CANCELLED" && (order.status !== "COMPLETED" || orderDependencyIds.includes(order.stableId))).map((order) => <option key={order.stableId} value={order.stableId}>{order.title}</option>)}</select></label><p className="erp-form-help">Source and destination are explicit plan fields, not proof of access, account membership, ownership, or transferability. Retrieval from bank or shared storage remains player-controlled and requires the player to confirm current access. Readiness uses only recorded dependencies and linked evidence. A clear check means review the manual step; it never verifies game prerequisites or executes an action.</p><button className="primary-button" disabled={busy}>{editingOrderId ? "Save work-order plan" : "Add work order"}</button>{editingOrderId && <button type="button" onClick={() => { clearPrefilledManualSupply(); setEditing(p.stableId); }}>Cancel work-order edit</button>}{prefilledNeedId && <button type="button" onClick={() => { setEditing(null); clearPrefilledManualSupply(); }}>Cancel prefilled step</button>}</form>}
    </article>)}</div>}
  </section>;
}

function UnworkedNeedPanel({ needs, sourceName, openProject }: { needs: ReturnType<typeof findErpUnworkedNeeds>; sourceName: (need: ErpResourceNeed) => string; openProject: (projectId: string) => void }) {
  return <section className="erp-unworked-needs" aria-labelledby="erp-unworked-needs-title"><h2 id="erp-unworked-needs-title">Resource needs without an open work order</h2><p>These project requirements are not currently covered by a recent observation and have no non-terminal manual work order linked. This highlights planning gaps; it does not recommend gathering, purchasing, crafting, or transferring.</p>{needs.length ? <ul>{needs.map(({ project, need, evidence, reason }) => <li key={`${project.stableId}:${need.stableId}`}><div><strong>{need.label}</strong> <span className="erp-status">{need.kind} · need {need.requiredQuantity}</span><p>{project.title} · priority {project.priority} · project {project.status.toLowerCase()}</p><p>{reason} {evidence?.reason ?? "No evidence assessment is available; state remains UNKNOWN."}</p><small>Source: {sourceName(need)} · Evidence {evidence?.observedAt ? new Date(evidence.observedAt * 1000).toLocaleString() : "time UNKNOWN"} · {evidence?.freshness ?? "unknown"} freshness{evidence?.observedQuantity !== undefined ? ` · observed ${evidence.observedQuantity}` : " · observed quantity UNKNOWN"}{evidence?.potentialQuantity !== undefined ? ` · ${evidence.potentialQuantity} LAST_SEEN possible` : ""}</small>{project.status === "COMPLETED" && <p><strong>The project is marked complete by the player, while this need is not currently confirmed met.</strong> This evidence does not prove the project failed.</p>}</div><button type="button" onClick={() => openProject(project.stableId)}>Open project</button></li>)}</ul> : <p>No uncovered resource needs are missing an open manual work order.</p>}</section>;
}

function ResourceSourceScreenView({ screen, disabled, plannedSourceIdentityKey, sourceChangeBlocked, sourceChangeBlockReason, onChooseSource, onCreateInvestigation, existingInvestigation, onCreateProvisioning, existingProvisioning }: { screen: ErpResourceSourceScreen; disabled: boolean; plannedSourceIdentityKey?: string; sourceChangeBlocked: boolean; sourceChangeBlockReason: string; onChooseSource: (sourceIdentityKey: string) => void; onCreateInvestigation: (candidate: ErpResourceSourceCandidate) => void; existingInvestigation: (candidate: ErpResourceSourceCandidate) => boolean; onCreateProvisioning: (candidate: ErpResourceSourceCandidate) => void; existingProvisioning: (candidate: ErpResourceSourceCandidate) => boolean }) {
  return <section className="erp-source-screen" aria-label="Possible same-version resource sources">
    <strong>Possible observed sources for this intended recipient</strong>
    <p>Screened {screen.scannedCharacterCount} other characters of this version. This is a location lead only: shared roster records do not prove account membership, access, or transferability.</p>
    {screen.candidates.length ? <ul>{screen.candidates.map((candidate) => <li key={candidate.sourceIdentityKey}>
      <strong>{candidate.sourceName}{candidate.sourceSurname ? ` ${candidate.sourceSurname}` : ""} — {candidate.sourceRealm}</strong>
      <span> · {candidate.state === "OBSERVED" ? "OBSERVED" : "LAST_SEEN"}{candidate.observedQuantity !== undefined ? ` · ${candidate.observedQuantity} observed` : ""}{candidate.potentialQuantity !== undefined ? ` · ${candidate.potentialQuantity} historical possible` : ""}</span>
      <small>{candidate.locations.filter((location) => location.quantity !== undefined || location.knownLowerBound !== undefined).map((location) => `${location.section}: ${location.quantity !== undefined ? location.quantity : `at least ${location.knownLowerBound}`} (${location.state}${location.observedAt ? `, ${when(location.observedAt)}` : ""})`).join("; ") || "Matching storage location is not fully resolved"} · {candidate.freshness} freshness · {candidate.activeReservationQuantity} reserved ({candidate.reservationState})</small>
      {candidate.matchingItems.length > 0 && <small>Matched exact itemStrings: {candidate.matchingItems.map((item) => <span key={`${item.section}:${item.state}:${item.itemRef}`}><code>{item.itemRef}</code> ({item.section}, {item.state}, {item.quantity !== undefined ? item.quantity : item.knownLowerBound !== undefined ? `at least ${item.knownLowerBound}` : "quantity UNKNOWN"}) </span>)}</small>}
      {candidate.kind === "ITEM_ID" && <small>Base-item search groups these exact variants for discovery; it does not establish that they are interchangeable for crafting, equipment, or allocation.</small>}
      <small>Account membership, access, and transferability: UNKNOWN. {candidate.reason}</small>
      {candidate.unresolvedSections.length > 0 && <small>Unresolved: {candidate.unresolvedSections.join(", ")}</small>}
      {plannedSourceIdentityKey === candidate.sourceIdentityKey ? <small>Recorded as the planned source (intent only).</small> : <button type="button" disabled={sourceChangeBlocked || disabled} title={sourceChangeBlocked ? sourceChangeBlockReason : "Record source intent only; no resource is moved."} onClick={() => onChooseSource(candidate.sourceIdentityKey)}>Set planned source</button>}
      {existingInvestigation(candidate) ? <small>Source verification work order already exists for this need.</small> : <button type="button" disabled={disabled} onClick={() => onCreateInvestigation(candidate)}>Create source verification task</button>}{candidate.state === "OBSERVED" && candidate.freshness === "recent" && candidate.reservationState === "UNRESERVED" && candidate.activeReservationQuantity === 0 && <>{existingProvisioning(candidate) ? <small>Provisioning review already exists for this source and recipient.</small> : <><button type="button" disabled={disabled} title="Create a manual review using this location lead; the existing need source is unchanged and no resource is moved." onClick={() => onCreateProvisioning(candidate)}>Plan manual provisioning review</button><small>This adds this observed location as the source lead for a manual review only; the need's planned source is unchanged and no resource is moved.</small></>}</>}
    </li>)}</ul> : <p>No positive matching quantity was found in the other imported same-version character observations.</p>}
    {sourceChangeBlocked && <small>{sourceChangeBlockReason}</small>}
    {screen.candidatesTruncated && <small>Showing {screen.candidates.length} of {screen.candidateCount} possible sources, ordered by evidence state and character identity; this is not a priority ranking.</small>}
    {screen.unresolvedCharacterCount > 0 && <small>{screen.unresolvedCharacterCount} other character observation(s) had stale, partial, or unknown storage evidence; absence from those records is not treated as proof of no supply.</small>}
  </section>;
}

function ResourceCommitmentPanel({ lines, totalCount, truncated, sourceLabel, characterName, openNeed, openProject }: { lines: readonly ErpResourceCommitmentLine[]; totalCount: number; truncated: boolean; sourceLabel: (line: ErpResourceCommitmentLine) => string; characterName: (identityKey?: string) => string; openNeed: (projectId: string, needId: string) => void; openProject: (projectId: string) => void }) {
  const [filter, setFilter] = useState<"ALL" | "REVIEW" | "RESERVED">("ALL");
  const [query, setQuery] = useState("");
  const needsReview = (line: ErpResourceCommitmentLine) => line.sourceScope === "UNKNOWN_SOURCE" || line.freshness !== "recent" || line.reservationState === "OVER_RESERVED" || line.reservationState === "UNKNOWN" || line.overlappingResourceKeys.length > 0 || line.unresolvedSections.length > 0;
  const ordered = [...lines].sort((a, b) => Number(needsReview(b)) - Number(needsReview(a)) || a.label.localeCompare(b.label) || a.resourceKey.localeCompare(b.resourceKey));
  const visible = ordered.filter((line) => {
    if (filter === "REVIEW" && !needsReview(line)) return false;
    if (filter === "RESERVED" && line.activeReservationQuantity === 0 && !line.overlappingReservationQuantity) return false;
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${line.label} ${line.kind} ${line.resourceKey} ${sourceLabel(line)} ${line.contributors.map((entry) => entry.projectTitle).join(" ")}`.toLocaleLowerCase().includes(needle);
  });
  const sectionLabel = (section: ErpResourceCommitmentLine["sourceSections"][number]["section"]) => section === "character bank" ? "Character bank" : section === "shared storage" ? "Shared storage" : section === "bags" ? "Bags" : section === "currencies" ? "Currencies" : "Character";
  const sectionRows = (line: ErpResourceCommitmentLine) => {
    if (line.sourceScope === "UNKNOWN_SOURCE") return [];
    const grouped = new Map<string, ErpResourceCommitmentLine["sourceSections"][number][]>();
    for (const section of line.sourceSections) grouped.set(section.section, [...(grouped.get(section.section) ?? []), section]);
    return [...grouped.entries()].map(([section, records]) => {
      const distinct = [...new Map(records.map((record) => [JSON.stringify(record), record])).values()];
      if (distinct.length > 1) return { section: sectionLabel(section as ErpResourceCommitmentLine["sourceSections"][number]["section"]), detail: `Conflicting section assessments (${distinct.length}); quantity UNKNOWN.` };
      const record = distinct[0]!;
      const itemResource = line.kind === "ITEM_ID" || line.kind === "ITEM_REF";
      const quantity = record.matchingQuantity !== undefined ? `${record.matchingQuantity} matching ${record.matchingQuantity === 1 ? "unit" : "units"}`
        : record.matchingPotentialQuantity !== undefined ? `${record.matchingPotentialQuantity} matching ${record.matchingPotentialQuantity === 1 ? "unit" : "units"} LAST_SEEN`
          : record.state === "UNKNOWN" ? itemResource ? "contents UNKNOWN" : "resource-specific value UNKNOWN" : itemResource ? "matching quantity UNKNOWN" : "resource-specific value is summarized above; section quantity detail unavailable";
      const completeness = record.completeness ? ` · ${record.completeness}` : "";
      return { section: sectionLabel(record.section), detail: `${record.state} · ${quantity}${completeness} · seen ${when(record.observedAt)}` };
    });
  };
  return <section className="erp-resource-commitments" aria-labelledby="erp-resource-commitments-title">
    <h2 id="erp-resource-commitments-title">Resource commitments</h2>
    <p>Planning demand and reservations are intent. Observed supply is shown once per explicit source and exact resource key. Rows with overlapping item scopes must not be added together; this view does not establish access or ownership beyond the source evidence.</p>
    {lines.length > 0 && <div className="erp-commitment-controls"><label>Commitment filter<select aria-label="Commitment filter" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="ALL">All resources</option><option value="REVIEW">Needs review</option><option value="RESERVED">Has reservations</option></select></label><label>Search commitments<input aria-label="Search commitments" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Resource, source, or project" /></label><span aria-live="polite">Showing {visible.length} of {totalCount} resource scopes · {ordered.filter(needsReview).length} need review</span></div>}
    {lines.length === 0 ? <p>No resource needs are recorded for this version.</p> : visible.length === 0 ? <p>No commitments match this filter.</p> : <div className="erp-commitment-list">{visible.map((line) => <article className="erp-commitment-card" key={`${line.version}:${line.sourceScope}:${line.sourceIdentityKey ?? line.sourceOwnerKey ?? "?"}:${line.kind}:${line.resourceKey}`}>
      <h3>{line.label} <small>{line.kind}: <code>{line.resourceKey}</code></small></h3>
      <p><strong>Source:</strong> {sourceLabel(line)} · <strong>Freshness:</strong> {line.freshness}{line.observedAt ? ` · observed ${when(line.observedAt)}` : " · observation time unknown"}</p>
      <dl><div><dt>Active plan demand</dt><dd>{line.activeNeedCount} needs · {line.activeNeedQuantity} requested</dd></div><div><dt>Paused plan demand</dt><dd>{line.pausedNeedCount} needs · {line.pausedNeedQuantity} requested</dd></div><div><dt>Reservations on these exact needs</dt><dd>{line.activeReservationQuantity}{line.overlappingReservationQuantity ? ` · plus ${line.overlappingReservationQuantity} on overlapping scopes` : ""} · {line.reservationState.replaceAll("_", " ")}</dd></div><div><dt>{line.freshness === "stale" ? "Last observed quantity" : line.freshness === "recent" ? "Recently observed quantity" : "Observed quantity"}</dt><dd>{line.observedQuantity === undefined ? "UNKNOWN" : line.observedQuantity}{line.potentialQuantity !== undefined ? ` · ${line.potentialQuantity} LAST_SEEN possible` : ""}{line.availableObservedLowerBound !== undefined ? ` · at least ${line.availableObservedLowerBound} unreserved under this exact scope` : ""}</dd></div></dl>
      {(() => { const rows = sectionRows(line); return <details className="erp-commitment-sections"><summary>Source-section evidence</summary><p>Section quantities describe their own captured locations and timestamps. Do not add them to the aggregate or to other overlapping identity rows. LAST_SEEN is historical; UNKNOWN is not empty.</p>{line.sourceScope === "UNKNOWN_SOURCE" ? <p>Location details are unavailable because no explicit source is selected.</p> : rows.length ? <ul>{rows.map((entry) => <li key={entry.section}><strong>{entry.section}:</strong> {entry.detail}</li>)}</ul> : <p>No source-section detail is available in this evidence.</p>}</details>; })()}
      {line.overlappingResourceKeys.length > 0 && <p role="note"><strong>Scope overlap:</strong> also planned as {line.overlappingResourceKeys.join(", ")}. These resource identities may overlap; do not total their rows together.</p>}
      {line.overlappingReservations.length > 0 && <details><summary>{line.overlappingReservations.length} active reservation{line.overlappingReservations.length === 1 ? "" : "s"} on overlapping item scope{line.overlappingReservations.length === 1 ? "" : "s"}</summary><p>These reservations use a different base-item or exact-variant identity at the same explicit source. Their quantities can overlap the row above and are not summed as independent stock.</p><ul>{line.overlappingReservations.map((entry) => <li key={entry.reservationId}><strong>{entry.projectTitle}</strong> · {entry.projectStatus.toLowerCase()} · {entry.quantity} reserved against {entry.kind} <code>{entry.resourceKey}</code>{entry.ambiguous ? " · exact allocation is ambiguous" : ""} <button type="button" onClick={() => openProject(entry.projectId)}>Open project</button></li>)}</ul></details>}
      {line.unresolvedSections.length > 0 && <p>Unresolved evidence sections: {line.unresolvedSections.join(", ")}.</p>}
      {line.contributors.length > 0 && <details><summary>{line.contributorCount} contributing plan need{line.contributorCount === 1 ? "" : "s"}{line.contributorsTruncated ? " (list truncated)" : ""}</summary><ul>{line.contributors.map((entry) => <li key={`${entry.projectId}:${entry.needId}`}><button type="button" className="erp-commitment-need-link" aria-label={`Review ${entry.projectTitle}: ${entry.label} requirement and reservation`} onClick={() => openNeed(entry.projectId, entry.needId)}>{entry.projectTitle}: {entry.label}</button> · {entry.projectStatus} · priority {entry.priority} · requires {entry.requiredQuantity}{entry.destinationIdentityKey ? ` · intended recipient ${characterName(entry.destinationIdentityKey)}` : ""}</li>)}</ul></details>}</article>)}</div>}
    {truncated && <p>Showing {lines.length} of {totalCount} resource scopes. Review individual project needs for additional scopes.</p>}
  </section>;
}
