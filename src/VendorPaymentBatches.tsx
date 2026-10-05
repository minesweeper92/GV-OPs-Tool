import { useState, useEffect } from "react";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Heading, Table, Field, Drawer, ErrorBox, Empty } from "./components";
import { BankSelect } from "./Banking";
import {
  request,
  today,
  day,
  money,
  decimal,
  type Data,
  type Me,
  type VendorPaymentBatch,
} from "./model";
import { minor } from "../shared/money";
import {
  readBrowserDraft,
  writeBrowserDraft,
  clearBrowserDraft,
} from "./browserDraft";

const schema = z.object({
  savedAt: z.number(),
  entity: z.string(),
  vendor: z.string(),
  currency: z.string(),
  date: z.string(),
  fx: z.string(),
  fee: z.string(),
  reference: z.string(),
  bank: z.string(),
  requestKey: z.uuid(),
  allocations: z.record(
    z.string(),
    z.object({ amount: z.string(), wht: z.string() }),
  ),
});
type Draft = Omit<z.infer<typeof schema>, "savedAt">;
function number(value: string) {
  try {
    return minor(value);
  } catch {
    return 0n;
  }
}

export function VendorPaymentBatches({
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
    [open, setOpen] = useState(false),
    [reverse, setReverse] = useState<VendorPaymentBatch | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const key = `gv:${me.organization.id}:${me.user.id}:vendor-payment-batch:v1`;
  const [draft, setDraft] = useState<Draft>(
    () =>
      readBrowserDraft(key, schema) || {
        entity: entity === "all" ? data.entities[0]?.id || "" : entity,
        vendor: "",
        currency: "PKR",
        date: today(),
        fx: "1",
        fee: "0",
        reference: "",
        bank: "",
        requestKey: crypto.randomUUID(),
        allocations: {},
      },
  );
  const [storageOk, setStorageOk] = useState(true);
  useEffect(() => {
    if (open) setStorageOk(writeBrowserDraft(key, draft));
  }, [draft, key, open]);
  const bills = data.bills.filter(
    (b) =>
      b.status === "Open" &&
      b.entity_id === draft.entity &&
      b.vendor_id === draft.vendor &&
      b.currency === draft.currency,
  );
  const rows = (data.vendorPaymentBatches || []).filter(
    (p) => (entity === "all" || p.entity_id === entity) && (!id || p.id === id),
  );
  const allocations = Object.entries(draft.allocations).filter(
    ([, a]) =>
      a.amount.trim() !== "" ||
      (a.wht.trim() !== "" && !/^0+(?:\.0+)?$/.test(a.wht.trim())),
  );
  const cash = allocations.reduce((s, [, a]) => s + number(a.amount), 0n),
    wht = allocations.reduce((s, [, a]) => s + number(a.wht), 0n);
  async function save(command: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await request("commands", "POST", command, me.csrf);
      for (const queryKey of [
        ["data"],
        ["report"],
        ["financial-report"],
        ["financial-detail"],
        ["banking"],
        ["party-statement"],
      ])
        await cache.invalidateQueries({ queryKey });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function change<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [field]: value }));
  }
  function context(field: "entity" | "vendor" | "currency", value: string) {
    setDraft((d) => ({
      ...d,
      [field]: value,
      allocations: {},
      bank: field === "entity" ? "" : d.bank,
      fx: field === "currency" && value === "PKR" ? "1" : d.fx,
    }));
  }
  function allocate(bill: string, field: "amount" | "wht", value: string) {
    setDraft((d) => ({
      ...d,
      allocations: {
        ...d.allocations,
        [bill]: {
          amount: d.allocations[bill]?.amount || "",
          wht: d.allocations[bill]?.wht || "0",
          [field]: value,
        },
      },
    }));
  }
  return (
    <>
      <Heading
        title="Payments made"
        subtitle="One vendor payment, one bank entry. Allocate cash and withholding to approved bills; no bank transfer is initiated."
        action="Record vendor payment"
        onAction={() => {
          setError("");
          setOpen(true);
        }}
      />
      <ErrorBox error={error} />
      {rows.length ? (
        <Table
          headers={[
            "Reference / vendor",
            "Date",
            "Cash paid",
            "Withheld",
            "Bank charge",
            "Status",
            "Bill allocations",
          ]}
        >
          {rows.map((p) => (
            <tr key={p.id}>
              <td>
                <a href={`#vendor-payments/${p.id}`}>{p.reference}</a>
                <small>
                  {p.vendor_name} ·{" "}
                  {data.entities.find((e) => e.id === p.entity_id)?.code}
                </small>
              </td>
              <td>{day(p.payment_date)}</td>
              <td>{money(p.amount_minor, p.currency)}</td>
              <td>{money(p.wht_minor, p.currency)}</td>
              <td>{money(p.fee_minor, p.currency)}</td>
              <td>
                {p.reversal_date ? (
                  `Reversed ${day(p.reversal_date)}`
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setReverse(p);
                    }}
                  >
                    Reverse payment
                  </button>
                )}
                {p.reversal_reason ? <small>{p.reversal_reason}</small> : null}
              </td>
              <td>
                {p.allocations.map((a) => (
                  <div key={a.bill_id}>
                    <a href={`#bill/${a.bill_id}`}>{a.reference}</a> ·{" "}
                    {money(a.amount_minor, p.currency)} cash
                    {number(a.wht_minor) > 0n
                      ? ` + ${money(a.wht_minor, p.currency)} withheld`
                      : ""}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty title="No multi-bill payments">
          Record one payment against one or more approved bills from the same
          vendor, legal entity and currency.
        </Empty>
      )}
      {open ? (
        <Drawer
          title="Record vendor payment"
          wide
          dirty={true}
          close={() => {
            if (busy) return;
            clearBrowserDraft(key);
            setOpen(false);
            setDraft({
              entity: entity === "all" ? data.entities[0]?.id || "" : entity,
              vendor: "",
              currency: "PKR",
              date: today(),
              fx: "1",
              fee: "0",
              reference: "",
              bank: "",
              requestKey: crypto.randomUUID(),
              allocations: {},
            });
          }}
        >
          <form
            className="editor"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              const done = await save({
                action: "vendor-payment.batch-create",
                bank_account_id: draft.bank || null,
                date: draft.date,
                fx: draft.fx,
                fee: draft.fee,
                reference: draft.reference,
                request_key: draft.requestKey,
                allocations: allocations.map(([bill_id, a]) => ({
                  bill_id,
                  amount: a.amount,
                  wht: a.wht || "0",
                })),
              });
              if (done) {
                clearBrowserDraft(key);
                setOpen(false);
                setDraft((d) => ({
                  ...d,
                  reference: "",
                  fee: "0",
                  allocations: {},
                  requestKey: crypto.randomUUID(),
                }));
              }
            }}
          >
            <div className="editor-body">
              <p>
                Your unfinished payment is saved in this browser tab for up to
                24 hours.
              </p>
              {!storageOk ? (
                <p role="alert">
                  Draft recovery is unavailable in this browser. Keep this form
                  open until saved.
                </p>
              ) : null}
              <div className="form-row">
                <Field label="Legal entity">
                  <select
                    required
                    value={draft.entity}
                    onChange={(e) => context("entity", e.target.value)}
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
                    value={draft.vendor}
                    onChange={(e) => context("vendor", e.target.value)}
                  >
                    <option value="">Select vendor</option>
                    {data.companies
                      .filter((c) => c.vendor)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Payment currency">
                  <select
                    value={draft.currency}
                    onChange={(e) => context("currency", e.target.value)}
                  >
                    {[
                      ...new Set([
                        "PKR",
                        ...data.bills
                          .filter(
                            (b) =>
                              b.entity_id === draft.entity &&
                              b.vendor_id === draft.vendor &&
                              b.status === "Open",
                          )
                          .map((b) => b.currency),
                      ]),
                    ].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Payment date">
                  <input
                    required
                    type="date"
                    value={draft.date}
                    onChange={(e) => change("date", e.target.value)}
                  />
                </Field>
                <Field label="Reference">
                  <input
                    required
                    maxLength={2000}
                    value={draft.reference}
                    onChange={(e) => change("reference", e.target.value)}
                  />
                </Field>
                <Field label="Exchange rate (PKR per unit)">
                  <input
                    required
                    inputMode="decimal"
                    readOnly={draft.currency === "PKR"}
                    value={draft.fx}
                    onChange={(e) => change("fx", e.target.value)}
                  />
                </Field>
                <Field
                  label={`Bank charge (${draft.currency})`}
                  hint="Charged once for this payment, allocated proportionally to bills."
                >
                  <input
                    required
                    inputMode="decimal"
                    value={draft.fee}
                    onChange={(e) => change("fee", e.target.value)}
                  />
                </Field>
                <div
                  onChange={(e) => {
                    const target = e.target;
                    if (
                      target instanceof HTMLSelectElement &&
                      target.name === "bank_account_id"
                    )
                      change("bank", target.value);
                  }}
                >
                  <BankSelect
                    key={draft.entity}
                    data={data}
                    entity={draft.entity}
                    defaultValue={draft.bank}
                  />
                </div>
              </div>
              <h3>Allocate to bills</h3>
              <p>
                Cash plus withholding cannot exceed the bill's remaining
                balance. Leave cash blank to skip a bill.
              </p>
              {bills.length ? (
                <Table
                  headers={[
                    "Bill",
                    "Due date",
                    "Outstanding",
                    "Cash paid",
                    "Withheld",
                    "Use balance",
                  ]}
                >
                  {bills.map((b) => {
                    const balance =
                      BigInt(b.total_minor) -
                      BigInt(b.paid_minor) -
                      BigInt(b.credited_minor);
                    return (
                      <tr key={b.id}>
                        <td>{b.reference}</td>
                        <td>{day(b.due_date)}</td>
                        <td>{money(String(balance), b.currency)}</td>
                        <td>
                          <input
                            aria-label={`Cash for ${b.reference}`}
                            inputMode="decimal"
                            value={draft.allocations[b.id]?.amount || ""}
                            onChange={(e) =>
                              allocate(b.id, "amount", e.target.value)
                            }
                          />
                        </td>
                        <td>
                          <input
                            aria-label={`Withholding for ${b.reference}`}
                            inputMode="decimal"
                            value={draft.allocations[b.id]?.wht || "0"}
                            onChange={(e) =>
                              allocate(b.id, "wht", e.target.value)
                            }
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() =>
                              allocate(
                                b.id,
                                "amount",
                                decimal(
                                  balance -
                                    number(draft.allocations[b.id]?.wht || "0"),
                                ),
                              )
                            }
                          >
                            Use balance
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </Table>
              ) : (
                <p>
                  No matching approved open bills. Select a vendor with
                  outstanding bills.
                </p>
              )}
              <section className="panel" aria-live="polite">
                <p>
                  Allocated to bills:{" "}
                  {money(String(cash + wht), draft.currency)}
                </p>
                <p>
                  Cash: {money(String(cash), draft.currency)} · Withholding:{" "}
                  {money(String(wht), draft.currency)}
                </p>
                <strong>
                  Total bank debit:{" "}
                  {money(String(cash + number(draft.fee)), draft.currency)}
                </strong>
              </section>
              <ErrorBox error={error} />
            </div>
            <div className="editor-footer actions">
              <button
                type="submit"
                className="primary"
                disabled={busy || !allocations.length}
              >
                {busy ? "Recording…" : "Record payment"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Keep draft & close
              </button>
            </div>
          </form>
        </Drawer>
      ) : null}
      {reverse ? (
        <Drawer
          title={`Reverse ${reverse.reference}`}
          dirty={true}
          close={() => {
            if (!busy) setReverse(null);
          }}
        >
          <form
            className="editor"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              const f = new FormData(e.currentTarget);
              if (
                await save({
                  action: "vendor-payment.batch-reverse",
                  id: reverse.id,
                  date: f.get("date"),
                  reason: f.get("reason"),
                })
              )
                setReverse(null);
            }}
          >
            <div className="editor-body">
              <p>
                This reverses the entire payment and all bill allocations. It
                does not initiate a bank refund.
              </p>
              <Field label="Reversal date">
                <input
                  required
                  type="date"
                  name="date"
                  min={reverse.payment_date}
                  defaultValue={today()}
                />
              </Field>
              <Field label="Reason">
                <textarea required name="reason" />
              </Field>
              <ErrorBox error={error} />
            </div>
            <div className="editor-footer">
              <button className="primary" disabled={busy}>
                {busy ? "Reversing…" : "Reverse entire payment"}
              </button>
            </div>
          </form>
        </Drawer>
      ) : null}
    </>
  );
}
