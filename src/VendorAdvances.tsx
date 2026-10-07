import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Heading, Table, Drawer, Field, ErrorBox, Empty } from "./components";
import { ContactCompanyField } from "./ContactCompanyField";
import { request, money, rate, today, day, type Data, type Me } from "./model";
import {
  readBrowserDraft,
  writeBrowserDraft,
  clearBrowserDraft,
} from "./browserDraft";

const schema = z.object({
  savedAt: z.number(),
  requestKey: z.uuid(),
  entity: z.string(),
  vendor: z.string(),
  project: z.string(),
  currency: z.string(),
  date: z.string(),
  amount: z.string(),
  wht: z.string(),
  fee: z.string(),
  fx: z.string(),
  bank: z.string(),
  purpose: z.enum(["operating", "investing"]),
  reference: z.string(),
  notes: z.string(),
});
type Draft = Omit<z.infer<typeof schema>, "savedAt">;
type Operation = {
  action:
    "apply" | "refund" | "reverse" | "reverse-application" | "reverse-refund";
  id: string;
  date: string;
  amount: string;
  bill: string;
  fee: string;
  fx: string;
  bank: string;
  reference: string;
  reason: string;
  requestKey: string;
};
const minorInput = (minor: bigint) =>
  `${minor / 100n}.${String(minor % 100n).padStart(2, "0")}`;

