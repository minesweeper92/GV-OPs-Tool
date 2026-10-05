import test from "node:test";
import assert from "node:assert/strict";
import { remittanceHtml, type RemittanceAdvice } from "../shared/remittance.ts";
const payment: RemittanceAdvice = {
  reference: "PAY-1",
  date: "2026-10-06",
  issuer: "Company",
  issuerAddress: "Lahore",
  vendor: "Vendor",
  currency: "PKR",
  reversedOn: null,
  reversalReason: "",
  cash: "2500000",
  withheld: "100000",
  bankFee: "5000",
  allocations: [
    { reference: "BILL-1", cash: "1000000", withheld: "100000" },
    { reference: "BILL-2", cash: "1500000", withheld: "0" },
  ],
};
test("remittance reconciles bill allocations and keeps bank fees separate from vendor cash", () => {
  const html = remittanceHtml(payment);
  assert.match(html, /PKR 25,000\.00/);
  assert.match(html, /PKR 26,000\.00/);
  assert.match(html, /PKR 50\.00/);
  assert.throws(
    () => remittanceHtml({ ...payment, cash: "2500001" }),
    /reconcile/,
  );
  assert.throws(
    () => remittanceHtml({ ...payment, bankFee: "-1" }),
    /non-negative/,
  );
});
test("remittance escapes directory and reference text, marks reversals and preserves large integer cents", () => {
  const html = remittanceHtml({
    ...payment,
    issuer: '<script>alert("x")</script>',
    reference: "<img src=x onerror=alert(1)>",
    reversedOn: "2026-10-07",
    reversalReason: "Wrong & duplicated",
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /REVERSED/);
  assert.match(html, /Wrong &amp; duplicated/);
  assert.match(
    remittanceHtml({
      ...payment,
      cash: "9000000000000001",
      withheld: "0",
      allocations: [
        { reference: "Exact cents", cash: "9000000000000001", withheld: "0" },
      ],
    }),
    /90,000,000,000,000\.01/,
  );
});
