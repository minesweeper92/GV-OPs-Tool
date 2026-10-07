import test from "node:test";
import assert from "node:assert/strict";
import {
  releasePrepayment,
  prepaymentCostAdjustment,
} from "../shared/prepayment.ts";
test("prepayment releases preserve historical carrying cents across partial and final use", () => {
  let available = 3n,
    base = 841n;
  const first = releasePrepayment(1n, available, base);
  available--;
  base -= first;
  const second = releasePrepayment(1n, available, base);
  available--;
  base -= second;
  const last = releasePrepayment(1n, available, base);
  assert.equal(first + second + last, 841n);
  assert.equal(base - last, 0n);
  assert.throws(() => releasePrepayment(4n, 3n, 841n));
});
test("historical prepayment differences adjust original costs, not recoverable tax or settlement FX", () => {
  const lines = [
    { account_code: "5000", subtotal: "10000", taxMinor: "1800" },
    { account_code: "5200", subtotal: "20000", taxMinor: "0" },
  ];
  const a = prepaymentCostAdjustment(lines, "recoverable", 2001n);
  assert.deepEqual(a, [
    { account: "5000", amount_minor: "667" },
    { account: "5200", amount_minor: "1334" },
  ]);
  assert.equal(
    prepaymentCostAdjustment(lines, "expense", -2001n).reduce(
      (s, l) => s + BigInt(l.amount_minor),
      0n,
    ),
    -2001n,
  );
  assert.ok(prepaymentCostAdjustment(lines, "recoverable", 0n).length === 0);
});
