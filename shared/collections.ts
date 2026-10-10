import { z } from "zod";

// Collections commands and the worklist calculation shared by server tests
// and the interface. Nothing in this module sends a message to a customer.
const id = z.uuid(),
  date = z.iso.date(),
  money = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/);

export const reminderStep = z.strictObject({
  // Stable within a schedule so a follow-up stays attached when steps reorder.
  key: z.string().regex(/^[a-z0-9-]{1,40}$/),
  // Days relative to the invoice due date: negative before, 0 on, positive after.
  offset_days: z.number().int().min(-60).max(365),
  subject: z.string().trim().min(1).max(150),
  body: z.string().trim().max(2000),
});
export type ReminderStep = z.infer<typeof reminderStep>;

export const collectionCommands = [
  z.strictObject({
    action: z.literal("collection.contact"),
    entity_id: id,
    company_id: id,
    invoice_id: id.nullable(),
    kind: z.enum(["Call", "Meeting", "Email", "Note"]),
    summary: z.string().trim().min(1).max(2000),
    contacted_on: date,
    promise_date: date.nullable(),
    promise_amount: money.nullable(),
    next_action: z.string().trim().max(200),
    next_action_due: date.nullable(),
    assignee_id: id.nullable(),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("collection.dispute-open"),
    invoice_id: id,
    reason: z.string().trim().min(1).max(1000),
    amount: money,
    owner_id: id,
    date,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("collection.dispute-resolve"),
    id,
    resolution: z.string().trim().min(1).max(1000),
    date,
  }),
  z.strictObject({
    action: z.literal("collection.hold-place"),
    entity_id: id,
    company_id: id,
    mode: z.enum(["warn", "block"]),
    reason: z.string().trim().min(1).max(500),
    date,
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("collection.hold-release"),
    id,
    reason: z.string().trim().min(1).max(500),
    date,
  }),
  z.strictObject({
    action: z.literal("collection.schedule-save"),
    entity_id: id,
    name: z.string().trim().min(1).max(80),
    pause_on_promise: z.boolean(),
    steps: z.array(reminderStep).max(12),
    // The version being replaced; 0 when the entity has no schedule yet.
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("collection.followup"),
    invoice_id: id,
    step_key: z.string().regex(/^[a-z0-9-]{1,40}$/),
    outcome: z.enum(["Done manually", "Skipped"]),
    note: z.string().trim().max(1000),
    date,
  }),
] as const;

export interface CollectionContact {
  id: string;
  entity_id: string;
  company_id: string;
  invoice_id: string | null;
  kind: string;
  summary: string;
  contacted_on: string;
  promise_date: string | null;
  promise_amount_minor: string | null;
  next_action: string;
  next_action_due: string | null;
  assignee_id: string | null;
  created_by_name: string;
}
export interface InvoiceDispute {
  id: string;
  entity_id: string;
  company_id: string;
  invoice_id: string;
  reason: string;
  amount_minor: string;
  owner_id: string;
  opened_on: string;
  opened_by_name: string;
  resolved_on: string | null;
  resolution: string | null;
}
export interface CreditHold {
  id: string;
  entity_id: string;
  company_id: string;
  mode: "warn" | "block";
  reason: string;
  placed_on: string;
  placed_by_name: string;
  released_on: string | null;
}
export interface ReminderSchedule {
  id: string;
  entity_id: string;
  version: number;
  name: string;
  steps: ReminderStep[];
  pause_on_promise: boolean;
}
export interface ReminderFollowup {
  id: string;
  invoice_id: string;
  schedule_id: string;
  step_key: string;
  outcome: string;
  note: string;
  followed_up_on: string;
  created_by_name: string;
}

export function scheduleProblem(steps: ReminderStep[]) {
  if (new Set(steps.map((s) => s.key)).size !== steps.length)
    return "Each reminder step needs its own key.";
  if (new Set(steps.map((s) => s.offset_days)).size !== steps.length)
    return "Two reminder steps fall on the same day. Combine or move one.";
  return null;
}

const day = (v: string) => v.slice(0, 10);
const addDays = (iso: string, days: number) => {
  const d = new Date(`${day(iso)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const between = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${day(to)}T00:00:00Z`) -
      Date.parse(`${day(from)}T00:00:00Z`)) /
      86400000,
  );

export type ReminderState =
  | { state: "none" }
  | { state: "due"; step: ReminderStep; since: string; scheduleId: string }
  | { state: "paused"; reason: "dispute" | "promise"; until?: string }
  | { state: "upcoming"; step: ReminderStep; on: string };

export interface WorklistInvoice {
  id: string;
  number: string;
  entity_id: string;
  currency: string;
  due_date: string;
  days_overdue: number;
  balance: bigint;
  dispute: InvoiceDispute | null;
  promise: CollectionContact | null;
  promise_broken: boolean;
  reminder: ReminderState;
}
export interface WorklistBalance {
  entity_id: string;
  currency: string;
  outstanding: bigint;
  overdue: bigint;
  disputed: bigint;
  on_account: bigint;
}
export interface WorklistCustomer {
  company_id: string;
  name: string;
  balances: WorklistBalance[];
  invoices: WorklistInvoice[];
  holds: CreditHold[];
  last_contact: CollectionContact | null;
  next_action: CollectionContact | null;
  oldest_days_overdue: number;
  reminders_due: number;
}

