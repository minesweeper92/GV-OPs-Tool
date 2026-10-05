import { remittanceHtml, type RemittanceAdvice } from "../shared/remittance";
import type { Data, VendorPayment, VendorPaymentBatch } from "./model";
export function openRemittanceAdvice(
  data: Data,
  payment: VendorPayment | VendorPaymentBatch,
) {
  const issuer = data.entities.find((e) => e.id === payment.entity_id);
  if (!issuer) throw new Error("The payment's legal entity is not available.");
  const bill =
    "bill_id" in payment
      ? data.bills.find((b) => b.id === payment.bill_id)
      : null;
  if ("bill_id" in payment && !bill)
    throw new Error("The payment's bill is not available.");
  const advice: RemittanceAdvice = {
    reference: payment.reference,
    date: payment.payment_date.slice(0, 10),
    issuer: issuer.name,
    issuerAddress: issuer.address,
    vendor: "vendor_name" in payment ? payment.vendor_name : bill!.vendor_name,
    currency: "currency" in payment ? payment.currency : bill!.currency,
    reversedOn: payment.reversal_date?.slice(0, 10) || null,
    reversalReason: payment.reversal_reason || "",
    cash: payment.amount_minor,
    withheld: payment.wht_minor,
    bankFee: payment.fee_minor,
    allocations:
      "allocations" in payment
        ? payment.allocations.map((a) => ({
            reference: a.reference,
            cash: a.amount_minor,
            withheld: a.wht_minor,
          }))
        : [
            {
              reference: bill!.reference,
              cash: payment.amount_minor,
              withheld: payment.wht_minor,
            },
          ],
  };
  const html = remittanceHtml(advice);
  const popup = window.open("", "_blank");
  if (!popup)
    throw new Error(
      "Allow pop-ups for this app to open the remittance advice.",
    );
  popup.opener = null;
  popup.document.open();
  popup.document.write(html);
  popup.document.close();
  const style = popup.document.createElement("style");
  style.textContent =
    ".print-controls{margin-bottom:24px}.print-controls button{font:inherit;padding:10px 16px;border:1px solid #aaa;border-radius:6px;background:white;cursor:pointer}@media print{.print-controls{display:none}}";
  popup.document.head.append(style);
  const controls = popup.document.createElement("div");
  controls.className = "print-controls";
  const print = popup.document.createElement("button");
  print.textContent = "Print / Save PDF";
  print.addEventListener("click", () => popup.print());
  controls.append(print);
  popup.document.body.prepend(controls);
  popup.focus();
}
