import { z } from "zod";
const id = z.uuid(),
  text = z.string().trim().min(1).max(200),
  optional = z.string().trim().max(4000),
  version = z.number().int().positive(),
  url = z.union([
    z.url().refine((v) => /^https:\/\//i.test(v), "Use an HTTPS URL"),
    z.literal(""),
  ]);
const record = {
  record_type: z.enum(["contact", "company", "lead", "deal"]),
  record_id: id,
};
const task = {
  title: text,
  notes: optional,
  due_at: z.iso.datetime({ offset: true }),
  priority: z.enum(["Low", "Normal", "High"]),
  assignee_id: id,
};
export const crmCommands = [
  z.strictObject({
    action: z.literal("crm.contact-edit"),
    id,
    version,
    first_name: text,
    last_name: z.string().trim().max(200),
    email: z.union([z.email(), z.literal("")]),
    phone: z.string().trim().max(80),
    title: z.string().trim().max(200),
    source: z.string().trim().max(200),
    notes: optional,
    lifecycle: z.enum([
      "Subscriber",
      "Lead",
      "MQL",
      "SQL",
      "Opportunity",
      "Customer",
      "Evangelist",
    ]),
    additional_emails: z
      .array(z.strictObject({ label: text, value: z.email() }))
      .max(10),
    additional_phones: z
      .array(
        z.strictObject({
          label: z.enum(["Work", "Mobile", "Home", "Other"]),
          value: z.string().trim().min(1).max(80),
        }),
      )
      .max(10),
    address: optional,
    social_url: url,
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]),
    service_entity_id: id.nullable(),
    marketing_consent: z.enum(["Unknown", "Opted in", "Opted out"]),
    consent_date: z.iso.date().nullable(),
    consent_source: z.string().trim().max(200),
  }),
  z.strictObject({
    action: z.literal("crm.company-edit"),
    id,
    version,
    name: text,
    trading_name: z.string().trim().max(200),
    domain: z.string().trim().max(200),
    industry: z.string().trim().max(200),
    size: z.string().trim().max(80),
    tax_id: z.string().trim().max(200),
    address: optional,
    shipping_address: optional,
    customer: z.boolean(),
    vendor: z.boolean(),
    service_entity_id: id.nullable(),
  }),
  z.strictObject({
    action: z.literal("crm.lead-edit"),
    id,
    version,
    title: text,
    source: z.string().trim().max(200),
    status: z.enum([
      "New",
      "Attempted",
      "Connected",
      "Qualified",
      "Disqualified",
    ]),
    next_action: z.string().trim().max(200),
    due_date: z.iso.date().nullable(),
    reason: z.string().trim().max(200),
  }),
  z.strictObject({
    action: z.literal("crm.activity"),
    ...record,
    kind: z.enum(["Call", "Meeting", "Email", "Note"]),
    subject: text,
    body: optional,
    occurred_at: z.iso.datetime({ offset: true }),
    outcome: z.string().trim().max(200),
    reference_url: url,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("crm.task"),
    ...record,
    ...task,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("crm.task-edit"),
    id,
    version,
    ...task,
    status: z.enum(["Open", "Done", "Cancelled"]),
  }),
] as const;
export interface CrmActivity {
  id: string;
  record_type: string;
  record_id: string;
  kind: string;
  subject: string;
  body: string;
  occurred_at: string;
  outcome: string;
  reference_url: string;
  actor_id: string;
}
export interface CrmTask {
  id: string;
  record_type: string;
  record_id: string;
  title: string;
  notes: string;
  due_at: string;
  priority: string;
  assignee_id: string;
  created_by: string;
  status: string;
  completed_at: string | null;
  version: number;
}
