import { createHash } from "node:crypto";
import type { WowVersion } from "./types.ts";

export type ErpChangeOperation = "CREATE_PROJECT" | "UPDATE_PROJECT_PLAN" | "SET_PROJECT_STATUS" | "APPEND_WORK_ORDER_BATCH" | "REPLAN_RESERVATIONS";
export type ErpChangeProposalStatus = "PENDING" | "APPROVED" | "REJECTED" | "COMMITTING" | "COMMITTED" | "FAILED";

/** Immutable, version-scoped request awaiting a separate Dashboard approval. */
export interface ErpChangeProposal {
  readonly proposalId: string;
  readonly version: WowVersion;
  readonly operation: ErpChangeOperation;
  readonly projectIds: readonly string[];
  readonly expectedRevisions: Readonly<Record<string, number>>;
  readonly rationale: string;
  readonly mutation: Readonly<Record<string, unknown>>;
  readonly digest: string;
  readonly status: ErpChangeProposalStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly approvedAt?: number;
  readonly completedAt?: number;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly outcome?: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function erpChangeDigest(value: Pick<ErpChangeProposal, "version" | "operation" | "projectIds" | "expectedRevisions" | "rationale" | "mutation">): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
