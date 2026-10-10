import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Heading, Table, Field, Drawer, ErrorBox, Empty } from "./components";
import {
  request,
  today,
  day,
  money,
  decimal,
  invoiceBalance,
  type Data,
  type Me,
} from "./model";
import { hasCapability } from "../shared/permissions";
import {
  collectionWorklist,
  scheduleProblem,
  type CreditHold,
  type InvoiceDispute,
  type ReminderStep,
  type WorklistCustomer,
  type WorklistInvoice,
} from "../shared/collections";

type Action =
  | { kind: "contact"; customer: WorklistCustomer }
  | { kind: "dispute"; customer: WorklistCustomer; invoice: WorklistInvoice }
  | { kind: "resolve"; dispute: InvoiceDispute; number: string }
  | { kind: "hold"; customer: WorklistCustomer }
  | { kind: "release"; hold: CreditHold; name: string }
  | {
      kind: "followup";
      invoice: WorklistInvoice;
      step: ReminderStep;
      since: string;
      paused: boolean;
    }
  | { kind: "schedule" };

const offsetLabel = (days: number) =>
  days === 0
    ? "On the due date"
    : days < 0
      ? `${-days} day${days === -1 ? "" : "s"} before due`
      : `${days} day${days === 1 ? "" : "s"} after due`;

