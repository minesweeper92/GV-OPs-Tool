export interface RemittanceAdvice {
  reference: string;
  date: string;
  issuer: string;
  issuerAddress: string;
  vendor: string;
  currency: string;
  reversedOn: string | null;
  reversalReason: string;
  cash: string;
  withheld: string;
  bankFee: string;
  allocations: { reference: string; cash: string; withheld: string }[];
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function amount(value: string, currency: string) {
  const n = BigInt(value);
  if (n < 0n) throw new Error("Remittance amounts must be non-negative.");
  return `${escape(currency)} ${new Intl.NumberFormat("en-GB").format(n / 100n)}.${String(n % 100n).padStart(2, "0")}`;
}
// A printable record of an existing payment, not an instruction to transfer
// money, a tax certificate, or an immutable customer-facing company snapshot.
export function remittanceHtml(p: RemittanceAdvice) {
  if (
    p.allocations.reduce((n, a) => n + BigInt(a.cash), 0n) !== BigInt(p.cash) ||
    p.allocations.reduce((n, a) => n + BigInt(a.withheld), 0n) !==
      BigInt(p.withheld)
  )
    throw new Error(
      "Payment allocations do not reconcile to the recorded totals.",
    );
  const rows = p.allocations
    .map(
      (a) =>
        `<tr><td>${escape(a.reference)}</td><td>${amount(a.cash, p.currency)}</td><td>${amount(a.withheld, p.currency)}</td><td>${amount(String(BigInt(a.cash) + BigInt(a.withheld)), p.currency)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Remittance advice — ${escape(p.reference)}</title><style>body{font:14px system-ui,sans-serif;color:#202127;margin:40px;max-width:1000px}h1{font-size:26px}h2{font-size:18px}address{font-style:normal;white-space:pre-line}table{width:100%;border-collapse:collapse;margin:24px 0}th,td{padding:12px;border-bottom:1px solid #ddd;text-align:right}th:first-child,td:first-child{text-align:left}.warning{border:2px solid #9b2424;padding:16px;color:#9b2424}.summary{margin-left:auto;max-width:380px}.summary p{display:flex;justify-content:space-between;gap:20px}footer{margin-top:40px;font-size:12px;color:#545454}@media print{body{margin:0}tr{break-inside:avoid}thead{display:table-header-group}@page{margin:18mm}}</style></head><body>
  <h1>Remittance advice</h1>${p.reversedOn ? `<p class="warning"><strong>REVERSED — not a current payment</strong><br>Reversed ${escape(p.reversedOn)}: ${escape(p.reversalReason)}</p>` : ""}
  <h2>${escape(p.issuer)}</h2><address>${escape(p.issuerAddress)}</address><p><strong>Paid to:</strong> ${escape(p.vendor)}</p><p><strong>Payment reference:</strong> ${escape(p.reference)}<br><strong>Payment date:</strong> ${escape(p.date)}<br><strong>Currency:</strong> ${escape(p.currency)}</p>
  <table><thead><tr><th>Vendor bill reference</th><th>Cash allocated</th><th>Withheld</th><th>Bill balance settled</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="summary"><p><span>Cash paid to vendor</span><strong>${amount(p.cash, p.currency)}</strong></p><p><span>Withholding deducted</span><strong>${amount(p.withheld, p.currency)}</strong></p><p><span>Total bills settled</span><strong>${amount(String(BigInt(p.cash) + BigInt(p.withheld)), p.currency)}</strong></p><p><span>Separate bank charge</span><span>${amount(p.bankFee, p.currency)}</span></p></div>
  <footer>This advice records a payment entered in the books; it does not initiate or prove a bank transfer. Bank charges are not included in the cash paid to the vendor. Withholding shown is not a statutory tax certificate. Company name and address use the current directory; financial amounts and bill allocations come from the recorded payment.</footer></body></html>`;
}
