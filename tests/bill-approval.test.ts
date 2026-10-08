import test from "node:test";
import assert from "node:assert/strict";
import { canReviewBill, billReviewDecision } from "../shared/bill-approval.ts";

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

test("bill review denials explain missing rules, self-review and finance limits", () => {
  const bill = { created_by: "maker", base_minor: "200" };
  const policy = {
    bill_finance_limit_minor: "100",
    bill_separate_approver: false,
  };
  assert.match(
    billReviewDecision("admin", "other", bill, undefined).reason,
    /unavailable/,
  );
  assert.match(
    billReviewDecision("admin", "maker", bill, {
      ...policy,
      bill_separate_approver: true,
    }).reason,
    /different person/,
  );
  assert.match(
    billReviewDecision("finance", "other", bill, policy).reason,
    /exceeds/,
  );
  assert.match(
    billReviewDecision("finance", "other", bill, {
      ...policy,
      bill_finance_limit_minor: null,
    }).reason,
    /administrator/,
  );
  assert.equal(
    billReviewDecision("sales", "other", bill, policy).allowed,
    false,
  );
});