export function Collections({
  data,
  me,
  entity,
}: {
  data: Data;
  me: Me;
  entity: string;
}) {
  const cache = useQueryClient(),
    canPost = hasCapability(me.user, "books.post"),
    canSchedule = hasCapability(me.user, "team.manage"),
    [action, setAction] = useState<Action | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const inScope = (entityId: string) => entity === "all" || entityId === entity;
  const entityCode = (entityId: string) =>
    data.entities.find((e) => e.id === entityId)?.code || "";
  const person = (userId: string | null) =>
    (data.collectionPeople || []).find((p) => p.id === userId)?.name ||
    "Someone";
  const holds = (data.creditHolds || []).filter(
    (h) => !h.released_on && inScope(h.entity_id),
  );
  const worklist = collectionWorklist({
    today: today(),
    invoices: data.invoices
      .filter((i) => inScope(i.entity_id))
      .map((i) => ({
        id: i.id,
        number: i.number,
        entity_id: i.entity_id,
        company_id: i.company_id,
        customer_name: i.customer_name,
        currency: i.currency,
        due_date: i.due_date,
        status: i.status,
        balance: invoiceBalance(i),
      })),
    companies: data.companies,
    contacts: data.collectionContacts || [],
    disputes: data.invoiceDisputes || [],
    holds,
    schedules: data.reminderSchedules || [],
    followups: data.reminderFollowups || [],
    onAccount: (data.customerReceipts || [])
      .filter((r) => BigInt(r.available_minor) > 0n)
      .map((r) => ({
        company_id: r.company_id,
        entity_id: r.entity_id,
        currency: r.currency,
        available: BigInt(r.available_minor),
      })),
  });
  const companyName = (id: string) =>
    data.companies.find((c) => c.id === id)?.name || "Customer";

  async function submit(c: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await request("commands", "POST", c, me.csrf);
      await cache.invalidateQueries({ queryKey: ["data"] });
      setAction(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const act = (a: Action) => {
    setError("");
    setAction(a);
  };
  const reminderText = (i: WorklistInvoice) => {
    const r = i.reminder;
    return r.state === "due"
      ? `Due since ${day(r.since)}: ${r.step.subject}`
      : r.state === "paused"
        ? r.reason === "dispute"
          ? "Paused · in dispute"
          : `Paused · promised by ${day(r.until || null)}`
        : r.state === "upcoming"
          ? `Next ${day(r.on)}: ${r.step.subject}`
          : "No reminder scheduled";
  };

  return (
    <>
      <Heading
        title="Collections"
        subtitle="Who owes what, what they said, and what happens next. Reminders here are prompts for you to follow up; nothing is emailed to a customer from this screen."
        action={canSchedule ? "Reminder schedule" : undefined}
        onAction={() => act({ kind: "schedule" })}
      />
      {!action ? <ErrorBox error={error} /> : null}
      {holds.length ? (
        <section className="panel collections-holds" aria-label="Credit holds">
          <h2>Credit holds</h2>
          <ul>
            {holds.map((h) => (
              <li key={h.id}>
                <span>
                  <strong>{companyName(h.company_id)}</strong> ·{" "}
                  {entityCode(h.entity_id)} ·{" "}
                  {h.mode === "block"
                    ? "New quotes and invoices blocked"
                    : "Warning only"}{" "}
                  · since {day(h.placed_on)} · {h.reason}
                </span>
                {canPost ? (
                  <button
                    onClick={() =>
                      act({
                        kind: "release",
                        hold: h,
                        name: companyName(h.company_id),
                      })
                    }
                  >
                    Release hold
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {worklist.length ? (
        worklist.map((c) => (
          <section
            key={c.company_id}
            className="panel collections-customer"
            aria-label={c.name}
          >
            <div className="collections-head">
              <h2>
                <a href={`#customer-statements/${c.company_id}`}>{c.name}</a>
              </h2>
              {canPost ? (
                <div className="actions">
                  <button onClick={() => act({ kind: "contact", customer: c })}>
                    Log contact
                  </button>
                  <button onClick={() => act({ kind: "hold", customer: c })}>
                    Place credit hold
                  </button>
                </div>
              ) : null}
            </div>
            <dl className="receipt-facts">
              {c.balances.map((b) => (
                <div key={`${b.entity_id}/${b.currency}`}>
                  <dt>
                    {entityCode(b.entity_id)} · {b.currency} overdue
                  </dt>
                  <dd>{money(b.overdue, b.currency)}</dd>
                  {b.disputed > 0n ? (
                    <small>{money(b.disputed, b.currency)} in dispute</small>
                  ) : null}
                  {b.on_account > 0n ? (
                    <small>
                      {money(b.on_account, b.currency)} unapplied cash on
                      account
                    </small>
                  ) : null}
                </div>
              ))}
              <div>
                <dt>Oldest overdue</dt>
                <dd>
                  {c.oldest_days_overdue > 0
                    ? `${c.oldest_days_overdue} days`
                    : "Not overdue yet"}
                </dd>
              </div>
              <div>
                <dt>Last contact</dt>
                <dd>
                  {c.last_contact
                    ? `${c.last_contact.kind} · ${day(c.last_contact.contacted_on)}`
                    : "None logged"}
                </dd>
                {c.last_contact ? (
                  <small>{c.last_contact.summary}</small>
                ) : null}
              </div>
              <div>
                <dt>Next action</dt>
                <dd>
                  {c.next_action ? c.next_action.next_action : "None set"}
                </dd>
                {c.next_action ? (
                  <small>
                    {person(c.next_action.assignee_id)} · due{" "}
                    {day(c.next_action.next_action_due)}
                  </small>
                ) : null}
              </div>
            </dl>
            <Table
              label={`Invoices to chase for ${c.name}`}
              headers={[
                "Invoice",
                "Due",
                "Balance",
                "Promise",
                "Reminder",
                "Actions",
              ]}
            >
              {c.invoices.map((i) => (
                <tr key={i.id}>
                  <td>
                    <a href={`#invoice/${i.id}`}>{i.number}</a>
                    <small>{entityCode(i.entity_id)}</small>
                  </td>
                  <td>
                    {day(i.due_date)}
                    <small>
                      {i.days_overdue
                        ? `${i.days_overdue} days overdue`
                        : "Not overdue yet"}
                    </small>
                  </td>
                  <td className="num">
                    {money(i.balance, i.currency)}
                    {i.dispute ? (
                      <small>
                        {money(i.dispute.amount_minor, i.currency)} disputed:{" "}
                        {i.dispute.reason}
                      </small>
                    ) : null}
                  </td>
                  <td>
                    {i.promise ? (
                      <>
                        {money(
                          i.promise.promise_amount_minor || "0",
                          i.currency,
                        )}{" "}
                        by {day(i.promise.promise_date)}
                        {i.promise_broken ? (
                          <small className="collections-broken">
                            Promise date has passed
                          </small>
                        ) : null}
                      </>
                    ) : (
                      "None"
                    )}
                  </td>
                  <td>{reminderText(i)}</td>
                  <td>
                    {canPost ? (
                      <div className="actions">
                        {i.reminder.state === "due" ? (
                          <button
                            aria-label={`Follow up ${i.number}`}
                            onClick={() =>
                              i.reminder.state === "due" &&
                              act({
                                kind: "followup",
                                invoice: i,
                                step: i.reminder.step,
                                since: i.reminder.since,
                                paused: false,
                              })
                            }
                          >
                            Follow up
                          </button>
                        ) : null}
                        {i.dispute ? (
                          <button
                            aria-label={`Resolve dispute on ${i.number}`}
                            onClick={() =>
                              act({
                                kind: "resolve",
                                dispute: i.dispute!,
                                number: i.number,
                              })
                            }
                          >
                            Resolve dispute
                          </button>
                        ) : (
                          <button
                            aria-label={`Mark ${i.number} disputed`}
                            onClick={() =>
                              act({ kind: "dispute", customer: c, invoice: i })
                            }
                          >
                            Mark disputed
                          </button>
                        )}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
          </section>
        ))
      ) : (
        <Empty title="Nothing to chase">
          No issued invoice is overdue or has a reminder due
          {entity === "all" ? "" : " in this legal entity"}.
        </Empty>
      )}
      {action && action.kind !== "schedule" ? (
        <ActionDrawer
          action={action}
          data={data}
          busy={busy}
          error={error}
          entityCode={entityCode}
          close={() => !busy && setAction(null)}
          submit={submit}
        />
      ) : null}
      {action?.kind === "schedule" ? (
        <ScheduleDrawer
          data={data}
          entity={entity}
          busy={busy}
          error={error}
          close={() => !busy && setAction(null)}
          submit={submit}
        />
      ) : null}
    </>
  );
}

function ActionDrawer({
  action,
  data,
  busy,
  error,
  entityCode,
  close,
  submit,
}: {
  action: Exclude<Action, { kind: "schedule" }>;
  data: Data;
  busy: boolean;
  error: string;
  entityCode: (id: string) => string;
  close: () => void;
  submit: (c: Record<string, unknown>) => Promise<void>;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const customer = "customer" in action ? action.customer : null;
  // A customer can owe more than one legal entity; each action belongs to one.
  const entities = customer
    ? [...new Set(customer.invoices.map((i) => i.entity_id))]
    : [];
  const [entityId, setEntityId] = useState(
    action.kind === "dispute" ? action.invoice.entity_id : entities[0] || "",
  );
  const [promised, setPromised] = useState(false),
    [next, setNext] = useState(false);
  const people = (data.collectionPeople || []).filter(
    (p) => !p.entity_ids || p.entity_ids.includes(entityId),
  );
  const title =
    action.kind === "contact"
      ? `Log contact · ${action.customer.name}`
      : action.kind === "dispute"
        ? `Mark ${action.invoice.number} disputed`
        : action.kind === "resolve"
          ? `Resolve dispute on ${action.number}`
          : action.kind === "hold"
            ? `Place credit hold · ${action.customer.name}`
            : action.kind === "release"
              ? `Release credit hold · ${action.name}`
              : `Follow up ${action.invoice.number}`;
  function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<
      string,
      string
    >;
    void submit(
      action.kind === "contact"
        ? {
            action: "collection.contact",
            entity_id: entityId,
            company_id: action.customer.company_id,
            invoice_id: f.invoice_id || null,
            kind: f.kind,
            summary: f.summary,
            contacted_on: f.date,
            promise_date: promised ? f.promise_date : null,
            promise_amount: promised ? f.promise_amount : null,
            next_action: next ? f.next_action : "",
            next_action_due: next ? f.next_action_due : null,
            assignee_id: next ? f.assignee_id : null,
            request_key: key,
          }
        : action.kind === "dispute"
          ? {
              action: "collection.dispute-open",
              invoice_id: action.invoice.id,
              reason: f.reason,
              amount: f.amount,
              owner_id: f.owner_id,
              date: f.date,
              request_key: key,
            }
          : action.kind === "resolve"
            ? {
                action: "collection.dispute-resolve",
                id: action.dispute.id,
                resolution: f.reason,
                date: f.date,
              }
            : action.kind === "hold"
              ? {
                  action: "collection.hold-place",
                  entity_id: entityId,
                  company_id: action.customer.company_id,
                  mode: f.mode,
                  reason: f.reason,
                  date: f.date,
                  request_key: key,
                }
              : action.kind === "release"
                ? {
                    action: "collection.hold-release",
                    id: action.hold.id,
                    reason: f.reason,
                    date: f.date,
                  }
                : {
                    action: "collection.followup",
                    invoice_id: action.invoice.id,
                    step_key: action.step.key,
                    outcome: f.outcome,
                    note: f.note || "",
                    date: f.date,
                  },
    );
  }
  const entityField =
    entities.length > 1 ? (
      <Field label="Legal entity">
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)}>
          {entities.map((id) => (
            <option key={id} value={id}>
              {entityCode(id)}
            </option>
          ))}
        </select>
      </Field>
    ) : null;
  const earliest =
    action.kind === "resolve"
      ? action.dispute.opened_on
      : action.kind === "release"
        ? action.hold.placed_on
        : action.kind === "followup"
          ? action.since
          : undefined;
  return (
    <Drawer title={title} dirty={true} close={close}>
      <form className="editor" onSubmit={send}>
        <div className="editor-body">
          {action.kind === "contact" ? (
            <>
              {entityField}
              <Field label="How">
                <select name="kind" defaultValue="Call">
                  <option>Call</option>
                  <option>Meeting</option>
                  <option value="Email">Email (sent by you)</option>
                  <option>Note</option>
                </select>
              </Field>
              <Field label="About invoice">
                <select name="invoice_id" defaultValue="" required={promised}>
                  <option value="">The account in general</option>
                  {action.customer.invoices
                    .filter((i) => i.entity_id === entityId)
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.number} · {money(i.balance, i.currency)}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="What was said">
                <textarea required name="summary" maxLength={2000} />
              </Field>
              <label className="collections-check">
                <input
                  type="checkbox"
                  checked={promised}
                  onChange={(e) => setPromised(e.target.checked)}
                />{" "}
                The customer promised a payment
              </label>
              {promised ? (
                <>
                  <Field
                    label="Promised amount"
                    hint="Choose the invoice the promise is for above. Reminders for it pause until the promised date."
                  >
                    <input
                      required
                      name="promise_amount"
                      inputMode="decimal"
                      pattern="\d{1,13}(\.\d{1,2})?"
                    />
                  </Field>
                  <Field label="Promised by">
                    <input required type="date" name="promise_date" />
                  </Field>
                </>
              ) : null}
              <label className="collections-check">
                <input
                  type="checkbox"
                  checked={next}
                  onChange={(e) => setNext(e.target.checked)}
                />{" "}
                Set a next action
              </label>
              {next ? (
                <>
                  <Field label="Next action">
                    <input required name="next_action" maxLength={200} />
                  </Field>
                  <Field label="Next action due">
                    <input required type="date" name="next_action_due" />
                  </Field>
                  <Field
                    label="Responsible"
                    hint="A task is added for this person on the customer's record."
                  >
                    <select required name="assignee_id" defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              ) : null}
            </>
          ) : null}
          {action.kind === "dispute" ? (
            <>
              <p>
                Reminders for this invoice pause until the dispute is resolved.
                The invoice and the books do not change.
              </p>
              <Field label={`Disputed amount (${action.invoice.currency})`}>
                <input
                  required
                  name="amount"
                  inputMode="decimal"
                  defaultValue={decimal(action.invoice.balance)}
                />
              </Field>
              <Field label="What the customer disputes">
                <textarea required name="reason" maxLength={1000} />
              </Field>
              <Field
                label="Dispute owner"
                hint="A high-priority task is added for this person."
              >
                <select required name="owner_id" defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : null}
          {action.kind === "resolve" ? (
            <>
              <p>
                Disputed: {action.dispute.reason} Resolving it restarts
                reminders. If the outcome is a reduction, raise a credit note
                separately.
              </p>
              <Field label="How it was resolved">
                <textarea required name="reason" maxLength={1000} />
              </Field>
            </>
          ) : null}
          {action.kind === "hold" ? (
            <>
              {entityField}
              <Field
                label="Effect"
                hint="A hold applies to this customer in one legal entity only."
              >
                <select name="mode" defaultValue="warn">
                  <option value="warn">
                    Warn — show the hold, still allow new sales
                  </option>
                  <option value="block">
                    Block — refuse new quotes and invoices
                  </option>
                </select>
              </Field>
              <Field label="Reason">
                <textarea required name="reason" maxLength={500} />
              </Field>
            </>
          ) : null}
          {action.kind === "release" ? (
            <Field label="Why the hold is released">
              <textarea required name="reason" maxLength={500} />
            </Field>
          ) : null}
          {action.kind === "followup" ? (
            <>
              <p>
                This step ({offsetLabel(action.step.offset_days)}) is a prompt.
                The system does not send anything: contact the customer
                yourself, then record what you did.
              </p>
              <div className="collections-template">
                <strong>{action.step.subject}</strong>
                {action.step.body ? <p>{action.step.body}</p> : null}
              </div>
              <Field label="Outcome">
                <select name="outcome" defaultValue="Done manually">
                  <option value="Done manually">
                    I followed up with the customer myself
                  </option>
                  <option>Skipped</option>
                </select>
              </Field>
              <Field label="Note">
                <textarea name="note" maxLength={1000} />
              </Field>
            </>
          ) : null}
          <Field label="Date">
            <input
              required
              type="date"
              name="date"
              min={earliest?.slice(0, 10)}
              max={today()}
              defaultValue={today()}
            />
          </Field>
          <ErrorBox error={error} />
        </div>
        <div className="editor-footer actions">
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
}

function ScheduleDrawer({
  data,
  entity,
  busy,
  error,
  close,
  submit,
}: {
  data: Data;
  entity: string;
  busy: boolean;
  error: string;
  close: () => void;
  submit: (c: Record<string, unknown>) => Promise<void>;
}) {
  const current = (entityId: string) =>
    (data.reminderSchedules || []).find((s) => s.entity_id === entityId);
  const [entityId, setEntityId] = useState(
    entity === "all" ? data.entities[0]?.id || "" : entity,
  );
  const [name, setName] = useState(current(entityId)?.name || "Standard"),
    [pause, setPause] = useState(current(entityId)?.pause_on_promise ?? true),
    [steps, setSteps] = useState<ReminderStep[]>(
      current(entityId)?.steps || [],
    );
  const pick = (value: string) => {
    setEntityId(value);
    setName(current(value)?.name || "Standard");
    setPause(current(value)?.pause_on_promise ?? true);
    setSteps(current(value)?.steps || []);
  };
  const change = (index: number, patch: Partial<ReminderStep>) =>
    setSteps((all) =>
      all.map((s, n) => (n === index ? { ...s, ...patch } : s)),
    );
  const problem = steps.some((s) => !s.subject.trim())
    ? "Every step needs a subject."
    : scheduleProblem(steps);
  return (
    <Drawer title="Reminder schedule" wide dirty={true} close={close}>
      <form
        className="editor"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || problem) return;
          void submit({
            action: "collection.schedule-save",
            entity_id: entityId,
            name: name.trim(),
            pause_on_promise: pause,
            steps: steps.map((s) => ({
              ...s,
              subject: s.subject.trim(),
              body: s.body.trim(),
            })),
            version: current(entityId)?.version || 0,
          });
        }}
      >
        <div className="editor-body">
          <p>
            Each step puts the invoice on the collections list when it comes
            due. Nothing is emailed: the subject and message are a template for
            whoever follows up. Saving creates a new version; earlier follow-ups
            stay in the history.
          </p>
          {entity === "all" && data.entities.length > 1 ? (
            <Field label="Legal entity">
              <select value={entityId} onChange={(e) => pick(e.target.value)}>
                {data.entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Schedule name">
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <label className="collections-check">
            <input
              type="checkbox"
              checked={pause}
              onChange={(e) => setPause(e.target.checked)}
            />{" "}
            Pause reminders while a promised payment date is still ahead
          </label>
          {steps.map((s, n) => (
            <fieldset key={s.key} className="collections-step">
              <legend>
                Step {n + 1} · {offsetLabel(s.offset_days)}
              </legend>
              <Field
                label={`Days from due date for step ${n + 1}`}
                hint="Negative is before the due date, 0 is on it."
              >
                <input
                  required
                  type="number"
                  min={-60}
                  max={365}
                  step={1}
                  value={s.offset_days}
                  onChange={(e) =>
                    change(n, {
                      offset_days: Math.trunc(Number(e.target.value) || 0),
                    })
                  }
                />
              </Field>
              <Field label={`Subject for step ${n + 1}`}>
                <input
                  required
                  maxLength={150}
                  value={s.subject}
                  onChange={(e) => change(n, { subject: e.target.value })}
                />
              </Field>
              <Field label={`Message for step ${n + 1}`}>
                <textarea
                  maxLength={2000}
                  value={s.body}
                  onChange={(e) => change(n, { body: e.target.value })}
                />
              </Field>
              <button
                type="button"
                onClick={() => setSteps((all) => all.filter((_, x) => x !== n))}
              >
                Remove step {n + 1}
              </button>
            </fieldset>
          ))}
          {steps.length < 12 ? (
            <button
              type="button"
              onClick={() =>
                setSteps((all) => [
                  ...all,
                  {
                    key: `step-${crypto.randomUUID().slice(0, 8)}`,
                    offset_days: all.length
                      ? Math.min(
                          365,
                          Math.max(...all.map((s) => s.offset_days)) + 7,
                        )
                      : 0,
                    subject: "",
                    body: "",
                  },
                ])
              }
            >
              Add step
            </button>
          ) : null}
          {problem ? <p className="muted">{problem}</p> : null}
          <ErrorBox error={error} />
        </div>
        <div className="editor-footer actions">
          <button className="primary" disabled={busy || !!problem || !entityId}>
            {busy ? "Saving…" : "Save schedule"}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
}
