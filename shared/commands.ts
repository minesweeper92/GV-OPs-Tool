import { z } from "zod";
import { bankCommands } from "./banking.ts";
import { projectCommands } from "./projects.ts";
import { billingCommands } from "./billing.ts";
import { recurringCommands } from "./recurring.ts";
import { crmCommands } from "./crm.ts";
import { profileCommands } from "./profiles.ts";
import { purchaseOrderCommands } from "./purchase-orders.ts";
import { vendorCreditCommands } from "./vendor-credits.ts";
import { billScheduleCommands } from "./recurring-bills.ts";
import { vendorAdvanceCommands } from "./vendor-advances.ts";
import {
  documentCommands,
  documentDetails,
  documentLine,
} from "./documents.ts";
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
export const commandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("bill.approval-policy"),
    entity_id: id,
    version: z.number().int().positive(),
    finance_limit: money.nullable(),
    separate_approver: z.boolean(),
    two_stage: z.boolean().optional(),
    // Omitted keeps stored tiers; null returns to the finance-limit settings.
    tiers: z
      .array(
        z.strictObject({
          from: money,
          steps: z
            .array(z.strictObject({ role: z.enum(["finance", "admin"]) }))
            .min(1)
            .max(4),
        }),
      )
      .min(1)
      .max(5)
      .nullable()
      .optional(),
  }),
  ...bankCommands,
  ...projectCommands,
  ...billingCommands,
  ...recurringCommands,
  ...crmCommands,
  ...profileCommands,
  ...documentCommands,
  ...purchaseOrderCommands,
  ...vendorCreditCommands,
  ...billScheduleCommands,
  ...vendorAdvanceCommands,
  z.strictObject({
    action: z.literal("bill.create"),
    entity_id: id,
    vendor_id: id,
    deal_id: id.nullable(),
    reference: text,
    bill_date: date,
    due_date: date,
    currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]),
    fx,
    lines: z
      .array(
        line.extend({ account_code: z.enum(["5000", "5200", "1400", "1500"]) }),
      )
      .min(1)
      .max(100),
    tax_treatment: z.enum(["expense", "recoverable"]),
    acknowledge_duplicate: z.boolean().default(false),
    notes: optional,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("bill.edit"),
    id,
    version: z.number().int().positive(),
    vendor_id: id,
    deal_id: id.nullable(),
    reference: text,
    bill_date: date,
    due_date: date,
    currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]),
    fx,
    lines: z
      .array(
        line.extend({ account_code: z.enum(["5000", "5200", "1400", "1500"]) }),
      )
      .min(1)
      .max(100),
    tax_treatment: z.enum(["expense", "recoverable"]),
    acknowledge_duplicate: z.boolean().default(false),
    notes: optional,
  }),
  z.strictObject({
    action: z.literal("bill.submit"),
    id,
    version: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal("bill.review"),
    id,
    version: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal("bill.approve"),
    id,
    version: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal("bill.return"),
    id,
    version: z.number().int().positive(),
    reason: text,
  }),
  z.strictObject({
    action: z.literal("bill.void"),
    id,
    version: z.number().int().positive(),
    date,
    reason: text,
  }),
  z.strictObject({
    action: z.literal("vendor-payment.create"),
    bank_account_id: id.nullable().optional(),
    bill_id: id,
    date,
    amount: money,
    wht: money,
    fee: money,
    fx,
    reference: text,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("vendor-payment.reverse"),
    id,
    date,
    reason: text,
  }),
  z.strictObject({
    action: z.literal("vendor-payment.batch-create"),
    bank_account_id: id.nullable().optional(),
    date,
    fee: money,
    fx,
    reference: text,
    request_key: id,
    allocations: z
      .array(z.strictObject({ bill_id: id, amount: money, wht: money }))
      .min(1)
      .max(100),
  }),
  z.strictObject({
    action: z.literal("vendor-payment.batch-reverse"),
    id,
    date,
    reason: text,
  }),
  z.strictObject({
    action: z.literal("company.create"),
    request_key: id.optional(),
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
    company_id: id.nullable(),
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
    lines: z.array(documentLine).min(1).max(100),
    details: documentDetails.optional(),
    terms: optional,
    number_series_id: id.optional(),
  }),
  z.strictObject({ action: z.literal("quote.share"), id, reference: text }),
  z.strictObject({ action: z.literal("quote.accept"), id, reference: text }),
  z.strictObject({
    action: z.literal("invoice.create"),
    quote_id: id,
    issue_date: date,
    due_date: date,
    amount: money.optional(),
    billing_kind: z.enum(["earned", "advance"]).default("earned"),
    label: text.default("Accepted quote"),
    milestone_id: id.nullable().optional(),
    request_key: id.optional(),
    details: documentDetails.optional(),
    number_series_id: id.optional(),
  }),
  z.strictObject({ action: z.literal("invoice.issue"), id }),
  z.strictObject({
    action: z.literal("invoice.mark-sent"),
    id,
    reference: text,
  }),
  z.strictObject({
    action: z.literal("number-series.create"),
    entity_id: id,
    kind: z.enum(["quote", "invoice", "purchase-order"]),
    name: text,
    prefix: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9/_-]{0,19}$/),
    padding: z.number().int().min(1).max(12),
    next_number: z.number().int().min(1).max(999999999999),
  }),
  z.strictObject({ action: z.literal("invoice.void"), id, reason: text, date }),
  z.strictObject({
    action: z.literal("payment.create"),
    bank_account_id: id.nullable().optional(),
    invoice_id: id,
    date,
    amount: money,
    wht: money,
    sales_tax_withheld: money.default("0"),
    fx,
    reference: text,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("expense.create"),
    bank_account_id: id.nullable().optional(),
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
    action: z.literal("period.transition"),
    entity_id: id,
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    to: z.enum(["Open", "Soft closed", "Closed"]),
    version: z.number().int().min(0),
    preflight_hash: z.string().regex(/^[a-f0-9]{64}$/),
    acknowledge_warnings: z.boolean(),
    reason: text,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("period.legacy-unlock"),
    entity_id: id,
    expected_lock_date: date,
    reason: text,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("manual-journal.create"),
    entity_id: id,
    date,
    reference: text,
    memo: text,
    auto_reverse_on: date.nullable().optional(),
    lines: z
      .array(
        z.strictObject({
          account_code: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
          debit: money,
          credit: money,
          memo: z.string().trim().max(400),
        }),
      )
      .min(2)
      .max(100),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("manual-journal.reverse"),
    id,
    date,
    reason: text,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("journal-schedule.create"),
    entity_id: id,
    name: text,
    reference: text,
    memo: text,
    lines: z
      .array(
        z.strictObject({
          account_code: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
          debit: money,
          credit: money,
          memo: z.string().trim().max(400),
        }),
      )
      .min(2)
      .max(100),
    start_date: date,
    end_date: date.nullable(),
    frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
    timezone: z.enum(["UTC", "Asia/Karachi"]),
    occurrences: z.number().int().min(1).max(1200).nullable(),
    reverse_next_month: z.boolean(),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("journal-schedule.status"),
    id,
    version: z.number().int().positive(),
    status: z.enum(["Active", "Paused", "Stopped"]),
  }),
  z.strictObject({ action: z.literal("journal-schedule.run"), id }),
  z.strictObject({
    action: z.literal("journal-schedule.skip"),
    id,
    reason: text,
  }),
  z.strictObject({ action: z.literal("journal-schedule.post"), id }),
  z.strictObject({
    action: z.literal("journal-reversal.post"),
    id,
    date,
    reason: text,
  }),
  z.strictObject({
    action: z.literal("account.create"),
    entity_id: id,
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{4,8}$/),
    name: text,
    type: z.enum(["Asset", "Liability", "Equity", "Income", "Expense"]),
    parent_code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{4,8}$/)
      .nullable(),
    description: z.string().trim().max(1000),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("account.update"),
    entity_id: id,
    code: z.string().regex(/^[A-Z0-9]{4,8}$/),
    version: z.number().int().positive(),
    name: text,
    description: z.string().trim().max(1000),
  }),
  z.strictObject({
    action: z.literal("account.set-active"),
    entity_id: id,
    code: z.string().regex(/^[A-Z0-9]{4,8}$/),
    version: z.number().int().positive(),
    active: z.boolean(),
  }),
  z.strictObject({
    action: z.literal("note.create"),
    record_id: id,
    text: z.string().trim().min(1).max(4000),
  }),
]);
export type Command = z.infer<typeof commandSchema>;
