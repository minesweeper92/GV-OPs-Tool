import { hasCapability, type PermissionSubject } from "./permissions.ts";

// "finance" means anyone who may post to the books (finance or an
// administrator); "admin" means an administrator only.
export type ApprovalRole = "finance" | "admin";
export interface ApprovalTier {
  from_minor: string;
  steps: { role: ApprovalRole }[];
}
export const approvalLimits = { tiers: 5, steps: 4 } as const;

export interface BillApprovalPolicy {
  bill_finance_limit_minor: string | null;
  bill_separate_approver: boolean;
  bill_two_stage?: boolean;
  bill_approval_tiers?: ApprovalTier[] | null;
}
export interface ReviewableBill {
  approval_policy?:
    | (BillApprovalPolicy & {
        bill_approval_version: number;
        source: "submission" | "upgrade";
      })
    | null;
  created_by: string;
  base_minor: string;
  reviewed_by?: string | null;
  // Approvers of the current submission, in step order.
  approvals?: readonly string[];
}

// Entities that predate tiered rules keep their exact behaviour: the finance
// limit and two-stage switch translate into equivalent tiers.
export function approvalTiers(policy: BillApprovalPolicy): ApprovalTier[] {
  if (policy.bill_approval_tiers?.length) return policy.bill_approval_tiers;
  if (policy.bill_two_stage)
    return [
      { from_minor: "0", steps: [{ role: "finance" }, { role: "admin" }] },
    ];
  if (policy.bill_finance_limit_minor === null)
    return [{ from_minor: "0", steps: [{ role: "admin" }] }];
  return [
    { from_minor: "0", steps: [{ role: "finance" }] },
    {
      from_minor: String(BigInt(policy.bill_finance_limit_minor) + 1n),
      steps: [{ role: "admin" }],
    },
  ];
}

// Tiers compare the bill's stored base-currency amount, never its
// foreign-currency face value. The highest tier the amount reaches applies.
export function approvalPlan(policy: BillApprovalPolicy, baseMinor: string) {
  const tiers = approvalTiers(policy),
    amount = BigInt(baseMinor);
  let index = 0;
  tiers.forEach((tier, i) => {
    if (amount >= BigInt(tier.from_minor)) index = i;
  });
  return { tiers, index, steps: tiers[index].steps };
}

// Returns null when the tiers are valid, otherwise a reason to show.
export function tierProblem(tiers: ApprovalTier[]): string | null {
  if (!tiers.length || tiers.length > approvalLimits.tiers)
    return `Use between 1 and ${approvalLimits.tiers} amount tiers.`;
  if (tiers[0].from_minor !== "0")
    return "The first tier must start at zero so every bill has reviewers.";
  for (let i = 0; i < tiers.length; i++) {
    const steps = tiers[i].steps;
    if (!steps.length || steps.length > approvalLimits.steps)
      return `Each tier needs between 1 and ${approvalLimits.steps} approval steps.`;
    if (i && BigInt(tiers[i].from_minor) <= BigInt(tiers[i - 1].from_minor))
      return "Each tier must start above the previous tier.";
  }
  return null;
}

export function canReviewBill(
  subject: PermissionSubject,
  userId: string,
  bill: ReviewableBill,
  policy: BillApprovalPolicy,
): boolean {
  return billReviewDecision(subject, userId, bill, policy).allowed;
}

// The subject's effective capabilities gate review; the built-in role decides
// which steps they may complete, which custom profiles cannot change.
export function billReviewDecision(
  subject: PermissionSubject,
  userId: string,
  bill: ReviewableBill,
  policy: BillApprovalPolicy | undefined,
): {
  allowed: boolean;
  reason: string;
  action?: "review" | "approve";
  step?: number;
  steps?: number;
  waitingFor?: ApprovalRole;
} {
  policy = bill.approval_policy || policy;
  if (!policy)
    return {
      allowed: false,
      reason:
        "Approval rules are unavailable. Refresh before reviewing this bill.",
    };
  const role = typeof subject === "object" && subject ? subject.role : subject;
  const { index, steps } = approvalPlan(policy, bill.base_minor);
  const approvals =
    bill.approvals ?? (bill.reviewed_by ? [bill.reviewed_by] : []);
  // Submitted bills use their retained policy; later settings never shrink it.
  const at = Math.min(approvals.length, steps.length - 1),
    n = steps.length,
    next = steps[at],
    final = at === n - 1,
    label = n > 1 ? `Step ${at + 1} of ${n}` : "",
    stage = { step: at + 1, steps: n, waitingFor: next.role };
  if (!hasCapability(subject, "books.post"))
    return {
      allowed: false,
      ...stage,
      reason:
        "Permission to record financial transactions is required to review vendor bills.",
    };
  if (policy.bill_separate_approver && userId === bill.created_by)
    return {
      allowed: false,
      ...stage,
      reason:
        "A different person must review this bill because you created it.",
    };
  if (approvals.includes(userId))
    return {
      allowed: false,
      ...stage,
      reason:
        final && next.role === "admin"
          ? "A different administrator must give final approval because you approved an earlier step."
          : `A different person must complete ${label.toLowerCase() || "this step"} because you approved an earlier step.`,
    };
  if (next.role === "admin" && role !== "admin")
    return {
      allowed: false,
      ...stage,
      reason:
        n === 1
          ? index > 0
            ? "This bill exceeds your finance approval limit in PKR. An administrator must review it."
            : "This entity requires an administrator to review vendor bills."
          : final
            ? `${label}: an administrator must give final approval.`
            : `${label} needs an administrator.`,
    };
  return {
    allowed: true,
    ...stage,
    action: final ? "approve" : "review",
    reason: final
      ? n > 1
        ? `${label}: final approval posts the bill to the books.`
        : role === "admin"
          ? "Ready for administrator review."
          : "Within your finance approval limit in PKR."
      : `${label}: approval needed. Nothing posts until the final step${
          steps.slice(at + 1).some((s) => s.role === "admin")
            ? ", which needs an administrator"
            : ""
        }.`,
  };
}
