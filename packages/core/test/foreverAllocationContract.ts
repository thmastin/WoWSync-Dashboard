type AllocationPlanRow = {
  disposition?: string;
  item?: { itemRef?: string };
  source?: { identityKey?: string; location?: string };
  recipient?: { identityKey?: string };
  evidence?: { transferability?: string };
};

type RecipientEvaluation = {
  source?: { identityKey?: string };
  recipients?: Array<{ identityKey?: string; transferability?: string }>;
};

type Assessment = {
  source?: { identityKey?: string };
  recipient?: { identityKey?: string };
  transferability?: string;
};

type ForeverAllocation = {
  version?: string;
  ruleset?: string;
  scope?: { accountMembership?: string };
  allocationPlan?: AllocationPlanRow[];
  recipientEvaluations?: RecipientEvaluation[];
  assessments?: Assessment[];
};

/**
 * Validation-only invariants for the public Forever allocation projection.
 * These guard evidence boundaries; they do not calculate or rank allocations.
 */
export function foreverAllocationContractViolations(value: ForeverAllocation): string[] {
  const violations: string[] = [];
  const checkTransferability = (sourceIdentity: string | undefined, recipientIdentity: string | undefined, transferability: string | undefined, location: string) => {
    if (sourceIdentity && recipientIdentity && sourceIdentity === recipientIdentity && transferability === "ALLOWED") {
      violations.push(`SOURCE_LOCAL_SCREEN_DOES_NOT_ESTABLISH_TRANSFER: ${location} labels a source-local item transfer as ALLOWED`);
    }
    if (value.scope?.accountMembership === "UNKNOWN" && sourceIdentity && recipientIdentity && sourceIdentity !== recipientIdentity && transferability !== "UNKNOWN") {
      violations.push(`UNKNOWN_MEMBERSHIP_DOES_NOT_PROVE_TRANSFER: ${location} crosses characters while account membership is UNKNOWN`);
    }
  };
  if (value.version !== "forever") violations.push("VERSION_ISOLATION: allocation response must identify version=forever");
  if (value.ruleset !== "forever-70291-allocation-screen-v2") violations.push("RULESET_IDENTITY: allocation response must name the Forever 70291 ruleset");
  if (value.scope?.accountMembership !== "UNKNOWN") violations.push("ACCOUNT_MEMBERSHIP_NOT_OBSERVED: allocation response must preserve UNKNOWN membership unless supported evidence says otherwise");
  for (const [index, row] of (value.allocationPlan ?? []).entries()) {
    checkTransferability(row.source?.identityKey, row.recipient?.identityKey, row.evidence?.transferability, `allocationPlan[${index}]`);
    if (!row.item?.itemRef?.startsWith("item:")) {
      violations.push(`EXACT_ITEM_VARIANT_PRESERVED: allocationPlan[${index}] must retain its itemRef`);
    }
    if (row.disposition === "EQUIP_CANDIDATE"
      && row.source?.identityKey !== row.recipient?.identityKey) {
      violations.push(`LOCAL_CANDIDATE_IS_NOT_CROSS_CHARACTER_ALLOCATION: allocationPlan[${index}] is an EQUIP_CANDIDATE across character identities`);
    }
  }
  for (const [evaluationIndex, evaluation] of (value.recipientEvaluations ?? []).entries()) {
    for (const [recipientIndex, recipient] of (evaluation.recipients ?? []).entries()) {
      checkTransferability(evaluation.source?.identityKey, recipient.identityKey, recipient.transferability,
        `recipientEvaluations[${evaluationIndex}].recipients[${recipientIndex}]`);
    }
  }
  for (const [index, assessment] of (value.assessments ?? []).entries()) {
    checkTransferability(assessment.source?.identityKey, assessment.recipient?.identityKey,
      assessment.transferability, `assessments[${index}]`);
  }
  return violations;
}

export function assertForeverAllocationContract(value: ForeverAllocation): void {
  const violations = foreverAllocationContractViolations(value);
  if (violations.length) throw new Error(`Forever allocation evidence contract failed:\n${violations.map((entry) => `- ${entry}`).join("\n")}`);
}
