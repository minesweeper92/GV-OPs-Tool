import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Heading, Table, Field, Drawer, ErrorBox, Empty } from "./components";
import {
  request,
  today,
  day,
  money,
  decimal,
  rate,
  invoiceBalance,
  type Data,
  type Me,
} from "./model";
import { minor } from "../shared/money";
import { hasCapability } from "../shared/permissions";
import {
  receiptProblem,
  receiptTotals,
  suggestAllocations,
  type CustomerReceipt,
} from "../shared/customer-receipts";
import {
  readBrowserDraft,
  writeBrowserDraft,
  clearBrowserDraft,
} from "./browserDraft";

const allocationDraft = z.object({
  amount: z.string(),
  wht: z.string(),
  sales_tax_withheld: z.string(),
});
const schema = z.object({
  savedAt: z.number(),
  entity: z.string(),
  customer: z.string(),
  currency: z.string(),
  date: z.string(),
  amount: z.string(),
  fee: z.string(),
  fx: z.string(),
  reference: z.string(),
  notes: z.string(),
  bank: z.string(),
  requestKey: z.uuid(),
  allocations: z.record(z.string(), allocationDraft),
});
type Draft = Omit<z.infer<typeof schema>, "savedAt">;
type Allocation = z.infer<typeof allocationDraft>;
const amountPattern = /^\d{1,13}(\.\d{1,2})?$/;
// Incomplete typing must never throw; the server validates what is submitted.
const number = (value: string) => {
  try {
    return amountPattern.test(value.trim()) ? minor(value.trim()) : 0n;
  } catch {
    return 0n;
  }
};
const clean = (value: string) =>
  amountPattern.test(value.trim()) ? value.trim() : "0";
const blank = (data: Data, entity: string): Draft => ({
  entity: entity === "all" ? data.entities[0]?.id || "" : entity,
  customer: "",
  currency: "PKR",
  date: today(),
  amount: "",
  fee: "0",
  fx: "1",
  reference: "",
  notes: "",
  bank: "",
  requestKey: crypto.randomUUID(),
  allocations: {},
});

