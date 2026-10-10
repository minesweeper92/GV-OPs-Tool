import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { ArrowLeft, FileText, Plus, Trash2, X } from "lucide-react";
import { Field, ErrorBox } from "./components";
import { CustomFields } from "./ProfileFields";
import { today, money, rate, type Data, type Line } from "./model";
import { documentDetails, documentTotals } from "../shared/documents";
import { NumberSeriesField } from "./NumberSeriesField";
import { DocumentCharges } from "./DocumentCharges";
import { PaymentTermsField } from "./PaymentTermsField";
import {
  defaultsFor,
  resolvedDefaults,
  defaultDetails,
  updateDefaultDetails,
  replaceDefault,
} from "../shared/document-defaults";
import {
  clearBrowserDraft,
  draftLines,
  draftDetails,
  readBrowserDraft,
  writeBrowserDraft,
} from "./browserDraft";

const emptyLine = (): Line => ({
  description: "",
  quantity: "1",
  price: "",
  tax: "0",
  discount_type: "percent",
  discount: "0",
});
const normalized = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const quoteDraft = z.object({
  savedAt: z.number(),
  companyId: z.string(),
  dealId: z.string(),
  optionName: z.string(),
  currency: z.string(),
  fx: z.string(),
  terms: z.string(),
  shareReference: z.string(),
  numberSeriesId: z.string(),
  savedQuoteId: z.string(),
  details: draftDetails,
  lines: draftLines,
});

