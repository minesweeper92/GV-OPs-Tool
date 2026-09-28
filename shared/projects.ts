import { z } from "zod";
const id = z.uuid(),
  text = z.string().trim().min(1).max(200),
  date = z.iso.date();
const amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/);
export const projectCommands = [
  z.strictObject({
    action: z.literal("project.create"),
    quote_id: id,
    entity_id: id,
    name: text,
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9][A-Z0-9-]{0,29}$/),
    start_date: date,
    end_date: date.nullable(),
    budget: amount,
  }),
  z.strictObject({
    action: z.literal("project.update"),
    id,
    version: z.number().int().positive(),
    name: text,
    start_date: date,
    end_date: date.nullable(),
    budget: amount,
    status: z.enum(["Active", "On hold", "Completed"]),
  }),
  z.strictObject({
    action: z.literal("project.milestone"),
    request_key: id,
    project_id: id,
    name: text,
    due_date: date,
    amount,
    billing_kind: z.enum(["earned", "advance"]),
  }),
  z.strictObject({
    action: z.literal("project.cancel-milestone"),
    id,
    reason: text,
  }),
  z.strictObject({ action: z.literal("invoice.cancel"), id, reason: text }),
  z.strictObject({
    action: z.literal("invoice.recognise"),
    id,
    date,
    amount,
    reference: text,
    request_key: id,
  }),
] as const;
export interface Project {
  id: string;
  entity_id: string;
  deal_id: string;
  quote_id: string;
  name: string;
  code: string;
  start_date: string;
  end_date: string | null;
  budget_minor: string;
  status: string;
  version: number;
  customer_name: string;
  contact_id: string;
  currency: string;
  fx_micros: string;
  quote_net: string;
  quote_total: string;
  billed_net: string;
  reserved_net: string;
  planned_net: string;
  revenue: string;
  cost: string;
  cash: string;
  refunded: string;
  withholding: string;
  receivable: string;
  deferred: string;
  fx_result: string;
}
export interface Milestone {
  id: string;
  project_id: string;
  name: string;
  due_date: string;
  net_minor: string;
  billing_kind: "earned" | "advance";
  status: string;
}
export interface Recognition {
  id: string;
  invoice_id: string;
  recognition_date: string;
  net_minor: string;
  base_minor: string;
  reference: string;
}
