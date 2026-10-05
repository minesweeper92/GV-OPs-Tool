import { z } from "zod";
const id = z.uuid(),
  date = z.iso.date(),
  amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  reason = z.string().trim().min(1).max(200);
export const vendorCreditCommands = [
  z.strictObject({
    action: z.literal("vendor-credit.create"),
    bill_id: id,
    date,
    reference: reason,
    reason,
    lines: z
      .array(z.strictObject({ index: z.number().int().min(0).max(99), amount }))
      .min(1)
      .max(100),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("vendor-credit.apply"),
    credit_id: id,
    bill_id: id,
    date,
    amount,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("vendor-credit.refund"),
    credit_id: id,
    date,
    amount,
    fx: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/),
    bank_account_id: id.nullable(),
    reference: reason,
    request_key: id,
  }),
  ...(["reverse", "unapply", "reverse-refund"] as const).map((kind) =>
    z.strictObject({
      action: z.literal(`vendor-credit.${kind}`),
      id,
      date,
      reason,
    }),
  ),
] as const;
export interface VendorCredit {
  id: string;
  entity_id: string;
  bill_id: string;
  vendor_id: string;
  vendor_name: string;
  entity_name: string;
  currency: string;
  fx_micros: string;
  number: string;
  reference: string;
  reason: string;
  credit_date: string;
  total_minor: string;
  base_minor: string;
  available: string;
  reversal_date: string | null;
  lines: {
    billLine: number;
    description: string;
    subtotal: string;
    taxMinor: string;
    cost_base: string;
    account_code: string;
  }[];
}
export interface VendorCreditUse {
  id: string;
  credit_id: string;
  bill_id?: string;
  application_date?: string;
  refund_date?: string;
  amount_minor: string;
  reference?: string;
  reversal_date: string | null;
}
