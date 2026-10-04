import type { DocumentDetails, documentTotals } from "../shared/documents";
import { Field } from "./components";
import { money } from "./model";

type Amounts = ReturnType<typeof documentTotals> | null;

export function DocumentCharges({
  details,
  onChange,
  amounts,
  currency,
}: {
  details: DocumentDetails;
  onChange: (key: keyof DocumentDetails, value: string) => void;
  amounts: Amounts;
  currency: string;
}) {
  return (
    <>
      <div className="document-charge-fields">
        <Field label="Overall discount">
          <input
            required
            inputMode="decimal"
            value={details.document_discount}
            onChange={(event) =>
              onChange("document_discount", event.target.value)
            }
          />
        </Field>
        <Field label="Discount type">
          <select
            value={details.document_discount_type}
            onChange={(event) =>
              onChange("document_discount_type", event.target.value)
            }
          >
            <option value="percent">%</option>
            <option value="amount">{currency} amount</option>
          </select>
        </Field>
        <Field label="Shipping charges">
          <input
            required
            inputMode="decimal"
            value={details.shipping_amount}
            onChange={(event) =>
              onChange("shipping_amount", event.target.value)
            }
          />
        </Field>
        <Field label="Shipping tax %">
          <input
            required
            inputMode="decimal"
            value={details.shipping_tax}
            onChange={(event) => onChange("shipping_tax", event.target.value)}
          />
        </Field>
      </div>
      <p className="muted document-charge-hint">
        The overall discount is spread across items before tax. Shipping is a
        separate charge; set its own tax rate where applicable.
      </p>
      <div className="quote-totals">
        <div>
          <span>Items before overall discount</span>
          <strong>
            {amounts ? money(amounts.beforeDiscount, currency) : "—"}
          </strong>
        </div>
        <div>
          <span>Overall discount</span>
          <strong>
            {amounts
              ? `− ${money(amounts.documentDiscountMinor, currency)}`
              : "—"}
          </strong>
        </div>
        <div>
          <span>Shipping charges</span>
          <strong>
            {amounts ? money(amounts.shippingMinor, currency) : "—"}
          </strong>
        </div>
        <div>
          <span>Tax (items and shipping)</span>
          <strong>{amounts ? money(amounts.tax, currency) : "—"}</strong>
        </div>
        <div className="quote-totals-grand">
          <span>Total ({currency})</span>
          <strong>
            {amounts
              ? money(amounts.total, currency)
              : "Complete the line items"}
          </strong>
        </div>
      </div>
    </>
  );
}
