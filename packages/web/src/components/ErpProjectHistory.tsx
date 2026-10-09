import type { ErpProjectEvent } from "@wowsync-dashboard/core";

const FIELD_LABELS: Record<string, string> = {
  title: "title", objective: "objective", status: "status", completionNote: "completion note",
  priority: "priority", needs: "resource needs", reservations: "reservations", workOrders: "work orders",
  project: "initial project plan",
};
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();

export function ErpProjectHistory({ events, totalCount, truncated }: { events: readonly ErpProjectEvent[]; totalCount: number; truncated: boolean }) {
  return <details className="erp-history">
    <summary>Project history ({totalCount} recorded changes)</summary>
    <ol>{[...events].reverse().map((event) => <li key={event.eventId}>
      <strong>{event.fromStatus !== undefined ? `Status: ${event.fromStatus.replaceAll("_", " ")} to ${event.toStatus.replaceAll("_", " ")}` : event.kind === "CREATED" ? "Project created" : "Project updated"}</strong>
      <small>Revision {event.revision} | {when(event.occurredAt)} | {event.changedFields.map((field) => FIELD_LABELS[field] ?? field).join(", ") || "no plan fields changed"}</small>
    </li>)}</ol>
    <p>{truncated ? `Showing the latest ${events.length} changes. ` : ""}History records saved Dashboard intent changes. Observation deltas are separately labelled and do not explain their cause or prove a game action.</p>
  </details>;
}
