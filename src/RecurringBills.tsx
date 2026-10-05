import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Heading, Table, Drawer, Field, ErrorBox, Empty } from "./components";
import { request, money, today, day, type Data, type Me } from "./model";
import { totals } from "../shared/money";
import { occurrenceDate } from "../shared/recurring";
import type { BillSchedule } from "../shared/recurring-bills";
import {
  readBrowserDraft,
  writeBrowserDraft,
  clearBrowserDraft,
} from "./browserDraft";
const schema = z.object({
  savedAt: z.number(),
  editingId: z.string(),
  version: z.number(),
  requestKey: z.uuid(),
  entity: z.string(),
  vendor: z.string(),
  deal: z.string(),
  name: z.string(),
  currency: z.string(),
  fx: z.string(),
  start: z.string(),
  end: z.string(),
  frequency: z.string(),
  timezone: z.string(),
  count: z.string(),
  dueDays: z.string(),
  treatment: z.string(),
  notes: z.string(),
  lines: z
    .array(
      z.object({
        description: z.string(),
        quantity: z.string(),
        price: z.string(),
        tax: z.string(),
        account_code: z.string(),
      }),
    )
    .max(100),
});
type Draft = Omit<z.infer<typeof schema>, "savedAt">;
const line = () => ({
  description: "",
  quantity: "1",
  price: "",
  tax: "0",
  account_code: "5000",
});
export default function RecurringBills({
  data,
  me,
  entity,
  id,
}: {
  data: Data;
  me: Me;
  entity: string;
  id?: string;
}) {
  const cache = useQueryClient(),
    key = `gv:${me.organization.id}:${me.user.id}:recurring-bill:v1`;
  const fresh = (): Draft => ({
    editingId: "",
    version: 1,
    requestKey: crypto.randomUUID(),
    entity: entity === "all" ? data.entities[0]?.id || "" : entity,
    vendor: "",
    deal: "",
    name: "",
    currency: "PKR",
    fx: "1",
    start: today(),
    end: "",
    frequency: "monthly",
    timezone: "Asia/Karachi",
    count: "",
    dueDays: "30",
    treatment: "expense",
    notes: "",
    lines: [line()],
  });
  const [draft, setDraft] = useState<Draft>(
    () => readBrowserDraft(key, schema) || fresh(),
  );
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [storageOk, setStorageOk] = useState(true),
    [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setStorageOk(writeBrowserDraft(key, draft));
  }, [open, key, draft]);
  const schedules = data.billSchedules.filter(
      (p) => entity === "all" || p.entity_id === entity,
    ),
    selected = id ? schedules.find((p) => p.id === id) : undefined;
  let total = "0",
    calculationError = "";
  try {
    total = totals(draft.lines).total;
  } catch (e) {
    calculationError = (e as Error).message;
  }
  function change<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [field]: value }));
  }
  async function command(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ id: string }>(
        "commands",
        "POST",
        payload,
        me.csrf,
      );
      await cache.invalidateQueries({ queryKey: ["data"] });
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  function discard() {
    clearBrowserDraft(key);
    setDraft(fresh());
    setOpen(false);
    setError("");
  }
  function edit(p: BillSchedule) {
    if (
      readBrowserDraft(key, schema) &&
      !window.confirm(
        "Replace the saved recurring bill draft with this schedule?",
      )
    )
      return;
    setDraft({
      editingId: p.id,
      version: p.version,
      requestKey: crypto.randomUUID(),
      entity: p.entity_id,
      vendor: p.vendor_id,
      deal: p.deal_id || "",
      name: p.name,
      currency: p.currency,
      fx: String(Number(p.fx_micros) / 1000000),
      start: p.start_date.slice(0, 10),
      end: p.end_date ? p.end_date.slice(0, 10) : "",
      frequency: p.frequency,
      timezone: p.timezone,
      count: p.occurrences === null ? "" : String(p.occurrences),
      dueDays: String(p.due_days),
      treatment: p.tax_treatment,
      notes: p.notes,
      lines: p.lines.map((l) => ({ ...l })),
    });
    setError("");
    setOpen(true);
  }
  if (!["admin", "finance"].includes(me.user.role))
    return (
      <Empty title="Finance access required">
        Recurring bills are restricted to finance and administrators.
      </Empty>
    );
  return (
    <>
      <Heading
        title="Recurring bills"
        subtitle="Schedule unpaid vendor bills. Each cycle creates a draft for review—not a payment or posted expense."
        action="New recurring bill"
        onAction={() => {
          setError("");
          setOpen(true);
        }}
      />
      {error && !open ? <ErrorBox error={error} /> : null}
      {selected ? (
        <section className="panel">
          <a href="?view=recurring-bills">← All recurring bills</a>
          <h2>{selected.name}</h2>
          <p>
            {selected.vendor_name} · {selected.currency} · {selected.status} ·{" "}
            {money(selected.total_minor, selected.currency)} per cycle
          </p>
          <p>
            {selected.frequency} from {day(selected.start_date)} (
            {selected.timezone}).{" "}
            {selected.status === "Completed" || selected.status === "Stopped"
              ? "Schedule ended."
              : `Next cycle: ${occurrenceDate(selected.start_date, selected.frequency, selected.next_index)}`}
          </p>
          <p>
            Due {selected.due_days} days after each bill date. Edit the
            generated bill’s reference to match the vendor’s invoice before
            approval.
          </p>
          {selected.last_error ? (
            <ErrorBox error={selected.last_error} />
          ) : null}
          {!["Completed", "Stopped"].includes(selected.status) ? (
            <>
              <div className="actions">
                <button disabled={busy} onClick={() => edit(selected)}>
                  Edit future bills
                </button>
                {selected.status === "Active" ? (
                  <button
                    disabled={busy}
                    onClick={() =>
                      command({ action: "bill-schedule.run", id: selected.id })
                    }
                  >
                    Generate next draft
                  </button>
                ) : null}
                <button
                  disabled={busy}
                  onClick={() =>
                    command({
                      action: "bill-schedule.status",
                      id: selected.id,
                      version: selected.version,
                      status:
                        selected.status === "Paused" ? "Active" : "Paused",
                      reason:
                        selected.status === "Paused"
                          ? "Resumed by finance"
                          : "Paused by finance",
                    })
                  }
                >
                  {selected.status === "Paused" ? "Resume" : "Pause"}
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Stop this schedule permanently? Existing bill drafts are preserved.",
                      )
                    )
                      void command({
                        action: "bill-schedule.status",
                        id: selected.id,
                        version: selected.version,
                        status: "Stopped",
                        reason: "Stopped by finance",
                      });
                  }}
                >
                  Stop schedule
                </button>
              </div>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    await command({
                      action: "bill-schedule.skip",
                      id: selected.id,
                      version: selected.version,
                      reason,
                    })
                  )
                    setReason("");
                }}
              >
                <Field label="Reason for skipping next due cycle">
                  <input
                    required
                    maxLength={200}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                <button
                  disabled={
                    busy ||
                    occurrenceDate(
                      selected.start_date,
                      selected.frequency,
                      selected.next_index,
                    ) >
                      new Date().toLocaleDateString("en-CA", {
                        timeZone: selected.timezone,
                      })
                  }
                >
                  Skip next due cycle
                </button>
              </form>
            </>
          ) : null}
          <h3>Cycle history</h3>
          <Table
            headers={["Cycle", "Scheduled date", "Outcome", "Bill / reason"]}
          >
            {data.billScheduleOccurrences
              .filter((o) => o.schedule_id === selected.id)
              .map((o) => (
                <tr key={o.id}>
                  <td>{o.cycle + 1}</td>
                  <td>{day(o.scheduled_date)}</td>
                  <td>{o.status}</td>
                  <td>
                    {o.bill_id ? (
                      <a href={`?view=bill/${o.bill_id}`}>
                        {data.bills.find((b) => b.id === o.bill_id)
                          ?.reference || "Open bill"}
                      </a>
                    ) : (
                      o.reason
                    )}
                  </td>
                </tr>
              ))}
          </Table>
        </section>
      ) : id ? (
        <Empty title="Schedule not available">
          Select its legal entity, or return to all recurring bills.
        </Empty>
      ) : schedules.length ? (
        <Table
          headers={[
            "Schedule",
            "Vendor",
            "Legal entity",
            "Total",
            "Next cycle",
            "Status",
          ]}
        >
          {schedules.map((p) => (
            <tr key={p.id}>
              <td>
                <a href={`?view=bill-schedule/${p.id}`}>{p.name}</a>
              </td>
              <td>{p.vendor_name}</td>
              <td>{data.entities.find((e) => e.id === p.entity_id)?.name}</td>
              <td>{money(p.total_minor, p.currency)}</td>
              <td>
                {["Stopped", "Completed"].includes(p.status)
                  ? "—"
                  : occurrenceDate(
                      p.start_date,
                      p.frequency,
                      p.next_index,
                    )}
                {p.last_error ? (
                  <small className="error">Needs review: {p.last_error}</small>
                ) : null}
              </td>
              <td>{p.status}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty title="No recurring bills yet">
          Use this for rent, subscriptions and other regular unpaid vendor
          bills. For money already paid, use Expenses.
        </Empty>
      )}
      {open ? (
        <Drawer
          title={
            draft.editingId
              ? "Edit future recurring bills"
              : "New recurring bill"
          }
          close={discard}
          dirty
          wide
        >
          <form
            className="editor"
            onSubmit={async (e) => {
              e.preventDefault();
              const future = {
                name: draft.name,
                lines: draft.lines,
                fx: draft.fx,
                tax_treatment: draft.treatment,
                due_days: Number(draft.dueDays),
                notes: draft.notes,
                end_date: draft.end || null,
                occurrences: draft.count ? Number(draft.count) : null,
              };
              const payload = draft.editingId
                ? {
                    action: "bill-schedule.edit",
                    id: draft.editingId,
                    version: draft.version,
                    ...future,
                  }
                : {
                    action: "bill-schedule.create",
                    ...future,
                    entity_id: draft.entity,
                    vendor_id: draft.vendor,
                    deal_id: draft.deal || null,
                    currency: draft.currency,
                    start_date: draft.start,
                    frequency: draft.frequency,
                    timezone: draft.timezone,
                    request_key: draft.requestKey,
                  };
              const result = await command(payload);
              if (result) {
                discard();
                window.location.hash = `bill-schedule/${result.id}`;
              }
            }}
          >
            <div className="editor-body">
              <p>
                Each due cycle creates an unposted bill draft. Review its vendor
                reference, amount and exchange rate before submitting it for
                approval.
              </p>
              {!storageOk ? (
                <p role="status">
                  Draft recovery is unavailable in this browser. Keep this form
                  open until saved.
                </p>
              ) : (
                <p role="status">
                  Your draft is kept in this tab for up to 24 hours.
                </p>
              )}
              {error ? <ErrorBox error={error} /> : null}
            <div className="form-row">
                <Field label="Schedule name">
                  <input
                    required
                    maxLength={200}
                    value={draft.name}
                    onChange={(e) => change("name", e.target.value)}
                    placeholder="Office rent"
                  />
                </Field>
                <Field label="Legal entity">
                  <select
                    required
                    disabled={!!draft.editingId}
                    value={draft.entity}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        entity: e.target.value,
                        deal: "",
                      }))
                    }
                  >
                    {data.entities.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Vendor">
                  <select
                    required
                    disabled={!!draft.editingId}
                    value={draft.vendor}
                    onChange={(e) => change("vendor", e.target.value)}
                  >
                    <option value="">Select a vendor</option>
                    {data.companies
                      .filter((c) => c.vendor)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Project / deal (optional)">
                  <select
                    disabled={!!draft.editingId}
                    value={draft.deal}
                    onChange={(e) => change("deal", e.target.value)}
                  >
                    <option value="">General company expense</option>
                    {data.deals
                      .filter((d) => d.entity_id === draft.entity)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Currency">
                  <select
                    disabled={!!draft.editingId}
                    value={draft.currency}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        currency: e.target.value,
                        fx: e.target.value === "PKR" ? "1" : d.fx,
                      }))
                    }
                  >
                    {["PKR", "USD", "AED", "EUR", "GBP"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="PKR per currency unit"
                  hint="A fixed template rate, not a market feed. Review foreign-currency drafts before approval."
                >
                  <input
                    required
                    inputMode="decimal"
                    value={draft.fx}
                    onChange={(e) => change("fx", e.target.value)}
                    readOnly={draft.currency === "PKR"}
                  />
                </Field>
                <Field label="First bill date">
                  <input
                    required
                    disabled={!!draft.editingId}
                    type="date"
                    value={draft.start}
                    onChange={(e) => change("start", e.target.value)}
                  />
                </Field>
                <Field label="Repeat every">
                  <select
                    disabled={!!draft.editingId}
                    value={draft.frequency}
                    onChange={(e) => change("frequency", e.target.value)}
                  >
                    {["weekly", "monthly", "quarterly", "yearly"].map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Schedule timezone">
                  <select
                    disabled={!!draft.editingId}
                    value={draft.timezone}
                    onChange={(e) => change("timezone", e.target.value)}
                  >
                    <option>Asia/Karachi</option>
                    <option>UTC</option>
                  </select>
                </Field>
                <Field label="Payment due in days">
                  <input
                    required
                    type="number"
                    min={0}
                    max={365}
                    value={draft.dueDays}
                    onChange={(e) => change("dueDays", e.target.value)}
                  />
                </Field>
                <Field label="End date (optional)">
                  <input
                    type="date"
                    min={draft.start}
                    value={draft.end}
                    onChange={(e) => change("end", e.target.value)}
                  />
                </Field>
                <Field
                  label="Maximum cycles (optional)"
                  hint="Includes generated and skipped cycles. Blank means no count limit."
                >
                  <input
                    type="number"
                    min={1}
                    max={1200}
                    value={draft.count}
                    onChange={(e) => change("count", e.target.value)}
                  />
                </Field>
              </div>
              <h3>Bill items</h3>
              <Table
                headers={[
                  "Description",
                  "Quantity",
                  "Rate",
                  "Tax %",
                  "Account",
                  "Action",
                ]}
              >
                {draft.lines.map((l, i) => (
                  <tr key={i}>
                    {(["description", "quantity", "price", "tax"] as const).map(
                      (f) => (
                        <td key={f}>
                          <input
                            aria-label={`${f} ${i + 1}`}
                            required
                            value={l[f]}
                            inputMode={f === "description" ? "text" : "decimal"}
                            onChange={(e) =>
                              change(
                                "lines",
                                draft.lines.map((row, j) =>
                                  j === i
                                    ? { ...row, [f]: e.target.value }
                                    : row,
                                ),
                              )
                            }
                          />
                        </td>
                      ),
                    )}
                    <td>
                      <select
                        aria-label={`Account ${i + 1}`}
                        value={l.account_code}
                        onChange={(e) =>
                          change(
                            "lines",
                            draft.lines.map((row, j) =>
                              j === i
                                ? { ...row, account_code: e.target.value }
                                : row,
                            ),
                          )
                        }
                      >
                      <option value="5000">Operating expenses</option>
                      <option value="5200">Project production costs</option>
                      <option value="1400">Prepayments</option>
                      <option value="1500">Equipment</option>
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={draft.lines.length === 1}
                        aria-label={`Remove item ${i + 1}`}
                        onClick={() =>
                          change(
                            "lines",
                            draft.lines.filter((_, j) => j !== i),
                          )
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </Table>
              <button
                type="button"
                disabled={draft.lines.length >= 100}
                onClick={() => change("lines", [...draft.lines, line()])}
              >
                Add item
              </button>
              <Field label="Tax treatment">
                <select
                  value={draft.treatment}
                  onChange={(e) => change("treatment", e.target.value)}
                >
                  <option value="expense">Tax included in cost</option>
                  <option value="recoverable">Recoverable input tax</option>
                </select>
              </Field>
              <p>
                Total per cycle: <strong>{money(total, draft.currency)}</strong>
              </p>
              {calculationError && draft.lines.some((l) => l.price) ? (
                <p>{calculationError}</p>
              ) : null}
              <Field label="Bill notes">
                <textarea
                  maxLength={4000}
                  value={draft.notes}
                  onChange={(e) => change("notes", e.target.value)}
                />
              </Field>
            </div>
            <div className="editor-footer">
              <button className="primary" disabled={busy}>
                {busy
                  ? "Saving…"
                  : draft.editingId
                    ? "Save future changes"
                    : "Create schedule"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Keep draft & close
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Discard your unsaved changes?"))
                    discard();
                }}
              >
                Discard
              </button>
            </div>
          </form>
        </Drawer>
      ) : null}
    </>
  );
}
