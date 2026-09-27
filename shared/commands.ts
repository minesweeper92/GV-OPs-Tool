import { z } from "zod";
const id = z.uuid(),
  text = z.string().trim().min(1).max(200),
  optional = z.string().trim().max(4000).default("");
const date = z.iso.date();
const money = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, "Use an amount with at most two decimals.");
const fx = z
  .string()
  .regex(
    /^\d{1,7}(\.\d{1,6})?$/,
    "Use an exchange rate with at most six decimals.",
  );
const line = z
  .object({
    description: text,
    quantity: z.string().regex(/^\d{1,7}(\.\d{1,3})?$/),
    price: money,
    tax: money,
  })
  .strict();
export const commandSchema = z.discriminatedUnion(
  "action",
  [
    z.strictObject({
      action: z.literal("company.create"),
      name: text,
      domain: optional,
      industry: optional,
      tax_id: optional,
      address: optional,
      customer: z.boolean(),
      vendor: z.boolean(),
      service_entity_id: id.nullable(),
    }),
    z.strictObject({
      action: z.literal("contact.create"),
      first_name: text,
      last_name: optional,
      email: z.union([z.email(), z.literal("")]),
      phone: optional,
      title: optional,
      source: optional,
      notes: optional,
      company_id: id,
      role: text,
    }),
    z.strictObject({
      action: z.literal("contact.associate"),
      contact_id: id,
      company_id: id,
      role: text,
      work_email: z.union([z.email(), z.literal("")]),
      started_on: date,
    }),
    z.strictObject({
      action: z.literal("contact.end-association"),
      id,
      ended_on: date,
    }),
    z.strictObject({
      action: z.literal("lead.create"),
      company_id: id,
      contact_id: id,
      entity_id: id,
      title: text,
      source: optional,
      next_action: text,
      due_date: date,
    }),
    z.strictObject({ action: z.literal("lead.convert"), id }),
    z.strictObject({
      action: z.literal("deal.follow-up"),
      id,
      next_action: text,
      due_date: date,
    }),
    z.strictObject({ action: z.literal("deal.lose"), id, reason: text }),
    z.strictObject({
      action: z.literal("quote.create"),
      deal_id: id,
      option_name: text,
      currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]),
      fx,
      lines: z.array(line).min(1).max(100),
      terms: optional,
    }),
    z.strictObject({ action: z.literal("quote.share"), id, reference: text }),
    z.strictObject({ action: z.literal("quote.accept"), id, reference: text }),
    z.strictObject({
      action: z.literal("invoice.create"),
      quote_id: id,
      issue_date: date,
      due_date: date,
    }),
    z.strictObject({ action: z.literal("invoice.issue"), id }),
    z.strictObject({ action: z.literal("invoice.void"), id, reason: text, date }),
    z.strictObject({
      action: z.literal("payment.create"),
      invoice_id: id,
      date,
      amount: money,
      wht: money,
      fx,
      reference: text,
      request_key: id,
    }),
    z.strictObject({
      action: z.literal("expense.create"),
      entity_id: id,
      deal_id: id.nullable(),
      description: text,
      amount: money,
      date,
      reference: text,
      request_key: id,
    }),
    z.strictObject({
      action: z.literal("entity.create"),
      name: text,
      code: z
        .string()
        .trim()
        .regex(/^[A-Z][A-Z0-9]{1,7}$/),
      tax_id: optional,
      address: optional,
    }),
    z.strictObject({
      action: z.literal("period.close"),
      entity_id: id,
      date,
      reason: text,
    }),
    z.strictObject({
      action: z.literal("note.create"),
      record_id: id,
      text: z.string().trim().min(1).max(4000),
    }),
  ],
);
export type Command = z.infer<typeof commandSchema>;
