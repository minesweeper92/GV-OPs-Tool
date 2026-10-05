import { z } from "zod";
import { purchaseLine } from "./purchase-orders.ts";
const id = z.uuid(),
  date = z.iso.date(),
  name = z.string().trim().min(1).max(200);
const future = {
  name,
  lines: z.array(purchaseLine).min(1).max(100),
  fx: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/),
  tax_treatment: z.enum(["expense", "recoverable"]),
  due_days: z.number().int().min(0).max(365),
  notes: z.string().max(4000),
  end_date: date.nullable(),
  occurrences: z.number().int().min(1).max(1200).nullable(),
};
export const billScheduleCommands = [
  z.strictObject({
    action: z.literal("bill-schedule.create"),
    ...future,
    entity_id: id,
    vendor_id: id,
    deal_id: id.nullable(),
    currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]),
    start_date: date,
    frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
    timezone: z.enum(["Asia/Karachi", "UTC"]),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("bill-schedule.edit"),
    id,
    version: z.number().int().positive(),
    ...future,
  }),
  z.strictObject({
    action: z.literal("bill-schedule.status"),
    id,
    version: z.number().int().positive(),
    status: z.enum(["Active", "Paused", "Stopped"]),
    reason: name,
  }),
  z.strictObject({ action: z.literal("bill-schedule.run"), id }),
  z.strictObject({
    action: z.literal("bill-schedule.skip"),
    id,
    version: z.number().int().positive(),
    reason: name,
  }),
] as const;
export interface BillSchedule {
  id: string;
  entity_id: string;
  vendor_id: string;
  vendor_name: string;
  deal_id: string | null;
  name: string;
  currency: string;
  lines: z.infer<typeof purchaseLine>[];
  fx_micros: string;
  tax_treatment: "expense" | "recoverable";
  total_minor: string;
  due_days: number;
  notes: string;
  start_date: string;
  end_date: string | null;
  frequency: string;
  timezone: string;
  occurrences: number | null;
  next_index: number;
  status: "Active" | "Paused" | "Stopped" | "Completed";
  version: number;
  last_error: string;
}
export interface BillScheduleOccurrence {
  id: string;
  schedule_id: string;
  cycle: number;
  scheduled_date: string;
  bill_id: string | null;
  status: "Draft created" | "Skipped";
  reason: string;
  template: Record<string, unknown>;
}
