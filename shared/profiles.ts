import { z } from "zod";
import { crmCommands } from "./crm.ts";
const short = z.string().trim().max(200).default("");
const notes = z.string().trim().max(4000).default("");
const id = z.uuid();
export const customFields = z
  .array(
    z.strictObject({
      label: z.string().trim().min(1).max(80),
      type: z.enum(["Text", "Number", "Date", "Yes/No"]),
      value: z.string().max(1000),
    }),
  )
  .max(30)
  .default([])
  .superRefine((fields, ctx) => {
    const labels = new Set<string>();
    fields.forEach((f, i) => {
      const key = f.label.toLowerCase();
      if (labels.has(key))
        ctx.addIssue({
          code: "custom",
          path: [i, "label"],
          message: "Use unique field names.",
        });
      labels.add(key);
      if (
        f.value &&
        ((f.type === "Number" && !/^-?\d+(\.\d+)?$/.test(f.value)) ||
          (f.type === "Date" && !z.iso.date().safeParse(f.value).success) ||
          (f.type === "Yes/No" && !["Yes", "No"].includes(f.value)))
      )
        ctx.addIssue({
          code: "custom",
          path: [i, "value"],
          message: `Enter a valid ${f.type} value.`,
        });
    });
  });
export const address = z.strictObject({
  street: short,
  city: short,
  region: short,
  postal_code: short,
  country: short,
});
export const contactProfile = z.strictObject({
  salutation: short,
  department: short,
  seniority: short,
  preferred_channel: z
    .enum(["", "Email", "Phone", "WhatsApp", "Meeting"])
    .default(""),
  language: short,
  timezone: z
    .string()
    .max(100)
    .default("")
    .refine((v) => {
      try {
        if (v) new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Choose a valid time zone."),
  location: address.default({
    street: "",
    city: "",
    region: "",
    postal_code: "",
    country: "",
  }),
  referrer: short,
  custom_fields: customFields,
});
export const companyProfile = z.strictObject({
  customer_type: z.enum(["Business", "Individual"]).default("Business"),
  phone: short,
  source: short,
  notes,
  parent_company_id: id.nullable().default(null),
  currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]).default("PKR"),
  payment_days: z.number().int().min(0).max(365).default(30),
  credit_limit: z
    .string()
    .regex(/^\d{1,13}(\.\d{1,2})?$/)
    .default("0"),
  billing_recipients: z.array(z.email()).max(20).default([]),
  document_notes: notes,
  payment_instructions: notes,
  registrations: z
    .array(
      z.strictObject({
        entity_id: id,
        code: short,
        status: z.enum(["Pending", "Active", "Expired", "Inactive"]),
        instructions: notes,
        reference_url: z.union([
          z.url().refine((v) => /^https:\/\//i.test(v), "Use HTTPS."),
          z.literal(""),
        ]),
      }),
    )
    .max(20)
    .default([]),
  custom_fields: customFields,
});
export const commercialProfile = z.strictObject({
  brief: notes,
  service: short,
  priority: z.enum(["Low", "Normal", "High"]).default("Normal"),
  currency: z.enum(["PKR", "USD", "AED", "EUR", "GBP"]).default("PKR"),
  estimated_value: z
    .string()
    .regex(/^\d{1,13}(\.\d{1,2})?$/)
    .default("0"),
  expected_close: z.iso.date().nullable().default(null),
  end_client_id: id.nullable().default(null),
  pipeline: short,
  probability: z.number().int().min(0).max(100).default(0),
  forecast: z
    .enum(["Not forecasted", "Pipeline", "Best case", "Commit", "Closed won"])
    .default("Not forecasted"),
  decision_process: notes,
  qualification_notes: notes,
  won_reason: short,
  stakeholders: z
    .array(
      z.strictObject({
        contact_id: id,
        role: z.string().trim().min(1).max(80),
      }),
    )
    .max(30)
    .default([]),
  custom_fields: customFields,
});
const identity = {
  id: id.optional(),
  version: z.number().int().positive().optional(),
  owner_id: id,
};
export const profileCommands = [
  crmCommands[0].omit({ action: true, id: true, version: true }).extend({
    action: z.literal("profile.contact"),
    ...identity,
    company_id: id.nullable().default(null),
    role: short.default("Contact"),
    profile: contactProfile,
  }),
  crmCommands[1].omit({ action: true, id: true, version: true }).extend({
    action: z.literal("profile.company"),
    ...identity,
    profile: companyProfile,
  }),
  crmCommands[2].omit({ action: true, id: true, version: true }).extend({
    action: z.literal("profile.lead"),
    ...identity,
    company_id: id,
    contact_id: id,
    entity_id: id,
    profile: commercialProfile,
  }),
  z.strictObject({
    action: z.literal("profile.deal"),
    id,
    version: z.number().int().positive(),
    owner_id: id,
    name: z.string().trim().min(1).max(200),
    profile: commercialProfile,
  }),
] as const;
export type ContactProfile = z.infer<typeof contactProfile>;
export type CompanyProfile = z.infer<typeof companyProfile>;
export type CommercialProfile = z.infer<typeof commercialProfile>;
