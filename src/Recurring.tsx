import { useState, type FormEvent } from "react";
import { type Data, money, decimal, today, day } from "./model";
import { occurrenceDate } from "../shared/recurring";
import {
  Heading,
  Table,
  Badge,
  Empty,
  Drawer,
  Field,
  ErrorBox,
} from "./components";
import { BankSelect } from "./Banking";
type Props = {
  data: Data;
  entity: string;
  id?: string;
  kind: "invoice" | "expense";
  run: (c: Record<string, unknown>) => Promise<void>;
};
type Form = {
  mode: "new" | "edit" | "post" | "skip";
  id?: string;
  key: string;
};
export function Recurring({
  data,
  entity,
  id,
  kind,
  run,
  canPost,
}: Props & { canPost: boolean }) {
  const [form, setForm] = useState<Form | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const p = data.recurringProfiles.find((p) => p.id === id),
    list = data.recurringProfiles.filter(
      (p) => p.kind === kind && (entity === "all" || p.entity_id === entity),
    );
  const open = (mode: Form["mode"], id?: string) =>
    setForm({ mode, id, key: crypto.randomUUID() });
  async function generate() {
    setBusy(true);
    setError("");
    try {
      await run({ action: "recurring.run", id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (id && !p)
    return (
      <Empty title="Schedule not found">Choose a schedule from the list.</Empty>
    );
  return (
    <>
      <Heading
        title={
          p
            ? p.name
            : kind === "invoice"
              ? "Recurring invoices"
              : "Recurring expenses"
        }
        subtitle="Due cycles become drafts for review. Nothing is issued, charged, emailed or paid automatically."
        action={!p && canPost ? "New schedule" : undefined}
        onAction={() => open("new")}
      />
      {error ? <ErrorBox error={error} /> : null}
      {p ? (
        <>
          <a href={p.kind === "invoice" ? "#recurring" : "#recurring-expenses"}>
            ← All schedules
          </a>
          <div className="panel space-top">
            <h2>
              {p.name} <Badge>{p.status}</Badge>
            </h2>
            <p>
              {data.entities.find((e) => e.id === p.entity_id)?.name} ·{" "}
              {p.frequency} · {p.timezone}
            </p>
            <p>
              {money(p.amount_minor, p.currency)}{" "}
              {p.kind === "invoice" ? "before tax" : ""} per cycle ·{" "}
              {p.next_index} cycles processed
            </p>
            <p>
              Starts {day(p.start_date)}
              {p.end_date ? ` · Ends ${day(p.end_date)}` : ""}
              {p.occurrences ? ` · ${p.occurrences} cycles total` : ""}
            </p>
            {["Active", "Paused"].includes(p.status) ? (
              <p>
                Next cycle:{" "}
                {occurrenceDate(p.start_date, p.frequency, p.next_index)}
              </p>
            ) : null}
            {p.last_error ? <ErrorBox error={p.last_error} /> : null}
            <p className="muted">
              Drafts are generated while the server is running, catching up
              after downtime. Each run processes up to 12 due cycles. Existing
              drafts never change when you edit future cycles.
            </p>
            <div className="actions">
              {canPost && ["Active", "Paused"].includes(p.status) ? (
                <>
                  <button onClick={() => open("edit", p.id)}>
                    Edit future cycles
                  </button>
                  <button
                    disabled={busy || p.status !== "Active"}
                    onClick={generate}
                  >
                    {busy ? "Generating…" : "Generate due drafts"}
                  </button>
                  <button onClick={() => open("skip", p.id)}>
                    Skip next due cycle
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <h2>Generated history</h2>
          <Table
            headers={[
              "Cycle",
              "Scheduled date",
              "Amount",
              "Status",
              "Document / action",
            ]}
          >
            {data.recurringOccurrences
              .filter((o) => o.profile_id === p.id)
              .map((o) => (
                <tr key={o.id}>
                  <td>{o.cycle + 1}</td>
                  <td>{day(o.scheduled_date)}</td>
                  <td>{money(o.amount_minor, p.currency)}</td>
                  <td>
                    <Badge>{o.status}</Badge>
                    {o.reason ? <small>{o.reason}</small> : null}
                  </td>
                  <td>
                    {o.invoice_id ? (
                      <a href={`#invoice/${o.invoice_id}`}>
                        {data.invoices.find((i) => i.id === o.invoice_id)
                          ?.number || "Open draft invoice"}{" "}
                        ·{" "}
                        {
                          data.invoices.find((i) => i.id === o.invoice_id)
                            ?.status
                        }
                      </a>
                    ) : canPost && o.status === "Pending review" ? (
                      <div className="actions">
                        <button onClick={() => open("post", o.id)}>
                          Review & post expense
                        </button>
                        <button onClick={() => open("skip", o.id)}>
                          Skip expense
                        </button>
                      </div>
                    ) : o.expense_id ? (
                      <a href="#expenses">View expenses</a>
                    ) : null}
                  </td>
                </tr>
              ))}
          </Table>
        </>
      ) : list.length ? (
        <Table
          headers={[
            "Schedule",
            "Entity",
            "Frequency",
            "Amount",
            "Next cycle",
            "Status",
          ]}
        >
          {list.map((p) => (
            <tr key={p.id}>
              <td>
                <a href={`#schedule/${p.id}`}>{p.name}</a>
                {p.last_error ? (
                  <small className="error">Needs attention</small>
                ) : null}
              </td>
              <td>{data.entities.find((e) => e.id === p.entity_id)?.name}</td>
              <td>{p.frequency}</td>
              <td>{money(p.amount_minor, p.currency)}</td>
              <td>
                {["Active", "Paused"].includes(p.status)
                  ? occurrenceDate(p.start_date, p.frequency, p.next_index)
                  : "—"}
              </td>
              <td>
                <Badge>{p.status}</Badge>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty title="No recurring schedules yet">
          Set up a repeating service or company expense. You review each
          generated document before it affects your books.
        </Empty>
      )}
      {form ? (
        <ScheduleEditor
          key={form.key}
          {...{ form, data, entity, kind: p?.kind || kind, run }}
          close={() => setForm(null)}
        />
      ) : null}
    </>
  );
}
function ScheduleEditor({
  form,
  data,
  entity,
  kind,
  run,
  close,
}: Props & { form: Form; close: () => void }) {
  const p = data.recurringProfiles.find((p) => p.id === form.id),
    o = data.recurringOccurrences.find((o) => o.id === form.id),
    parent = p || data.recurringProfiles.find((p) => p.id === o?.profile_id);
  const [selectedEntity, setEntity] = useState(
      p?.entity_id || (entity !== "all" ? entity : data.entities[0]?.id) || "",
    ),
    [quote, setQuote] = useState(p?.quote_id || ""),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const q = data.quotes.find((q) => q.id === quote),
    currency = p?.currency || q?.currency || "PKR";
  const available = data.quotes.filter(
    (q) =>
      data.deals.some((d) => d.accepted_quote_id === q.id) &&
      data.deals.find((d) => d.id === q.deal_id)?.entity_id ===
        selectedEntity &&
      !data.projects.some((p) => p.deal_id === q.deal_id) &&
      !data.invoices.some((i) => i.deal_id === q.deal_id) &&
      !data.recurringProfiles.some((p) => p.deal_id === q.deal_id),
  );
  const title =
    form.mode === "new"
      ? "New recurring schedule"
      : form.mode === "edit"
        ? "Edit future cycles"
        : form.mode === "post"
          ? "Review recurring expense"
          : "Skip occurrence";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(event.currentTarget),
      v = (k: string) => String(f.get(k) || ""),
      count = v("occurrences") ? Number(v("occurrences")) : null;
    let c: Record<string, unknown>;
    if (form.mode === "post")
      c = {
        action: "recurring.post-expense",
        id: form.id,
        date: v("date"),
        bank_account_id: v("bank_account_id") || null,
        reference: v("reference"),
      };
    else if (form.mode === "skip")
      c = { action: "recurring.skip", id: form.id, reason: v("reason") };
    else if (form.mode === "edit")
      c = {
        action: "recurring.update",
        id: p!.id,
        version: p!.version,
        status: v("status"),
        name: v("name"),
        description: v("description"),
        amount: v("amount"),
        fx: v("fx") || "1",
        end_date: v("end_date") || null,
        occurrences: count,
        due_days: Number(v("due_days") || "0"),
      };
    else
      c = {
        action: `recurring.${kind}`,
        entity_id: selectedEntity,
        name: v("name"),
        start_date: v("start_date"),
        end_date: v("end_date") || null,
        frequency: v("frequency"),
        timezone: v("timezone"),
        occurrences: count,
        request_key: form.key,
        amount: v("amount"),
        ...(kind === "invoice"
          ? { quote_id: quote, fx: v("fx"), due_days: Number(v("due_days")) }
          : { deal_id: v("deal_id") || null, description: v("description") }),
      };
    try {
      await run(c);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      title={title}
      dirty={dirty}
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        className="editor-body billing-editor"
        onSubmit={submit}
        onChange={() => setDirty(true)}
      >
        <fieldset disabled={busy}>
          {error ? <ErrorBox error={error} /> : null}
          {["new", "edit"].includes(form.mode) ? (
            <>
              {form.mode === "new" ? (
                <Field label="Issuing entity">
                  <select
                    value={selectedEntity}
                    onChange={(e) => {
                      setEntity(e.target.value);
                      setQuote("");
                    }}
                    required
                  >
                    {data.entities.map((e) => (
                      <option value={e.id} key={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <Field label="Schedule name">
                <input
                  name="name"
                  defaultValue={p?.name}
                  maxLength={200}
                  required
                />
              </Field>
              {kind === "invoice" && form.mode === "new" ? (
                <>
                  <Field label="Accepted recurring contract">
                    <select
                      value={quote}
                      onChange={(e) => setQuote(e.target.value)}
                      required
                    >
                      <option value="">Choose an accepted quote</option>
                      {available.map((q) => (
                        <option value={q.id} key={q.id}>
                          {data.deals.find((d) => d.id === q.deal_id)?.name} ·{" "}
                          {q.option_name} · {q.currency}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <p className="muted">
                    Use a dedicated deal and accepted quote for the recurring
                    agreement. Fixed projects and deals already invoiced are
                    excluded, so recurring billing cannot bypass a project's
                    agreed budget.
                  </p>
                </>
              ) : null}
              {kind === "expense" ? (
                <>
                  <Field label="Expense description">
                    <input
                      name="description"
                      defaultValue={p?.description}
                      required
                      maxLength={200}
                    />
                  </Field>
                  {form.mode === "new" ? (
                    <Field label="Project / deal (optional)">
                      <select name="deal_id">
                        <option value="">Company overhead</option>
                        {data.deals
                          .filter((d) => d.entity_id === selectedEntity)
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                      </select>
                    </Field>
                  ) : null}
                </>
              ) : (
                <input
                  type="hidden"
                  name="description"
                  value={p?.description || ""}
                />
              )}
              <Field
                label={`Amount per cycle (${currency}${kind === "invoice" ? ", before tax" : ""})`}
              >
                <input
                  key={quote}
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={
                    p ? decimal(p.amount_minor) : q ? decimal(q.net_minor) : ""
                  }
                  required
                />
              </Field>
              {kind === "invoice" ? (
                <>
                  <Field label="PKR per currency unit">
                    <input
                      key={quote}
                      name="fx"
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      defaultValue={
                        Number(p?.fx_micros || q?.fx_micros || 1000000) / 1e6
                      }
                      readOnly={currency === "PKR"}
                      required
                    />
                  </Field>
                  <Field label="Payment due after (days)">
                    <input
                      name="due_days"
                      type="number"
                      min="0"
                      max="365"
                      defaultValue={p?.due_days ?? 30}
                      required
                    />
                  </Field>
                </>
              ) : null}
              {form.mode === "new" ? (
                <>
                  <Field label="First scheduled date">
                    <input
                      name="start_date"
                      type="date"
                      defaultValue={today()}
                      required
                    />
                  </Field>
                  <Field label="Repeat">
                    <select name="frequency">
                      <option value="monthly">Monthly</option>
                      <option value="weekly">Weekly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </Field>
                  <Field label="Schedule timezone">
                    <select name="timezone">
                      <option value="Asia/Karachi">Asia/Karachi</option>
                      <option value="UTC">UTC</option>
                    </select>
                  </Field>
                </>
              ) : null}
              <Field label="End date (optional)">
                <input
                  name="end_date"
                  type="date"
                  defaultValue={p?.end_date?.slice(0, 10) || ""}
                />
              </Field>
              <Field
                label="Total cycles (optional)"
                hint="Leave both limits blank to continue until paused or stopped."
              >
                <input
                  name="occurrences"
                  type="number"
                  min={Math.max(1, p?.next_index || 1)}
                  max="1200"
                  defaultValue={p?.occurrences ?? ""}
                />
              </Field>
              {form.mode === "edit" ? (
                <Field label="Schedule status">
                  <select name="status" defaultValue={p?.status}>
                    <option value="Active">Active</option>
                    <option value="Paused">Paused</option>
                    <option value="Stopped">Stop permanently</option>
                  </select>
                </Field>
              ) : null}
              <p className="muted">
                Changes affect future cycles only. Invoice rates are copied into
                each draft; review the rate before issuing. Resuming catches up
                missed cycles; explicitly skip any you do not need.
              </p>
            </>
          ) : form.mode === "post" ? (
            <>
              <p>
                {o?.description} · {money(o?.amount_minor || "0")} · Scheduled{" "}
                {day(o?.scheduled_date || "")}
              </p>
              <Field label="Payment date">
                <input
                  name="date"
                  type="date"
                  min={o?.scheduled_date.slice(0, 10)}
                  defaultValue={today()}
                  required
                />
              </Field>
              <BankSelect data={data} entity={parent?.entity_id || ""} />
              <Field label="Payment reference">
                <input name="reference" maxLength={200} required />
              </Field>
              <p className="muted">
                Record an expense that has already been paid. This posts to the
                ledger; it does not send money.
              </p>
            </>
          ) : (
            <>
              <p>
                Skipping records the reason and leaves any earlier documents
                unchanged.
              </p>
              <Field label="Reason">
                <textarea name="reason" maxLength={200} required />
              </Field>
            </>
          )}
          <button className="primary" type="submit">
            {busy
              ? "Saving…"
              : form.mode === "post"
                ? "Post paid expense"
                : form.mode === "skip"
                  ? "Skip occurrence"
                  : "Save schedule"}
          </button>
        </fieldset>
      </form>
    </Drawer>
  );
}
