import { z } from "zod";
import { paymentTerm } from "./document-defaults.ts";
import { customFields } from "./profiles.ts";
import { minor, scaled, totals } from "./money.ts";
const text = z.string().trim().max(4000).default("");
const short = z.string().trim().max(200).default("");
const money = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/);
const signedMoney = z.string().regex(/^-?\d{1,13}(\.\d{1,2})?$/);
export const documentLine = z.strictObject({
  description: z.string().trim().min(1).max(2000),
  quantity: z.string().regex(/^\d{1,7}(\.\d{1,3})?$/),
  price: money,
  tax: money,
  unit: short,
  section: short,
  discount_type: z.enum(["percent", "amount"]).default("percent"),
  discount: money.default("0"),
});
export const documentDetails = z.strictObject({
  subject: short,
  reference: short,
  purchase_order: short,
  quote_date: z.iso.date().nullable().default(null),
  valid_until: z.iso.date().nullable().default(null),
  billing_address: text,
  shipping_address: text,
  customer_tax_id: short,
  attention: short,
  recipients: z.array(z.email()).max(20).default([]),
  payment_terms: short,
  payment_term: paymentTerm.nullable().default(null),
  document_discount_type: z.enum(["percent", "amount"]).default("percent"),
  document_discount: money.default("0"),
  shipping_amount: money.default("0"),
  shipping_tax: money.default("0"),
  adjustment_amount: signedMoney.default("0"),
  customer_notes: text,
  inclusions: text,
  exclusions: text,
  delivery_schedule: text,
  payment_schedule: text,
  payment_instructions: text,
  template: z.enum(["Standard", "Compact"]).default("Standard"),
  custom_fields: customFields,
  references: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        url: z
          .url()
          .refine((v) => /^https:\/\//i.test(v), "Use an HTTPS document link."),
      }),
    )
    .max(20)
    .default([]),
});
export type DocumentDetails = z.infer<typeof documentDetails>;
export function documentTotals(
  lines: Parameters<typeof totals>[0],
  details: Pick<
    DocumentDetails,
    | "document_discount_type"
    | "document_discount"
    | "shipping_amount"
    | "shipping_tax"
    | "adjustment_amount"
  >,
) {
  const items = totals(lines, {
    type: details.document_discount_type,
    amount: details.document_discount,
  });
  const shipping = minor(details.shipping_amount);
  if (scaled(details.shipping_tax, 2) > 10000n)
    throw new Error("Shipping tax must be between 0 and 100%.");
  const charge = shipping
    ? totals([
        {
          description: "Shipping charges",
          quantity: "1",
          price: details.shipping_amount,
          tax: details.shipping_tax,
        },
      ])
    : null;
  const net = BigInt(items.net) + shipping;
  const tax = BigInt(items.tax) + BigInt(charge?.tax || "0");
  const adjustmentValue = details.adjustment_amount;
  const adjustment = adjustmentValue.startsWith("-")
    ? -minor(adjustmentValue.slice(1))
    : minor(adjustmentValue);
  const total = net + tax + adjustment;
  if (total <= 0n)
    throw new Error("Adjustment must leave a positive document total.");
  if (total > 9_000_000_000_000_000n)
    throw new Error("Document total is outside the supported range.");
  return {
    lines: [
      ...items.lines,
      ...(charge
        ? charge.lines.map((line) => ({ ...line, kind: "shipping" }))
        : []),
    ],
    net: String(net),
    tax: String(tax),
    adjustment: String(adjustment),
    total: String(total),
    beforeDiscount: items.beforeDiscount,
    documentDiscountMinor: items.documentDiscountMinor,
    shippingMinor: String(shipping),
    shippingTaxMinor: charge?.tax || "0",
  };
}
export const documentCommands = [
  z.strictObject({
    action: z.literal("document.item-save"),
    name: z.string().trim().min(1).max(200),
    currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]),
    line: documentLine,
    request_key: z.uuid(),
  }),
  z.strictObject({ action: z.literal("document.item-archive"), id: z.uuid() }),
  z.strictObject({
    action: z.literal("document.invoice-create"),
    entity_id: z.uuid(),
    company_id: z.uuid(),
    issue_date: z.iso.date(),
    due_date: z.iso.date(),
    currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]),
    fx: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/),
    lines: z.array(documentLine).min(1).max(100),
    billing_kind: z.enum(["earned", "advance"]),
    label: short,
    terms: text,
    details: documentDetails,
    request_key: z.uuid(),
    number_series_id: z.uuid().optional(),
  }),
  z.strictObject({
    action: z.literal("document.invoice-edit"),
    id: z.uuid(),
    version: z.number().int().positive(),
    issue_date: z.iso.date(),
    due_date: z.iso.date(),
    terms: text,
    details: documentDetails,
  }),
] as const;
