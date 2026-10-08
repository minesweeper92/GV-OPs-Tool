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

test("two-stage approval never lets the first reviewer post or skip final administrator approval", () => {
  const policy = {
    bill_finance_limit_minor: "100000",
    bill_separate_approver: false,
    bill_two_stage: true,
  };
  const bill = {
    created_by: "maker",
    base_minor: "50000",
    reviewed_by: null as string | null,
  };
  assert.equal(
    billReviewDecision("finance", "first", bill, policy).action,
    "review",
  );
  const reviewed = { ...bill, reviewed_by: "first" };
  assert.equal(
    billReviewDecision("admin", "first", reviewed, policy).allowed,
    false,
  );
  assert.equal(
    billReviewDecision("finance", "another", reviewed, policy).allowed,
    false,
  );
  assert.equal(
    billReviewDecision("admin", "final", reviewed, policy).action,
    "approve",
  );
  assert.equal(
    billReviewDecision("sales", "first", bill, policy).allowed,
    false,
  );
});

test("bill review follows effective capabilities, not the base role alone", () => {
  const bill = { created_by: "creator", base_minor: "100" };
  const policy = {
    bill_finance_limit_minor: "1000",
    bill_separate_approver: false,
  };
  const narrowed = { role: "finance", capabilities: ["books.view"] };
  const full = {
    role: "finance",
    capabilities: ["books.view", "books.post", "contacts.manage"],
  };
  assert.deepEqual(billReviewDecision(narrowed, "other", bill, policy), {
    allowed: false,
    reason:
      "Permission to record financial transactions is required to review vendor bills.",
  });
  assert.equal(canReviewBill(full, "other", bill, policy), true);
  // A profile cannot grant what its template lacks.
  assert.equal(
    canReviewBill(
      { role: "sales", capabilities: ["books.post"] },
      "other",
      bill,
      policy,
    ),
    false,
  );
});
