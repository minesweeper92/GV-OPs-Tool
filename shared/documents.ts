import { z } from "zod";
import { customFields } from "./profiles.ts";
const text = z.string().trim().max(4000).default("");
const short = z.string().trim().max(200).default("");
const money = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/);
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
