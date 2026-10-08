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
  if (policy.bill_separate_approver && userId === bill.created_by) return false;
  if (role === "admin") return true;
  return (
    role === "finance" &&
    policy.bill_finance_limit_minor !== null &&
    BigInt(bill.base_minor) <= BigInt(policy.bill_finance_limit_minor)
  );
}
