import { useState, type FormEvent } from "react";
import { type Data, money, decimal, today, day, invoiceBalance } from "./model";
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
  initialInvoice?: string;
  run: (c: Record<string, unknown>) => Promise<void>;
};
type Form = { mode: string; target?: string; key: string };
export function Credits({ data, entity, id, initialInvoice, run }: Props) {
  const [form, setForm] = useState<Form | null>(
    initialInvoice
      ? { mode: "create", target: initialInvoice, key: crypto.randomUUID() }
      : null,
  );
  const open = (mode: string, target?: string) =>
    setForm({ mode, target, key: crypto.randomUUID() });
  const credit = data.credits.find((c) => c.id === id),
    list = data.credits.filter(
      (c) => entity === "all" || c.entity_id === entity,
    );
  if (id && !credit)
    return (
      <Empty title="Credit note not found">
        Choose a credit note from the list.
      </Empty>
    );
  return (
    <>
      <Heading
        title={credit ? credit.number : "Credit notes"}
        subtitle="Adjust issued invoices without changing their history. Apply available credit or record money returned."
        action={!credit ? "New credit note" : undefined}
        onAction={() => open("create")}
      />
      {credit ? (
        <>
          <a href="#credits">← All credit notes</a>
          <div className="panel space-top">
            <h2>{credit.customer_name}</h2>
            <p>
              {data.entities.find((e) => e.id === credit.entity_id)?.name} ·{" "}
              {day(credit.credit_date)} ·{" "}
              <Badge>{credit.reversal_date ? "Reversed" : "Issued"}</Badge>
            </p>
            <p>
              Original invoice:{" "}
              <a href={`#invoice/${credit.invoice_id}`}>
                {credit.invoice_number}
              </a>
            </p>
            <Table headers={["Description", "Subtotal", "Tax"]}>
              {credit.lines.map((l, n) => (
                <tr key={n}>
                  <td>{l.description}</td>
                  <td>{money(l.subtotal, credit.currency)}</td>
                  <td>{money(l.taxMinor, credit.currency)}</td>
                </tr>
              ))}
            </Table>
            <p>
              <strong>
                Total {money(credit.total_minor, credit.currency)}
              </strong>{" "}
              · Available {money(credit.available, credit.currency)}
            </p>
            <p>{credit.reason}</p>
            <p className="muted">
              {credit.treatment === "deferred"
                ? "Reduces unearned revenue"
                : "Reduces earned revenue"}
              . Original invoice remains unchanged.
            </p>
            {!credit.reversal_date ? (
              <div className="actions">
                <button
                  disabled={BigInt(credit.available) <= 0n}
                  onClick={() => open("apply")}
                >
                  Apply to invoice
                </button>
                <button
                  disabled={BigInt(credit.available) <= 0n}
                  onClick={() => open("refund")}
                >
                  Record refund
                </button>
                <button onClick={() => open("credit.reverse", credit.id)}>
                  Reverse credit note
                </button>
              </div>
            ) : null}
          </div>
          <h2>Applications</h2>
          <Table headers={["Invoice", "Date", "Amount", "Status", "Action"]}>
            {data.creditApplications
              .filter((a) => a.credit_id === id)
              .map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={`#invoice/${a.invoice_id}`}>
                      {data.invoices.find((i) => i.id === a.invoice_id)?.number}
                    </a>
                  </td>
                  <td>{day(a.application_date)}</td>
                  <td>{money(a.amount_minor, credit.currency)}</td>
                  <td>
                    {a.reversal_date
                      ? `Reversed ${day(a.reversal_date)}`
                      : "Applied"}
                  </td>
                  <td>
                    {!a.reversal_date ? (
                      <button onClick={() => open("credit.unapply", a.id)}>
                        Reverse application
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
          </Table>
          <h2>Refunds</h2>
          <Table headers={["Reference", "Date", "Amount", "Status", "Action"]}>
            {data.customerRefunds
              .filter((r) => r.credit_id === id)
              .map((r) => (
                <tr key={r.id}>
                  <td>{r.reference}</td>
                  <td>{day(r.refund_date)}</td>
                  <td>{money(r.amount_minor, credit.currency)}</td>
                  <td>
                    {r.reversal_date
                      ? `Reversed ${day(r.reversal_date)}`
                      : "Recorded"}
                  </td>
                  <td>
                    {!r.reversal_date ? (
                      <button
                        onClick={() => open("credit.reverse-refund", r.id)}
                      >
                        Reverse refund
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
          </Table>
        </>
      ) : list.length ? (
        <Table
          headers={[
            "Credit note",
            "Customer / entity",
            "Date",
            "Total",
            "Available",
            "Status",
          ]}
        >
          {list.map((c) => (
            <tr key={c.id}>
              <td>
                <a href={`#credit/${c.id}`}>{c.number}</a>
                <small>{c.invoice_number}</small>
              </td>
              <td>
                {c.customer_name}
                <small>
                  {data.entities.find((e) => e.id === c.entity_id)?.name}
                </small>
              </td>
              <td>{day(c.credit_date)}</td>
              <td>{money(c.total_minor, c.currency)}</td>
              <td>{money(c.available, c.currency)}</td>
              <td>
                <Badge>
                  {c.reversal_date
                    ? "Reversed"
                    : BigInt(c.available) === 0n
                      ? "Settled"
                      : "Available"}
                </Badge>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty title="No credit notes yet">
          Open an issued invoice to credit all or part of its line items.
          Credits can be applied to another invoice for the same customer,
          entity and currency.
        </Empty>
      )}
      {form ? (
        <CreditEditor
          key={form.key}
          form={form}
          data={data}
          entity={entity}
          creditId={id}
          run={run}
          close={() => setForm(null)}
        />
      ) : null}
    </>
  );
}
function CreditEditor({
  form,
  data,
  entity,
  creditId,
  run,
  close,
}: Props & { form: Form; creditId?: string; close: () => void }) {
  const [selected, setSelected] = useState(form.target || ""),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const c = data.credits.find((c) => c.id === creditId),
    i = data.invoices.find((i) => i.id === selected);
  const invoices = data.invoices.filter(
    (i) =>
      ["Issued", "Paid", "Settled"].includes(i.status) &&
      (entity === "all" || i.entity_id === entity),
  );
  const options = data.invoices.filter(
    (i) =>
      c &&
      i.status === "Issued" &&
      i.entity_id === c.entity_id &&
      i.currency === c.currency &&
      data.deals.find((d) => d.id === i.deal_id)?.company_id === c.company_id &&
      invoiceBalance(i) > 0n,
  );
  const title =
    form.mode === "create"
      ? "New credit note"
      : form.mode === "apply"
        ? "Apply credit"
        : form.mode === "refund"
          ? "Record customer refund"
          : form.mode === "credit.reverse"
            ? "Reverse credit note"
            : form.mode === "credit.unapply"
              ? "Reverse credit application"
              : "Reverse customer refund";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(event.currentTarget),
      v = (k: string) => String(f.get(k) || "");
    let command: Record<string, unknown>;
    if (form.mode === "create")
      command = {
        action: "credit.create",
        invoice_id: selected,
        date: v("date"),
        reason: v("reason"),
        treatment: v("treatment"),
        request_key: form.key,
        lines: i?.lines
          .map((_, index) => ({ index, amount: v(`line-${index}`) || "0" }))
          .filter((l) => Number(l.amount) > 0),
      };
    else if (form.mode === "apply")
      command = {
        action: "credit.apply",
        credit_id: creditId,
        invoice_id: v("invoice_id"),
        date: v("date"),
        amount: v("amount"),
        request_key: form.key,
      };
    else if (form.mode === "refund")
      command = {
        action: "credit.refund",
        credit_id: creditId,
        date: v("date"),
        amount: v("amount"),
        fx: v("fx"),
        bank_account_id: v("bank_account_id") || null,
        reference: v("reference"),
        request_key: form.key,
      };
    else
      command = {
        action: form.mode,
        id: form.target,
        date: v("date"),
        reason: v("reason"),
      };
    try {
      await run(command);
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
          {form.mode === "create" ? (
            <>
              <Field label="Original invoice">
                <select
                  required
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="">Choose an issued invoice</option>
                  {invoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.number} · {money(i.total_minor, i.currency)} ·{" "}
                      {data.entities.find((e) => e.id === i.entity_id)?.code}
                    </option>
                  ))}
                </select>
              </Field>
              {i ? (
                <div key={i.id}>
                  <p className="muted">
                    Enter the net amount to credit for each line. Use zero to
                    leave a line unchanged. Original tax is calculated
                    automatically.
                  </p>
                  {i.lines.map((l, index) => {
                    const used = data.credits
                      .filter((c) => c.invoice_id === i.id && !c.reversal_date)
                      .flatMap((c) => c.lines)
                      .filter((l) => l.invoiceLine === index)
                      .reduce((s, l) => s + BigInt(l.subtotal), 0n);
                    const remaining = BigInt(l.subtotal || "0") - used;
                    return (
                      <Field
                        key={index}
                        label={`Credit: ${l.description}`}
                        hint={`Available ${money(remaining, i.currency)}, before tax`}
                      >
                        <input
                          name={`line-${index}`}
                          type="number"
                          min="0"
                          max={decimal(remaining)}
                          step="0.01"
                          defaultValue={decimal(remaining)}
                          required
                        />
                      </Field>
                    );
                  })}
                  <Field label="Revenue adjustment">
                    <select name="treatment">
                      <option value="earned">
                        Work already earned — reduce revenue
                      </option>
                      {i.billing_kind === "advance" ? (
                        <option value="deferred">
                          Unperformed work — reduce deferred revenue
                        </option>
                      ) : null}
                    </select>
                  </Field>
                </div>
              ) : null}
            </>
          ) : null}
          {form.mode === "apply" ? (
            <Field label="Apply to invoice">
              <select name="invoice_id" required>
                <option value="">Choose an open invoice</option>
                {options.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.number} · Due {money(invoiceBalance(i), i.currency)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Date">
            <input type="date" name="date" defaultValue={today()} required />
          </Field>
          {["apply", "refund"].includes(form.mode) && c ? (
            <Field
              label={`Amount (${c.currency})`}
              hint={`Available ${money(c.available, c.currency)}`}
            >
              <input
                name="amount"
                type="number"
                min="0.01"
                max={decimal(c.available)}
                step="0.01"
                defaultValue={decimal(c.available)}
                required
              />
            </Field>
          ) : null}
          {form.mode === "refund" && c ? (
            <>
              <Field label="PKR per currency unit">
                <input
                  name="fx"
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  defaultValue={Number(c.fx_micros) / 1e6}
                  readOnly={c.currency === "PKR"}
                  required
                />
              </Field>
              <BankSelect data={data} entity={c.entity_id} />
              <Field label="Payment reference">
                <input name="reference" maxLength={200} required />
              </Field>
              <p className="muted">
                Record a refund you have already made. This does not transfer
                money. Withholding tax already collected is not automatically
                reversed.
              </p>
            </>
          ) : null}
          {!["apply", "refund"].includes(form.mode) ? (
            <Field label="Reason">
              <textarea name="reason" maxLength={200} required />
            </Field>
          ) : null}
          <p className="muted">
            {form.mode === "create"
              ? "Issuing posts the credit note to the ledger. It does not email the customer."
              : form.mode.startsWith("credit.")
                ? "A dated reversal preserves the original audit trail. Reverse any active applications and refunds before reversing a credit note."
                : "This posts the allocation or refund to the ledger."}
          </p>
          <button className="primary" type="submit">
            {busy
              ? "Saving…"
              : form.mode === "create"
                ? "Issue credit note"
                : title}
          </button>
        </fieldset>
      </form>
    </Drawer>
  );
}
