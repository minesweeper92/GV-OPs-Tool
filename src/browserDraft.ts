import { z } from "zod";
import { documentDetails } from "../shared/documents";

// Drafts must preserve incomplete input; strict financial validation still happens on save.
export const draftDetails = documentDetails.extend({
  quote_date: z.string().nullable(),
  valid_until: z.string().nullable(),
  recipients: z.array(z.string()).max(100),
  references: z.array(z.object({ name: z.string(), url: z.string() })).max(100),
  document_discount: z.string(),
  shipping_amount: z.string(),
  shipping_tax: z.string(),
  adjustment_amount: z.string(),
});

// Tab-local convenience only: these drafts never issue or post a document.
const MAX_DRAFT_SIZE = 256000;
const MAX_DRAFT_AGE = 24 * 60 * 60 * 1000;
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const draftLines = z
  .array(
    z.object({
      description: z.string(),
      quantity: z.string(),
      price: z.string(),
      tax: z.string(),
      unit: z.string().optional(),
      section: z.string().optional(),
      discount_type: z.enum(["percent", "amount"]).optional(),
      discount: z.string().optional(),
    }),
  )
  .max(500);

export function readBrowserDraft<T extends { savedAt: number }>(
  key: string,
  schema: z.ZodType<T>,
  storage?: DraftStorage,
): T | null {
  try {
    const raw = (storage ?? window.sessionStorage).getItem(key);
    if (!raw || raw.length > MAX_DRAFT_SIZE) return null;
    const result = schema.safeParse(JSON.parse(raw));
    if (!result.success) return null;
    const age = Date.now() - result.data.savedAt;
    return age >= 0 && age < MAX_DRAFT_AGE ? result.data : null;
  } catch {
    return null;
  }
}

export function writeBrowserDraft(
  key: string,
  value: Record<string, unknown>,
  storage?: DraftStorage,
): boolean {
  try {
    const raw = JSON.stringify({ ...value, savedAt: Date.now() });
    const target = storage ?? window.sessionStorage;
    if (raw.length > MAX_DRAFT_SIZE) {
      target.removeItem(key);
      return false;
    }
    target.setItem(key, raw);
    return true;
  } catch {
    return false;
  }
}

export const invoiceDraft = z.object({
  savedAt: z.number(),
  customerId: z.string(),
  issuerId: z.string(),
  seriesId: z.string(),
  issueDate: z.string(),
  dueDate: z.string(),
  currency: z.string(),
  fx: z.string(),
  lines: draftLines,
  label: z.string(),
  amount: z.string(),
  billingKind: z.enum(["earned", "advance"]),
  terms: z.string(),
  details: draftDetails,
  requestKey: z.uuid(),
  newCustomerOpen: z.boolean(),
  newCustomerName: z.string(),
  newCustomerDomain: z.string(),
  newCustomerTaxId: z.string(),
  newCustomerAddress: z.string(),
  createdCustomer: z.object({ id: z.string(), name: z.string() }).nullable(),
  customerRetry: z.object({ key: z.uuid(), payload: z.string() }).nullable(),
});

export const invoiceDraftKey = (
  scope: string,
  kind: "invoice" | "direct-invoice",
  id: string,
) => `gv-invoice-draft-v1:${scope}:${kind}:${id || "new"}`;

export const bankTransactionDraft = z.object({
  savedAt: z.number(),
  direction: z.enum(["in", "out"]),
  amount: z.string().max(100),
  description: z.string().max(200),
  date: z.string().max(20),
  reference: z.string().max(200),
  hint: z.string().max(200),
  requestKey: z.uuid(),
  lines: z
    .array(
      z.object({
        account_code: z.string().max(100),
        debit: z.string().max(100),
        credit: z.string().max(100),
        memo: z.string().max(400),
      }),
    )
    .min(1)
    .max(100),
});

export const bankTransactionDraftKey = (
  organization: string,
  user: string,
  entity: string,
  bank: string,
) => `gv-bank-transaction-draft-v1:${organization}:${user}:${entity}:${bank}`;

export const journalEntryDraft = bankTransactionDraft
  .pick({
    savedAt: true,
    lines: true,
    requestKey: true,
    date: true,
    reference: true,
  })
  .extend({
    memo: z.string().max(200),
    autoReverseOn: z.string().max(20),
    scheduleName: z.string().max(200),
    frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
    timezone: z.enum(["Asia/Karachi", "UTC"]),
    endDate: z.string().max(20),
    occurrences: z.string().max(100),
    reverseNextMonth: z.boolean(),
  });
export const journalEntryDraftKey = (
  organization: string,
  user: string,
  entity: string,
  focus: "manual" | "schedules",
) => `gv-journal-entry-draft-v1:${organization}:${user}:${entity}:${focus}`;

export const accountEntryDraft = z
  .object({
    savedAt: z.number(),
    mode: z.enum(["create", "edit"]),
    selected: z
      .object({ code: z.string().max(8), version: z.number().int() })
      .nullable(),
    code: z.string().max(8),
    name: z.string().max(200),
    type: z.enum(["Asset", "Liability", "Equity", "Income", "Expense"]),
    parent: z.string().max(8),
    description: z.string().max(1000),
    requestKey: z.uuid(),
  })
  .refine((draft) => draft.mode === "create" || draft.selected !== null);
export const accountEntryDraftKey = (
  organization: string,
  user: string,
  entity: string,
) => `gv-account-entry-draft-v1:${organization}:${user}:${entity}`;

export function clearBrowserDraft(key: string, storage?: DraftStorage) {
  try {
    (storage ?? window.sessionStorage).removeItem(key);
  } catch {
    /* Storage may be blocked. */
  }
}