export default function VendorAdvances({
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
    key = `gv:${me.organization.id}:${me.user.id}:vendor-advance:v1`;
  const fresh = (): Draft => ({
    requestKey: crypto.randomUUID(),
    entity: entity === "all" ? data.entities[0]?.id || "" : entity,
    vendor: "",
    project: "",
    currency: "PKR",
    date: today(),
    amount: "",
    wht: "0",
    fee: "0",
    fx: "1",
    bank: "",
    purpose: "operating",
    reference: "",
    notes: "",
  });
  const [draft, setDraft] = useState<Draft>(
    () => readBrowserDraft(key, schema) || fresh(),
  );
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [storageOk, setStorageOk] = useState(true),
    [addingVendor, setAddingVendor] = useState(false),
    [vendorBusy, setVendorBusy] = useState(false),
    [operation, setOperation] = useState<Operation | null>(null);
  useEffect(() => {
    if (open) setStorageOk(writeBrowserDraft(key, draft));
  }, [open, key, draft]);
  const records = (data.vendorAdvances || []).filter(
      (a) => entity === "all" || a.entity_id === entity,
    ),
    selected = records.find((a) => a.id === id);
  const applications = (data.vendorAdvanceApplications || []).filter(
      (a) => a.advance_id === id,
    ),
    refunds = (data.vendorAdvanceRefunds || []).filter(
      (a) => a.advance_id === id,
    );
  const available =
    selected && !selected.reversal_date
      ? BigInt(selected.total_minor) -
        BigInt(selected.applied_minor) -
        BigInt(selected.refunded_minor)
      : 0n;
  const bills = selected
    ? data.bills.filter(
        (b) =>
          b.status === "Open" &&
          b.vendor_id === selected.vendor_id &&
          b.entity_id === selected.entity_id &&
          b.currency === selected.currency &&
          (selected.purpose === "investing"
            ? b.lines.every((l) => l.account_code === "1500")
            : b.lines.every((l) => l.account_code !== "1500")) &&
          (!selected.deal_id || b.deal_id === selected.deal_id),
      )
    : [];
  const change = <K extends keyof Draft>(field: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [field]: value }));
  async function save(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ id: string }>(
        "commands",
        "POST",
        payload,
        me.csrf,
      );
      await Promise.all(
        [
          "data",
          "banking",
          "financial-report",
          "financial-detail",
          "report",
          "party-statement",
        ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
      );
      return result;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  function discard() {
    clearBrowserDraft(key);
    clearBrowserDraft(`${key}:vendor`);
    setDraft(fresh());
    setOpen(false);
    setError("");
  }
  function start(action: Operation["action"], target = id || "") {
    setError("");
    setOperation({
      action,
      id: target,
      date: today(),
      amount:
        action === "apply" && bills[0]
          ? minorInput(
              available <
                BigInt(bills[0].total_minor) -
                  BigInt(bills[0].paid_minor) -
                  BigInt(bills[0].credited_minor)
                ? available
                : BigInt(bills[0].total_minor) -
                    BigInt(bills[0].paid_minor) -
                    BigInt(bills[0].credited_minor),
            )
          : minorInput(available),
      bill: bills[0]?.id || "",
      fee: "0",
      fx: selected ? rate(selected.fx_micros) : "1",
      bank: selected?.bank_account_id || "",
      reference: "",
      reason: "",
      requestKey: crypto.randomUUID(),
    });
  }
  const bankField = (
    entityId: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <Field
      label="Bank account"
      hint="Select where the money actually moved. Unassigned entries must be allocated before reconciliation."
    >
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Unassigned bank ledger</option>
        {data.bankAccounts
          .filter((b) => b.entity_id === entityId)
          .map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
      </select>
    </Field>
  );
  if (!["admin", "finance"].includes(me.user.role))
    return (
      <Empty title="Finance access required">
        Vendor advances are restricted to finance and administrators.
      </Empty>
    );
  return (
    <>
      <Heading
        title="Vendor advances"
        subtitle="Record purchase prepayments, apply them to approved bills, and track unused balances. This records money already paid—it does not send a payment."
        action="Record advance"
        onAction={() => {
          setError("");
          setOpen(true);
        }}
      />
      {!open && !operation && error && <ErrorBox error={error} />}
      {selected ? (
        <>
          <a href="#vendor-advances">← All vendor advances</a>
          <section className="panel">
            <h2>{selected.reference}</h2>
            <p>
              {selected.vendor_name} ·{" "}
              {data.entities.find((e) => e.id === selected.entity_id)?.name} ·{" "}
              {day(selected.advance_date)} ·{" "}
              {selected.reversal_date
                ? "Reversed"
                : available > 0n
                  ? "Available"
                  : "Fully used"}
            </p>
            <div className="form-row">
              <div>
                <p>Original advance (cash + withholding)</p>
                <h3>{money(selected.total_minor, selected.currency)}</h3>
                <p>
                  Cash {money(selected.amount_minor, selected.currency)} ·
                  Withholding {money(selected.wht_minor, selected.currency)} ·
                  Bank fee {money(selected.fee_minor, selected.currency)}
                </p>
              </div>
              <div>
                <p>Unused balance</p>
                <h3>{money(available, selected.currency)}</h3>
                <p>
                  Historical base carrying value:{" "}
                  {money(
                    selected.reversal_date
                      ? "0"
                      : BigInt(selected.base_minor) -
                          BigInt(selected.applied_base_minor) -
                          BigInt(selected.refunded_base_minor),
                  )}
                </p>
              </div>
            </div>
            <p>
              {selected.purpose === "investing"
                ? "Equipment / capital purchase"
                : "Operating purchase"}
              {selected.notes ? ` · ${selected.notes}` : ""}
            </p>
            {!selected.reversal_date && (
              <div className="actions">
                <button
                  disabled={busy || available <= 0n || !bills.length}
                  onClick={() => start("apply")}
                >
                  Apply to bill
                </button>
                <button
                  disabled={busy || available <= 0n}
                  onClick={() => start("refund")}
                >
                  Record refund received
                </button>
                <button
                  disabled={
                    busy ||
                    applications.some((a) => !a.reversal_date) ||
                    refunds.some((r) => !r.reversal_date)
                  }
                  onClick={() => start("reverse")}
                >
                  Reverse advance
                </button>
              </div>
            )}
            {!selected.reversal_date && !bills.length && (
              <p>
                No matching open bill. Create and approve a bill for this
                vendor, entity and currency before applying the advance.
              </p>
            )}
            {selected.reversal_date && (
              <p>
                Reversed {day(selected.reversal_date)}:{" "}
                {selected.reversal_reason}
              </p>
            )}
          </section>
          <h2>Bill applications</h2>
          <p className="muted">
            Applications settle bills without moving cash. Reversals retain the
            original application and reason.
          </p>
          <Table headers={["Date", "Bill", "Amount", "Status", "Action"]}>
            {applications.map((a) => (
              <tr key={a.id}>
                <td>{day(a.application_date)}</td>
                <td>
                  <a href={`#bill/${a.bill_id}`}>
                    {data.bills.find((b) => b.id === a.bill_id)?.reference ||
                      "Bill"}
                  </a>
                </td>
                <td>{money(a.amount_minor, selected.currency)}</td>
                <td>
                  {a.reversal_date
                    ? `Reversed ${day(a.reversal_date)}: ${a.reversal_reason}`
                    : "Applied"}
                </td>
                <td>
                  {!a.reversal_date && (
                    <button
                      disabled={busy}
                      onClick={() => start("reverse-application", a.id)}
                    >
                      Reverse application
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          <h2>Refunds received</h2>
          <Table
            headers={[
              "Date",
              "Reference",
              "Amount",
              "Bank fee",
              "Status",
              "Action",
            ]}
          >
            {refunds.map((r) => (
              <tr key={r.id}>
                <td>{day(r.refund_date)}</td>
                <td>{r.reference}</td>
                <td>{money(r.amount_minor, selected.currency)}</td>
                <td>{money(r.fee_minor, selected.currency)}</td>
                <td>
                  {r.reversal_date
                    ? `Reversed ${day(r.reversal_date)}: ${r.reversal_reason}`
                    : "Recorded"}
                </td>
                <td>
                  {!r.reversal_date && (
                    <button
                      disabled={busy}
                      onClick={() => start("reverse-refund", r.id)}
                    >
                      Reverse refund
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </>
      ) : id ? (
        <Empty title="Advance not found">
          Choose the correct legal entity or return to all advances.
        </Empty>
      ) : records.length ? (
        <Table
          headers={[
            "Date",
            "Reference",
            "Vendor",
            "Legal entity",
            "Total",
            "Available",
            "Status",
          ]}
        >
          {records.map((a) => (
            <tr key={a.id}>
              <td>{day(a.advance_date)}</td>
              <td>
                <a href={`#vendor-advances/${a.id}`}>{a.reference}</a>
              </td>
              <td>{a.vendor_name}</td>
              <td>{data.entities.find((e) => e.id === a.entity_id)?.name}</td>
              <td>{money(a.total_minor, a.currency)}</td>
              <td>
                {money(
                  a.reversal_date
                    ? "0"
                    : BigInt(a.total_minor) -
                        BigInt(a.applied_minor) -
                        BigInt(a.refunded_minor),
                  a.currency,
                )}
              </td>
              <td>{a.reversal_date ? "Reversed" : "Recorded"}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty title="No vendor advances yet">
          Record a purchase prepayment when you pay a vendor before their bill
          is approved.
        </Empty>
      )}
      {open && (
        <Drawer
          title="Record vendor advance"
          dirty={false}
          close={() => {
            if (!busy && !vendorBusy && !addingVendor) setOpen(false);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || vendorBusy || addingVendor) return;
              try {
                const result = await save({
                  action: "vendor-advance.create",
                  entity_id: draft.entity,
                  vendor_id: draft.vendor,
                  deal_id: draft.project || null,
                  currency: draft.currency,
                  date: draft.date,
                  amount: draft.amount,
                  wht: draft.wht,
                  fee: draft.fee,
                  fx: draft.currency === "PKR" ? "1" : draft.fx,
                  bank_account_id: draft.bank || null,
                  purpose: draft.purpose,
                  reference: draft.reference,
                  notes: draft.notes,
                  request_key: draft.requestKey,
                });
                discard();
                location.hash = `vendor-advances/${result.id}`;
              } catch {
                /* Keep the exact request key and draft for a safe retry. */
              }
            }}
          >
            <div className="editor-body">
              {error && <ErrorBox error={error} />}
              {!storageOk && (
                <p role="status">
                  Browser storage is unavailable. Keep this form open to
                  preserve your draft.
                </p>
              )}
              <Field label="Legal entity">
                <select
                  required
                  value={draft.entity}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      entity: e.target.value,
                      bank: "",
                      project: "",
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
              <ContactCompanyField
                companies={data.companies.filter((c) => c.vendor)}
                create={save}
                vendor
                required
                draftKey={`${key}:vendor`}
                initialCompanyId={draft.vendor}
                onSelectionChange={(v) => change("vendor", v)}
                onOpenChange={setAddingVendor}
                onBusyChange={setVendorBusy}
                onChange={() => {}}
              />
              <div className="form-row">
                <Field label="Cash paid">
                  <input
                    required
                    inputMode="decimal"
                    value={draft.amount}
                    onChange={(e) => change("amount", e.target.value)}
                  />
                </Field>
                <Field label="Payment date">
                  <input
                    required
                    type="date"
                    value={draft.date}
                    onChange={(e) => change("date", e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Reference">
                <input
                  required
                  maxLength={200}
                  value={draft.reference}
                  onChange={(e) => change("reference", e.target.value)}
                />
              </Field>
              {bankField(draft.entity, draft.bank, (v) => change("bank", v))}
              <details>
                <summary>
                  Currency, withholding, project and other details
                </summary>
                <div className="form-row">
                  <Field label="Currency">
                    <select
                      value={draft.currency}
                      onChange={(e) => change("currency", e.target.value)}
                    >
                      {["PKR", "USD", "AED", "EUR", "GBP"].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  {draft.currency !== "PKR" && (
                    <Field label="PKR per currency unit">
                      <input
                        required
                        inputMode="decimal"
                        value={draft.fx}
                        onChange={(e) => change("fx", e.target.value)}
                      />
                    </Field>
                  )}
                </div>
                <div className="form-row">
                  <Field
                    label="Withholding amount"
                    hint="Recorded separately from cash. This is not a tax certificate."
                  >
                    <input
                      required
                      inputMode="decimal"
                      value={draft.wht}
                      onChange={(e) => change("wht", e.target.value)}
                    />
                  </Field>
                  <Field label="Bank fee">
                    <input
                      required
                      inputMode="decimal"
                      value={draft.fee}
                      onChange={(e) => change("fee", e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="Purchase purpose">
                  <select
                    value={draft.purpose}
                    onChange={(e) =>
                      change("purpose", e.target.value as Draft["purpose"])
                    }
                  >
                    <option value="operating">
                      Operating goods or services
                    </option>
                    <option value="investing">
                      Equipment / capital purchase
                    </option>
                  </select>
                </Field>
                <Field label="Project (optional)">
                  <select
                    value={draft.project}
                    onChange={(e) => change("project", e.target.value)}
                  >
                    <option value="">General company purchase</option>
                    {data.deals
                      .filter((d) => d.entity_id === draft.entity)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Notes">
                  <textarea
                    maxLength={4000}
                    value={draft.notes}
                    onChange={(e) => change("notes", e.target.value)}
                  />
                </Field>
                <p>
                  For purchase prepayments only—not loans or refundable security
                  deposits. The advance remains an asset until applied to an
                  approved bill.
                </p>
              </details>
            </div>
            <div className="editor-footer">
              <button
                className="primary"
                disabled={busy || vendorBusy || addingVendor}
              >
                {busy ? "Saving…" : "Record advance"}
              </button>
              <button
                type="button"
                disabled={busy || vendorBusy || addingVendor}
                onClick={() => setOpen(false)}
              >
                Close & keep draft
              </button>
              <button
                type="button"
                disabled={busy || vendorBusy || addingVendor}
                onClick={() => {
                  if (window.confirm("Discard this advance draft?")) discard();
                }}
              >
                Discard draft
              </button>
            </div>
          </form>
        </Drawer>
      )}
      {operation && selected && (
        <Drawer
          title={
            operation.action === "apply"
              ? "Apply advance to bill"
              : operation.action === "refund"
                ? "Record vendor refund received"
                : "Reverse recorded transaction"
          }
          dirty
          close={() => {
            if (!busy) setOperation(null);
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              const o = operation;
              const payload =
                o.action === "apply"
                  ? {
                      bill_id: o.bill,
                      amount: o.amount,
                      request_key: o.requestKey,
                    }
                  : o.action === "refund"
                    ? {
                        amount: o.amount,
                        fee: o.fee,
                        fx: selected.currency === "PKR" ? "1" : o.fx,
                        bank_account_id: o.bank || null,
                        reference: o.reference,
                        request_key: o.requestKey,
                      }
                    : { reason: o.reason };
              try {
                await save({
                  action: `vendor-advance.${o.action}`,
                  id: o.id,
                  date: o.date,
                  ...payload,
                });
                setOperation(null);
              } catch {
                /* Preserve fields for retry. */
              }
            }}
          >
            <div className="editor-body">
              {error && <ErrorBox error={error} />}
              <p>
                {selected.vendor_name} · {selected.currency} · Available{" "}
                {money(available, selected.currency)}
              </p>
              <Field label="Transaction date">
                <input
                  type="date"
                  required
                  value={operation.date}
                  onChange={(e) =>
                    setOperation({ ...operation, date: e.target.value })
                  }
                />
              </Field>
              {operation.action === "apply" && (
                <>
                  <Field label="Approved bill">
                    <select
                      required
                      value={operation.bill}
                      onChange={(e) => {
                        const b = bills.find((b) => b.id === e.target.value);
                        if (!b) return;
                        const due =
                          BigInt(b.total_minor) -
                          BigInt(b.paid_minor) -
                          BigInt(b.credited_minor);
                        setOperation({
                          ...operation,
                          bill: b.id,
                          amount: minorInput(available < due ? available : due),
                        });
                      }}
                    >
                      {bills.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.reference} · Due{" "}
                          {money(
                            BigInt(b.total_minor) -
                              BigInt(b.paid_minor) -
                              BigInt(b.credited_minor),
                            b.currency,
                          )}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <p>
                    This settles the payable without moving money again.
                    Historical exchange differences adjust the original purchase
                    cost.
                  </p>
                </>
              )}
              {["apply", "refund"].includes(operation.action) ? (
                <Field label={`Amount (${selected.currency})`}>
                  <input
                    required
                    inputMode="decimal"
                    value={operation.amount}
                    onChange={(e) =>
                      setOperation({ ...operation, amount: e.target.value })
                    }
                  />
                </Field>
              ) : (
                <>
                  <Field label="Reason">
                    <textarea
                      required
                      maxLength={200}
                      value={operation.reason}
                      onChange={(e) =>
                        setOperation({ ...operation, reason: e.target.value })
                      }
                    />
                  </Field>
                  <p>
                    A dated inverse entry preserves the original record. This
                    does not return cash to or from the vendor.
                  </p>
                </>
              )}
              {operation.action === "refund" && (
                <>
                  <p>
                    Record only money already received. Withholding liability is
                    not automatically refunded or adjusted.
                  </p>
                  <Field label="Refund reference">
                    <input
                      required
                      maxLength={200}
                      value={operation.reference}
                      onChange={(e) =>
                        setOperation({
                          ...operation,
                          reference: e.target.value,
                        })
                      }
                    />
                  </Field>
                  {bankField(selected.entity_id, operation.bank, (bank) =>
                    setOperation({ ...operation, bank }),
                  )}
                  <Field label="Bank fee">
                    <input
                      required
                      inputMode="decimal"
                      value={operation.fee}
                      onChange={(e) =>
                        setOperation({ ...operation, fee: e.target.value })
                      }
                    />
                  </Field>
                  {selected.currency !== "PKR" && (
                    <Field label="Refund exchange rate (PKR per unit)">
                      <input
                        required
                        inputMode="decimal"
                        value={operation.fx}
                        onChange={(e) =>
                          setOperation({ ...operation, fx: e.target.value })
                        }
                      />
                    </Field>
                  )}
                </>
              )}
            </div>
            <div className="editor-footer">
              <button className="primary" disabled={busy}>
                {busy
                  ? "Saving…"
                  : operation.action === "apply"
                    ? "Apply advance"
                    : operation.action === "refund"
                      ? "Record refund"
                      : "Confirm reversal"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setOperation(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        </Drawer>
      )}
    </>
  );
}
