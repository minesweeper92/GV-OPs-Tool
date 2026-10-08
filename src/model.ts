export interface Entity {
  bill_two_stage: boolean;
  bill_finance_limit_minor: string | null;
  bill_separate_approver: boolean;
  bill_approval_version: number;
  id: string;
  name: string;
  code: string;
  currency: string;
  address: string;
  tax_id: string;
  lock_date: string | null;
}
export interface Company {
  profile: Partial<import("../shared/profiles").CompanyProfile>;
  version: number;
  trading_name: string;
  shipping_address: string;
  size: string;
  id: string;
  name: string;
  domain: string;
  industry: string;
  address: string;
  tax_id: string;
  customer: boolean;
  vendor: boolean;
  service_entity_id: string | null;
  owner_id: string;
}
export interface Contact {
  created_at?: string;
  profile: Partial<import("../shared/profiles").ContactProfile>;
  version: number;
  additional_emails: { label: string; value: string }[];
  additional_phones: { label: string; value: string }[];
  address: string;
  social_url: string;
  tags: string[];
  currency: string;
  service_entity_id: string | null;
  marketing_consent: string;
  consent_date: string | null;
  consent_source: string;
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  title: string;
  source: string;
  notes: string;
  lifecycle: string;
  owner_id: string;
}
export interface Affiliation {
  id: string;
  company_id: string;
  contact_id: string;
  role: string;
  work_email: string;
  started_on: string;
  ended_on: string | null;
}
export interface Lead {
  profile: Partial<import("../shared/profiles").CommercialProfile>;
  owner_id: string;
  version: number;
  disqualified_reason: string;
  id: string;
  company_id: string;
  contact_id: string;
  entity_id: string;
  title: string;
  source: string;
  status: string;
  next_action: string | null;
  due_date: string | null;
}
export interface Deal {
  profile: Partial<import("../shared/profiles").CommercialProfile>;
  version: number;
  owner_id: string;
  id: string;
  company_id: string;
  contact_id: string;
  entity_id: string;
  lead_id: string;
  name: string;
  stage: string;
  next_action: string | null;
  due_date: string | null;
  accepted_quote_id: string | null;
}
export interface Line {
  kind?: "shipping";
  unit?: string;
  section?: string;
  discount_type?: "percent" | "amount";
  discount?: string;
  discountMinor?: string;
  documentDiscountMinor?: string;
  description: string;
  quantity: string;
  price: string;
  tax: string;
  subtotal?: string;
  taxMinor?: string;
}
export interface Quote {
  number: string | null;
  details: Partial<import("../shared/documents").DocumentDetails>;
  issuer_address: string;
  issuer_tax_id: string;
  id: string;
  deal_id: string;
  entity_id: string;
  option_name: string;
  revision: number;
  currency: string;
  fx_micros: string;
  lines: Line[];
  net_minor: string;
  tax_minor: string;
  adjustment_minor: string;
  total_minor: string;
  customer_name: string;
  issuer_name: string;
  terms: string;
  created_at: string;
}
export interface Invoice {
  details: Partial<import("../shared/documents").DocumentDetails>;
  company_id: string;
  version: number;
  credited_minor: string;
  credited_base_minor: string;
  billing_kind: "earned" | "advance";
  label: string;
  milestone_id: string | null;
  id: string;
  entity_id: string;
  deal_id: string | null;
  quote_id: string | null;
  number: string | null;
  status: string;
  issue_date: string;
  due_date: string;
  paid_minor: string;
  total_minor: string;
  net_minor: string;
  tax_minor: string;
  adjustment_minor: string;
  fx_micros: string;
  currency: string;
  lines: Line[];
  customer_name: string;
  issuer_name: string;
  issuer_address: string;
  issuer_tax_id: string;
  terms: string;
  deal_name: string;
}
export interface Payment {
  id: string;
  entity_id: string;
  invoice_id: string;
  payment_date: string;
  amount_minor: string;
  wht_minor: string;
  reference: string;
  fx_micros: string;
}
export interface Expense {
  id: string;
  entity_id: string;
  deal_id: string | null;
  description: string;
  amount_minor: string;
  expense_date: string;
  reference: string;
}
export interface Event {
  actor_id: string;
  id: string;
  record_id: string;
  action: string;
  created_at: string;
  details: Record<string, unknown>;
}
export interface Data {
  journalSchedules: {
    id: string;
    entity_id: string;
    name: string;
    reference: string;
    memo: string;
    lines: {
      account_code: string;
      debit: string;
      credit: string;
      memo: string;
    }[];
    start_date: string;
    end_date: string | null;
    frequency: string;
    timezone: string;
    occurrences: number | null;
    next_index: number;
    reverse_next_month: boolean;
    status: "Active" | "Paused" | "Stopped" | "Completed";
    version: number;
    last_error: string;
  }[];
  journalOccurrences: {
    id: string;
    entity_id: string;
    schedule_id: string;
    cycle: number;
    scheduled_date: string;
    reference: string;
    memo: string;
    lines: {
      account_code: string;
      debit: string;
      credit: string;
      memo: string;
    }[];
    reverse_next_month: boolean;
    status: "Pending review" | "Posted" | "Skipped";
    journal_id: string | null;
    reason: string;
  }[];
  journalReversalTasks: {
    id: string;
    entity_id: string;
    original_journal_id: string;
    due_date: string;
    status: "Pending review" | "Posted";
    reversal_journal_id: string | null;
    external_reference: string;
    description: string;
  }[];
  numberSeries: {
    id: string | null;
    entity_id: string;
    kind: "quote" | "invoice" | "purchase-order";
    name: string;
    prefix: string;
    padding: number;
    next_number: string | number;
    is_default: boolean;
  }[];
  invoiceDeliveryEvents: {
    invoice_id: string;
    kind: "Sent";
    reference: string;
    created_at: string;
  }[];
  catalogItems: {
    id: string;
    name: string;
    currency: string;
    line: Line;
    created_by: string;
  }[];
  crmActivities: import("../shared/crm").CrmActivity[];
  crmTasks: import("../shared/crm").CrmTask[];
  crmMembers: { id: string; name: string; role: string }[];
  recurringProfiles: import("../shared/recurring").RecurringProfile[];
  recurringOccurrences: import("../shared/recurring").RecurringOccurrence[];
  billSchedules: import("../shared/recurring-bills").BillSchedule[];
  billScheduleOccurrences: import("../shared/recurring-bills").BillScheduleOccurrence[];
  vendorAdvances: import("../shared/vendor-advances").VendorAdvance[];
  vendorAdvanceApplications: import("../shared/vendor-advances").VendorAdvanceApplication[];
  vendorAdvanceRefunds: import("../shared/vendor-advances").VendorAdvanceRefund[];
  credits: import("../shared/billing").CreditNote[];
  creditApplications: import("../shared/billing").CreditApplication[];
  customerRefunds: import("../shared/billing").CustomerRefund[];
  projects: import("../shared/projects").Project[];
  milestones: import("../shared/projects").Milestone[];
  recognitions: import("../shared/projects").Recognition[];
  bankAccounts: import("../shared/banking").BankAccount[];
  bills: Bill[];
  purchaseOrders: import("../shared/purchase-orders").PurchaseOrder[];
  vendorPayments: VendorPayment[];
  vendorPaymentBatches: VendorPaymentBatch[];
  vendorCredits: import("../shared/vendor-credits").VendorCredit[];
  vendorCreditApplications: import("../shared/vendor-credits").VendorCreditUse[];
  vendorRefunds: import("../shared/vendor-credits").VendorCreditUse[];
  entities: Entity[];
  companies: Company[];
  contacts: Contact[];
  affiliations: Affiliation[];
  leads: Lead[];
  deals: Deal[];
  quotes: Quote[];
  quoteEvents: {
    quote_id: string;
    kind: string;
    reference: string;
    created_at: string;
  }[];
  documentAttachments: {
    id: string;
    quote_id: string | null;
    invoice_id: string | null;
    filename: string;
    content_type: string;
    size_bytes: number;
    uploaded_by: string;
    created_at: string;
  }[];
  invoices: Invoice[];
  payments: Payment[];
  expenses: Expense[];
  events: Event[];
}
export interface Bill {
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_by: string;
  credited_minor: string;
  credited_base_minor: string;
  purchase_order_id: string | null;
  id: string;
  entity_id: string;
  vendor_id: string;
  deal_id: string | null;
  vendor_name: string;
  entity_name: string;
  reference: string;
  bill_date: string;
  due_date: string;
  currency: string;
  fx_micros: string;
  lines: (Line & { account_code: string })[];
  tax_treatment: "expense" | "recoverable";
  net_minor: string;
  tax_minor: string;
  total_minor: string;
  base_minor: string;
  paid_minor: string;
  paid_base_minor: string;
  status: "Draft" | "Pending approval" | "Open" | "Paid" | "Voided";
  version: number;
  notes: string;
  last_activity_on: string;
}
export interface VendorPayment {
  id: string;
  entity_id: string;
  bill_id: string;
  payment_date: string;
  amount_minor: string;
  wht_minor: string;
  fee_minor: string;
  fx_micros: string;
  reference: string;
  reversal_date: string | null;
  reversal_reason: string | null;
}
export interface VendorPaymentBatch {
  id: string;
  entity_id: string;
  vendor_id: string;
  vendor_name: string;
  currency: string;
  payment_date: string;
  amount_minor: string;
  wht_minor: string;
  fee_minor: string;
  fx_micros: string;
  reference: string;
  bank_account_id: string | null;
  reversal_date: string | null;
  reversal_reason: string | null;
  allocations: {
    bill_id: string;
    reference: string;
    amount_minor: string;
    wht_minor: string;
  }[];
}
export interface Me {
  user: { id: string; name: string; role: string; email: string };
  organization: { id: string; name: string };
  csrf: string;
  mode: string;
  onboarding: boolean;
}
export interface Report {
  periods: { month: string; status: "Open" | "Soft closed" | "Closed" }[];
  trial: {
    id: string;
    code: string;
    name: string;
    type: string;
    parent_code: string | null;
    description: string;
    active: boolean;
    system: boolean;
    version: number;
    debit: string;
    credit: string;
  }[];
  journals: {
    id: string;
    posted_on: string;
    description: string;
    source_type: string;
    source_id: string;
    external_reference: string;
    memo: string;
    reverses_journal_id: string | null;
    reversal_id: string | null;
    lines: { account: string; debit: string; credit: string; memo: string }[];
  }[];
}
export type Editor = { kind: string; id?: string };
export const today = () => new Date().toLocaleDateString("en-CA");
export const invoiceBalance = (i: Invoice) =>
  ["Voided", "Cancelled"].includes(i.status)
    ? 0n
    : BigInt(i.total_minor) -
      BigInt(i.paid_minor) -
      BigInt(i.credited_minor || "0");
export const day = (value: string | null) =>
  value
    ? new Date(value.slice(0, 10) + "T12:00:00").toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Not set";
export function decimal(value: string | bigint) {
  const n = BigInt(value),
    v = n < 0n ? -n : n;
  return `${n < 0n ? "-" : ""}${v / 100n}.${String(v % 100n).padStart(2, "0")}`;
}
export function money(value: string | bigint, currency = "PKR") {
  const [w, f] = decimal(value).split(".");
  return `${currency} ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f}`;
}
export function rate(value: string) {
  const v = BigInt(value);
  return `${v / 1_000_000n}.${String(v % 1_000_000n).padStart(6, "0")}`;
}
export async function request<T>(
  url: string,
  method = "GET",
  body?: unknown,
  csrf?: string,
): Promise<T> {
  const response = await fetch(`/api/${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error || "Request failed."), {
      status: response.status,
    });
  return data;
}
