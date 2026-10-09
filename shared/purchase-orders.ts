import { z } from "zod";
const id = z.uuid(),
  date = z.iso.date(),
  amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  quantity = z.string().regex(/^\d{1,7}(\.\d{1,3})?$/);
export const purchaseLine = z.strictObject({
  description: z.string().trim().min(1).max(200),
  quantity,
  price: amount,
  tax: amount,
  account_code: z.enum(["5000", "5200", "1400", "1500"]),
});
const fields = {
  vendor_id: id,
  deal_id: id.nullable(),
  order_date: date,
  delivery_date: date.nullable(),
  currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]),
  fx: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/),
  lines: z.array(purchaseLine).min(1).max(100),
  tax_treatment: z.enum(["expense", "recoverable"]),
  reference: z.string().trim().max(200).default(""),
  notes: z.string().max(4000).default(""),
  terms: z.string().max(4000).default(""),
  delivery_address: z.string().max(4000).default(""),
};
export const purchaseOrderCommands = [
  ...(["submit", "review", "return"] as const).map((verb) =>
    z.strictObject({
      action: z.literal(`purchase-order.${verb}`),
      id,
      version: z.number().int().positive(),
      comment: z.string().trim().max(2000).default(""),
    }),
  ),
  z.strictObject({
    action: z.literal("purchase-order.create"),
    entity_id: id,
    ...fields,
    number_series_id: id.optional(),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("purchase-order.edit"),
    id,
    version: z.number().int().positive(),
    ...fields,
  }),
  z.strictObject({
    action: z.literal("purchase-order.status"),
    id,
    version: z.number().int().positive(),
    status: z.enum(["Issued", "Closed", "Cancelled"]),
    reason: z.string().trim().min(1).max(200),
  }),
  z.strictObject({
    action: z.literal("purchase-order.bill"),
    id,
    version: z.number().int().positive(),
    reference: z.string().trim().min(1).max(200),
    bill_date: date,
    due_date: date,
    fx: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/),
    allocations: z
      .array(
        z.strictObject({ index: z.number().int().min(0).max(99), quantity }),
      )
      .min(1)
      .max(100),
    acknowledge_duplicate: z.boolean().default(false),
    request_key: id,
  }),
] as const;
export interface PurchaseOrder {
  id: string;
  entity_id: string;
  vendor_id: string;
  deal_id: string | null;
  number: string;
  vendor_name: string;
  entity_name: string;
  order_date: string;
  delivery_date: string | null;
  currency: string;
  fx_micros: string;
  lines: (z.infer<typeof purchaseLine> & {
    subtotal: string;
    taxMinor: string;
  })[];
  net_minor: string;
  tax_minor: string;
  total_minor: string;
  tax_treatment: "expense" | "recoverable";
  reference: string;
  notes: string;
  terms: string;
  delivery_address: string;
  status: "Draft" | "Pending approval" | "Issued" | "Closed" | "Cancelled";
  version: number;
  allocations: {
    bill_id: string;
    line_index: number;
    quantity_millis: string;
    status: string;
  }[];
}
