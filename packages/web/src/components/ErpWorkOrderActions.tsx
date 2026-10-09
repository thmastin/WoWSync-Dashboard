import type { ErpWorkOrder, ErpWorkOrderStatus } from "@wowsync-dashboard/core";

export function ErpWorkOrderActions({ order, disabled, onStatus, onComplete }: { order: ErpWorkOrder; disabled: boolean; onStatus: (status: ErpWorkOrderStatus) => void; onComplete: () => void }) {
  if (order.status === "COMPLETED" || order.status === "CANCELLED") return null;
  return <div className="erp-work-order-actions" aria-label={`Manual plan status actions for ${order.title}`}>
    {order.status === "PLANNED" && <>
      <button disabled={disabled} title="Changes saved plan state only; performs no game action" onClick={() => onStatus("IN_PROGRESS")}>Mark in progress</button>
      <button disabled={disabled} title="Changes saved plan state only; records no game observation" onClick={() => onStatus("WAITING_FOR_EVIDENCE")}>Wait for evidence</button>
    </>}
    {order.status === "IN_PROGRESS" && <>
      <button disabled={disabled} title="Changes saved plan state only; records no game observation" onClick={() => onStatus("WAITING_FOR_EVIDENCE")}>Wait for evidence</button>
      <button disabled={disabled} title="Returns this player-authored plan step to PLANNED" onClick={() => onStatus("PLANNED")}>Return to planned</button>
    </>}
    {order.status === "WAITING_FOR_EVIDENCE" && <>
      <button disabled={disabled} title="Changes saved plan state only; performs no game action" onClick={() => onStatus("IN_PROGRESS")}>Resume manual work</button>
      <button disabled={disabled} title="Returns this player-authored plan step to PLANNED" onClick={() => onStatus("PLANNED")}>Return to planned</button>
    </>}
    <button disabled={disabled} onClick={onComplete}>Record completion...</button>
  </div>;
}
