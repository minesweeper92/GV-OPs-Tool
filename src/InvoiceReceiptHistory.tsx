import { money, day, type Data } from "./model";

// Which customer receipts changed this invoice's balance, including ones later
// reversed, so the history explains the balance instead of just stating it.
export function InvoiceReceiptHistory({
  data,
  invoiceId,
  currency,
}: {
  data: Data;
  invoiceId: string;
  currency: string;
}) {
  const receipt = (id: string) =>
    (data.customerReceipts || []).find((r) => r.id === id);
  const allocations = (data.customerReceiptAllocations || []).filter(
      (a) => a.invoice_id === invoiceId,
    ),
    applications = (data.customerReceiptApplications || []).filter(
      (a) => a.invoice_id === invoiceId,
    );
  if (!allocations.length && !applications.length) return null;
  return (
    <>
      {allocations.map((a) => {
        const r = receipt(a.receipt_id);
        const withheld =
          BigInt(a.wht_minor) + BigInt(a.sales_tax_withheld_minor);
        return (
          <div className="association-item" key={a.id}>
            <strong>{money(a.amount_minor, currency)}</strong>
            <span>
              Receipt{" "}
              <a href={`#customer-receipts/${a.receipt_id}`}>
                {r?.reference || "receipt"}
              </a>
              {withheld > 0n
                ? ` + ${money(String(withheld), currency)} withheld`
                : ""}
              {r?.reversal_date ? ` · reversed ${day(r.reversal_date)}` : ""}
            </span>
            <small>{r ? day(r.receipt_date) : ""}</small>
          </div>
        );
      })}
      {applications.map((a) => (
        <div className="association-item" key={a.id}>
          <strong>{money(a.amount_minor, currency)}</strong>
          <span>
            Cash on account from{" "}
            <a href={`#customer-receipts/${a.receipt_id}`}>
              {receipt(a.receipt_id)?.reference || "receipt"}
            </a>
            {a.reversal_date ? ` · reversed ${day(a.reversal_date)}` : ""}
          </span>
          <small>{day(a.application_date)}</small>
        </div>
      ))}
    </>
  );
}
