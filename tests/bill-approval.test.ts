import test from "node:test";
import assert from "node:assert/strict";
import {
  canReviewBill,
  billReviewDecision,
  approvalTiers,
  tierProblem,
} from "../shared/bill-approval.ts";

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
  const refused = billReviewDecision(narrowed, "other", bill, policy);
  assert.equal(refused.allowed, false);
  assert.equal(
    refused.reason,
    "Permission to record financial transactions is required to review vendor bills.",
  );
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

test("legacy settings translate to equivalent tiers", () => {
  const base = { bill_separate_approver: false };
  assert.deepEqual(
    approvalTiers({ ...base, bill_finance_limit_minor: "1000" }),
    [
      { from_minor: "0", steps: [{ role: "finance" }] },
      { from_minor: "1001", steps: [{ role: "admin" }] },
    ],
  );
  assert.deepEqual(approvalTiers({ ...base, bill_finance_limit_minor: null }), [
    { from_minor: "0", steps: [{ role: "admin" }] },
  ]);
  assert.deepEqual(
    approvalTiers({
      ...base,
      bill_finance_limit_minor: "1000",
      bill_two_stage: true,
    }),
    [{ from_minor: "0", steps: [{ role: "finance" }, { role: "admin" }] }],
  );
});

test("tiered rules pick steps by amount and need a different person per step", () => {
  const policy = {
    bill_finance_limit_minor: null,
    bill_separate_approver: true,
    bill_approval_tiers: [
      { from_minor: "0", steps: [{ role: "finance" as const }] },
      {
        from_minor: "50000000",
        steps: [
          { role: "finance" as const },
          { role: "finance" as const },
          { role: "admin" as const },
        ],
      },
    ],
  };
  const small = { created_by: "maker", base_minor: "49999999" };
  assert.equal(
    billReviewDecision("finance", "a", small, policy).action,
    "approve",
  );
  const large = { created_by: "maker", base_minor: "50000000", approvals: [] };
  const first = billReviewDecision("finance", "a", large, policy);
  assert.deepEqual([first.action, first.step, first.steps], ["review", 1, 3]);
  assert.match(first.reason, /Step 1 of 3.*administrator/);
  // The creator cannot approve any step; nobody approves two steps.
  assert.match(
    billReviewDecision("admin", "maker", large, policy).reason,
    /created it/,
  );
  const second = { ...large, approvals: ["a"] };
  assert.match(
    billReviewDecision("finance", "a", second, policy).reason,
    /step 2 of 3 because you approved an earlier step/,
  );
  assert.equal(
    billReviewDecision("finance", "b", second, policy).action,
    "review",
  );
  const last = { ...large, approvals: ["a", "b"] };
  const waiting = billReviewDecision("finance", "c", last, policy);
  assert.equal(waiting.allowed, false);
  assert.equal(waiting.waitingFor, "admin");
  assert.match(waiting.reason, /Step 3 of 3: an administrator/);
  assert.equal(
    billReviewDecision("admin", "d", last, policy).action,
    "approve",
  );
  assert.match(
    billReviewDecision("admin", "a", last, policy).reason,
    /different administrator/,
  );
  // If rules shrink after approvals, the remaining step is the final one.
  const shrunk = {
    ...policy,
    bill_approval_tiers: [policy.bill_approval_tiers[0]],
  };
  assert.equal(
    billReviewDecision("finance", "c", last, shrunk).action,
    "approve",
  );
});

test("tier validation rejects gaps, disorder and empty steps", () => {
  const step = [{ role: "finance" as const }];
  assert.equal(tierProblem([{ from_minor: "0", steps: step }]), null);
  assert.match(
    tierProblem([{ from_minor: "5", steps: step }])!,
    /start at zero/,
  );
  assert.match(
    tierProblem([
      { from_minor: "0", steps: step },
      { from_minor: "0", steps: step },
    ])!,
    /above the previous/,
  );
  assert.match(
    tierProblem([{ from_minor: "0", steps: [] }])!,
    /between 1 and 4/,
  );
  assert.match(tierProblem([])!, /between 1 and 5/);
});
