export interface Entity {
  id: string;
  name: string;
  code: string;
  currency: string;
  address: string;
  tax_id: string;
  lock_date: string | null;
}
export interface Company {
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
  id: string;
  company_id: string;
  contact_id: string;
  entity_id: string;
  title: string;
  source: string;
  status: string;
  next_action: string;
  due_date: string;
}
export interface Deal {
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
  description: string;
  quantity: string;
  price: string;
  tax: string;
  subtotal?: string;
  taxMinor?: string;
}
export interface Quote {
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
  total_minor: string;
  customer_name: string;
  issuer_name: string;
  terms: string;
  created_at: string;
}
export interface Invoice {
  id: string;
  entity_id: string;
  deal_id: string;
  quote_id: string;
  number: string | null;
  status: string;
  issue_date: string;
  due_date: string;
  paid_minor: string;
  total_minor: string;
  net_minor: string;
  tax_minor: string;
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
  id: string;
  record_id: string;
  action: string;
  created_at: string;
  details: Record<string, unknown>;
}
export interface Data {
  entities: Entity[];
  companies: Company[];
  contacts: Contact[];
  affiliations: Affiliation[];
  leads: Lead[];
  deals: Deal[];
  quotes: Quote[];
  quoteEvents: { quote_id: string; kind: string; reference: string }[];
  invoices: Invoice[];
  payments: Payment[];
  expenses: Expense[];
  events: Event[];
}
export interface Me {
  user: { id: string; name: string; role: string };
  organization: { id: string; name: string };
  csrf: string;
  mode: string;
}
export interface Report {
  trial: {
    code: string;
    name: string;
    type: string;
    debit: string;
    credit: string;
  }[];
  journals: {
    id: string;
    posted_on: string;
    description: string;
    source_type: string;
    source_id: string;
    lines: { account: string; debit: string; credit: string }[];
  }[];
}
export type Editor = { kind: string; id?: string };
export const today = () => new Date().toLocaleDateString("en-CA");
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
