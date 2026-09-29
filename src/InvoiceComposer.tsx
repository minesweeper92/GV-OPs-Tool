import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, FileText, Plus, Trash2, X } from "lucide-react";
import { ErrorBox, Field } from "./components";
import { NumberSeriesField } from "./NumberSeriesField";
import { decimal, money, rate, today, type Data, type Line } from "./model";
import { documentDetails } from "../shared/documents";
import { totals } from "../shared/money";

const blankLine = (): Line => ({
  description: "",
  quantity: "1",
  price: "",
  tax: "0",
  discount_type: "percent",
  discount: "0",
});
function plusDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function InvoiceComposer({
  id,
  kind,
  data,
  entityId,
  create,
  close,
  done,
  canManageNumbering,
}: {
  id: string;
  kind: "invoice" | "direct-invoice";
  data: Data;
  entityId: string;
  create: (command: Record<string, unknown>) => Promise<{ id: string }>;
  close: () => void;
  done: (invoiceId: string) => void;
  canManageNumbering: boolean;
}) {
  const quote =
    kind === "invoice" ? data.quotes.find((q) => q.id === id) : undefined;
  const deal = data.deals.find((d) => d.id === quote?.deal_id);
  const [customerId, setCustomerId] = useState(deal?.company_id || "");
  const [issuerId, setIssuerId] = useState(
    quote?.entity_id || (entityId === "all" ? "" : entityId),
  );
  const [seriesId, setSeriesId] = useState("");
  const [issueDate, setIssueDate] = useState(today());
  const customer = data.companies.find((c) => c.id === customerId);
  const [dueDate, setDueDate] = useState(
    plusDays(today(), customer?.profile.payment_days ?? 30),
  );
  const [currency, setCurrency] = useState(quote?.currency || "PKR");
  const [fx, setFx] = useState(quote ? rate(quote.fx_micros) : "1");
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [label, setLabel] = useState(
    quote?.details?.subject || "Accepted quote",
  );
  const billed = quote
    ? data.invoices
        .filter(
          (i) =>
            i.quote_id === quote.id &&
            !["Cancelled", "Voided"].includes(i.status),
        )
        .reduce((sum, i) => sum + BigInt(i.net_minor), 0n)
    : 0n;
  const remaining = quote ? BigInt(quote.net_minor) - billed : 0n;
  const reserved = quote
    ? BigInt(
        data.projects.find((p) => p.quote_id === quote.id)?.planned_net || "0",
      )
    : 0n;
  const available = remaining - reserved;
  const [amount, setAmount] = useState(
    quote ? decimal(available > 0n ? available : 0n) : "",
  );
  const [billingKind, setBillingKind] = useState<"earned" | "advance">(
    "earned",
  );
  const [terms, setTerms] = useState(quote?.terms || "");
  const [details, setDetails] = useState(() =>
    documentDetails.parse({
      ...quote?.details,
      quote_date: quote?.details?.quote_date || today(),
    }),
  );
  const [requestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [itemBusy, setItemBusy] = useState(false);
  const [itemNotice, setItemNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const setDetail = (key: keyof typeof details, value: unknown) => {
    setDetails((old) => ({ ...old, [key]: value }));
    setDirty(true);
  };
  const setLine = (index: number, key: keyof Line, value: string) => {
    setLines((old) =>
      old.map((line, i) => (i === index ? { ...line, [key]: value } : line)),
    );
    setDirty(true);
  };
  const leave = () => {
    if (!dirty || window.confirm("Discard your unsaved invoice?")) close();
  };
  async function saveItem(line: Line) {
    setItemBusy(true);
    setError("");
    try {
      await create({
        action: "document.item-save",
        name: line.description.slice(0, 200),
        currency,
        line,
        request_key: crypto.randomUUID(),
      });
      setItemNotice("Item saved to this workspace's reusable item library.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setItemBusy(false);
    }
  }
  let calculated: ReturnType<typeof totals> | null = null;
  if (!quote)
    try {
      calculated = totals(lines);
    } catch {
      /* Incomplete rows while typing. */
    }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!issuerId || !customerId) {
      setError("Choose the customer company and issuing legal entity.");
      return;
    }
    if (!quote && lines.some((line) => !line.description.trim())) {
      setError("Complete each invoice line.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const command = quote
        ? {
            action: "invoice.create",
            quote_id: quote.id,
            issue_date: issueDate,
            due_date: dueDate,
            amount,
            billing_kind: billingKind,
            label: label.trim() || "Accepted quote",
            request_key: requestKey,
            details,
            ...(seriesId ? { number_series_id: seriesId } : {}),
          }
        : {
            action: "document.invoice-create",
            entity_id: issuerId,
            company_id: customerId,
            issue_date: issueDate,
            due_date: dueDate,
            currency,
            fx,
            lines,
            billing_kind: billingKind,
            label: label.trim() || "Direct invoice",
            terms,
            details,
            request_key: requestKey,
            ...(seriesId ? { number_series_id: seriesId } : {}),
          };
      const result = await create(command);
      setDirty(false);
      done(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="quote-composer invoice-composer">
      <div className="quote-composer-heading">
        <div>
          <button className="quote-composer-back" onClick={leave}>
            <ArrowLeft size={16} /> All invoices
          </button>
          <h1>
            <FileText size={26} />{" "}
            {quote ? "Convert quote to invoice" : "New invoice"}
          </h1>
        </div>
        <button aria-label="Close invoice" onClick={leave}>
          <X size={19} />
        </button>
      </div>
      <form
        className="quote-composer-form"
        onSubmit={save}
        onChange={() => setDirty(true)}
      >
        <div className="quote-composer-scroll">
          <section className="quote-composer-section quote-customer-block">
            <h2>Customer and issuing company</h2>
            {quote ? (
              <p className="muted">
                From accepted quote{" "}
                <a href={`#quote/${quote.id}`}>
                  {quote.number || quote.option_name}
                </a>{" "}
                · {deal?.name}. The customer, issuer and quoted terms are
                carried forward.
              </p>
            ) : null}
            <div className="quote-field-grid">
              <Field
                label="Customer company"
                hint="Customers are companies, not a separate record type."
              >
                <select
                  required
                  value={customerId}
                  disabled={!!quote}
                  onChange={(e) => {
                    setCustomerId(e.target.value);
                    setDueDate(
                      plusDays(
                        issueDate,
                        data.companies.find((c) => c.id === e.target.value)
                          ?.profile.payment_days ?? 30,
                      ),
                    );
                  }}
                >
                  <option value="">Select a company</option>
                  {data.companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Issuing legal entity">
                <select
                  required
                  value={issuerId}
                  disabled={!!quote}
                  onChange={(e) => {
                    setIssuerId(e.target.value);
                    setSeriesId("");
                  }}
                >
                  <option value="">Choose the legal entity</option>
                  {data.entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} ({e.code})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </section>
          <section className="quote-composer-section">
            <h2>Invoice information</h2>
            <div className="quote-field-grid">
              <NumberSeriesField
                data={data}
                entityId={issuerId}
                kind="invoice"
                selectedId={seriesId}
                onSelect={setSeriesId}
                create={create}
                canManage={canManageNumbering}
              />
              <Field label="Reference number">
                <input
                  value={details.reference}
                  onChange={(e) => setDetail("reference", e.target.value)}
                  maxLength={200}
                />
              </Field>
              <Field label="Invoice date">
                <input
                  type="date"
                  required
                  value={issueDate}
                  onChange={(e) => {
                    setIssueDate(e.target.value);
                    setDueDate(
                      plusDays(
                        e.target.value,
                        customer?.profile.payment_days ?? 30,
                      ),
                    );
                  }}
                />
              </Field>
              <Field label="Due date">
                <input
                  type="date"
                  required
                  min={issueDate}
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </Field>
              <Field label="Related opportunity">
                <input
                  value={deal?.name || "No linked opportunity (direct invoice)"}
                  readOnly
                />
              </Field>
              <Field label="Subject">
                <input
                  value={details.subject}
                  onChange={(e) => setDetail("subject", e.target.value)}
                  maxLength={200}
                />
              </Field>
            </div>
          </section>
          <section className="quote-composer-section">
            <div className="quote-section-heading">
              <h2>Item table</h2>
              <span className="muted">Tax exclusive · tax set per line</span>
            </div>
            {quote ? (
              <>
                <p className="muted">
                  Approved quote items are locked. A partial invoice allocates
                  the entered subtotal across the unbilled items and keeps each
                  line's tax rate.
                </p>
                <div className="quote-item-table">
                  <div className="quote-item-head">
                    <span>Item details</span>
                    <span>Quantity</span>
                    <span>Rate</span>
                    <span>Tax %</span>
                    <span>Amount</span>
                    <span />
                  </div>
                  {quote.lines.map((line, i) => (
                    <div className="quote-item-row" key={i}>
                      <strong>{line.description}</strong>
                      <span>{line.quantity}</span>
                      <span>{line.price}</span>
                      <span>{line.tax}</span>
                      <strong>
                        {money(
                          BigInt(line.subtotal || "0") +
                            BigInt(line.taxMinor || "0"),
                          quote.currency,
                        )}
                      </strong>
                      <span />
                    </div>
                  ))}
                </div>
                <div className="quote-field-grid invoice-allocation">
                  <Field
                    label={`Subtotal to invoice (${quote.currency}, before tax)`}
                    hint={`Available after draft invoices and planned milestones: ${money(available, quote.currency)}.`}
                  >
                    <input
                      required
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </Field>
                  <Field label="Billing stage">
                    <input
                      required
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      maxLength={200}
                    />
                  </Field>
                </div>
              </>
            ) : (
              <>
                <div className="quote-currency-row">
                  <Field label="Currency">
                    <select
                      value={currency}
                      onChange={(e) => {
                        setCurrency(e.target.value);
                        setFx(e.target.value === "PKR" ? "1" : "");
                      }}
                    >
                      {["PKR", "USD", "AED", "EUR", "GBP"].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  {currency !== "PKR" ? (
                    <Field label="PKR per 1 unit">
                      <input
                        required
                        inputMode="decimal"
                        value={fx}
                        onChange={(e) => setFx(e.target.value)}
                      />
                    </Field>
                  ) : null}
                  <Field label="Add saved item">
                    <select
                      value=""
                      onChange={(e) => {
                        const item = data.catalogItems.find(
                          (i) => i.id === e.target.value,
                        );
                        if (item)
                          setLines((old) =>
                            old.length === 1 && !old[0].description
                              ? [{ ...item.line }]
                              : [...old, { ...item.line }],
                          );
                      }}
                    >
                      <option value="">Choose an item</option>
                      {data.catalogItems
                        .filter((i) => i.currency === currency)
                        .map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>
                <div
                  className="quote-item-table"
                  role="group"
                  aria-label="Invoice line items"
                >
                  <div className="quote-item-head">
                    <span>Item details</span>
                    <span>Quantity</span>
                    <span>Rate</span>
                    <span>Tax %</span>
                    <span>Amount</span>
                    <span />
                  </div>
                  {lines.map((line, i) => (
                    <div className="quote-item-row" key={i}>
                      <div className="quote-item-description">
                        <label
                          className="sr-only"
                          htmlFor={`invoice-line-${i}`}
                        >
                          Description {i + 1}
                        </label>
                        <textarea
                          id={`invoice-line-${i}`}
                          required
                          value={line.description}
                          onChange={(e) =>
                            setLine(i, "description", e.target.value)
                          }
                          placeholder="Type or select an item"
                          maxLength={2000}
                        />
                        <details>
                          <summary>Unit, section and discount</summary>
                          <div className="quote-line-extras">
                            <Field label={`Unit ${i + 1}`}>
                              <input
                                value={line.unit || ""}
                                onChange={(e) =>
                                  setLine(i, "unit", e.target.value)
                                }
                              />
                            </Field>
                            <Field label={`Section ${i + 1}`}>
                              <input
                                value={line.section || ""}
                                onChange={(e) =>
                                  setLine(i, "section", e.target.value)
                                }
                              />
                            </Field>
                            <Field label={`Discount type ${i + 1}`}>
                              <select
                                value={line.discount_type || "percent"}
                                onChange={(e) =>
                                  setLine(i, "discount_type", e.target.value)
                                }
                              >
                                <option value="percent">Percentage</option>
                                <option value="amount">Amount</option>
                              </select>
                            </Field>
                            <Field label={`Discount ${i + 1}`}>
                              <input
                                value={line.discount || "0"}
                                onChange={(e) =>
                                  setLine(i, "discount", e.target.value)
                                }
                                inputMode="decimal"
                              />
                            </Field>
                            <button
                              type="button"
                              disabled={itemBusy || !line.description.trim()}
                              onClick={() => saveItem(line)}
                              aria-label={`Save line ${i + 1} to item library`}
                            >
                              Save item
                            </button>
                          </div>
                        </details>
                      </div>
                      {(["quantity", "price", "tax"] as const).map((key) => (
                        <label key={key}>
                          <span
                            className="invoice-mobile-label"
                            aria-hidden="true"
                          >
                            {key === "price"
                              ? "Rate"
                              : key === "tax"
                                ? "Tax %"
                                : "Quantity"}
                          </span>
                          <input
                            aria-label={`${key === "price" ? "Unit price" : key === "tax" ? "Tax %" : "Quantity"} ${i + 1}`}
                            required
                            inputMode="decimal"
                            value={line[key]}
                            onChange={(e) => setLine(i, key, e.target.value)}
                          />
                        </label>
                      ))}
                      <strong>
                        {calculated
                          ? money(
                              BigInt(calculated.lines[i].subtotal) +
                                BigInt(calculated.lines[i].taxMinor),
                              currency,
                            )
                          : "—"}
                      </strong>
                      <button
                        type="button"
                        aria-label={`Remove line ${i + 1}`}
                        disabled={lines.length === 1}
                        onClick={() =>
                          setLines((old) => old.filter((_, n) => n !== i))
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="quote-add-row"
                  onClick={() => setLines((old) => [...old, blankLine()])}
                >
                  <Plus size={16} /> Add new row
                </button>
                <div className="quote-totals">
                  <div>
                    <span>Sub total</span>
                    <strong>
                      {calculated ? money(calculated.net, currency) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span>Tax</span>
                    <strong>
                      {calculated ? money(calculated.tax, currency) : "—"}
                    </strong>
                  </div>
                  <div className="quote-totals-grand">
                    <span>Total ({currency})</span>
                    <strong>
                      {calculated
                        ? money(calculated.total, currency)
                        : "Complete the line items"}
                    </strong>
                  </div>
                </div>
                <Field label="Billing stage">
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    maxLength={200}
                  />
                </Field>
              </>
            )}
            <Field label="Revenue treatment">
              <select
                value={billingKind}
                onChange={(e) =>
                  setBillingKind(e.target.value as "earned" | "advance")
                }
              >
                <option value="earned">Delivered work — earned revenue</option>
                <option value="advance">
                  Customer advance — deferred revenue
                </option>
              </select>
            </Field>
          </section>
          <section className="quote-composer-section quote-bottom-fields">
            <Field label="Customer notes">
              <textarea
                value={details.customer_notes}
                onChange={(e) => setDetail("customer_notes", e.target.value)}
                rows={4}
                maxLength={4000}
              />
            </Field>
            <Field label="Terms & conditions">
              <textarea
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                rows={4}
                maxLength={4000}
                disabled={!!quote}
              />
            </Field>
            <details className="quote-more-details">
              <summary>More customer, billing and PDF details</summary>
              <div className="quote-field-grid">
                <Field label="Billing address">
                  <textarea
                    value={details.billing_address}
                    onChange={(e) =>
                      setDetail("billing_address", e.target.value)
                    }
                  />
                </Field>
                <Field label="Shipping address">
                  <textarea
                    value={details.shipping_address}
                    onChange={(e) =>
                      setDetail("shipping_address", e.target.value)
                    }
                  />
                </Field>
                <Field label="Attention">
                  <input
                    value={details.attention}
                    onChange={(e) => setDetail("attention", e.target.value)}
                  />
                </Field>
                <Field label="Customer tax ID">
                  <input
                    value={details.customer_tax_id}
                    onChange={(e) =>
                      setDetail("customer_tax_id", e.target.value)
                    }
                  />
                </Field>
                <Field label="Purchase order number">
                  <input
                    value={details.purchase_order}
                    onChange={(e) =>
                      setDetail("purchase_order", e.target.value)
                    }
                  />
                </Field>
                <Field label="Payment terms">
                  <input
                    value={details.payment_terms}
                    onChange={(e) => setDetail("payment_terms", e.target.value)}
                  />
                </Field>
                <Field label="Recipients (comma separated)">
                  <input
                    value={details.recipients.join(", ")}
                    onChange={(e) =>
                      setDetail(
                        "recipients",
                        e.target.value
                          .split(",")
                          .map((v) => v.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </Field>
                <Field label="Payment instructions">
                  <textarea
                    value={details.payment_instructions}
                    onChange={(e) =>
                      setDetail("payment_instructions", e.target.value)
                    }
                  />
                </Field>
              </div>
            </details>
            {itemNotice ? (
              <p className="quote-composer-notice" role="status">
                {itemNotice}
              </p>
            ) : null}
            {error ? <ErrorBox error={error} /> : null}
          </section>
        </div>
        <div className="quote-composer-footer">
          <div className="quote-footer-actions">
            <button
              type="submit"
              className="primary"
              disabled={busy || itemBusy}
            >
              {busy ? "Saving…" : "Save as draft"}
            </button>
            <button type="button" onClick={leave}>
              Cancel
            </button>
          </div>
          <label>
            PDF template{" "}
            <select
              value={details.template}
              onChange={(e) => setDetail("template", e.target.value)}
            >
              <option value="Standard">Standard</option>
              <option value="Compact">Compact</option>
            </select>
          </label>
        </div>
      </form>
    </div>
  );
}