export function QuoteComposer({
  id,
  data,
  draftScope,
  entityId,
  canManageNumbering,
  create,
  close,
  done,
}: {
  id: string;
  data: Data;
  draftScope: string;
  entityId: string;
  canManageNumbering: boolean;
  create: (command: Record<string, unknown>) => Promise<{ id: string }>;
  close: () => void;
  done: (quoteId: string) => void;
}) {
  const draftKey = `gv-quote-draft-v1:${draftScope}:${id || "new"}`;
  const [restored] = useState(() => readBrowserDraft(draftKey, quoteDraft));
  const hydrated = useRef(false);
  const [draftStored, setDraftStored] = useState(!!restored);
  const initialQuote = data.quotes.find((q) => q.id === id);
  const initialDeal = data.deals.find(
    (d) => d.id === (initialQuote?.deal_id || id),
  );
  const [companyId, setCompanyId] = useState(
    restored?.companyId ?? initialDeal?.company_id ?? "",
  );
  const [dealId, setDealId] = useState(
    restored?.dealId ?? initialDeal?.id ?? "",
  );
  const defaults = defaultsFor(
    data.documentDefaults,
    data.deals.find((d) => d.id === dealId)?.entity_id ??
      (entityId === "all" ? "" : entityId),
  );
  const initialDefaults = resolvedDefaults(
    defaults,
    "quote",
    today(),
    data.companies.find((c) => c.id === companyId)?.profile,
  );
  const previousDefaults = useRef(initialDefaults);
  const [customerSearch, setCustomerSearch] = useState("");
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerFirst, setCustomerFirst] = useState("");
  const [customerLast, setCustomerLast] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [createdCompanyId, setCreatedCompanyId] = useState("");
  const [companyRetryKey] = useState(() => crypto.randomUUID());
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectEntity, setProjectEntity] = useState(
    entityId === "all" ? "" : entityId,
  );
  const [projectContact, setProjectContact] = useState("");
  const [contactFirst, setContactFirst] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [createdContactId, setCreatedContactId] = useState("");
  const [createdLeadId, setCreatedLeadId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(!!restored);
  const [savedQuoteId, setSavedQuoteId] = useState(
    restored?.savedQuoteId ?? "",
  );
  const [shareReference, setShareReference] = useState(
    restored?.shareReference ?? "",
  );
  const [numberSeriesId, setNumberSeriesId] = useState(
    restored?.numberSeriesId ?? "",
  );
  const [optionName, setOptionName] = useState(
    restored?.optionName ?? initialQuote?.option_name ?? "",
  );
  const [currency, setCurrency] = useState(
    restored?.currency ??
      initialQuote?.currency ??
      data.companies.find((c) => c.id === companyId)?.profile.currency ??
      "PKR",
  );
  const [fx, setFx] = useState(
    restored?.fx ?? (initialQuote ? rate(initialQuote.fx_micros) : "1"),
  );
  const [lines, setLines] = useState<Line[]>(
    () =>
      restored?.lines ??
      (initialQuote
        ? initialQuote.lines
            .filter((line) => line.kind !== "shipping")
            .map(
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
            )
        : [emptyLine()]),
  );
  const [details, setDetails] = useState(
    () =>
      restored?.details ??
      documentDetails.parse({
        ...defaultDetails(initialDefaults),
        ...initialQuote?.details,
        quote_date: initialQuote?.details?.quote_date || today(),
      }),
  );
  const [terms, setTerms] = useState(
    restored?.terms ?? initialQuote?.terms ?? initialDefaults.terms,
  );

  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    if (!dirty) return;
    setDraftStored(
      writeBrowserDraft(draftKey, {
        companyId,
        dealId,
        optionName,
        currency,
        fx,
        lines,
        details,
        terms,
        shareReference,
        numberSeriesId,
        savedQuoteId,
      }),
    );
  }, [
    draftKey,
    dirty,
    companyId,
    dealId,
    optionName,
    currency,
    fx,
    lines,
    details,
    terms,
    shareReference,
    numberSeriesId,
    savedQuoteId,
  ]);

  const clearDraft = () => {
    clearBrowserDraft(draftKey);
  };

  useEffect(() => {
    const preventLostDraft = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", preventLostDraft);
    return () => window.removeEventListener("beforeunload", preventLostDraft);
  }, [dirty]);

  const chosenCompany = data.companies.find((c) => c.id === companyId);
  const chosenDeal = data.deals.find((d) => d.id === dealId);
  const activeContacts = data.affiliations
    .filter((a) => a.company_id === companyId && !a.ended_on)
    .map((a) => data.contacts.find((c) => c.id === a.contact_id))
    .filter((c): c is Data["contacts"][number] => !!c);
  const openDeals = data.deals.filter(
    (d) => d.company_id === companyId && !["Won", "Lost"].includes(d.stage),
  );
  const matchedCompanies = data.companies.filter((c) =>
    normalized(c.name).includes(normalized(customerSearch)),
  );
  let amounts: ReturnType<typeof documentTotals> | null = null;
  try {
    amounts = documentTotals(lines, details);
  } catch {
    // Incomplete rows are normal while a quote is being drafted.
  }
  const setDetail = (key: keyof typeof details, value: unknown) => {
    setDetails((old) => ({ ...old, [key]: value }));
    setDirty(true);
  };
  function applyDefaults(issuer: string, company?: Data["companies"][number]) {
    if (initialQuote) return;
    const next = resolvedDefaults(
      defaultsFor(data.documentDefaults, issuer),
      "quote",
      details.quote_date || today(),
      company?.profile,
    );
    const previous = previousDefaults.current;
    setDetails((old) => updateDefaultDetails(old, previous, next));
    setTerms((old) => replaceDefault(old, previous.terms, next.terms));
    previousDefaults.current = next;
  }
  const setLine = (index: number, field: keyof Line, value: string) => {
    setLines((old) =>
      old.map((line, i) => (i === index ? { ...line, [field]: value } : line)),
    );
    setDirty(true);
  };
  const attemptClose = () => {
    if (!dirty || window.confirm("Discard your unsaved quote?")) {
      clearDraft();
      close();
    }
  };

  async function addCustomer() {
    if (!customerName.trim() || !customerFirst.trim()) {
      setError("Enter the customer name and primary contact first name.");
      return;
    }
    if (
      !createdCompanyId &&
      data.companies.some(
        (c) => normalized(c.name) === normalized(customerName),
      )
    ) {
      setError("This customer already exists. Select it from the list.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let company = createdCompanyId;
      if (!company) {
        company = (
          await create({
            action: "company.create",
            request_key: companyRetryKey,
            name: customerName.trim(),
            customer: true,
            vendor: false,
            service_entity_id: null,
          })
        ).id;
        setCreatedCompanyId(company);
      }
      await create({
        action: "contact.create",
        first_name: customerFirst.trim(),
        last_name: customerLast.trim(),
        email: customerEmail.trim(),
        company_id: company,
        role: "Primary contact",
      });
      setCompanyId(company);
      applyDefaults(entityId === "all" ? "" : entityId);
      setDealId("");
      setNewCustomerOpen(false);
      setProjectOpen(true);
      setNotice(
        "Customer and primary contact added. Choose or create an opportunity.",
      );
      setDirty(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addProject() {
    if (!companyId || !projectName.trim() || !projectEntity) {
      setError(
        "Choose a customer and issuing entity, then name the opportunity.",
      );
      return;
    }
    if (!projectContact && !createdContactId && !contactFirst.trim()) {
      setError("Choose or add a contact for this opportunity.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let contact = projectContact || createdContactId;
      if (!contact) {
        contact = (
          await create({
            action: "contact.create",
            first_name: contactFirst.trim(),
            last_name: "",
            email: contactEmail.trim(),
            company_id: companyId,
            role: "Opportunity contact",
          })
        ).id;
        setCreatedContactId(contact);
      }
      let lead = createdLeadId;
      if (!lead) {
        lead = (
          await create({
            action: "lead.create",
            company_id: companyId,
            contact_id: contact,
            entity_id: projectEntity,
            title: projectName.trim(),
            next_action: "Prepare quote",
            due_date: today(),
          })
        ).id;
        setCreatedLeadId(lead);
      }
      const deal = (await create({ action: "lead.convert", id: lead })).id;
      applyDefaults(projectEntity, chosenCompany);
      setDealId(deal);
      setNumberSeriesId("");
      setProjectOpen(false);
      setNotice("Opportunity created and linked to this quote.");
      setDirty(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const markSent = submitter?.value === "mark-sent";
    if (!dealId) {
      setError(
        "Choose or create a customer opportunity before saving the quote.",
      );
      return;
    }
    if (markSent && !shareReference.trim()) {
      setError("Add the message or email reference before marking as sent.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let quoteId = savedQuoteId;
      if (!quoteId) {
        quoteId = (
          await create({
            action: "quote.create",
            deal_id: dealId,
            option_name: optionName.trim(),
            currency,
            fx,
            lines,
            details,
            terms,
            ...(numberSeriesId ? { number_series_id: numberSeriesId } : {}),
          })
        ).id;
        setSavedQuoteId(quoteId);
      }
      if (markSent) {
        await create({
          action: "quote.share",
          id: quoteId,
          reference: shareReference.trim(),
        });
      }
      setDirty(false);
      clearDraft();
      done(quoteId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quote-composer">
      <div className="quote-composer-heading">
        <div>
          <button className="quote-composer-back" onClick={attemptClose}>
            <ArrowLeft size={16} /> All quotes
          </button>
          <h1>
            <FileText size={26} /> {initialQuote ? "Revise quote" : "New quote"}
          </h1>
        </div>
        <button aria-label="Close quote" onClick={attemptClose}>
          <X size={19} />
        </button>
      </div>
      <form
        className="quote-composer-form"
        onSubmit={saveQuote}
        onChange={() => setDirty(true)}
      >
        <div className="quote-composer-scroll">
          {dirty && (
            <div className="quote-draft-notice" role="status">
              <span>
                {draftStored
                  ? "Quote fields saved in this tab for 24 hours. Inline customer/project forms and attachments are not included."
                  : "Draft recovery is unavailable. Save your quote before leaving."}
              </span>
              {draftStored && (
                <button type="button" disabled={busy} onClick={close}>
                  Keep draft & close
                </button>
              )}
            </div>
          )}
          <section className="quote-composer-section quote-customer-block">
            <h2>Customer and location</h2>
            <div className="quote-main-fields">
              <div className="field quote-customer-picker">
                <label htmlFor="quote-customer-select">
                  Customer name <span aria-hidden="true">*</span>
                </label>
                <input
                  aria-label="Search customers"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Search customers"
                  disabled={!!initialDeal}
                />
                <select
                  id="quote-customer-select"
                  aria-label="Customer name"
                  required
                  value={companyId}
                  disabled={!!initialDeal}
                  onChange={(e) => {
                    const company = data.companies.find(
                      (c) => c.id === e.target.value,
                    );
                    setCompanyId(e.target.value);
                    applyDefaults(entityId === "all" ? "" : entityId, company);
                    setCurrency((old) =>
                      replaceDefault(
                        old,
                        chosenCompany?.profile.currency ?? "PKR",
                        company?.profile.currency ?? "PKR",
                      ),
                    );
                    setDealId("");
                    setDetails((old) => ({
                      ...old,
                      billing_address: company?.address || "",
                      shipping_address: company?.shipping_address || "",
                      customer_tax_id: company?.tax_id || "",
                      recipients: company?.profile.billing_recipients || [],
                    }));
                    setDirty(true);
                  }}
                >
                  <option value="">Select a customer</option>
                  {matchedCompanies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  {chosenCompany &&
                  !matchedCompanies.some((c) => c.id === companyId) ? (
                    <option value={chosenCompany.id}>
                      {chosenCompany.name}
                    </option>
                  ) : null}
                </select>
              </div>
              {!initialDeal ? (
                <button
                  type="button"
                  className="quote-inline-add"
                  onClick={() => {
                    setNewCustomerOpen((open) => !open);
                    setError("");
                  }}
                >
                  <Plus size={16} /> New customer
                </button>
              ) : null}
              <div className="quote-fixed-field">
                <small>Location / issuing entity</small>
                <strong>
                  {chosenDeal
                    ? data.entities.find((e) => e.id === chosenDeal.entity_id)
                        ?.name
                    : "Choose an opportunity below"}
                </strong>
              </div>
            </div>
            {newCustomerOpen ? (
              <div className="quote-inline-panel">
                <h3>New customer</h3>
                <p className="muted">
                  Create the customer here; this quote stays open.
                </p>
                <div className="quote-field-grid">
                  <Field label="Company name">
                    <input
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      maxLength={200}
                    />
                  </Field>
                  <Field label="Primary contact first name">
                    <input
                      value={customerFirst}
                      onChange={(e) => setCustomerFirst(e.target.value)}
                      maxLength={200}
                    />
                  </Field>
                  <Field label="Primary contact last name">
                    <input
                      value={customerLast}
                      onChange={(e) => setCustomerLast(e.target.value)}
                      maxLength={200}
                    />
                  </Field>
                  <Field label="Primary contact email">
                    <input
                      type="email"
                      value={customerEmail}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="quote-inline-actions">
                  <button
                    type="button"
                    onClick={() => setNewCustomerOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={addCustomer}
                  >
                    Create customer
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <section className="quote-composer-section">
            <h2>Quote information</h2>
            <div className="quote-field-grid">
              <NumberSeriesField
                data={data}
                entityId={
                  chosenDeal?.entity_id ||
                  projectEntity ||
                  (entityId === "all" ? "" : entityId)
                }
                kind="quote"
                selectedId={numberSeriesId}
                onSelect={setNumberSeriesId}
                create={create}
                canManage={canManageNumbering}
                existingNumber={undefined}
              />
              <Field label="Reference number">
                <input
                  value={details.reference}
                  onChange={(e) => setDetail("reference", e.target.value)}
                  maxLength={200}
                />
              </Field>
              <Field label="Quote date">
                <input
                  type="date"
                  required
                  value={details.quote_date || ""}
                  onChange={(e) => {
                    const before = resolvedDefaults(
                      defaults,
                      "quote",
                      details.quote_date || today(),
                      chosenCompany?.profile,
                    );
                    const next = resolvedDefaults(
                      defaults,
                      "quote",
                      e.target.value,
                      chosenCompany?.profile,
                    );
                    setDetails((old) => ({
                      ...old,
                      quote_date: e.target.value,
                      valid_until: replaceDefault(
                        old.valid_until,
                        before.valid_until,
                        next.valid_until,
                      ),
                    }));
                    previousDefaults.current = next;
                    setDirty(true);
                  }}
                />
              </Field>
              <Field label="Expiry date">
                <input
                  type="date"
                  min={details.quote_date || undefined}
                  value={details.valid_until || ""}
                  onChange={(e) =>
                    setDetail("valid_until", e.target.value || null)
                  }
                />
              </Field>
              <PaymentTermsField
                settings={defaults}
                value={details.payment_term}
                onChange={(term) => {
                  setDetails((old) => ({
                    ...old,
                    payment_term: term,
                    payment_terms: term.name,
                  }));
                  setDirty(true);
                }}
              />
            </div>
            <div className="quote-field-grid">
              <div className="quote-project-picker">
                <Field
                  label="Related opportunity"
                  hint="This is the pre-sale CRM deal. An accounting project can be started after a quote is accepted."
                >
                  <select
                    value={dealId}
                    required
                    disabled={!!initialDeal}
                    onChange={(e) => {
                      if (e.target.value === "new") setProjectOpen(true);
                      else {
                        applyDefaults(
                          data.deals.find((d) => d.id === e.target.value)
                            ?.entity_id || "",
                          chosenCompany,
                        );
                        setDealId(e.target.value);
                        setNumberSeriesId("");
                      }
                      setDirty(true);
                    }}
                  >
                    <option value="">Select an opportunity</option>
                    {openDeals.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ·{" "}
                        {data.entities.find((e) => e.id === d.entity_id)?.code}
                      </option>
                    ))}
                    {chosenDeal && !openDeals.some((d) => d.id === dealId) ? (
                      <option value={chosenDeal.id}>{chosenDeal.name}</option>
                    ) : null}
                    {companyId && !initialDeal ? (
                      <option value="new">＋ Create new opportunity…</option>
                    ) : null}
                  </select>
                </Field>
                {!initialDeal ? (
                  <button
                    type="button"
                    className="quote-inline-add"
                    onClick={() => {
                      if (!companyId)
                        setError(
                          "Choose a customer company first, then add the opportunity.",
                        );
                      else {
                        setError("");
                        setProjectOpen(true);
                      }
                    }}
                  >
                    <Plus size={16} /> Add opportunity
                  </button>
                ) : null}
              </div>
              <Field
                label="Named option"
                hint="Baku, Sri Lanka, Director A, etc. Reusing a name creates its next version."
              >
                <input
                  required
                  value={optionName}
                  onChange={(e) => {
                    setOptionName(e.target.value);
                    setDirty(true);
                  }}
                  maxLength={200}
                />
              </Field>
            </div>
            {projectOpen && companyId && !initialDeal ? (
              <div className="quote-inline-panel">
                <h3>New opportunity</h3>
                <p className="muted">
                  This creates a linked CRM lead and deal. If won, you can start
                  a separate cost-tracked project from the accepted quote.
                </p>
                <div className="quote-field-grid">
                  <Field label="Opportunity name">
                    <input
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      maxLength={200}
                    />
                  </Field>
                  <Field label="Issuing legal entity">
                    <select
                      value={projectEntity}
                      onChange={(e) => {
                        setProjectEntity(e.target.value);
                        setNumberSeriesId("");
                      }}
                    >
                      <option value="">Choose the entity</option>
                      {data.entities.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name} ({e.code})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Opportunity contact">
                    <select
                      value={projectContact}
                      onChange={(e) => setProjectContact(e.target.value)}
                    >
                      <option value="">
                        {activeContacts.length
                          ? "Choose a contact"
                          : "Add a contact below"}
                      </option>
                      {activeContacts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.first_name} {c.last_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {!projectContact ? (
                  <div className="quote-field-grid">
                    <Field label="New contact first name">
                      <input
                        value={contactFirst}
                        onChange={(e) => setContactFirst(e.target.value)}
                        maxLength={200}
                      />
                    </Field>
                    <Field label="New contact email">
                      <input
                        type="email"
                        value={contactEmail}
                        onChange={(e) => setContactEmail(e.target.value)}
                      />
                    </Field>
                  </div>
                ) : null}
                <div className="quote-inline-actions">
                  <button type="button" onClick={() => setProjectOpen(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={addProject}
                  >
                    Create opportunity
                  </button>
                </div>
              </div>
            ) : null}
            <Field
              label="Subject"
              hint="Tell the customer what this quote is for."
            >
              <textarea
                value={details.subject}
                onChange={(e) => setDetail("subject", e.target.value)}
                rows={2}
                maxLength={200}
              />
            </Field>
          </section>

          <section className="quote-composer-section">
            <div className="quote-section-heading">
              <h2>Item table</h2>
              <label className="quote-tax-mode">
                Tax exclusive · tax set per line
              </label>
            </div>
            <div className="quote-currency-row">
              <Field label="Currency">
                <select
                  value={currency}
                  onChange={(e) => {
                    setCurrency(e.target.value);
                    setFx(e.target.value === "PKR" ? "1" : "");
                    setDirty(true);
                  }}
                >
                  {["PKR", "USD", "AED", "EUR", "GBP"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              {currency !== "PKR" ? (
                <Field
                  label="PKR per 1 unit"
                  hint="Document-date exchange rate"
                >
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
              aria-label="Quote line items"
            >
              <div className="quote-item-head" aria-hidden="true">
                <span>Item details</span>
                <span>Quantity</span>
                <span>Rate</span>
                <span>Tax %</span>
                <span>Amount</span>
                <span />
              </div>
              {lines.map((line, index) => (
                <div className="quote-item-row" key={index}>
                  <div className="quote-item-description">
                    <label
                      className="sr-only"
                      htmlFor={`quote-description-${index}`}
                    >
                      Description {index + 1}
                    </label>
                    <textarea
                      id={`quote-description-${index}`}
                      required
                      placeholder="Type or select an item"
                      value={line.description}
                      onChange={(e) =>
                        setLine(index, "description", e.target.value)
                      }
                      maxLength={2000}
                    />
                    <details>
                      <summary>Unit, section and discount</summary>
                      <div className="quote-line-extras">
                        <Field label={`Unit ${index + 1}`}>
                          <input
                            value={line.unit || ""}
                            onChange={(e) =>
                              setLine(index, "unit", e.target.value)
                            }
                          />
                        </Field>
                        <Field label={`Section ${index + 1}`}>
                          <input
                            value={line.section || ""}
                            onChange={(e) =>
                              setLine(index, "section", e.target.value)
                            }
                          />
                        </Field>
                        <Field label={`Discount type ${index + 1}`}>
                          <select
                            value={line.discount_type || "percent"}
                            onChange={(e) =>
                              setLine(index, "discount_type", e.target.value)
                            }
                          >
                            <option value="percent">Percentage</option>
                            <option value="amount">Amount</option>
                          </select>
                        </Field>
                        <Field label={`Discount ${index + 1}`}>
                          <input
                            inputMode="decimal"
                            value={line.discount || "0"}
                            onChange={(e) =>
                              setLine(index, "discount", e.target.value)
                            }
                          />
                        </Field>
                      </div>
                    </details>
                  </div>
                  <label>
                    <span className="sr-only">Quantity {index + 1}</span>
                    <input
                      required
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) =>
                        setLine(index, "quantity", e.target.value)
                      }
                    />
                  </label>
                  <label>
                    <span className="sr-only">Unit price {index + 1}</span>
                    <input
                      required
                      inputMode="decimal"
                      value={line.price}
                      onChange={(e) => setLine(index, "price", e.target.value)}
                    />
                  </label>
                  <label>
                    <span className="sr-only">Tax % {index + 1}</span>
                    <input
                      required
                      inputMode="decimal"
                      value={line.tax}
                      onChange={(e) => setLine(index, "tax", e.target.value)}
                    />
                  </label>
                  <strong>
                    {amounts
                      ? money(
                          BigInt(amounts.lines[index].subtotal) +
                            BigInt(amounts.lines[index].taxMinor),
                          currency,
                        )
                      : "—"}
                  </strong>
                  <button
                    type="button"
                    aria-label={`Remove line ${index + 1}`}
                    disabled={lines.length === 1}
                    onClick={() => {
                      setLines((old) => old.filter((_, i) => i !== index));
                      setDirty(true);
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="quote-add-row"
              onClick={() => {
                setLines((old) => [...old, emptyLine()]);
                setDirty(true);
              }}
            >
              <Plus size={16} /> Add new row
            </button>
            <DocumentCharges
              details={details}
              onChange={setDetail}
              amounts={amounts}
              currency={currency}
            />
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
                onChange={(e) => {
                  setTerms(e.target.value);
                  setDirty(true);
                }}
                rows={5}
                maxLength={4000}
              />
            </Field>
            <details className="quote-more-details">
              <summary>More customer, delivery and PDF details</summary>
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
                <Field label="Purchase order">
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
                <Field label="Scope / inclusions">
                  <textarea
                    value={details.inclusions}
                    onChange={(e) => setDetail("inclusions", e.target.value)}
                  />
                </Field>
                <Field label="Exclusions">
                  <textarea
                    value={details.exclusions}
                    onChange={(e) => setDetail("exclusions", e.target.value)}
                  />
                </Field>
                <Field label="Delivery schedule">
                  <textarea
                    value={details.delivery_schedule}
                    onChange={(e) =>
                      setDetail("delivery_schedule", e.target.value)
                    }
                  />
                </Field>
                <Field label="Payment schedule">
                  <textarea
                    value={details.payment_schedule}
                    onChange={(e) =>
                      setDetail("payment_schedule", e.target.value)
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
                <Field label="Document recipients (comma separated)">
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
              </div>
              <CustomFields
                value={details.custom_fields}
                onChange={(v) => setDetail("custom_fields", v)}
              />
            </details>
            <div className="quote-document-links">
              <h3>Attach document links</h3>
              <p className="muted">
                Link files already stored in your document system. File upload
                is not connected yet.
              </p>
              {details.references.map((reference, index) => (
                <div className="quote-field-grid" key={index}>
                  <Field label={`File ${index + 1} name`}>
                    <input
                      required
                      value={reference.name}
                      onChange={(e) =>
                        setDetail(
                          "references",
                          details.references.map((r, i) =>
                            i === index ? { ...r, name: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={`File ${index + 1} HTTPS link`}>
                    <input
                      type="url"
                      required
                      value={reference.url}
                      onChange={(e) =>
                        setDetail(
                          "references",
                          details.references.map((r, i) =>
                            i === index ? { ...r, url: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  </Field>
                  <button
                    type="button"
                    onClick={() =>
                      setDetail(
                        "references",
                        details.references.filter((_, i) => i !== index),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={details.references.length >= 20}
                onClick={() =>
                  setDetail("references", [
                    ...details.references,
                    { name: "", url: "" },
                  ])
                }
              >
                <Plus size={16} /> Add document link
              </button>
            </div>
            <div className="quote-manual-send">
              <Field
                label="Sent message reference"
                hint="Only needed if you already sent this quote outside the app. This does not email it."
              >
                <input
                  value={shareReference}
                  onChange={(e) => setShareReference(e.target.value)}
                  placeholder="Outlook message link or reference"
                  maxLength={200}
                />
              </Field>
            </div>
          </section>
          {notice ? (
            <p className="quote-composer-notice" role="status">
              {notice}
            </p>
          ) : null}
          {error ? <ErrorBox error={error} /> : null}
        </div>
        <div className="quote-composer-footer">
          <div className="quote-footer-actions">
            <button type="submit" value="draft" disabled={busy}>
              Save as draft
            </button>
            <button
              type="submit"
              value="mark-sent"
              className="primary"
              disabled={busy}
            >
              Save & mark as sent
            </button>
            <button type="button" onClick={attemptClose}>
              Cancel
            </button>
          </div>
          <label>
            PDF template
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
