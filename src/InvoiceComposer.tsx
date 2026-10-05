import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ArrowLeft, FileText, Plus, Trash2, X } from "lucide-react";
import { ErrorBox, Field } from "./components";
import { NumberSeriesField } from "./NumberSeriesField";
import { decimal, money, rate, today, type Data, type Line } from "./model";
import { documentDetails, documentTotals } from "../shared/documents";
import { DocumentCharges } from "./DocumentCharges";
import {
  clearBrowserDraft,
  invoiceDraft,
  invoiceDraftKey,
  readBrowserDraft,
  writeBrowserDraft,
} from "./browserDraft";

const blankLine = (): Line => ({
  description: "",
  quantity: "1",
  price: "",
  tax: "0",
  discount_type: "percent",
  discount: "0",
});
const normalized = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
function plusDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function InvoiceComposer({
  id,
  kind,
  data,
  draftScope,
  entityId,
  create,
  close,
  done,
  canManageNumbering,
}: {
  id: string;
  kind: "invoice" | "direct-invoice";
  data: Data;
  draftScope: string;
  entityId: string;
  create: (command: Record<string, unknown>) => Promise<{ id: string }>;
  close: () => void;
  done: (invoiceId: string) => void;
  canManageNumbering: boolean;
}) {
  const draftKey = invoiceDraftKey(draftScope, kind, id);
  const [restored] = useState(() => readBrowserDraft(draftKey, invoiceDraft));
  const [draftStored, setDraftStored] = useState(!!restored);
  const quote =
    kind === "invoice" ? data.quotes.find((q) => q.id === id) : undefined;
  const deal = data.deals.find((d) => d.id === quote?.deal_id);
  const [customerId, setCustomerId] = useState(
    restored?.customerId ?? deal?.company_id ?? "",
  );
  const [newCustomerOpen, setNewCustomerOpen] = useState(
    restored?.newCustomerOpen ?? false,
  );
  const [newCustomerName, setNewCustomerName] = useState(
    restored?.newCustomerName ?? "",
  );
  const [newCustomerDomain, setNewCustomerDomain] = useState(
    restored?.newCustomerDomain ?? "",
  );
  const [newCustomerTaxId, setNewCustomerTaxId] = useState(
    restored?.newCustomerTaxId ?? "",
  );
  const [newCustomerAddress, setNewCustomerAddress] = useState(
    restored?.newCustomerAddress ?? "",
  );
  const [createdCustomer, setCreatedCustomer] = useState<{
    id: string;
    name: string;
  } | null>(restored?.createdCustomer ?? null);
  const customerRetry = useRef<{ key: string; payload: string } | null>(
    restored?.customerRetry ?? null,
  );
  const customerPicker = useRef<HTMLSelectElement>(null);
  const customerTrigger = useRef<HTMLButtonElement>(null);
  const [customerBusy, setCustomerBusy] = useState(false);
  const [customerError, setCustomerError] = useState("");
  const [issuerId, setIssuerId] = useState(
    restored?.issuerId ??
      quote?.entity_id ??
      (entityId === "all" ? "" : entityId),
  );
  const [seriesId, setSeriesId] = useState(restored?.seriesId ?? "");
  const [issueDate, setIssueDate] = useState(restored?.issueDate ?? today());
  const customer = data.companies.find((c) => c.id === customerId);
  const [dueDate, setDueDate] = useState(
    restored?.dueDate ??
      plusDays(today(), customer?.profile.payment_days ?? 30),
  );
  const [currency, setCurrency] = useState(
    restored?.currency ?? quote?.currency ?? "PKR",
  );
  const [fx, setFx] = useState(
    restored?.fx ?? (quote ? rate(quote.fx_micros) : "1"),
  );
  const [lines, setLines] = useState<Line[]>(restored?.lines ?? [blankLine()]);
  const [label, setLabel] = useState(
    restored?.label ??
      (quote?.details?.subject ||
        (quote ? "Accepted quote" : "Direct invoice")),
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
    restored?.amount ?? (quote ? decimal(available > 0n ? available : 0n) : ""),
  );
  const [billingKind, setBillingKind] = useState<"earned" | "advance">(
    restored?.billingKind ?? "earned",
  );
  const [terms, setTerms] = useState(restored?.terms ?? quote?.terms ?? "");
  const [details, setDetails] = useState(
    () =>
      restored?.details ??
      documentDetails.parse({
        ...quote?.details,
        quote_date: quote?.details?.quote_date || today(),
      }),
  );
  const [requestKey] = useState(
    () => restored?.requestKey ?? crypto.randomUUID(),
  );
  const [busy, setBusy] = useState(false);
  const [itemBusy, setItemBusy] = useState(false);
  const [itemNotice, setItemNotice] = useState("");
  const [dirty, setDirty] = useState(!!restored);
  const [error, setError] = useState("");
  const storeDraft = useCallback(
    () =>
      writeBrowserDraft(draftKey, {
        customerId,
        issuerId,
        seriesId,
        issueDate,
        dueDate,
        currency,
        fx,
        lines,
        label,
        amount,
        billingKind,
        terms,
        details,
        requestKey,
        newCustomerOpen,
        newCustomerName,
        newCustomerDomain,
        newCustomerTaxId,
        newCustomerAddress,
        createdCustomer,
        customerRetry: customerRetry.current,
      }),
    [
      draftKey,
      customerId,
      issuerId,
      seriesId,
      issueDate,
      dueDate,
      currency,
      fx,
      lines,
      label,
      amount,
      billingKind,
      terms,
      details,
      requestKey,
      newCustomerOpen,
      newCustomerName,
      newCustomerDomain,
      newCustomerTaxId,
      newCustomerAddress,
      createdCustomer,
      customerBusy,
    ],
  );
  useEffect(() => {
    if (dirty) setDraftStored(storeDraft());
  }, [dirty, storeDraft]);
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
  function selectCustomer(companyId: string) {
    const company = data.companies.find((c) => c.id === companyId);
    setCustomerId(companyId);
    setDueDate(plusDays(issueDate, company?.profile.payment_days ?? 30));
    setDetails((old) => ({
      ...old,
      billing_address: company?.address || "",
      shipping_address: company?.shipping_address || "",
      customer_tax_id: company?.tax_id || "",
      customer_notes: company?.profile.document_notes || "",
      recipients: company?.profile.billing_recipients || [],
      payment_terms: `Net ${company?.profile.payment_days ?? 30} days`,
    }));
    setDirty(true);
  }
  async function addCustomer() {
    if (customerBusy) return;
    const name = newCustomerName.trim();
    if (!name) {
      setCustomerError("Enter the customer company name.");
      return;
    }
    const existing = data.companies.find(
      (c) => normalized(c.name) === normalized(name),
    );
    if (existing) {
      selectCustomer(existing.id);
      setCustomerError("");
      setNewCustomerOpen(false);
      customerPicker.current?.focus();
      return;
    }
    const command = {
      action: "company.create",
      name,
      domain: newCustomerDomain.trim(),
      tax_id: newCustomerTaxId.trim(),
      address: newCustomerAddress.trim(),
      customer: true,
      vendor: false,
      service_entity_id: null,
    };
    const fingerprint = JSON.stringify(command);
    if (customerRetry.current?.payload !== fingerprint)
      customerRetry.current = {
        key: crypto.randomUUID(),
        payload: fingerprint,
      };
    setCustomerBusy(true);
    setCustomerError("");
    try {
      const result = await create({
        ...command,
        request_key: customerRetry.current.key,
      });
      setCreatedCustomer({ id: result.id, name });
      setCustomerId(result.id);
      setDueDate(plusDays(issueDate, 30));
      setDetails((old) => ({
        ...old,
        billing_address: command.address,
        customer_tax_id: command.tax_id,
        payment_terms: "Net 30 days",
      }));
      setNewCustomerOpen(false);
      setDirty(true);
      customerRetry.current = null;
      customerPicker.current?.focus();
    } catch (error) {
      setCustomerError((error as Error).message);
    } finally {
      setCustomerBusy(false);
    }
  }
  const setLine = (index: number, key: keyof Line, value: string) => {
    setLines((old) =>
      old.map((line, i) => (i === index ? { ...line, [key]: value } : line)),
    );
    setDirty(true);
  };
  const leave = () => {
    if (busy || customerBusy || itemBusy) return;
    if (!dirty || window.confirm("Discard your unsaved invoice?")) {
      clearBrowserDraft(draftKey);
      close();
    }
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
  let calculated: ReturnType<typeof documentTotals> | null = null;
  if (!quote)
    try {
      calculated = documentTotals(lines, details);
    } catch {
      /* Incomplete rows while typing. */
    }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newCustomerOpen || customerBusy) {
      setError("Finish adding the customer or close that panel first.");
      return;
    }
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
      setDirty(true);
      setDraftStored(storeDraft());
      const result = await create(command);
      setDirty(false);
      clearBrowserDraft(draftKey);
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
          {dirty && (
            <div className="quote-draft-notice" role="status">
              <span>
                {draftStored
                  ? "Invoice draft saved in this tab for 24 hours. Resume here before issuing; this does not save or post it to your books."
                  : "Draft recovery is unavailable. Save your invoice before leaving."}
              </span>
              {draftStored && (
                <button
                  type="button"
                  disabled={busy || customerBusy || itemBusy}
                  onClick={close}
                >
                  Keep draft & close
                </button>
              )}
            </div>
          )}
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
              <div className="invoice-customer-picker">
                <Field
                  label="Customer company"
                  hint="Customers are companies, not a separate record type."
                >
                  <select
                    ref={customerPicker}
                    required
                    value={customerId}
                    disabled={!!quote}
                    onChange={(e) => selectCustomer(e.target.value)}
                  >
                    <option value="">Select a company</option>
                    {data.companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    {createdCustomer &&
                    !data.companies.some((c) => c.id === createdCustomer.id) ? (
                      <option value={createdCustomer.id}>
                        {createdCustomer.name}
                      </option>
                    ) : null}
                  </select>
                </Field>
                {!quote ? (
                  <button
                    ref={customerTrigger}
                    type="button"
                    className="quote-inline-add"
                    aria-expanded={newCustomerOpen}
                    onClick={() => {
                      setNewCustomerOpen((open) => !open);
                      setCustomerError("");
                    }}
                  >
                    <Plus size={16} /> New customer
                  </button>
                ) : null}
              </div>
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
            {newCustomerOpen && !quote ? (
              <div
                className="quote-inline-panel"
                aria-label="New customer details"
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !customerBusy) {
                    event.preventDefault();
                    setNewCustomerOpen(false);
                    customerTrigger.current?.focus();
                  } else if (
                    event.key === "Enter" &&
                    event.target instanceof HTMLInputElement
                  ) {
                    event.preventDefault();
                    void addCustomer();
                  }
                }}
              >
                <h3>Add a customer company</h3>
                <p className="muted">
                  Your invoice stays open. Add a contact to this company later
                  from CRM if needed.
                </p>
                <div className="quote-field-grid">
                  <Field label="New customer company name">
                    <input
                      autoFocus
                      value={newCustomerName}
                      maxLength={200}
                      onChange={(e) => setNewCustomerName(e.target.value)}
                    />
                  </Field>
                  <Field label="Website domain (optional)">
                    <input
                      value={newCustomerDomain}
                      maxLength={200}
                      onChange={(e) => setNewCustomerDomain(e.target.value)}
                    />
                  </Field>
                  <Field label="Tax registration (optional)">
                    <input
                      value={newCustomerTaxId}
                      maxLength={200}
                      onChange={(e) => setNewCustomerTaxId(e.target.value)}
                    />
                  </Field>
                  <Field label="Billing address (optional)">
                    <textarea
                      value={newCustomerAddress}
                      maxLength={4000}
                      onChange={(e) => setNewCustomerAddress(e.target.value)}
                    />
                  </Field>
                </div>
                {customerError ? <ErrorBox error={customerError} /> : null}
                <div className="quote-inline-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setNewCustomerOpen(false);
                      customerTrigger.current?.focus();
                    }}
                    disabled={customerBusy}
                  >
                    Back to invoice
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void addCustomer()}
                    disabled={customerBusy}
                  >
                    {customerBusy
                      ? "Adding customer…"
                      : "Create & select customer"}
                  </button>
                </div>
              </div>
            ) : null}
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
                    hint={`Available after draft invoices and planned milestones: ${money(available, quote.currency)}.${BigInt(quote.adjustment_minor || "0") !== 0n ? " The quote adjustment is applied to the final invoice only." : ""}`}
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
                <DocumentCharges
                  details={details}
                  onChange={setDetail}
                  amounts={calculated}
                  currency={currency}
                />
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
              disabled={busy || itemBusy || customerBusy || newCustomerOpen}
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