// One row per customer with something to chase: an overdue balance or a
// reminder step that has come due. Balances are never merged across legal
// entities or currencies.
export function collectionWorklist(input: {
  today: string;
  invoices: {
    id: string;
    number: string | null;
    entity_id: string;
    company_id: string;
    customer_name?: string | null;
    currency: string;
    due_date: string;
    status: string;
    balance: bigint;
  }[];
  companies: { id: string; name: string }[];
  contacts: CollectionContact[];
  disputes: InvoiceDispute[];
  holds: CreditHold[];
  schedules: ReminderSchedule[];
  followups: ReminderFollowup[];
  onAccount: {
    company_id: string;
    entity_id: string;
    currency: string;
    available: bigint;
  }[];
}): WorklistCustomer[] {
  const { today } = input;
  const latestSchedule = new Map<string, ReminderSchedule>();
  for (const s of input.schedules) {
    const current = latestSchedule.get(s.entity_id);
    if (!current || s.version > current.version)
      latestSchedule.set(s.entity_id, s);
  }
  const followed = new Set(
    input.followups.map((f) => `${f.invoice_id}/${f.step_key}`),
  );
  const newest = (a: CollectionContact, b: CollectionContact) =>
    b.contacted_on.localeCompare(a.contacted_on);
  const customers = new Map<string, WorklistCustomer>();
  for (const i of input.invoices) {
    if (i.status !== "Issued" || i.balance <= 0n) continue;
    const dispute =
      input.disputes.find((d) => d.invoice_id === i.id && !d.resolved_on) ||
      null;
    const promise =
      input.contacts
        .filter((c) => c.invoice_id === i.id && c.promise_date)
        .sort(newest)[0] || null;
    const promiseActive = !!promise && day(promise.promise_date!) >= today;
    const schedule = latestSchedule.get(i.entity_id);
    const steps = [...(schedule?.steps || [])].sort(
      (a, b) => a.offset_days - b.offset_days,
    );
    const waiting = steps.filter((s) => !followed.has(`${i.id}/${s.key}`));
    const dueStep = [...waiting]
      .reverse()
      .find((s) => addDays(i.due_date, s.offset_days) <= today);
    const nextStep = waiting.find(
      (s) => addDays(i.due_date, s.offset_days) > today,
    );
    const reminder: ReminderState = dispute
      ? { state: "paused", reason: "dispute" }
      : promiseActive && schedule?.pause_on_promise
        ? {
            state: "paused",
            reason: "promise",
            until: day(promise!.promise_date!),
          }
        : dueStep
          ? {
              state: "due",
              step: dueStep,
              since: addDays(i.due_date, dueStep.offset_days),
              scheduleId: schedule!.id,
            }
          : nextStep
            ? {
                state: "upcoming",
                step: nextStep,
                on: addDays(i.due_date, nextStep.offset_days),
              }
            : { state: "none" };
    const days = between(i.due_date, today);
    if (days <= 0 && reminder.state !== "due") continue;
    let c = customers.get(i.company_id);
    if (!c) {
      c = {
        company_id: i.company_id,
        name:
          input.companies.find((x) => x.id === i.company_id)?.name ||
          i.customer_name ||
          "Customer",
        balances: [],
        invoices: [],
        holds: input.holds.filter(
          (h) => h.company_id === i.company_id && !h.released_on,
        ),
        last_contact: null,
        next_action: null,
        oldest_days_overdue: 0,
        reminders_due: 0,
      };
      customers.set(i.company_id, c);
    }
    c.invoices.push({
      id: i.id,
      number: i.number || "Invoice",
      entity_id: i.entity_id,
      currency: i.currency,
      due_date: day(i.due_date),
      days_overdue: days > 0 ? days : 0,
      balance: i.balance,
      dispute,
      promise,
      promise_broken: !!promise && !promiseActive,
      reminder,
    });
    let b = c.balances.find(
      (x) => x.entity_id === i.entity_id && x.currency === i.currency,
    );
    if (!b) {
      b = {
        entity_id: i.entity_id,
        currency: i.currency,
        outstanding: 0n,
        overdue: 0n,
        disputed: 0n,
        on_account: input.onAccount
          .filter(
            (a) =>
              a.company_id === i.company_id &&
              a.entity_id === i.entity_id &&
              a.currency === i.currency,
          )
          .reduce((s, a) => s + a.available, 0n),
      };
      c.balances.push(b);
    }
    b.outstanding += i.balance;
    if (days > 0) b.overdue += i.balance;
    if (dispute) {
      const disputed = BigInt(dispute.amount_minor);
      b.disputed += disputed < i.balance ? disputed : i.balance;
    }
    if (days > c.oldest_days_overdue) c.oldest_days_overdue = days;
    if (reminder.state === "due") c.reminders_due++;
  }
  for (const c of customers.values()) {
    const history = input.contacts
      .filter((x) => x.company_id === c.company_id)
      .sort(newest);
    c.last_contact = history[0] || null;
    c.next_action = history.find((x) => x.next_action) || null;
    c.invoices.sort(
      (a, b) =>
        a.due_date.localeCompare(b.due_date) ||
        a.number.localeCompare(b.number),
    );
  }
  return [...customers.values()].sort(
    (a, b) =>
      b.oldest_days_overdue - a.oldest_days_overdue ||
      a.name.localeCompare(b.name),
  );
}
