export interface BillApprovalPolicy {
  bill_finance_limit_minor: string | null;
  bill_separate_approver: boolean;
}
// Limit is compared with the bill's stored base-currency amount, never its
// foreign-currency face value. Null preserves administrator-only approval.
export function canReviewBill(
  role: string,
  userId: string,
  bill: { created_by: string; base_minor: string },
  policy: BillApprovalPolicy,
): boolean {
  return billReviewDecision(role, userId, bill, policy).allowed;
}

export function billReviewDecision(
  role: string,
  userId: string,
  bill: { created_by: string; base_minor: string },
  policy: BillApprovalPolicy | undefined,
): { allowed: boolean; reason: string } {
  if (!policy)
    return {
      allowed: false,
      reason:
        "Approval rules are unavailable. Refresh before reviewing this bill.",
    };
  if (role !== "admin" && role !== "finance")
    return {
      allowed: false,
      reason:
        "A finance or administrator role is required to review vendor bills.",
    };
  if (policy.bill_separate_approver && userId === bill.created_by)
    return {
      allowed: false,
      reason:
        "A different person must review this bill because you created it.",
    };
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