export function CustomerReceipts({
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
    canPost = hasCapability(me.user, "books.post"),
    [open, setOpen] = useState(false),
    [reviewing, setReviewing] = useState(false),
    [action, setAction] = useState<
      | { kind: "apply" | "refund" | "reverse"; receipt: CustomerReceipt }
      | {
          kind: "reverse-application" | "reverse-refund";
          receipt: CustomerReceipt;
          id: string;
          label: string;
          min: string;
        }
      | null
    >(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const key = `gv:${me.organization.id}:${me.user.id}:customer-receipt:v1`;
  const [draft, setDraft] = useState<Draft>(
    () => readBrowserDraft(key, schema) || blank(data, entity),
  );
  const [storageOk, setStorageOk] = useState(true);
  useEffect(() => {
    if (open) setStorageOk(writeBrowserDraft(key, draft));
  }, [draft, key, open]);

  const receipts = data.customerReceipts || [],
    allocationsOf = (receiptId: string) =>
      (data.customerReceiptAllocations || []).filter(
        (a) => a.receipt_id === receiptId,
      ),
    applicationsOf = (receiptId: string) =>
      (data.customerReceiptApplications || []).filter(
        (a) => a.receipt_id === receiptId,
      ),
    refundsOf = (receiptId: string) =>
      (data.customerReceiptRefunds || []).filter(
        (a) => a.receipt_id === receiptId,
      );
  const invoiceNumber = (invoiceId: string) =>
    data.invoices.find((i) => i.id === invoiceId)?.number || "Invoice";
  const entityCode = (entityId: string) =>
    data.entities.find((e) => e.id === entityId)?.code || "";
  const bankName = (bankId: string | null) =>
    bankId
      ? (data.bankAccounts || []).find((b) => b.id === bankId)?.name ||
        "Bank account"
      : "Unassigned bank and cash (1000)";
  const rows = receipts.filter(
    (r) => (entity === "all" || r.entity_id === entity) && (!id || r.id === id),
  );
  const selected = id ? receipts.find((r) => r.id === id) : undefined;
  // Cash customers have on account, never merged across entity or currency.
  const onAccount = [
    ...receipts
      .filter(
        (r) =>
          (entity === "all" || r.entity_id === entity) &&
          BigInt(r.available_minor) > 0n,
      )
      .reduce((groups, r) => {
        const k = `${r.company_id}/${r.entity_id}/${r.currency}`;
        const g = groups.get(k) || {
          key: k,
          name: r.customer_name,
          entity: r.entity_id,
          currency: r.currency,
          total: 0n,
        };
        g.total += BigInt(r.available_minor);
        return groups.set(k, g);
      }, new Map<string, { key: string; name: string; entity: string; currency: string; total: bigint }>())
      .values(),
  ];
  const openInvoices = (customer: string, entityId: string, currency: string) =>
    data.invoices.filter(
      (i) =>
        i.status === "Issued" &&
        i.company_id === customer &&
        i.entity_id === entityId &&
        i.currency === currency &&
        invoiceBalance(i) > 0n,
    );
  const invoices = openInvoices(draft.customer, draft.entity, draft.currency);
  const entered = invoices
    .map((i) => ({ i, a: draft.allocations[i.id] }))
    .filter(
      (x): x is { i: (typeof invoices)[number]; a: Allocation } =>
        !!x.a &&
        number(x.a.amount) + number(x.a.wht) + number(x.a.sales_tax_withheld) >
          0n,
    );
  const command = {
    amount: clean(draft.amount),
    fee: clean(draft.fee),
    allocations: entered.map(({ i, a }) => ({
      invoice_id: i.id,
      amount: clean(a.amount),
      wht: clean(a.wht),
      sales_tax_withheld: clean(a.sales_tax_withheld),
    })),
  };
  const totals = receiptTotals(command);
  const over = entered.find(
    ({ i, a }) =>
      number(a.amount) + number(a.wht) + number(a.sales_tax_withheld) >
      invoiceBalance(i),
  );
  const problem = !draft.customer
    ? "Choose the customer who paid."
    : !draft.reference.trim()
      ? "Enter the bank or receipt reference."
      : over
        ? `The allocation to ${over.i.number} exceeds its outstanding balance.`
        : receiptProblem(command);

  async function save(c: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await request("commands", "POST", c, me.csrf);
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
  const change = <K extends keyof Draft>(field: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [field]: value }));
  // Changing who paid, the entity or the currency changes which invoices are
  // eligible, so earlier allocations cannot be carried across silently.
  const context = (field: "entity" | "customer" | "currency", value: string) =>
    setDraft((d) => ({
      ...d,
      [field]: value,
      allocations: {},
      bank: field === "entity" ? "" : d.bank,
      fx: field === "currency" && value === "PKR" ? "1" : d.fx,
    }));
  const allocate = (
    invoiceId: string,
    field: keyof Allocation,
    value: string,
  ) =>
    setDraft((d) => ({
      ...d,
      allocations: {
        ...d.allocations,
        [invoiceId]: {
          amount: d.allocations[invoiceId]?.amount || "",
          wht: d.allocations[invoiceId]?.wht || "0",
          sales_tax_withheld:
            d.allocations[invoiceId]?.sales_tax_withheld || "0",
          [field]: value,
        },
      },
    }));
  function suggest() {
    const suggestion = suggestAllocations(
      number(draft.amount),
      invoices.map((i) => ({
        id: i.id,
        due_date: i.due_date,
        number: i.number || "",
        // Leave room for withholding already entered on that invoice.
        balance:
          invoiceBalance(i) -
          number(draft.allocations[i.id]?.wht || "0") -
          number(draft.allocations[i.id]?.sales_tax_withheld || "0"),
      })),
    );
    setDraft((d) => ({
      ...d,
      allocations: Object.fromEntries(
        invoices.map((i) => [
          i.id,
          {
            amount: decimal(
              suggestion.find((s) => s.invoice_id === i.id)?.amount || 0n,
            ),
            wht: d.allocations[i.id]?.wht || "0",
            sales_tax_withheld: d.allocations[i.id]?.sales_tax_withheld || "0",
          },
        ]),
      ),
    }));
  }
  function closeComposer(discard: boolean) {
    if (busy) return;
    setOpen(false);
    setReviewing(false);
    if (discard) {
      clearBrowserDraft(key);
      setDraft(blank(data, entity));
    }
  }
  async function post() {
    if (busy || problem) return;
    const done = await save({
      action: "customer-receipt.create",
      entity_id: draft.entity,
      company_id: draft.customer,
      currency: draft.currency,
      bank_account_id: draft.bank || null,
      date: draft.date,
      fx: draft.fx,
      reference: draft.reference.trim(),
      notes: draft.notes.trim(),
      request_key: draft.requestKey,
      ...command,
    });
    if (done) {
      clearBrowserDraft(key);
      setOpen(false);
      setReviewing(false);
      setDraft(blank(data, entity));
    }
  }
  const currencies = [
    ...new Set([
      "PKR",
      ...data.invoices
        .filter(
          (i) =>
            i.company_id === draft.customer &&
            i.entity_id === draft.entity &&
            i.status === "Issued",
        )
        .map((i) => i.currency),
    ]),
  ];
  const status = (r: CustomerReceipt) =>
    r.reversal_date
      ? `Reversed ${day(r.reversal_date)}`
      : BigInt(r.available_minor) > 0n
        ? `${money(r.available_minor, r.currency)} unapplied`
        : "Fully allocated";

  return (
    <>
      {id ? <a href="#customer-receipts">← All customer receipts</a> : null}
      <Heading
        title={selected ? `Receipt ${selected.reference}` : "Customer receipts"}
        subtitle={
          selected
            ? `${selected.customer_name} · ${entityCode(selected.entity_id)} · ${day(selected.receipt_date)}`
            : "One payment from a customer, allocated across their invoices. Cash left over stays on their account until it is applied or refunded. No bank transfer is initiated."
        }
        action={canPost && !id ? "Record customer receipt" : undefined}
        onAction={() => {
          setError("");
          setOpen(true);
        }}
      />
      {!open && !action ? <ErrorBox error={error} /> : null}
      {!id && onAccount.length ? (
        <section
          className="panel receipts-on-account"
          aria-label="Cash on account"
        >
          <h2>Cash on account</h2>
          <p className="muted">
            Unapplied customer cash, shown per customer, legal entity and
            currency. It is owed to the customer until it settles an invoice or
            is refunded.
          </p>
          <ul>
            {onAccount.map((g) => (
              <li key={g.key}>
                <strong>{g.name}</strong> · {entityCode(g.entity)} ·{" "}
                {money(String(g.total), g.currency)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {id && !selected ? (
        <Empty title="Receipt not found">
          It may belong to a legal entity you cannot open.
        </Empty>
      ) : null}
      {!id ? (
        rows.length ? (
          <Table
            label="Customer receipts"
            headers={[
              "Reference / customer",
              "Date",
              "Cash received",
              "Withheld",
              "Bank charge",
              "Status",
              "Settled",
            ]}
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <a href={`#customer-receipts/${r.id}`}>{r.reference}</a>
                  <small>
                    {r.customer_name} · {entityCode(r.entity_id)}
                  </small>
                </td>
                <td>{day(r.receipt_date)}</td>
                <td className="num">{money(r.amount_minor, r.currency)}</td>
                <td className="num">
                  {money(
                    String(
                      BigInt(r.wht_minor) + BigInt(r.sales_tax_withheld_minor),
                    ),
                    r.currency,
                  )}
                </td>
                <td className="num">{money(r.fee_minor, r.currency)}</td>
                <td>{status(r)}</td>
                <td>
                  {allocationsOf(r.id).map((a) => (
                    <div key={a.id}>
                      <a href={`#invoice/${a.invoice_id}`}>
                        {invoiceNumber(a.invoice_id)}
                      </a>
                    </div>
                  ))}
                  {!allocationsOf(r.id).length ? "On account only" : null}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty title="No customer receipts yet">
            Record one payment against one or more issued invoices for the same
            customer, legal entity and currency. Earlier single-invoice payments
            stay under Payments received.
          </Empty>
        )
      ) : null}
      {selected ? (
        <ReceiptDetail
          receipt={selected}
          data={data}
          canPost={canPost}
          busy={busy}
          status={status(selected)}
          bankName={bankName}
          invoiceNumber={invoiceNumber}
          allocations={allocationsOf(selected.id)}
          applications={applicationsOf(selected.id)}
          refunds={refundsOf(selected.id)}
          canApply={
            openInvoices(
              selected.company_id,
              selected.entity_id,
              selected.currency,
            ).length > 0
          }
          act={(a) => {
            setError("");
            setAction(a);
          }}
        />
      ) : null}
      {open ? (
        <Drawer
          title={
            reviewing ? "Review customer receipt" : "Record customer receipt"
          }
          wide
          dirty={true}
          close={() => closeComposer(false)}
        >
          {reviewing ? (
            <div className="editor">
              <div className="editor-body">
                <p>
                  Check the amounts, accounts and date. Posting writes to the
                  books immediately and cannot be edited afterwards; a mistake
                  is corrected by a dated reversal.
                </p>
                <Table
                  label="What will be posted"
                  headers={["Account", "Effect", `Amount (${draft.currency})`]}
                >
                  {(
                    [
                      [
                        bankName(draft.bank || null),
                        "Bank increases",
                        totals.bank,
                      ],
                      ["Bank charges (5300)", "Expense", totals.fee],
                      [
                        "Withholding tax receivable (1200)",
                        "Income tax the customer withheld",
                        totals.wht,
                      ],
                      [
                        "Sales tax withheld by customers (1210)",
                        "Sales tax the customer withheld",
                        totals.salesTax,
                      ],
                      [
                        "Accounts receivable (1100)",
                        "Invoices settled",
                        totals.allocatedCash + totals.wht + totals.salesTax,
                      ],
                      [
                        "Unapplied customer receipts (2410)",
                        "Held for the customer",
                        totals.unapplied,
                      ],
                    ] as const
                  )
                    .filter(([, , amount]) => amount > 0n)
                    .map(([account, effect, amount]) => (
                      <tr key={account}>
                        <td>{account}</td>
                        <td>{effect}</td>
                        <td className="num">
                          {money(String(amount), draft.currency)}
                        </td>
                      </tr>
                    ))}
                </Table>
                <p>
                  <strong>
                    {data.companies.find((c) => c.id === draft.customer)?.name}
                  </strong>{" "}
                  · {entityCode(draft.entity)} · dated {day(draft.date)} ·
                  reference {draft.reference}
                  {draft.currency !== "PKR"
                    ? ` · ${draft.fx} PKR per ${draft.currency}`
                    : ""}
                </p>
                {entered.length ? (
                  <Table
                    label="Invoices settled"
                    headers={[
                      "Invoice",
                      "Cash",
                      "Income tax withheld",
                      "Sales tax withheld",
                      "Left after",
                    ]}
                  >
                    {entered.map(({ i, a }) => (
                      <tr key={i.id}>
                        <td>{i.number}</td>
                        <td className="num">
                          {money(String(number(a.amount)), i.currency)}
                        </td>
                        <td className="num">
                          {money(String(number(a.wht)), i.currency)}
                        </td>
                        <td className="num">
                          {money(
                            String(number(a.sales_tax_withheld)),
                            i.currency,
                          )}
                        </td>
                        <td className="num">
                          {money(
                            String(
                              invoiceBalance(i) -
                                number(a.amount) -
                                number(a.wht) -
                                number(a.sales_tax_withheld),
                            ),
                            i.currency,
                          )}
                        </td>
                      </tr>
                    ))}
                  </Table>
                ) : (
                  <p>
                    No invoice is settled. The whole amount stays on the
                    customer's account.
                  </p>
                )}
                <ErrorBox error={error} />
              </div>
              <div className="editor-footer actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void post()}
                >
                  {busy ? "Posting…" : "Post receipt"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setReviewing(false)}
                >
                  Back to edit
                </button>
              </div>
            </div>
          ) : (
            <form
              className="editor"
              onSubmit={(e) => {
                e.preventDefault();
                if (problem) return setError(problem);
                setError("");
                setReviewing(true);
              }}
            >
              <div className="editor-body">
                <p className="muted">
                  Your unfinished receipt is kept in this browser tab for up to
                  24 hours. Nothing is posted until you review and confirm.
                </p>
                {!storageOk ? (
                  <p role="alert">
                    Draft recovery is unavailable in this browser. Keep this
                    form open until posted.
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
                  <Field label="Customer">
                    <select
                      required
                      value={draft.customer}
                      onChange={(e) => context("customer", e.target.value)}
                    >
                      <option value="">Select customer</option>
                      {data.companies
                        .filter((c) => c.customer)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Receipt currency">
                    <select
                      value={draft.currency}
                      onChange={(e) => context("currency", e.target.value)}
                    >
                      {currencies.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Received into">
                    <select
                      value={draft.bank}
                      onChange={(e) => change("bank", e.target.value)}
                    >
                      <option value="">Unassigned bank and cash (1000)</option>
                      {(data.bankAccounts || [])
                        .filter((b) => b.entity_id === draft.entity)
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name} · PKR
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Receipt date">
                    <input
                      required
                      type="date"
                      value={draft.date}
                      onChange={(e) => change("date", e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Reference"
                    hint="Bank, cheque or transfer reference."
                  >
                    <input
                      required
                      maxLength={200}
                      value={draft.reference}
                      onChange={(e) => change("reference", e.target.value)}
                    />
                  </Field>
                  <Field
                    label={`Cash received (${draft.currency})`}
                    hint="What the customer paid. Leave 0 if they withheld everything."
                  >
                    <input
                      required
                      inputMode="decimal"
                      value={draft.amount}
                      onChange={(e) => change("amount", e.target.value)}
                    />
                  </Field>
                  <Field
                    label={`Bank charge (${draft.currency})`}
                    hint="Kept by the bank out of this receipt."
                  >
                    <input
                      required
                      inputMode="decimal"
                      value={draft.fee}
                      onChange={(e) => change("fee", e.target.value)}
                    />
                  </Field>
                  {draft.currency !== "PKR" ? (
                    <Field
                      label={`Exchange rate (PKR per ${draft.currency})`}
                      hint="The rate your bank applied on this receipt."
                    >
                      <input
                        required
                        inputMode="decimal"
                        value={draft.fx}
                        onChange={(e) => change("fx", e.target.value)}
                      />
                    </Field>
                  ) : null}
                </div>
                <div className="section-title">
                  <h3>Allocate to invoices</h3>
                  <button
                    type="button"
                    disabled={!invoices.length || number(draft.amount) <= 0n}
                    onClick={suggest}
                  >
                    Suggest oldest first
                  </button>
                </div>
                {!draft.customer ? (
                  <p className="muted">
                    Choose a customer to see their open invoices.
                  </p>
                ) : invoices.length ? (
                  <Table
                    label="Open invoices"
                    headers={[
                      "Invoice",
                      "Due",
                      "Outstanding",
                      "Cash",
                      "Income tax withheld",
                      "Sales tax withheld",
                    ]}
                  >
                    {invoices.map((i) => (
                      <tr key={i.id}>
                        <td>{i.number}</td>
                        <td>{day(i.due_date)}</td>
                        <td className="num">
                          {money(String(invoiceBalance(i)), i.currency)}
                        </td>
                        {(
                          [
                            ["amount", "Cash", ""],
                            ["wht", "Income tax withheld", "0"],
                            ["sales_tax_withheld", "Sales tax withheld", "0"],
                          ] as const
                        ).map(([field, label, empty]) => (
                          <td key={field}>
                            <input
                              aria-label={`${label} for ${i.number}`}
                              inputMode="decimal"
                              value={draft.allocations[i.id]?.[field] ?? empty}
                              onChange={(e) =>
                                allocate(i.id, field, e.target.value)
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Table>
                ) : (
                  <p>
                    This customer has no open {draft.currency} invoices in this
                    legal entity. The whole amount will stay on their account.
                  </p>
                )}
                <section className="panel receipt-summary" aria-live="polite">
                  <p>
                    Settling invoices:{" "}
                    {money(String(totals.allocatedCash), draft.currency)} cash
                    {totals.wht + totals.salesTax > 0n
                      ? ` + ${money(String(totals.wht + totals.salesTax), draft.currency)} withheld (never reaches the bank)`
                      : ""}
                  </p>
                  <p>
                    Left on the customer's account:{" "}
                    <strong>
                      {money(
                        String(totals.unapplied > 0n ? totals.unapplied : 0n),
                        draft.currency,
                      )}
                    </strong>
                  </p>
                  <p>
                    Bank increases by{" "}
                    <strong>
                      {money(
                        String(totals.bank > 0n ? totals.bank : 0n),
                        draft.currency,
                      )}
                    </strong>
                    {totals.fee > 0n
                      ? ` after ${money(String(totals.fee), draft.currency)} bank charge`
                      : ""}
                  </p>
                  {problem ? <p className="muted">{problem}</p> : null}
                </section>
                <Field label="Notes">
                  <textarea
                    maxLength={1000}
                    value={draft.notes}
                    onChange={(e) => change("notes", e.target.value)}
                  />
                </Field>
                <ErrorBox error={error} />
              </div>
              <div className="editor-footer actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={busy || !!problem}
                >
                  Review receipt
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => closeComposer(false)}
                >
                  Keep draft & close
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => closeComposer(true)}
                >
                  Discard draft
                </button>
              </div>
            </form>
          )}
        </Drawer>
      ) : null}
      {action ? (
        <ActionDrawer
          action={action}
          data={data}
          busy={busy}
          error={error}
          invoices={openInvoices(
            action.receipt.company_id,
            action.receipt.entity_id,
            action.receipt.currency,
          )}
          close={() => {
            if (!busy) setAction(null);
          }}
          submit={async (c) => {
            if (await save(c)) setAction(null);
          }}
        />
      ) : null}
    </>
  );
}

type Action = Parameters<Parameters<typeof ReceiptDetail>[0]["act"]>[0];

function ReceiptDetail({
  receipt,
  data,
  canPost,
  busy,
  status,
  bankName,
  invoiceNumber,
  allocations,
  applications,
  refunds,
  canApply,
  act,
}: {
  receipt: CustomerReceipt;
  data: Data;
  canPost: boolean;
  busy: boolean;
  status: string;
  bankName: (id: string | null) => string;
  invoiceNumber: (id: string) => string;
  allocations: NonNullable<Data["customerReceiptAllocations"]>;
  applications: NonNullable<Data["customerReceiptApplications"]>;
  refunds: NonNullable<Data["customerReceiptRefunds"]>;
  canApply: boolean;
  act: (
    a:
      | { kind: "apply" | "refund" | "reverse"; receipt: CustomerReceipt }
      | {
          kind: "reverse-application" | "reverse-refund";
          receipt: CustomerReceipt;
          id: string;
          label: string;
          min: string;
        },
  ) => void;
}) {
  const live = !receipt.reversal_date,
    available = BigInt(receipt.available_minor),
    used =
      applications.some((a) => !a.reversal_date) ||
      refunds.some((f) => !f.reversal_date);
  const c = receipt.currency;
  return (
    <>
      <section className="panel receipt-detail">
        <dl className="receipt-facts">
          <div>
            <dt>Cash received</dt>
            <dd>{money(receipt.amount_minor, c)}</dd>
          </div>
          <div>
            <dt>Income tax withheld</dt>
            <dd>{money(receipt.wht_minor, c)}</dd>
          </div>
          <div>
            <dt>Sales tax withheld</dt>
            <dd>{money(receipt.sales_tax_withheld_minor, c)}</dd>
          </div>
          <div>
            <dt>Bank charge</dt>
            <dd>{money(receipt.fee_minor, c)}</dd>
          </div>
          <div>
            <dt>Received into</dt>
            <dd>{bankName(receipt.bank_account_id)}</dd>
          </div>
          {c !== "PKR" ? (
            <div>
              <dt>Exchange rate</dt>
              <dd>
                {rate(receipt.fx_micros)} PKR per {c}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Status</dt>
            <dd>{status}</dd>
          </div>
        </dl>
        {receipt.reversal_reason ? (
          <p>Reversal reason: {receipt.reversal_reason}</p>
        ) : null}
        {receipt.notes ? <p className="muted">{receipt.notes}</p> : null}
        {canPost && live ? (
          <div className="row-actions">
            {available > 0n ? (
              <>
                <button
                  disabled={busy || !canApply}
                  title={
                    canApply
                      ? undefined
                      : "This customer has no open invoice in this entity and currency."
                  }
                  onClick={() => act({ kind: "apply", receipt })}
                >
                  Apply to an invoice
                </button>
                <button
                  disabled={busy}
                  onClick={() => act({ kind: "refund", receipt })}
                >
                  Record refund
                </button>
              </>
            ) : null}
            <button
              disabled={busy || used}
              title={
                used
                  ? "Reverse this receipt's applications and refunds first."
                  : undefined
              }
              onClick={() => act({ kind: "reverse", receipt })}
            >
              Reverse receipt
            </button>
          </div>
        ) : null}
        {canPost && live && used ? (
          <p className="muted">
            Reverse this receipt's applications and refunds before reversing the
            receipt.
          </p>
        ) : null}
      </section>
      <h2>Invoices settled by this receipt</h2>
      {allocations.length ? (
        <Table
          label="Invoices settled by this receipt"
          headers={[
            "Invoice",
            "Cash",
            "Income tax withheld",
            "Sales tax withheld",
          ]}
        >
          {allocations.map((a) => (
            <tr key={a.id}>
              <td>
                <a href={`#invoice/${a.invoice_id}`}>
                  {invoiceNumber(a.invoice_id)}
                </a>
              </td>
              <td className="num">{money(a.amount_minor, c)}</td>
              <td className="num">{money(a.wht_minor, c)}</td>
              <td className="num">{money(a.sales_tax_withheld_minor, c)}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <p className="muted">
          None. The receipt was recorded on the customer's account.
        </p>
      )}
      {BigInt(receipt.unapplied_minor) > 0n ? (
        <>
          <h2>Unapplied cash</h2>
          <p>
            {money(receipt.unapplied_minor, c)} was left unallocated;{" "}
            <strong>{money(receipt.available_minor, c)}</strong> is still
            available.
          </p>
          {applications.length || refunds.length ? (
            <Table
              label="Use of unapplied cash"
              headers={["Date", "Use", "Amount", "Status"]}
            >
              {applications.map((a) => (
                <tr key={a.id}>
                  <td>{day(a.application_date)}</td>
                  <td>
                    Applied to{" "}
                    <a href={`#invoice/${a.invoice_id}`}>
                      {invoiceNumber(a.invoice_id)}
                    </a>
                  </td>
                  <td className="num">{money(a.amount_minor, c)}</td>
                  <td>
                    {a.reversal_date ? (
                      `Reversed ${day(a.reversal_date)} · ${a.reversal_reason}`
                    ) : canPost && live ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          act({
                            kind: "reverse-application",
                            receipt,
                            id: a.id,
                            label: `application to ${invoiceNumber(a.invoice_id)}`,
                            min: a.application_date,
                          })
                        }
                      >
                        Reverse application
                      </button>
                    ) : (
                      "Applied"
                    )}
                  </td>
                </tr>
              ))}
              {refunds.map((f) => (
                <tr key={f.id}>
                  <td>{day(f.refund_date)}</td>
                  <td>Refunded · {f.reference}</td>
                  <td className="num">{money(f.amount_minor, c)}</td>
                  <td>
                    {f.reversal_date ? (
                      `Reversed ${day(f.reversal_date)} · ${f.reversal_reason}`
                    ) : canPost && live ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          act({
                            kind: "reverse-refund",
                            receipt,
                            id: f.id,
                            label: `refund ${f.reference}`,
                            min: f.refund_date,
                          })
                        }
                      >
                        Reverse refund
                      </button>
                    ) : (
                      "Refunded"
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          ) : null}
        </>
      ) : null}
      <p className="muted">
        Statement and history:{" "}
        <a href={`#customer-statements/${receipt.company_id}`}>
          {receipt.customer_name}
        </a>
        {data.entities.length > 1 ? " (choose the legal entity there)" : ""}
      </p>
    </>
  );
}

function ActionDrawer({
  action,
  data,
  busy,
  error,
  invoices,
  close,
  submit,
}: {
  action: Action;
  data: Data;
  busy: boolean;
  error: string;
  invoices: Data["invoices"];
  close: () => void;
  submit: (c: Record<string, unknown>) => Promise<void>;
}) {
  const r = action.receipt,
    available = BigInt(r.available_minor);
  const [key] = useState(() => crypto.randomUUID());
  const [invoice, setInvoice] = useState(invoices[0]?.id || "");
  const chosen = invoices.find((i) => i.id === invoice);
  const most =
    chosen && invoiceBalance(chosen) < available
      ? invoiceBalance(chosen)
      : available;
  const title =
    action.kind === "apply"
      ? `Apply unapplied cash · ${r.reference}`
      : action.kind === "refund"
        ? `Refund unapplied cash · ${r.reference}`
        : "label" in action
          ? `Reverse ${action.label}`
          : `Reverse receipt ${r.reference}`;
  function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<
      string,
      string
    >;
    void submit(
      action.kind === "apply"
        ? {
            action: "customer-receipt.apply",
            receipt_id: r.id,
            invoice_id: invoice,
            date: f.date,
            amount: f.amount,
            request_key: key,
          }
        : action.kind === "refund"
          ? {
              action: "customer-receipt.refund",
              receipt_id: r.id,
              bank_account_id: f.bank_account_id || null,
              date: f.date,
              amount: f.amount,
              fx: f.fx || "1",
              reference: f.reference,
              request_key: key,
            }
          : {
              action: `customer-receipt.${action.kind}`,
              id: "id" in action ? action.id : r.id,
              date: f.date,
              reason: f.reason,
            },
    );
  }
  const earliest =
    action.kind === "reverse-application" || action.kind === "reverse-refund"
      ? action.min
      : r.receipt_date;
  return (
    <Drawer title={title} dirty={true} close={close}>
      <form className="editor" onSubmit={send}>
        <div className="editor-body">
          {action.kind === "apply" ? (
            <>
              <p>
                {money(r.available_minor, r.currency)} is available. It settles
                the invoice from the customer's account; no new money moves
                through the bank.
              </p>
              <Field label="Invoice">
                <select
                  required
                  value={invoice}
                  onChange={(e) => setInvoice(e.target.value)}
                >
                  {invoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.number} ·{" "}
                      {money(String(invoiceBalance(i)), i.currency)} outstanding
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`Amount to apply (${r.currency})`}>
                <input
                  key={invoice}
                  required
                  name="amount"
                  inputMode="decimal"
                  defaultValue={decimal(most)}
                />
              </Field>
            </>
          ) : null}
          {action.kind === "refund" ? (
            <>
              <p>
                Records money already returned to {r.customer_name}. It does not
                send a payment. Up to {money(r.available_minor, r.currency)} can
                be refunded.
              </p>
              <Field label="Paid from">
                <select
                  name="bank_account_id"
                  defaultValue={r.bank_account_id || ""}
                >
                  <option value="">Unassigned bank and cash (1000)</option>
                  {(data.bankAccounts || [])
                    .filter((b) => b.entity_id === r.entity_id)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} · PKR
                      </option>
                    ))}
                </select>
              </Field>
              <Field label={`Amount refunded (${r.currency})`}>
                <input
                  required
                  name="amount"
                  inputMode="decimal"
                  defaultValue={decimal(available)}
                />
              </Field>
              {r.currency !== "PKR" ? (
                <Field
                  label={`Exchange rate (PKR per ${r.currency})`}
                  hint="The rate on the day of the refund."
                >
                  <input
                    required
                    name="fx"
                    inputMode="decimal"
                    defaultValue={rate(r.fx_micros)}
                  />
                </Field>
              ) : null}
              <Field label="Refund reference">
                <input required name="reference" maxLength={200} />
              </Field>
            </>
          ) : null}
          {action.kind === "reverse" ? (
            <p>
              This reverses the whole receipt: the bank entry, the withholding
              and every invoice it settled. Those invoices become open again. It
              does not send money back.
            </p>
          ) : null}
          {action.kind === "reverse-application" ||
          action.kind === "reverse-refund" ? (
            <p>
              The original stays in the history. The cash becomes unapplied
              again.
            </p>
          ) : null}
          <Field
            label={
              action.kind === "apply"
                ? "Application date"
                : action.kind === "refund"
                  ? "Refund date"
                  : "Reversal date"
            }
          >
            <input
              required
              type="date"
              name="date"
              min={earliest.slice(0, 10)}
              defaultValue={today()}
            />
          </Field>
          {action.kind === "reverse" ||
          action.kind === "reverse-application" ||
          action.kind === "reverse-refund" ? (
            <Field label="Reason">
              <textarea required name="reason" maxLength={200} />
            </Field>
          ) : null}
          <ErrorBox error={error} />
        </div>
        <div className="editor-footer actions">
          <button
            className="primary"
            disabled={busy || (action.kind === "apply" && !invoice)}
          >
            {busy
              ? "Saving…"
              : action.kind === "apply"
                ? "Apply cash"
                : action.kind === "refund"
                  ? "Record refund"
                  : "Confirm reversal"}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
}
