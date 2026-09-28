import { z } from "zod";
const id = z.uuid(),
  date = z.iso.date(),
  text = z.string().trim().min(1).max(200),
  amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/),
  fx = z.string().regex(/^\d{1,7}(\.\d{1,6})?$/);
const schedule = {
  entity_id: id,
  name: text,
  start_date: date,
  end_date: date.nullable(),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  timezone: z.enum(["Asia/Karachi", "UTC"]),
  occurrences: z.number().int().min(1).max(1200).nullable(),
  request_key: id,
};
export const recurringCommands = [
  z.strictObject({
    action: z.literal("recurring.invoice"),
    ...schedule,
    quote_id: id,
    amount,
    fx,
    due_days: z.number().int().min(0).max(365),
  }),
  z.strictObject({
    action: z.literal("recurring.expense"),
    ...schedule,
    deal_id: id.nullable(),
    description: text,
    amount,
  }),
  z.strictObject({
    action: z.literal("recurring.update"),
    id,
    version: z.number().int().positive(),
    status: z.enum(["Active", "Paused", "Stopped"]),
    amount,
    fx,
    end_date: date.nullable(),
    occurrences: z.number().int().min(1).max(1200).nullable(),
    due_days: z.number().int().min(0).max(365),
    name: text,
    description: z.string().trim().max(200),
  }),
  z.strictObject({ action: z.literal("recurring.run"), id }),
  z.strictObject({ action: z.literal("recurring.skip"), id, reason: text }),
  z.strictObject({
    action: z.literal("recurring.post-expense"),
    id,
    date,
    bank_account_id: id.nullable(),
    reference: text,
  }),
] as const;
export function occurrenceDate(
  start: string,
  frequency: string,
  index: number,
) {
  const [year, month, day] = start.slice(0, 10).split("-").map(Number);
  if (frequency === "weekly")
    return new Date(Date.UTC(year, month - 1, day + index * 7))
      .toISOString()
      .slice(0, 10);
  const months =
      index * (frequency === "yearly" ? 12 : frequency === "quarterly" ? 3 : 1),
    target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
export interface RecurringProfile {
  id: string;
  entity_id: string;
  kind: "invoice" | "expense";
  quote_id: string | null;
  deal_id: string | null;
  name: string;
  description: string;
  amount_minor: string;
  fx_micros: string;
  start_date: string;
  end_date: string | null;
  frequency: string;
  timezone: string;
  occurrences: number | null;
  next_index: number;
  due_days: number;
  status: string;
  version: number;
  last_error: string;
  currency: string;
}
export interface RecurringOccurrence {
  id: string;
  profile_id: string;
  cycle: number;
  scheduled_date: string;
  amount_minor: string;
  fx_micros: string;
  description: string;
  invoice_id: string | null;
  expense_id: string | null;
  status: string;
  reason: string;
}
