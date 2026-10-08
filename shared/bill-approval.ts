import { hasCapability, type PermissionSubject } from "./permissions.ts";

export interface BillApprovalPolicy {
  bill_finance_limit_minor: string | null;
  bill_separate_approver: boolean;
  bill_two_stage?: boolean;
}
// Limit is compared with the bill's stored base-currency amount, never its
// foreign-currency face value. Null preserves administrator-only approval.
export function canReviewBill(
  subject: PermissionSubject,
  userId: string,
  bill: { created_by: string; base_minor: string; reviewed_by?: string | null },
  policy: BillApprovalPolicy,
): boolean {
  return billReviewDecision(subject, userId, bill, policy).allowed;
}

// The subject's effective capabilities gate review; the built-in role still
// decides limits and final approval, which custom profiles cannot change.
export function billReviewDecision(
  subject: PermissionSubject,
  userId: string,
  bill: { created_by: string; base_minor: string; reviewed_by?: string | null },
  policy: BillApprovalPolicy | undefined,
): { allowed: boolean; reason: string; action?: "review" | "approve" } {
  if (!policy)
    return {
      allowed: false,
      reason:
        "Approval rules are unavailable. Refresh before reviewing this bill.",
    };
  const role = typeof subject === "object" && subject ? subject.role : subject;
  if (!hasCapability(subject, "books.post"))
    return {
      allowed: false,
      reason:
        "Permission to record financial transactions is required to review vendor bills.",
    };
  if (policy.bill_separate_approver && userId === bill.created_by)
    return {
      allowed: false,
      reason:
        "A different person must review this bill because you created it.",
    };
  if (policy.bill_two_stage) {
    if (!bill.reviewed_by)
      return {
        allowed: true,
        action: "review",
        reason:
          "First review required. An administrator must approve afterward; first review does not post to the books.",
      };
    if (userId === bill.reviewed_by)
      return {
        allowed: false,
        reason:
          "A different administrator must give final approval because you completed the first review.",
      };
    if (role !== "admin")
      return {
        allowed: false,
        reason:
          "First review is complete. An administrator must give final approval.",
      };
    return {
      allowed: true,
      action: "approve",
      reason: "First review complete. Ready for final administrator approval.",
    };
  }
  if (role === "admin")
    return { allowed: true, reason: "Ready for administrator review." };
  if (policy.bill_finance_limit_minor === null)
    return {
      allowed: false,
      reason: "This entity requires an administrator to review vendor bills.",
    };
  if (BigInt(bill.base_minor) > BigInt(policy.bill_finance_limit_minor))
    return {
      allowed: false,
      reason:
        "This bill exceeds your finance approval limit in PKR. An administrator must review it.",
    };
  return {
    allowed: true,
    reason: "Within your finance approval limit in PKR.",
  };
}
