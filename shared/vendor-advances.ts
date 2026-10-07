import { z } from "zod";
const id = z.uuid(),
  date = z.iso.date(),
  money = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  fx = z.string().regex(/^\d{1,7}(\.\d{1,6})?$/),
  reason = z.string().trim().min(1).max(200);
export const vendorAdvanceCommands = [
  z.strictObject({
    action: z.literal("vendor-advance.create"),
    entity_id: id,
    vendor_id: id,
    deal_id: id.nullable(),
    currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]),
    date,
    amount: money,
    wht: money,
    fee: money,
    fx,
    bank_account_id: id.nullable(),
    purpose: z.enum(["operating", "investing"]),
    reference: reason,
    notes: z.string().max(4000),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("vendor-advance.apply"),
    id,
    bill_id: id,
    date,
    amount: money,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("vendor-advance.refund"),
    id,
    date,
    amount: money,
    fee: money,
    fx,
    bank_account_id: id.nullable(),
    reference: reason,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("vendor-advance.reverse"),
    id,
    date,
    reason,
  }),
  z.strictObject({
    action: z.literal("vendor-advance.reverse-application"),
    id,
    date,
    reason,
  }),
  z.strictObject({
    action: z.literal("vendor-advance.reverse-refund"),
    id,
    date,
    reason,
  }),
] as const;
export interface VendorAdvance {
  id: string;
  entity_id: string;
  vendor_id: string;
  vendor_name: string;
  deal_id: string | null;
  currency: string;
  advance_date: string;
  amount_minor: string;
  wht_minor: string;
  fee_minor: string;
  total_minor: string;
  base_minor: string;
  fx_micros: string;
  bank_account_id: string | null;
  purpose: "operating" | "investing";
  reference: string;
  notes: string;
  applied_minor: string;
  applied_base_minor: string;
  refunded_minor: string;
  refunded_base_minor: string;
  reversal_date: string | null;
  reversal_reason: string | null;
}
export interface VendorAdvanceApplication {
  id: string;
  advance_id: string;
  bill_id: string;
  application_date: string;
  amount_minor: string;
  carrying_minor: string;
  bill_carrying_minor: string;
  cost_adjustments: { account: string; amount_minor: string }[];
  reversal_date: string | null;
  reversal_reason: string | null;
}
export interface VendorAdvanceRefund {
  id: string;
  advance_id: string;
  refund_date: string;
  amount_minor: string;
  carrying_minor: string;
  fx_micros: string;
  fee_minor: string;
  bank_account_id: string | null;
  reference: string;
  reversal_date: string | null;
  reversal_reason: string | null;
}
