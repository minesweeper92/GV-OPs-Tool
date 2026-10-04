import { z } from "zod";
const id = z.uuid(),
  date = z.iso.date(),
  text = z.string().trim().min(1).max(200),
  amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  fx = z.string().regex(/^\d{1,7}(\.\d{1,6})?$/);
export const billingCommands = [
  z.strictObject({
    action: z.literal("credit.create"),
    invoice_id: id,
    date,
    adjustment_amount: z
      .string()
      .regex(/^-?\d{1,13}(\.\d{1,2})?$/)
      .default("0"),
    lines: z
      .array(z.strictObject({ index: z.number().int().min(0).max(99), amount }))
      .min(0)
      .max(100),
    treatment: z.enum(["earned", "deferred"]),
    reason: text,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("credit.apply"),
    credit_id: id,
    invoice_id: id,
    date,
    amount,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("credit.refund"),
    credit_id: id,
    date,
    amount,
    fx,
    bank_account_id: id.nullable(),
    reference: text,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("credit.reverse"),
    id,
    date,
    reason: text,
  }),
  z.strictObject({
    action: z.literal("credit.unapply"),
    id,
    date,
    reason: text,
  }),
  z.strictObject({
    action: z.literal("credit.reverse-refund"),
    id,
    date,
    reason: text,
  }),
] as const;
export interface CreditNote {
  id: string;
  entity_id: string;
  invoice_id: string;
  number: string;
  credit_date: string;
  lines: {
    invoiceLine: number;
    description: string;
    subtotal: string;
    taxMinor: string;
  }[];
  net_minor: string;
  tax_minor: string;
  adjustment_minor: string;
  total_minor: string;
  base_minor: string;
  treatment: string;
  reason: string;
  currency: string;
  fx_micros: string;
  company_id: string;
  customer_name: string;
  invoice_number: string;
  available: string;
  reversal_date: string | null;
}
export interface CreditApplication {
  id: string;
  credit_id: string;
  invoice_id: string;
  application_date: string;
  amount_minor: string;
  reversal_date: string | null;
}
export interface CustomerRefund {
  id: string;
  credit_id: string;
  refund_date: string;
  amount_minor: string;
  fx_micros: string;
  reference: string;
  reversal_date: string | null;
}
