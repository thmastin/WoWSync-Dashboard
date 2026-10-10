export function erpNeedAnchorId(projectId: string, needId: string): string {
  // encodeURIComponent leaves hyphens untouched, so escape them to keep the separator unambiguous.
  return `erp-need-${encodeURIComponent(projectId).replaceAll("-", "%2D")}-${encodeURIComponent(needId).replaceAll("-", "%2D")}`;
}

export function erpWorkOrderAnchorId(projectId: string, workOrderId: string): string {
  return `erp-work-order-${encodeURIComponent(projectId).replaceAll("-", "%2D")}-${encodeURIComponent(workOrderId).replaceAll("-", "%2D")}`;
}

export function erpSavedNeedHistoryAnchorId(projectId: string, needId: string): string {
  // Keep the separator unambiguous when either stable identifier contains hyphens.
  return `erp-saved-need-history-${encodeURIComponent(projectId).replaceAll("-", "%2D")}-${encodeURIComponent(needId).replaceAll("-", "%2D")}`;
}

export function erpSourceFulfillmentAnchorId(stableId: string): string {
  return `erp-source-fulfillment-${encodeURIComponent(stableId)}`;
}

export function erpReservationScopeAnchorId(line: { version: string; sourceScope: string; sourceIdentityKey?: string; sourceOwnerKey?: string; kind: string; resourceKey: string }): string {
  return `erp-reservation-scope-${encodeURIComponent(JSON.stringify([line.version, line.sourceScope, line.sourceIdentityKey, line.sourceOwnerKey, line.kind, line.resourceKey]))}`;
}
