export function erpNeedAnchorId(projectId: string, needId: string): string {
  // encodeURIComponent leaves hyphens untouched, so escape them to keep the separator unambiguous.
  return `erp-need-${encodeURIComponent(projectId).replaceAll("-", "%2D")}-${encodeURIComponent(needId).replaceAll("-", "%2D")}`;
}

export function erpWorkOrderAnchorId(projectId: string, workOrderId: string): string {
  return `erp-work-order-${encodeURIComponent(projectId).replaceAll("-", "%2D")}-${encodeURIComponent(workOrderId).replaceAll("-", "%2D")}`;
}
