import test from "node:test";
import assert from "node:assert/strict";
import { canReviewBill } from "../shared/bill-approval.ts";

test("bill review policy uses exact base-currency limits and never bypasses separation", () => {
  const bill = { created_by: "creator", base_minor: "9007199254740993" };
  const policy = {
    bill_finance_limit_minor: "9007199254740993",
    bill_separate_approver: false,
  };
  assert.equal(canReviewBill("finance", "other", bill, policy), true);
  assert.equal(
    canReviewBill(
      "finance",
      "other",
      { ...bill, base_minor: "9007199254740994" },
      policy,
    ),
    false,
  );
  for (const role of ["sales", "viewer", "Admin", "__proto__", "unknown"])
    assert.equal(canReviewBill(role, "other", bill, policy), false);
  assert.equal(
    canReviewBill("admin", "creator", bill, {
      ...policy,
      bill_separate_approver: true,
    }),
    false,
  );
  assert.equal(
    canReviewBill("admin", "other", bill, {
      ...policy,
      bill_finance_limit_minor: null,
    }),
    true,
  );
  assert.equal(
    canReviewBill("finance", "other", bill, {
      ...policy,
      bill_finance_limit_minor: null,
    }),
    false,
  );
});
