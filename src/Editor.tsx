import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Drawer, Field, ErrorBox } from "./components";
import { BankSelect } from "./Banking";
import {
  today,
  invoiceBalance,
  money,
  decimal,
  rate,
  type Data,
  type Editor as EditorState,
  type Line,
  type Me,
} from "./model";
import { totals } from "../shared/money";
import { documentDetails } from "../shared/documents";
import { DocumentFields } from "./DocumentFields";
const titles: Record<string, string> = {
  company: "New company",
  contact: "New contact",
  lead: "New lead",
  quote: "New quote version",
  payment: "Record payment",
  expense: "Record expense",
  entity: "Add legal entity",
  accept: "Accept this quote",
  share: "Mark quote as shared",
  "invoice-mark-sent": "Mark invoice as sent",
  invoice: "Create invoice draft",
  "direct-invoice": "New invoice",
  "edit-invoice": "Edit invoice draft",
  "milestone-invoice": "Invoice milestone",
  "cancel-invoice": "Cancel invoice draft",
  recognise: "Recognise delivered work",
  issue: "Issue invoice",
  void: "Void invoice",
  lose: "Close deal as lost",
  "follow-up": "Set next action",
  association: "Add company association",
  "end-association": "End company association",
  note: "Add a note",
};
export function Editor({
  editor,
  data,
  me,
  onClose,
  onSave,
  entityId,
}: {
  editor: EditorState;
  data: Data;
  me: Me;
  onClose: () => void;
  onSave: (command: Record<string, unknown>) => Promise<void>;
  entityId: string;
}) {
  const { kind, id } = editor,
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const milestone =
    kind === "milestone-invoice"
      ? data.milestones.find((m) => m.id === id)
      : undefined;
  const milestoneProject = data.projects.find(
    (p) => p.id === milestone?.project_id,
  );
  const initialQuote = data.quotes.find(
      (q) => q.id === (milestoneProject?.quote_id || id),
    ),
    initialDeal = data.deals.find(
      (d) => d.id === (initialQuote?.deal_id || id),
    ),
    invoice = data.invoices.find((i) => i.id === id);
  const customer = data.companies.find(
    (c) => c.id === (invoice?.company_id || initialDeal?.company_id),
  );
  const defaults = (company: typeof customer) =>
    documentDetails.parse({
      quote_date: today(),
      billing_address: company?.address || "",
      shipping_address: company?.shipping_address || "",
      customer_tax_id: company?.tax_id || "",
      recipients: company?.profile.billing_recipients || [],
      payment_terms: `Net ${company?.profile.payment_days ?? 30} days`,
      customer_notes: company?.profile.document_notes || "",
    });
  const [details, setDetails] = useState(() =>
    documentDetails.parse(
      invoice?.details ||
        (initialQuote
          ? {
              ...initialQuote.details,
              quote_date: initialQuote.details?.quote_date || today(),
            }
          : defaults(customer)),
    ),
  );
  const [selectedCompany, setSelectedCompany] = useState(customer?.id || ""),
    [selectedEntity, setSelectedEntity] = useState(
      entityId === "all" ? "" : entityId,
    );
  const [currency, setCurrency] = useState(
    initialQuote?.currency ||
      customer?.profile.currency ||
      data.contacts.find((c) => c.id === initialDeal?.contact_id)?.currency ||
      "PKR",
  );
  const [lines, setLines] = useState<Line[]>(
    initialQuote?.lines.map(
      ({
        description,
        quantity,
        price,
        tax,
        unit,
        section,
        discount_type,
        discount,
      }) => ({
        description,
        quantity,
        price,
        tax,
        unit,
        section,
        discount_type,
        discount,
      }),
    ) || [{ description: "", quantity: "1", price: "", tax: "0" }],
  );
  const [fx, setFx] = useState(
    initialQuote ? rate(initialQuote.fx_micros) : currency === "PKR" ? "1" : "",
  );
  const [issueDate, setIssueDate] = useState(
    invoice?.issue_date.slice(0, 10) || today(),
  );
  const addDays = (date: string, days: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  };
  const [dueDate, setDueDate] = useState(
    invoice?.due_date.slice(0, 10) ||
      addDays(today(), customer?.profile.payment_days ?? 30),
  );
  const documentMode = [
    "quote",
    "invoice",
    "milestone-invoice",
    "direct-invoice",
    "edit-invoice",
  ].includes(kind);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [itemNotice, setItemNotice] = useState("");
  const [itemBusy, setItemBusy] = useState(false);
  async function saveItem(line: Line) {
    setItemBusy(true);
    setError("");
    try {
      await onSave({
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
  let total = "";
  try {
    total = totals(lines).total;
  } catch {
    /* Incomplete line editor is expected while typing. */
  }
  const companyOptions = data.companies.map((c) => (
    <option key={c.id} value={c.id}>
      {c.name}
    </option>
  ));
  const entityOptions = data.entities.map((e) => (
    <option key={e.id} value={e.id}>
      {e.name} ({e.code})
    </option>
  ));
  const text = (
    name: string,
    label: string,
    required = true,
    value = "",
    type = "text",
    hint?: string,
  ) => (
    <Field label={label} hint={hint}>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={value}
        maxLength={200}
      />
    </Field>
  );
  const entityField = (
    <Field
      label="Legal entity"
      hint="This entity will own the document and its ledger entries."
    >
      <select
        name="entity_id"
        required
        value={selectedEntity}
        onChange={(e) => setSelectedEntity(e.target.value)}
      >
        <option value="">Choose an entity</option>
        {entityOptions}
      </select>
    </Field>
  );
  const quote = initialQuote;
  const available = quote
    ? BigInt(quote.net_minor) -
      data.invoices
        .filter(
          (i) =>
            i.quote_id === quote.id &&
            !["Voided", "Cancelled"].includes(i.status),
        )
        .reduce((s, i) => s + BigInt(i.net_minor), 0n) -
      BigInt(
        data.projects.find((p) => p.quote_id === quote.id)?.planned_net || "0",
      )
    : 0n;
  const deferred = invoice
    ? BigInt(invoice.net_minor) -
      data.recognitions
        .filter((r) => r.invoice_id === invoice.id)
        .reduce((s, r) => s + BigInt(r.net_minor), 0n) -
      data.credits
        .filter(
          (c) =>
            c.invoice_id === invoice.id &&
            !c.reversal_date &&
            c.treatment === "deferred",
        )
        .reduce((s, c) => s + BigInt(c.net_minor), 0n)
    : 0n;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const f = Object.fromEntries(
      new FormData(event.currentTarget).entries(),
    ) as Record<string, string>;
    let command: Record<string, unknown> = {};
    switch (kind) {
      case "company":
        command = {
          action: "company.create",
          ...f,
          customer: f.customer === "on",
          vendor: f.vendor === "on",
          service_entity_id: f.service_entity_id || null,
        };
        break;
      case "contact":
        command = { action: "contact.create", ...f };
        break;
      case "lead":
        command = { action: "lead.create", ...f };
        break;
      case "quote":
        command = {
          action: "quote.create",
          ...f,
          deal_id: initialDeal?.id,
          lines,
          details,
        };
        break;
      case "accept":
        command = { action: "quote.accept", id, ...f };
        break;
      case "share":
        command = { action: "quote.share", id, ...f };
        break;
      case "invoice-mark-sent":
        command = { action: "invoice.mark-sent", id, ...f };
        break;
      case "invoice":
      case "milestone-invoice":
        command = {
          action: "invoice.create",
          quote_id: quote?.id,
          ...f,
          request_key: requestKey,
          ...(milestone ? { milestone_id: milestone.id } : {}),
          details,
        };
        break;
      case "direct-invoice":
        command = {
          action: "document.invoice-create",
          ...f,
          lines,
          details,
          request_key: requestKey,
        };
        break;
      case "edit-invoice":
        command = {
          action: "document.invoice-edit",
          ...f,
          id,
          version: invoice?.version,
          details,
        };
        break;
      case "cancel-invoice":
        command = { action: "invoice.cancel", id, ...f };
        break;
      case "recognise":
        command = {
          action: "invoice.recognise",
          id,
          ...f,
          request_key: requestKey,
        };
        break;
      case "issue":
        command = { action: "invoice.issue", id };
        break;
      case "payment":
        command = {
          action: "payment.create",
          invoice_id: id,
          ...f,
          bank_account_id: f.bank_account_id || null,
          request_key: requestKey,
        };
        break;
      case "expense":
        command = {
          action: "expense.create",
          ...f,
          bank_account_id: f.bank_account_id || null,
          deal_id: f.deal_id || null,
          request_key: requestKey,
        };
        break;
      case "entity":
        command = { action: "entity.create", ...f };
        break;
      case "void":
        command = { action: "invoice.void", id, ...f };
        break;
      case "lose":
        command = { action: "deal.lose", id, ...f };
        break;
      case "follow-up":
        command = { action: "deal.follow-up", id, ...f };
        break;
      case "association":
        command = { action: "contact.associate", contact_id: id, ...f };
        break;
      case "end-association":
        command = { action: "contact.end-association", id, ...f };
        break;
      case "note":
        command = { action: "note.create", record_id: id, ...f };
        break;
    }
    try {
      await onSave(command);
      setDirty(false);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      title={titles[kind] || kind}
      close={() => {
        if (!busy) onClose();
      }}
      dirty={dirty}
      wide={documentMode}
    >
      <form className="editor" onSubmit={save} onChange={() => setDirty(true)}>
        <div className="editor-body">
          {kind === "company" ? (
            <>
              {text("name", "Company name")}
              {text("domain", "Website domain", false)}
              {text("industry", "Industry", false)}
              <Field label="Usually serviced by">
                <select name="service_entity_id" defaultValue={selectedEntity}>
                  <option value="">Choose per project</option>
                  {entityOptions}
                </select>
              </Field>
              <div className="checks">
                <label>
                  <input type="checkbox" name="customer" /> Customer
                </label>
                <label>
                  <input
                    type="checkbox"
                    name="vendor"
                    defaultChecked={id === "vendor"}
                  />{" "}
                  Vendor
                </label>
              </div>
              <details>
                <summary>Billing details</summary>
                {text("tax_id", "Tax registration", false)}
                {text("address", "Billing address", false)}
              </details>
            </>
          ) : null}
          {kind === "contact" ? (
            <>
              <div className="form-row">
                {text("first_name", "First name")}
                {text("last_name", "Last name", false)}
              </div>
              {text("email", "Email", false, "", "email")}
              {text("phone", "Phone", false)}
              {text("title", "Job title", false)}
              <Field label="Company">
                <select name="company_id" required defaultValue="">
                  <option value="">Choose company</option>
                  {companyOptions}
                </select>
              </Field>
              {text("role", "Relationship role", true, "Decision maker")}
              <details>
                <summary>Source and notes</summary>
                {text("source", "Lead source", false)}
                <Field label="Notes">
                  <textarea name="notes" maxLength={4000} />
                </Field>
              </details>
            </>
          ) : null}
          {kind === "lead" ? (
            <>
              {text("title", "Project or opportunity")}
              <Field label="Company">
                <select
                  name="company_id"
                  required
                  value={selectedCompany}
                  onChange={(e) => setSelectedCompany(e.target.value)}
                >
                  <option value="">Choose company</option>
                  {companyOptions}
                </select>
              </Field>
              <Field label="Contact">
                <select
                  key={selectedCompany}
                  name="contact_id"
                  required
                  defaultValue=""
                >
                  <option value="">Choose contact</option>
                  {data.contacts
                    .filter((c) =>
                      data.affiliations.some(
                        (a) =>
                          a.contact_id === c.id &&
                          a.company_id === selectedCompany &&
                          !a.ended_on,
                      ),
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.first_name} {c.last_name}
                      </option>
                    ))}
                </select>
              </Field>
              {entityField}
              {text("source", "Source", false)}
              {text("next_action", "Next action")}
              {text("due_date", "Follow-up date", true, today(), "date")}
            </>
          ) : null}
          {kind === "direct-invoice" ? (
            <section>
              <p className="muted">
                Invoice an existing customer without creating a lead or deal.
                Choose the issuing legal entity explicitly. Use the accepted
                quote's invoice action for project billing.
              </p>
              <div className="form-row">
                {entityField}
                <Field label="Customer">
                  <select
                    name="company_id"
                    required
                    value={selectedCompany}
                    onChange={(e) => {
                      const company = data.companies.find(
                        (c) => c.id === e.target.value,
                      );
                      setSelectedCompany(e.target.value);
                      setDetails(defaults(company));
                      const cur = company?.profile.currency || "PKR";
                      setCurrency(cur);
                      setFx(cur === "PKR" ? "1" : "");
                      setDueDate(
                        addDays(issueDate, company?.profile.payment_days ?? 30),
                      );
                    }}
                  >
                    <option value="">Choose customer</option>
                    {companyOptions}
                  </select>
                </Field>
              </div>
              {text("label", "Billing stage", true, "Direct invoice")}
              <Field label="Revenue treatment">
                <select name="billing_kind">
                  <option value="earned">
                    Delivered work — earned revenue
                  </option>
                  <option value="advance">Advance — deferred revenue</option>
                </select>
              </Field>
            </section>
          ) : null}
          {kind === "quote" || kind === "direct-invoice" ? (
            <>
              {kind === "quote" && initialDeal ? (
                <div className="quote-editor-context">
                  <div>
                    <small>Customer</small>
                    <strong>
                      {
                        data.companies.find(
                          (c) => c.id === initialDeal.company_id,
                        )?.name
                      }
                    </strong>
                  </div>
                  <div>
                    <small>Project</small>
                    <strong>{initialDeal.name}</strong>
                  </div>
                  <div>
                    <small>Issuing entity</small>
                    <strong>
                      {
                        data.entities.find(
                          (e) => e.id === initialDeal.entity_id,
                        )?.name
                      }
                    </strong>
                  </div>
                  <div>
                    <small>Quote number</small>
                    <strong>Assigned on save</strong>
                  </div>
                </div>
              ) : initialDeal ? (
                <p className="context-label">{initialDeal.name}</p>
              ) : null}
              {kind === "quote"
                ? text(
                    "option_name",
                    "Named option",
                    true,
                    initialQuote?.option_name || "",
                    "text",
                    "Use names such as Baku or Director Ali. The same name creates the next revision.",
                  )
                : null}
              {kind === "quote" ? (
                <DocumentFields
                  value={details}
                  quote
                  onChange={(v) => {
                    setDetails(v);
                    setDirty(true);
                  }}
                />
              ) : null}
              <div className="form-row">
                <Field label="Currency">
                  <select
                    name="currency"
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
                <Field
                  label="PKR per 1 unit"
                  hint="Manual document-date exchange rate."
                >
                  <input
                    name="fx"
                    required
                    value={fx}
                    readOnly={currency === "PKR"}
                    onChange={(e) => setFx(e.target.value)}
                  />
                </Field>
              </div>
              <h3>Line items</h3>
              <Field
                label="Add saved item"
                hint="Only items in this document's currency are shown. Review the rate and tax before saving."
              >
                <select
                  value=""
                  onChange={(e) => {
                    const item = data.catalogItems.find(
                      (i) => i.id === e.target.value,
                    );
                    if (item) {
                      setLines((old) =>
                        old.length === 1 && !old[0].description
                          ? [{ ...item.line }]
                          : [...old, { ...item.line }],
                      );
                      setDirty(true);
                    }
                  }}
                >
                  <option value="">Choose from the item library</option>
                  {data.catalogItems
                    .filter((i) => i.currency === currency)
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                </select>
              </Field>
              {itemNotice ? <p role="status">{itemNotice}</p> : null}
              {data.catalogItems.length ? (
                <details>
                  <summary>Manage saved items</summary>
                  <p className="muted">
                    Archiving removes a reusable item from future choices.
                    Existing quotes and invoices keep their own copy.
                  </p>
                  {data.catalogItems.map((item) => (
                    <p key={item.id}>
                      {item.name} · {item.currency} {item.line.price}{" "}
                      {me.user.role === "admin" ||
                      item.created_by === me.user.id ? (
                        <button
                          type="button"
                          disabled={itemBusy}
                          onClick={async () => {
                            setItemBusy(true);
                            setError("");
                            try {
                              await onSave({
                                action: "document.item-archive",
                                id: item.id,
                              });
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setItemBusy(false);
                            }
                          }}
                        >
                          Archive {item.name}
                        </button>
                      ) : null}
                    </p>
                  ))}
                </details>
              ) : null}
              {lines.map((line, i) => (
                <div className="line-editor" key={i}>
                  <Field label={`Description ${i + 1}`}>
                    <textarea
                      required
                      value={line.description}
                      maxLength={2000}
                      onChange={(e) =>
                        setLines((old) =>
                          old.map((l, j) =>
                            j === i ? { ...l, description: e.target.value } : l,
                          ),
                        )
                      }
                    />
                  </Field>
                  <div className="form-row">
                    <Field label={`Unit ${i + 1}`}>
                      <input
                        value={line.unit || ""}
                        placeholder="days, hours, project…"
                        onChange={(e) =>
                          setLines((old) =>
                            old.map((l, n) =>
                              n === i ? { ...l, unit: e.target.value } : l,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label={`Section ${i + 1}`}>
                      <input
                        value={line.section || ""}
                        placeholder="Production, post-production…"
                        onChange={(e) =>
                          setLines((old) =>
                            old.map((l, n) =>
                              n === i ? { ...l, section: e.target.value } : l,
                            ),
                          )
                        }
                      />
                    </Field>
                  </div>
                  <div className="line-numbers">
                    {(["quantity", "price", "tax"] as const).map((key) => (
                      <Field
                        key={key}
                        label={`${key === "quantity" ? "Quantity" : key === "price" ? "Unit price" : "Tax %"} ${i + 1}`}
                      >
                        <input
                          required
                          inputMode="decimal"
                          value={line[key]}
                          onChange={(e) =>
                            setLines((old) =>
                              old.map((l, j) =>
                                j === i ? { ...l, [key]: e.target.value } : l,
                              ),
                            )
                          }
                        />
                      </Field>
                    ))}
                    <button
                      type="button"
                      aria-label={`Remove line ${i + 1}`}
                      disabled={lines.length === 1}
                      onClick={() => {
                        setLines((old) => old.filter((_, j) => j !== i));
                        setDirty(true);
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                  <div className="form-row">
                    <Field label={`Discount type ${i + 1}`}>
                      <select
                        value={line.discount_type || "percent"}
                        onChange={(e) =>
                          setLines((old) =>
                            old.map((l, n) =>
                              n === i
                                ? {
                                    ...l,
                                    discount_type: e.target.value as
                                      "percent" | "amount",
                                  }
                                : l,
                            ),
                          )
                        }
                      >
                        <option value="percent">Percentage</option>
                        <option value="amount">Line amount ({currency})</option>
                      </select>
                    </Field>
                    <Field
                      label={`Discount ${i + 1}`}
                      hint="Applied before tax to this line."
                    >
                      <input
                        inputMode="decimal"
                        value={line.discount || "0"}
                        onChange={(e) =>
                          setLines((old) =>
                            old.map((l, n) =>
                              n === i ? { ...l, discount: e.target.value } : l,
                            ),
                          )
                        }
                      />
                    </Field>
                  </div>
                  <button
                    type="button"
                    disabled={itemBusy || !line.description || !line.price}
                    onClick={() => saveItem(line)}
                  >
                    Save line {i + 1} to item library
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  setLines((old) => [
                    ...old,
                    { description: "", quantity: "1", price: "", tax: "0" },
                  ]);
                  setDirty(true);
                }}
              >
                <Plus size={16} />
                Add line
              </button>
              <div className="document-total">
                Total{" "}
                <strong>
                  {total ? money(total, currency) : "Complete the line items"}
                </strong>
              </div>
              <p className="muted">
                Taxes are entered explicitly. No tax exemption or statutory rate
                is inferred.
              </p>
              <Field label="Terms">
                <textarea
                  name="terms"
                  defaultValue={initialQuote?.terms || ""}
                  maxLength={4000}
                />
              </Field>
            </>
          ) : null}
          {kind === "accept" || kind === "share" ? (
            <>
              <div className="posting-notice">
                <strong>
                  {quote?.option_name} · v{quote?.revision}
                </strong>
                <p>{quote ? money(quote.total_minor, quote.currency) : ""}</p>
                {kind === "accept" ? (
                  <p>
                    This exact version will win the deal. Other options remain
                    in its history. No ledger entry is made.
                  </p>
                ) : (
                  <p>
                    This records a message you already sent. It does not send an
                    email.
                  </p>
                )}
              </div>
              {text(
                "reference",
                kind === "accept"
                  ? "Acceptance evidence"
                  : "Email link or message reference",
                true,
                "",
                "text",
                "Record who confirmed it, when, and a link or reference.",
              )}
            </>
          ) : null}
          {kind === "invoice-mark-sent" ? (
            <>
              <div className="posting-notice">
                <strong>{invoice?.number}</strong>
                <p>
                  This records an invoice sent outside the app. No email is sent
                  and no new journal is posted.
                </p>
              </div>
              {text(
                "reference",
                "Email link or message reference",
                true,
                "",
                "text",
                "Record the message or other evidence of delivery.",
              )}
            </>
          ) : null}
          {kind === "invoice" || kind === "milestone-invoice" ? (
            <>
              <p>
                The accepted quote supplies the customer, legal entity, currency
                and line items. Saving a draft does not post to the books.
              </p>
              <p className="context-label">
                {quote?.issuer_name} · {quote?.customer_name} · Available
                outside drafts and planned milestones:{" "}
                {money(available, quote?.currency)}
              </p>
              {milestone ? (
                <p>
                  {milestone.name} ·{" "}
                  {money(milestone.net_minor, quote?.currency)} before tax ·{" "}
                  {milestone.billing_kind === "advance"
                    ? "Advance / deferred revenue"
                    : "Earned revenue"}
                </p>
              ) : (
                <>
                  {text("label", "Billing stage", true, "Accepted quote")}
                  {text(
                    "amount",
                    `Subtotal to invoice (${quote?.currency}, before tax)`,
                    true,
                    decimal(available),
                  )}
                  <Field label="Revenue treatment">
                    <select name="billing_kind" defaultValue="earned">
                      <option value="earned">
                        Delivered work — earned revenue
                      </option>
                      <option value="advance">
                        Advance — deferred revenue
                      </option>
                    </select>
                  </Field>
                </>
              )}
              <p className="muted">
                Partial amounts are distributed across the remaining quote
                lines, preserving their tax rates. Drafts reserve the amount;
                cancel a draft to release it. Planned milestones reserve their
                amounts separately.
              </p>
            </>
          ) : null}
          {kind === "edit-invoice" ? (
            <>
              <p className="context-label">
                {invoice?.issuer_name} · {invoice?.customer_name} ·{" "}
                {invoice ? money(invoice.total_minor, invoice.currency) : ""}
              </p>
              <p className="muted">
                Update dates and document details before issuing. Amounts,
                entity and the approved quote allocation stay fixed; cancel and
                replace the draft if its scope changes.
              </p>
              <Field label="Terms">
                <textarea
                  name="terms"
                  defaultValue={invoice?.terms || ""}
                  maxLength={4000}
                />
              </Field>
            </>
          ) : null}
          {documentMode && kind !== "quote" ? (
            <div className="form-row">
              <Field label="Invoice date">
                <input
                  name="issue_date"
                  type="date"
                  required
                  value={issueDate}
                  onChange={(e) => {
                    setIssueDate(e.target.value);
                    if (kind !== "edit-invoice")
                      setDueDate(
                        addDays(
                          e.target.value,
                          data.companies.find((c) => c.id === selectedCompany)
                            ?.profile.payment_days ?? 30,
                        ),
                      );
                  }}
                />
              </Field>
              <Field label="Due date">
                <input
                  name="due_date"
                  type="date"
                  required
                  min={issueDate}
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </Field>
            </div>
          ) : null}
          {documentMode && kind !== "quote" ? (
            <DocumentFields
              key={selectedCompany}
              value={details}
              quote={kind === "quote"}
              onChange={(v) => {
                setDetails(v);
                setDirty(true);
              }}
            />
          ) : null}
          {kind === "issue" ? (
            <div className="posting-notice">
              <strong>{invoice?.customer_name}</strong>
              <p>
                {invoice ? money(invoice.total_minor, invoice.currency) : ""}
              </p>
              <p>
                Issue a numbered invoice and record accounts receivable,{" "}
                {invoice?.billing_kind === "advance"
                  ? "deferred revenue"
                  : "earned revenue"}{" "}
                and output tax. The document becomes read-only. This does not
                send an email.
              </p>
            </div>
          ) : null}
          {kind === "cancel-invoice" ? (
            <>
              <p>
                Cancel this unissued draft and release its quote allocation. Its
                history remains available.
              </p>
              {text("reason", "Reason")}
            </>
          ) : null}
          {kind === "recognise" ? (
            <>
              <p>
                {invoice?.number} · Unrecognised subtotal{" "}
                {money(deferred, invoice?.currency)}. Use this only for work
                already delivered. This moves deferred revenue to earned
                revenue; it does not record another invoice or receipt.
              </p>
              {text(
                "amount",
                `Delivered subtotal (${invoice?.currency})`,
                true,
                decimal(deferred),
              )}
              {text("date", "Recognition date", true, today(), "date")}
              {text("reference", "Delivery evidence")}
            </>
          ) : null}
          {kind === "payment" ? (
            <>
              <BankSelect data={data} entity={invoice?.entity_id || ""} />
              <p className="context-label">
                {invoice?.number} · Balance{" "}
                {invoice
                  ? money(invoiceBalance(invoice), invoice.currency)
                  : ""}
              </p>
              {text("date", "Payment date", true, today(), "date")}
              {text(
                "amount",
                `Money received (${invoice?.currency})`,
                true,
                invoice ? decimal(invoiceBalance(invoice)) : "",
              )}
              {text(
                "wht",
                `Withholding deducted (${invoice?.currency})`,
                true,
                "0",
              )}
              {text(
                "fx",
                "PKR per 1 unit at payment",
                true,
                invoice ? rate(invoice.fx_micros) : "1",
              )}
              {text("reference", "Bank or receipt reference")}
              <p className="posting-notice">
                Records cash and withholding receivable, reduces the invoice
                balance, and posts any exchange gain or loss. No bank transfer
                is initiated.
              </p>
            </>
          ) : null}
          {kind === "expense" ? (
            <>
              {entityField}
              <BankSelect data={data} entity={selectedEntity} />
              {text("description", "What was the expense for?")}
              {text("amount", "Amount paid (PKR)")}
              {text("date", "Expense date", true, today(), "date")}
              {text("reference", "Receipt or payment reference")}
              <Field label="Project (optional)">
                <select name="deal_id" key={selectedEntity} defaultValue="">
                  <option value="">General company expense</option>
                  {data.deals
                    .filter((d) => d.entity_id === selectedEntity)
                    .map((d) => (
                      <option value={d.id} key={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
              </Field>
              <p className="posting-notice">
                Records a paid expense: debit Operating expenses, credit Bank
                and cash. This first workflow does not claim recoverable input
                tax.
              </p>
            </>
          ) : null}
          {kind === "entity" ? (
            <>
              {text("name", "Legal name")}
              {text(
                "code",
                "Short code",
                true,
                "",
                "text",
                "2–8 uppercase letters or digits, beginning with a letter.",
              )}
              {text("tax_id", "Tax registration", false)}
              {text("address", "Registered address", false)}
              <p>
                Base currency: PKR. A separate chart of accounts and invoice
                sequence will be created.
              </p>
            </>
          ) : null}
          {["lose", "void"].includes(kind) ? (
            <>
              {text("reason", "Reason")}
              {kind === "void"
                ? text("date", "Reversal date", true, today(), "date")
                : null}
              <p className="posting-notice">
                {kind === "void"
                  ? "This reverses the unpaid invoice in the ledger and preserves its original number."
                  : "This removes the deal from open follow-ups and keeps its history."}
              </p>
            </>
          ) : null}
          {kind === "follow-up" ? (
            <>
              {text(
                "next_action",
                "Next action",
                true,
                initialDeal?.next_action || "",
              )}
              {text(
                "due_date",
                "Due date",
                true,
                initialDeal?.due_date?.slice(0, 10) || today(),
                "date",
              )}
            </>
          ) : null}
          {kind === "association" ? (
            <>
              <Field label="Company">
                <select name="company_id" required defaultValue="">
                  <option value="">Choose company</option>
                  {companyOptions}
                </select>
              </Field>
              {text("role", "Role", true, "Decision maker")}
              {text("work_email", "Work email", false, "", "email")}
              {text("started_on", "Started on", true, today(), "date")}
              <p>
                Existing project links stay unchanged. End an old employment
                separately to preserve its history.
              </p>
            </>
          ) : null}
          {kind === "end-association" ? (
            <>
              {text("ended_on", "Ended on", true, today(), "date")}
              <p>
                Old deals and documents keep their original company. The contact
                remains available for a new employer.
              </p>
            </>
          ) : null}
          {kind === "note" ? (
            <Field label="Note">
              <textarea name="text" required maxLength={4000} rows={6} />
            </Field>
          ) : null}
          {error ? <ErrorBox error={error} /> : null}
        </div>
        <div className="editor-footer">
          {kind === "quote" ? (
            <div className="quote-editor-footer-note">
              <button
                type="button"
                onClick={() => {
                  if (!dirty || window.confirm("Discard your unsaved changes?"))
                    onClose();
                }}
              >
                Cancel
              </button>
              <small>Save as draft. No email is sent.</small>
            </div>
          ) : (
            <span className="muted">{me.user.name}</span>
          )}
          <button className="primary" disabled={busy || itemBusy}>
            {busy
              ? "Saving…"
              : kind === "quote"
                ? "Save quote version"
                : kind === "invoice" ||
                    kind === "milestone-invoice" ||
                    kind === "direct-invoice"
                  ? "Save invoice draft"
                  : kind === "issue"
                    ? "Issue and post"
                    : kind === "payment"
                      ? "Record payment"
                      : kind === "expense"
                        ? "Post expense"
                        : "Save"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
