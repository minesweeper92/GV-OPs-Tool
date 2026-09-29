import type { Data, Deal, Editor, Invoice, Me, Report } from "./model";
import { day, money, invoiceBalance } from "./model";
import { Badge, Empty, ErrorBox, Heading, Table } from "./components";
import { ArrowLeft, ArrowUpRight, Plus } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { request } from "./model";
import type { CrmOpen } from "./Crm";
import { ProfileSummary } from "./ProfileFields";
import { DocumentExtras } from "./DocumentFields";
const CrmPanel = lazy(() =>
  import("./Crm").then((m) => ({ default: m.CrmPanel })),
);
type Props = {
  data: Data;
  me: Me;
  edit: (e: Editor) => void;
  run: (c: Record<string, unknown>) => Promise<void>;
  crmEdit: CrmOpen;
};
const finance = (me: Me) => ["admin", "finance"].includes(me.user.role),
  sales = (me: Me) => ["admin", "sales"].includes(me.user.role);
export function DealRecord({
  deal,
  data,
  me,
  edit,
  crmEdit,
}: Props & { deal: Deal }) {
  const company = data.companies.find((c) => c.id === deal.company_id),
    contact = data.contacts.find((c) => c.id === deal.contact_id),
    entity = data.entities.find((e) => e.id === deal.entity_id);
  const quotes = data.quotes.filter((q) => q.deal_id === deal.id),
    invoices = data.invoices.filter((i) => i.deal_id === deal.id),
    closed = ["Won", "Lost"].includes(deal.stage);
  const related = new Set([
    deal.id,
    deal.lead_id,
    ...quotes.map((q) => q.id),
    ...invoices.map((i) => i.id),
  ]);
  const events = data.events.filter(
    (e) => related.has(e.record_id) || e.details.deal_id === deal.id,
  );
  return (
    <>
      <a className="back" href="#deals">
        <ArrowLeft size={15} />
        All deals
      </a>
      <Heading
        title={deal.name}
        action={sales(me) && !closed ? "New quote" : undefined}
        onAction={() => edit({ kind: "quote", id: deal.id })}
      />
      <div className="record-summary">
        <Badge>{deal.stage}</Badge>
        <span>{entity?.name}</span>
        {sales(me) ? (
          <button onClick={() => crmEdit("deal", "deal", deal.id)}>
            Edit deal details
          </button>
        ) : null}
      </div>
      <ProfileSummary value={deal.profile || {}} data={data} />
      <div className="record-layout">
        <aside className="properties" aria-label="Deal details">
          <h2>Deal details</h2>
          <dl>
            <dt>Company</dt>
            <dd>
              <a href={`#company/${company?.id}`}>{company?.name}</a>
            </dd>
            <dt>Primary contact</dt>
            <dd>
              <a href={`#contact/${contact?.id}`}>
                {contact?.first_name} {contact?.last_name}
              </a>
            </dd>
            <dt>Issuing entity</dt>
            <dd>{entity?.code}</dd>
            <dt>Next action</dt>
            <dd>{deal.next_action || "Closed, no follow-up required"}</dd>
            {deal.due_date ? (
              <>
                <dt>Due</dt>
                <dd>{day(deal.due_date)}</dd>
              </>
            ) : null}
          </dl>
          {sales(me) && !closed ? (
            <div className="vertical-actions">
              <button onClick={() => edit({ kind: "follow-up", id: deal.id })}>
                Set next action
              </button>
              <button onClick={() => edit({ kind: "lose", id: deal.id })}>
                Close as lost
              </button>
            </div>
          ) : null}
        </aside>
        <section className="record-main">
          <div className="section-title">
            <h2>Quote options</h2>
            <span>{quotes.length} versions</span>
          </div>
          <p className="muted">
            Named alternatives stay separate. Acceptance always selects one
            exact version.
          </p>
          {quotes.length ? (
            <Table headers={["Option / version", "Total", "Status", "Actions"]}>
              {quotes.map((q) => {
                const accepted = deal.accepted_quote_id === q.id,
                  declined = data.quoteEvents.some(
                    (e) => e.quote_id === q.id && e.kind === "Declined",
                  ),
                  shared = data.quoteEvents.some(
                    (e) => e.quote_id === q.id && e.kind === "Shared",
                  );
                return (
                  <tr key={q.id}>
                    <td>
                      <strong>{q.option_name}</strong>
                      <small>Version {q.revision}</small>
                    </td>
                    <td className="num">{money(q.total_minor, q.currency)}</td>
                    <td>
                      <Badge>
                        {accepted
                          ? "Accepted"
                          : declined
                            ? "Declined"
                            : shared
                              ? "Sent"
                              : "Draft"}
                      </Badge>
                    </td>
                    <td>
                      <div className="row-actions">
                        <a href={`#quote/${q.id}`}>View</a>
                        {sales(me) && !closed ? (
                          <>
                            <button
                              onClick={() => edit({ kind: "quote", id: q.id })}
                            >
                              Revise
                            </button>
                            <button
                              onClick={() => edit({ kind: "share", id: q.id })}
                            >
                              Mark sent
                            </button>
                            <button
                              onClick={() => edit({ kind: "accept", id: q.id })}
                            >
                              Accept
                            </button>
                          </>
                        ) : null}
                        {accepted &&
                        invoices
                          .filter(
                            (i) => !["Cancelled", "Voided"].includes(i.status),
                          )
                          .reduce((s, i) => s + BigInt(i.net_minor), 0n) +
                          BigInt(
                            data.projects.find((p) => p.deal_id === deal.id)
                              ?.planned_net || "0",
                          ) <
                          BigInt(q.net_minor) &&
                        finance(me) ? (
                          <button
                            onClick={() => edit({ kind: "invoice", id: q.id })}
                          >
                            Create invoice
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
          ) : (
            <Empty title="Start with a named option">
              Create an option such as Baku or Director Ali, then revise that
              option as the brief changes.
            </Empty>
          )}
          <Suspense fallback={<p>Loading activity…</p>}>
            <CrmPanel
              data={data}
              me={me}
              open={crmEdit}
              type="deal"
              id={deal.id}
              events={events}
            />
          </Suspense>
        </section>
        <aside className="associations" aria-label="Linked commercial records">
          {finance(me) && deal.accepted_quote_id ? (
            <>
              <h3>Delivery & profitability</h3>
              {data.projects.find((p) => p.deal_id === deal.id) ? (
                <a
                  className="association-item"
                  href={`#project/${data.projects.find((p) => p.deal_id === deal.id)!.id}`}
                >
                  Open project
                </a>
              ) : (
                <a
                  className="association-item"
                  href={`#projects/${deal.accepted_quote_id}`}
                >
                  Start project from accepted quote
                </a>
              )}
            </>
          ) : null}
          <h3>Linked invoices</h3>
          {invoices.length ? (
            invoices.map((i) => (
              <a
                className="association-item"
                href={`#invoice/${i.id}`}
                key={i.id}
              >
                <strong>{i.number || "Invoice draft"}</strong>
                <span>{money(i.total_minor, i.currency)}</span>
                <Badge>{i.status}</Badge>
              </a>
            ))
          ) : (
            <p className="muted">
              An accepted quote can become an invoice without entering its
              details again.
            </p>
          )}
          {finance(me) ? (
            <>
              <h3 className="space-top">Project expenses</h3>
              {(data.bills || [])
                .filter((b) => b.deal_id === deal.id)
                .map((b) => (
                  <a
                    className="association-item"
                    key={b.id}
                    href={`#bill/${b.id}`}
                  >
                    <strong>
                      {b.reference} · {b.vendor_name}
                    </strong>
                    <span>{money(b.total_minor, b.currency)}</span>
                    <Badge>{b.status}</Badge>
                  </a>
                ))}
              {data.expenses
                .filter((e) => e.deal_id === deal.id)
                .map((e) => (
                  <div className="association-item" key={e.id}>
                    <span>{e.description}</span>
                    <strong>{money(e.amount_minor)}</strong>
                  </div>
                ))}
              <a href="#expenses">
                View expenses
                <ArrowUpRight size={14} />
              </a>
            </>
          ) : null}
        </aside>
      </div>
    </>
  );
}
export function Timeline({ events }: { events: Data["events"] }) {
  return events.length ? (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id}>
          <strong>
            {e.action.replaceAll(".", " · ").replaceAll("-", " ")}
          </strong>
          <time>{new Date(e.created_at).toLocaleString("en-GB")}</time>
          {e.details.text ? (
            <p>{String(e.details.text)}</p>
          ) : e.details.reference ? (
            <p>{String(e.details.reference)}</p>
          ) : null}
        </li>
      ))}
    </ol>
  ) : (
    <p className="muted">New activity will appear here.</p>
  );
}
export function PersonRecord({
  type,
  id,
  data,
  me,
  edit,
  crmEdit,
}: Props & { type: string; id: string }) {
  const contact =
      type === "contact" ? data.contacts.find((c) => c.id === id) : null,
    company =
      type === "company" ? data.companies.find((c) => c.id === id) : null;
  if (!contact && !company)
    return (
      <Empty title="Record unavailable">
        This record may not belong to your organization or role.
      </Empty>
    );
  const links = data.affiliations.filter((a) =>
      contact ? a.contact_id === id : a.company_id === id,
    ),
    deals = data.deals.filter((d) =>
      contact ? d.contact_id === id : d.company_id === id,
    ),
    ids = new Set(deals.map((d) => d.id)),
    quotes = data.quotes.filter((q) => ids.has(q.deal_id)),
    quoteIds = new Set(quotes.map((q) => q.id)),
    invoices = data.invoices.filter(
      (i) =>
        (i.deal_id && ids.has(i.deal_id)) ||
        (company && i.company_id === company.id),
    );
  const invoiceIds = new Set(invoices.map((i) => i.id));
  const paymentIds = new Set(
    data.payments.filter((p) => invoiceIds.has(p.invoice_id)).map((p) => p.id),
  );
  const events: Data["events"] = [
    ...data.events.filter(
      (e) =>
        e.record_id === id ||
        ids.has(e.record_id) ||
        quoteIds.has(e.record_id) ||
        invoiceIds.has(e.record_id) ||
        paymentIds.has(e.record_id) ||
        e.details.contact_id === id ||
        e.details.company_id === id,
    ),
    ...data.quoteEvents
      .filter((e) => quoteIds.has(e.quote_id))
      .map((e) => ({
        id: `${e.quote_id}-${e.kind}-${e.created_at}`,
        actor_id: "",
        record_id: e.quote_id,
        action: `quote.${e.kind.toLowerCase()}`,
        created_at: e.created_at,
        details: { reference: e.reference },
      })),
  ];
  const balances = new Map<string, bigint>();
  for (const i of invoices.filter((i) => i.status === "Issued"))
    balances.set(
      i.currency,
      (balances.get(i.currency) || 0n) + invoiceBalance(i),
    );
  return (
    <>
      <a className="back" href={contact ? "#contacts" : "#companies"}>
        <ArrowLeft size={15} />
        All {contact ? "contacts" : "companies"}
      </a>
      <Heading
        title={
          contact ? `${contact.first_name} ${contact.last_name}` : company!.name
        }
        action={sales(me) ? "Add note" : undefined}
        onAction={() => edit({ kind: "note", id })}
      />
      <ProfileSummary value={(contact || company)?.profile || {}} data={data} />
      <div className="record-layout">
        <aside className="properties" aria-label="Profile properties">
          <h2>Properties</h2>
          {me.user.role !== "viewer" ? (
            <button
              onClick={() => crmEdit(contact ? "contact" : "company", type, id)}
            >
              Edit {contact ? "contact" : "company"}
            </button>
          ) : null}
          <dl>
            {contact ? (
              <>
                <dt>Email</dt>
                <dd>{contact.email || "Not provided"}</dd>
                <dt>Phone</dt>
                <dd>{contact.phone || "Not provided"}</dd>
                <dt>Title</dt>
                <dd>{contact.title || "Not provided"}</dd>
                <dt>Source</dt>
                <dd>{contact.source || "Not provided"}</dd>
                <dt>Lifecycle</dt>
                <dd>{contact.lifecycle}</dd>
                <dt>Notes</dt>
                <dd>{contact.notes || "No notes"}</dd>
                <dt>Additional emails</dt>
                <dd>
                  {contact.additional_emails.map((e) => (
                    <div key={e.value}>
                      {e.label}: {e.value}
                    </div>
                  ))}
                </dd>
                <dt>Additional phones</dt>
                <dd>
                  {contact.additional_phones.map((p, n) => (
                    <div key={n}>
                      {p.label}: {p.value}
                    </div>
                  ))}
                </dd>
                <dt>Address</dt>
                <dd>{contact.address || "Not provided"}</dd>
                <dt>Tags</dt>
                <dd>{contact.tags.join(", ") || "None"}</dd>
                <dt>Default currency</dt>
                <dd>{contact.currency}</dd>
                <dt>Usually serviced by</dt>
                <dd>
                  {data.entities.find((e) => e.id === contact.service_entity_id)
                    ?.name || "Choose for each project"}
                </dd>
                <dt>Marketing consent</dt>
                <dd>
                  {contact.marketing_consent}
                  {contact.consent_date
                    ? ` · ${day(contact.consent_date)}`
                    : ""}
                </dd>
                {contact.social_url ? (
                  <>
                    <dt>Social profile</dt>
                    <dd>
                      <a
                        href={contact.social_url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open profile ↗
                      </a>
                    </dd>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <dt>Website domain</dt>
                <dd>{company!.domain || "Not provided"}</dd>
                <dt>Industry</dt>
                <dd>{company!.industry || "Not provided"}</dd>
                <dt>Usually serviced by</dt>
                <dd>
                  {data.entities.find(
                    (e) => e.id === company!.service_entity_id,
                  )?.name || "Chosen per project"}
                </dd>
                <dt>Tax registration</dt>
                <dd>{company!.tax_id || "Not provided"}</dd>
                <dt>Billing address</dt>
                <dd>{company!.address || "Not provided"}</dd>
                <dt>Trading name</dt>
                <dd>{company!.trading_name || "Not provided"}</dd>
                <dt>Company size</dt>
                <dd>{company!.size || "Not provided"}</dd>
                <dt>Shipping address</dt>
                <dd>{company!.shipping_address || "Not provided"}</dd>
              </>
            )}
          </dl>
        </aside>
        <section className="record-main">
          <h2>Opportunities</h2>
          {deals.length ? (
            <Table headers={["Deal", "Entity", "Stage"]}>
              {deals.map((d) => (
                <tr key={d.id}>
                  <td>
                    <a href={`#deal/${d.id}`}>{d.name}</a>
                  </td>
                  <td>
                    {data.entities.find((e) => e.id === d.entity_id)?.code}
                  </td>
                  <td>
                    <Badge>{d.stage}</Badge>
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="muted">No opportunities linked yet.</p>
          )}
          {quotes.length ? (
            <>
              <h2 className="space-top">Quotes</h2>
              <Table headers={["Quote", "Opportunity", "Amount", "Status"]}>
                {quotes.map((q) => {
                  const relatedDeal = deals.find((d) => d.id === q.deal_id);
                  const history = data.quoteEvents.filter(
                    (e) => e.quote_id === q.id,
                  );
                  const status =
                    relatedDeal?.accepted_quote_id === q.id
                      ? "Accepted"
                      : history.some((e) => e.kind === "Declined")
                        ? "Declined"
                        : history.some((e) => e.kind === "Shared")
                          ? "Sent"
                          : "Draft";
                  return (
                    <tr key={q.id}>
                      <td>
                        <a href={`#quote/${q.id}`}>
                          {q.number || q.option_name}
                        </a>
                        <small>
                          {q.option_name} · v{q.revision}
                        </small>
                      </td>
                      <td>{relatedDeal?.name || "—"}</td>
                      <td className="num">
                        {money(q.total_minor, q.currency)}
                      </td>
                      <td>
                        <Badge>{status}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </Table>
            </>
          ) : null}
          <Suspense fallback={<p>Loading activity…</p>}>
            <CrmPanel
              data={data}
              me={me}
              open={crmEdit}
              type={type}
              id={id}
              events={events}
            />
          </Suspense>
        </section>
        <aside className="associations" aria-label="Profile associations">
          <h3>{contact ? "Company history" : "People"}</h3>
          {links.map((a) => (
            <div className="association-item" key={a.id}>
              <a
                href={
                  contact
                    ? `#company/${a.company_id}`
                    : `#contact/${a.contact_id}`
                }
              >
                {contact
                  ? data.companies.find((c) => c.id === a.company_id)?.name
                  : data.contacts.find((c) => c.id === a.contact_id)
                      ?.first_name}
              </a>
              <span>{a.role}</span>
              <small>
                {day(a.started_on)} to{" "}
                {a.ended_on ? day(a.ended_on) : "present"}
              </small>
              {contact && !a.ended_on && sales(me) ? (
                <button
                  onClick={() => edit({ kind: "end-association", id: a.id })}
                >
                  End association
                </button>
              ) : null}
            </div>
          ))}
          {contact && sales(me) ? (
            <button onClick={() => edit({ kind: "association", id })}>
              Add company
            </button>
          ) : null}
          {company?.vendor && finance(me) ? (
            <>
              <h3 className="space-top">Vendor bills</h3>
              {(data.bills || [])
                .filter((b) => b.vendor_id === company.id)
                .map((b) => (
                  <a
                    className="association-item"
                    key={b.id}
                    href={`#bill/${b.id}`}
                  >
                    <strong>{b.reference}</strong>
                    <span>
                      {data.entities.find((e) => e.id === b.entity_id)?.code} ·{" "}
                      {money(b.total_minor, b.currency)}
                    </span>
                    <Badge>{b.status}</Badge>
                  </a>
                ))}
            </>
          ) : null}
          <h3 className="space-top">Outstanding invoices</h3>
          {balances.size ? (
            [...balances].map(([currency, n]) => (
              <p className="num" key={currency}>
                {money(n, currency)}
              </p>
            ))
          ) : (
            <p>No open balance</p>
          )}
          {invoices.map((i) => (
            <a
              className="association-item"
              href={`#invoice/${i.id}`}
              key={i.id}
            >
              {i.number || "Draft"}
              <Badge>{i.status}</Badge>
            </a>
          ))}
        </aside>
      </div>
    </>
  );
}
function InvoiceEmailPanel({
  invoice,
  data,
}: {
  invoice: Invoice;
  data: Data;
}) {
  const [contactId, setContactId] = useState("");
  const [subject, setSubject] = useState(
    `${invoice.issuer_name} invoice ${invoice.number || "draft"}`,
  );
  const [message, setMessage] = useState(
    `Hello,\n\nPlease find invoice ${invoice.number || ""} for ${money(invoice.total_minor, invoice.currency)} attached. The due date is ${day(invoice.due_date)}.\n\n${invoice.details?.payment_instructions || "Please use the payment instructions on the invoice."}\n\nKind regards,\n${invoice.issuer_name}`,
  );
  const contacts = data.affiliations
    .filter((a) => a.company_id === invoice.company_id && !a.ended_on)
    .map((a) => {
      const contact = data.contacts.find((c) => c.id === a.contact_id);
      return contact && (a.work_email || contact.email)
        ? {
            id: contact.id,
            name: `${contact.first_name} ${contact.last_name}`.trim(),
            email: a.work_email || contact.email,
          }
        : null;
    })
    .filter((c): c is { id: string; name: string; email: string } => !!c);
  const recipient = contacts.find((c) => c.id === contactId)?.email || "";
  return (
    <section
      id="invoice-email-panel"
      className="quote-share-panel"
      aria-label="Invoice email preparation"
    >
      <h2>Prepare invoice email</h2>
      <p className="muted">
        Review the recipient and message, save the invoice as a PDF, then attach
        it in your email app. Opening the draft does not send or mark the
        invoice as sent.
      </p>
      <label htmlFor="invoice-email-contact">Customer contact</label>
      <select
        id="invoice-email-contact"
        value={contactId}
        onChange={(e) => setContactId(e.target.value)}
      >
        <option value="">Select a contact with an email</option>
        {contacts.map((contact) => (
          <option key={contact.id} value={contact.id}>
            {contact.name} · {contact.email}
          </option>
        ))}
      </select>
      {!contacts.length ? (
        <p className="muted">
          Add an email address to an active contact at {invoice.customer_name}{" "}
          first.
        </p>
      ) : null}
      <label htmlFor="invoice-email-subject">Email subject</label>
      <input
        id="invoice-email-subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <label htmlFor="invoice-email-message">Email message</label>
      <textarea
        id="invoice-email-message"
        rows={7}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="actions">
        <button type="button" onClick={() => window.print()}>
          Print / Save PDF
        </button>
        {recipient ? (
          <a
            className="button primary"
            href={`mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`}
          >
            Open reviewed email draft
          </a>
        ) : (
          <span className="muted">
            Choose a customer contact to prepare the email.
          </span>
        )}
      </div>
      <p className="muted">
        After you send the PDF, use “Mark as sent” and record the message
        reference. Payments and the ledger update when a payment is recorded—not
        when this draft opens.
      </p>
    </section>
  );
}

export function DocumentRecord({
  type,
  id,
  data,
  me,
  edit,
}: Props & { type: string; id: string }) {
  const cache = useQueryClient();
  const [quoteTab, setQuoteTab] = useState<"details" | "activity">("details");
  const [quotePreview, setQuotePreview] = useState<"details" | "pdf">(
    "details",
  );
  const [shareOpen, setShareOpen] = useState(false);
  const [invoiceEmailOpen, setInvoiceEmailOpen] = useState(false);
  const [shareContactId, setShareContactId] = useState("");
  const [shareLink, setShareLink] = useState("");
  const [shareRecipient, setShareRecipient] = useState("");
  const [shareSubject, setShareSubject] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setShareOpen(false);
    setInvoiceEmailOpen(false);
    setShareContactId("");
    setShareLink("");
    setShareError("");
  }, [id]);
  const invoice =
      type === "invoice" ? data.invoices.find((i) => i.id === id) : undefined,
    quote = type === "quote" ? data.quotes.find((q) => q.id === id) : undefined,
    doc = invoice || quote;
  if (!doc)
    return (
      <Empty title="Document unavailable">
        Return to the document list and select a record you can access.
      </Empty>
    );
  const deal = data.deals.find((d) => d.id === doc.deal_id),
    entity = data.entities.find((e) => e.id === doc.entity_id);
  const quoteEvents = quote
    ? data.quoteEvents.filter((e) => e.quote_id === id)
    : [];
  const quoteStatus =
    deal?.accepted_quote_id === id
      ? "Accepted"
      : quoteEvents.some((e) => e.kind === "Declined")
        ? "Declined"
        : quoteEvents.some((e) => e.kind === "Shared")
          ? "Sent"
          : "Draft";
  const quoteSent = quoteEvents.some((e) => e.kind === "Shared");
  const canChangeQuote =
    !!quote && sales(me) && !["Won", "Lost"].includes(deal?.stage || "");
  const canMarkQuoteSent =
    !!quote &&
    sales(me) &&
    !quoteSent &&
    (!deal ||
      !["Won", "Lost"].includes(deal.stage) ||
      deal.accepted_quote_id === id);
  const shareContacts =
    quote && deal
      ? data.affiliations
          .filter((a) => a.company_id === deal.company_id && !a.ended_on)
          .map((a) => {
            const contact = data.contacts.find((c) => c.id === a.contact_id);
            return contact && (a.work_email || contact.email)
              ? {
                  id: contact.id,
                  name: `${contact.first_name} ${contact.last_name}`.trim(),
                  email: a.work_email || contact.email,
                }
              : null;
          })
          .filter((c): c is { id: string; name: string; email: string } => !!c)
      : [];
  async function prepareCustomerLink() {
    if (!quote || !shareContactId) return;
    setShareBusy(true);
    setShareError("");
    try {
      const result = await request<{
        url: string;
        recipient: string;
        expiresAt: string;
      }>(
        "quote-links",
        "POST",
        { quoteId: quote.id, contactId: shareContactId },
        me.csrf,
      );
      setShareLink(result.url);
      setShareRecipient(result.recipient);
      setShareSubject(
        `${quote.issuer_name} quote ${quote.number || quote.option_name} — ${deal?.name || "Project"}`,
      );
      setShareMessage(
        `Hello,\n\nPlease review the ${quote.option_name} quote for ${deal?.name || "your project"}. You can view the details and accept or decline this exact version using the private link below:\n\n${result.url}\n\nKind regards,\n${quote.issuer_name}`,
      );
      setCopied(false);
      await cache.invalidateQueries({ queryKey: ["data"] });
    } catch (error) {
      setShareError((error as Error).message);
    } finally {
      setShareBusy(false);
    }
  }
  const action = invoice
    ? invoice.status === "Draft"
      ? "Issue invoice"
      : invoice.status === "Issued"
        ? "Record payment"
        : undefined
    : undefined;
  const printQuote = () => {
    setQuoteTab("details");
    setQuotePreview("pdf");
    window.setTimeout(() => window.print(), 0);
  };
  return (
    <>
      <a className="back" href={invoice ? "#invoices" : "#quotes"}>
        <ArrowLeft size={15} />
        All {invoice ? "invoices" : "quotes"}
      </a>
      <Heading
        title={
          invoice
            ? invoice.number || "Invoice draft"
            : quote!.number || `${quote!.option_name} · v${quote!.revision}`
        }
        subtitle={
          quote
            ? `${quote.customer_name} · ${deal?.name || "Project"} · ${quote.option_name} (version ${quote.revision})`
            : undefined
        }
        action={finance(me) ? action : undefined}
        onAction={() =>
          edit({ kind: invoice?.status === "Draft" ? "issue" : "payment", id })
        }
      />
      {invoice ? (
        <div className="quote-action-bar" aria-label="Invoice actions">
          <Badge>{invoice.status}</Badge>
          <Badge>
            {data.invoiceDeliveryEvents.some((e) => e.invoice_id === invoice.id)
              ? "Sent"
              : "Not sent"}
          </Badge>
          {finance(me) &&
          ["Issued", "Paid", "Settled"].includes(invoice.status) &&
          !data.invoiceDeliveryEvents.some(
            (e) => e.invoice_id === invoice.id,
          ) ? (
            <button onClick={() => edit({ kind: "invoice-mark-sent", id })}>
              Mark as sent
            </button>
          ) : null}
          {finance(me) &&
          ["Issued", "Paid", "Settled"].includes(invoice.status) ? (
            <button
              aria-expanded={invoiceEmailOpen}
              aria-controls="invoice-email-panel"
              onClick={() => setInvoiceEmailOpen((open) => !open)}
            >
              Prepare invoice email
            </button>
          ) : null}
          <button onClick={() => window.print()}>PDF / Print</button>
        </div>
      ) : null}
      {invoice && invoiceEmailOpen ? (
        <InvoiceEmailPanel invoice={invoice} data={data} />
      ) : null}
      {quote ? (
        <>
          <div className="quote-action-bar" aria-label="Quote actions">
            <Badge>{quoteStatus}</Badge>
            {quoteStatus === "Accepted" ? (
              <Badge>{quoteSent ? "Sent" : "Not sent"}</Badge>
            ) : null}
            {canChangeQuote ? (
              <button onClick={() => edit({ kind: "quote", id })}>
                Create revision
              </button>
            ) : null}
            {canMarkQuoteSent ? (
              <button onClick={() => edit({ kind: "share", id })}>
                Mark as sent
              </button>
            ) : null}
            {canChangeQuote && quoteStatus !== "Declined" ? (
              <button
                aria-expanded={shareOpen}
                aria-controls="quote-share-panel"
                onClick={() => setShareOpen((open) => !open)}
              >
                Prepare customer link
              </button>
            ) : null}
            {canChangeQuote ? (
              <button
                className="primary"
                onClick={() => edit({ kind: "accept", id })}
              >
                Accept this version
              </button>
            ) : null}
            {finance(me) &&
            deal?.accepted_quote_id === id &&
            data.invoices
              .filter(
                (i) =>
                  i.quote_id === id &&
                  !["Voided", "Cancelled"].includes(i.status),
              )
              .reduce((sum, i) => sum + BigInt(i.net_minor), 0n) +
              BigInt(
                data.projects.find((p) => p.quote_id === id)?.planned_net ||
                  "0",
              ) <
              BigInt(quote.net_minor) ? (
              <button onClick={() => edit({ kind: "invoice", id })}>
                Convert to invoice
              </button>
            ) : null}
            <button onClick={printQuote}>PDF / Print</button>
          </div>
          {shareOpen && canChangeQuote ? (
            <section
              id="quote-share-panel"
              className="quote-share-panel"
              aria-label="Customer quote link"
            >
              <div className="quote-section-heading">
                <div>
                  <h2>Share this exact quote version</h2>
                  <p className="muted">
                    Choose a current contact at {quote.customer_name}. Creating
                    a link does not email the customer or mark the quote as
                    sent.
                  </p>
                </div>
              </div>
              {shareError ? <ErrorBox error={shareError} /> : null}
              <label htmlFor="quote-share-contact">Customer contact</label>
              <select
                id="quote-share-contact"
                value={shareContactId}
                onChange={(e) => {
                  setShareContactId(e.target.value);
                  setShareLink("");
                }}
              >
                <option value="">Select a contact with an email</option>
                {shareContacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name} · {contact.email}
                  </option>
                ))}
              </select>
              {!shareContacts.length ? (
                <p className="muted">
                  Add an email address to an active company contact before
                  sharing.
                </p>
              ) : null}
              <button
                type="button"
                className="primary"
                disabled={!shareContactId || shareBusy}
                onClick={prepareCustomerLink}
              >
                {shareBusy
                  ? "Preparing…"
                  : shareLink
                    ? "Replace link"
                    : "Create private link"}
              </button>
              {shareLink ? (
                <div className="quote-share-ready">
                  <p>
                    <strong>Private link ready.</strong> It expires in 30 days
                    or on the quote expiry date, whichever comes first.
                    Replacing it revokes the previous link for this contact.
                  </p>
                  <label htmlFor="quote-share-url">Customer link</label>
                  <input
                    id="quote-share-url"
                    value={shareLink}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                  <a href={shareLink} target="_blank" rel="noopener noreferrer">
                    Preview customer view ↗
                  </a>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(shareLink);
                        setCopied(true);
                      } catch {
                        setShareError(
                          "Copy was blocked. Select the link above and copy it manually.",
                        );
                      }
                    }}
                  >
                    {copied ? "Copied" : "Copy link"}
                  </button>
                  {copied ? (
                    <span role="status">Link copied to clipboard</span>
                  ) : null}
                  <label htmlFor="quote-share-subject">Email subject</label>
                  <input
                    id="quote-share-subject"
                    value={shareSubject}
                    onChange={(e) => setShareSubject(e.target.value)}
                  />
                  <label htmlFor="quote-share-message">Email message</label>
                  <textarea
                    id="quote-share-message"
                    rows={7}
                    value={shareMessage}
                    onChange={(e) => setShareMessage(e.target.value)}
                  />
                  <a
                    className="button primary"
                    href={`mailto:${encodeURIComponent(shareRecipient)}?subject=${encodeURIComponent(shareSubject)}&body=${encodeURIComponent(shareMessage)}`}
                  >
                    Open reviewed email draft
                  </a>
                  <p className="muted">
                    Your email app handles sending. The link is in the message;
                    no PDF is attached automatically. After sending, use “Mark
                    as sent” and record the message reference.
                  </p>
                </div>
              ) : null}
            </section>
          ) : null}
          {quoteStatus === "Draft" && canChangeQuote ? (
            <p className="quote-next-step">
              {shareLink
                ? "Next step: send the reviewed email, then record delivery using “Mark as sent”."
                : "Next step: create a private customer link, review the email draft, then record delivery using “Mark as sent”."}
            </p>
          ) : null}
          <div
            className="quote-detail-tabs"
            role="tablist"
            aria-label="Quote information"
          >
            <button
              role="tab"
              aria-selected={quoteTab === "details"}
              onClick={() => setQuoteTab("details")}
            >
              Quote details
            </button>
            <button
              role="tab"
              aria-selected={quoteTab === "activity"}
              onClick={() => setQuoteTab("activity")}
            >
              Activity
            </button>
          </div>
        </>
      ) : null}
      {quote && quoteTab === "activity" ? (
        <section className="quote-activity" role="tabpanel">
          <h2>Quote activity</h2>
          {quoteEvents.length ||
          data.events.some(
            (e) => e.record_id === id && e.action === "quote.link-created",
          ) ? (
            <ol>
              {data.events
                .filter(
                  (e) =>
                    e.record_id === id && e.action === "quote.link-created",
                )
                .map((e) => (
                  <li key={e.id}>
                    <Badge>Link prepared</Badge>
                    <strong>
                      For{" "}
                      {String(e.details.recipient_email || "customer contact")}{" "}
                      · not sent
                    </strong>
                    <small>{day(e.created_at)}</small>
                  </li>
                ))}
              {quoteEvents.map((e, i) => (
                <li key={i}>
                  <Badge>{e.kind}</Badge>
                  <strong>{e.reference}</strong>
                  {e.created_at ? <small>{day(e.created_at)}</small> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p>No sharing or acceptance recorded yet.</p>
          )}
        </section>
      ) : quote && quotePreview === "details" ? (
        <section className="quote-summary-card" role="tabpanel">
          <div className="quote-summary-card-head">
            <h2>Quote details</h2>
            <div
              className="quote-preview-switch"
              role="group"
              aria-label="Quote view"
            >
              <button className="active" aria-pressed="true">
                Details
              </button>
              <button
                aria-pressed="false"
                onClick={() => setQuotePreview("pdf")}
              >
                PDF preview
              </button>
            </div>
          </div>
          <div className="quote-summary-title">
            <div>
              <h3>
                {quote.number || `${quote.option_name} · v${quote.revision}`}
              </h3>
              <Badge>{quoteStatus}</Badge>
            </div>
            <strong>{money(quote.total_minor, quote.currency)}</strong>
          </div>
          <dl className="quote-summary-grid">
            <div>
              <dt>Quote number</dt>
              <dd>{quote.number || "Unnumbered legacy quote"}</dd>
            </div>
            <div>
              <dt>Quote date</dt>
              <dd>{day(quote.details?.quote_date || quote.created_at)}</dd>
            </div>
            <div>
              <dt>Expiry date</dt>
              <dd>
                {quote.details?.valid_until
                  ? day(quote.details.valid_until)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Reference number</dt>
              <dd>{quote.details?.reference || "—"}</dd>
            </div>
            <div>
              <dt>Issuing entity</dt>
              <dd>{entity?.name || quote.issuer_name}</dd>
            </div>
            <div>
              <dt>PDF template</dt>
              <dd>{quote.details?.template || "Standard"}</dd>
            </div>
            <div>
              <dt>Named option</dt>
              <dd>
                {quote.option_name} · version {quote.revision}
              </dd>
            </div>
            <div>
              <dt>Subject</dt>
              <dd>{quote.details?.subject || "—"}</dd>
            </div>
          </dl>
          <div className="quote-summary-people">
            <div>
              <h3>Customer details</h3>
              <strong>{quote.customer_name}</strong>
              {quote.details?.billing_address ? (
                <p className="preserve">{quote.details.billing_address}</p>
              ) : null}
            </div>
            <div>
              <h3>Related opportunity</h3>
              {deal ? (
                <a href={`#deal/${deal.id}`}>{deal.name}</a>
              ) : (
                <span>—</span>
              )}
            </div>
          </div>
          <h3>
            Items <span className="quote-item-count">{quote.lines.length}</span>
          </h3>
          <Table headers={["Item", "Qty", "Rate", "Tax", "Amount"]}>
            {quote.lines.map((line, index) => (
              <tr key={index}>
                <td className="preserve">{line.description}</td>
                <td>{line.quantity}</td>
                <td>
                  {quote.currency} {line.price}
                </td>
                <td>{line.tax}%</td>
                <td className="num">
                  {money(
                    BigInt(line.subtotal || "0") + BigInt(line.taxMinor || "0"),
                    quote.currency,
                  )}
                </td>
              </tr>
            ))}
          </Table>
          <dl className="quote-summary-totals">
            <dt>Subtotal</dt>
            <dd>{money(quote.net_minor, quote.currency)}</dd>
            <dt>Tax</dt>
            <dd>{money(quote.tax_minor, quote.currency)}</dd>
            <dt>Total</dt>
            <dd>
              <strong>{money(quote.total_minor, quote.currency)}</strong>
            </dd>
          </dl>
          {quote.details?.customer_notes ? (
            <div className="quote-summary-note">
              <h3>Customer notes</h3>
              <p className="preserve">{quote.details.customer_notes}</p>
            </div>
          ) : null}
          {quote.terms ? (
            <div className="quote-summary-note">
              <h3>Terms & conditions</h3>
              <p className="preserve">{quote.terms}</p>
            </div>
          ) : null}
          {quote.details?.references?.length ? (
            <div className="quote-summary-note">
              <h3>Supporting documents</h3>
              {quote.details.references.map((reference, index) => (
                <p key={index}>
                  <a href={reference.url} target="_blank" rel="noreferrer">
                    {reference.name} ↗
                  </a>
                </p>
              ))}
            </div>
          ) : null}
        </section>
      ) : (
        <div className="document-layout">
          {quote ? (
            <div className="quote-pdf-header">
              <div
                className="quote-preview-switch"
                role="group"
                aria-label="Quote view"
              >
                <button
                  aria-pressed="false"
                  onClick={() => setQuotePreview("details")}
                >
                  Details
                </button>
                <button className="active" aria-pressed="true">
                  PDF preview
                </button>
              </div>
              <p>
                Print this preview or choose Save as PDF in the print dialog. No
                email is sent.
              </p>
            </div>
          ) : null}
          <article
            className={`document ${doc.details?.template === "Compact" ? "compact-document" : ""}`}
          >
            <div className="document-masthead">
              <div>
                <p className="eyebrow">{invoice ? "INVOICE" : "QUOTE"}</p>
                <h2>{doc.issuer_name}</h2>
                <p className="document-number">
                  {invoice
                    ? invoice.number || "Invoice draft"
                    : quote?.number ||
                      `${quote?.option_name} · v${quote?.revision}`}
                </p>
                <p>{doc.issuer_address}</p>
                {doc.issuer_tax_id ? <p>Tax ID: {doc.issuer_tax_id}</p> : null}
              </div>
              <Badge>{invoice?.status || quoteStatus}</Badge>
            </div>
            <div className="document-parties">
              <div>
                <small>Bill to</small>
                <h3>{doc.customer_name}</h3>
                {deal ? (
                  <a href={`#deal/${deal.id}`}>{deal.name}</a>
                ) : (
                  <span>Direct customer invoice</span>
                )}
              </div>
              {invoice ? (
                <dl>
                  <dt>Billing stage</dt>
                  <dd>{invoice.label}</dd>
                  <dt>Revenue treatment</dt>
                  <dd>
                    {invoice.billing_kind === "advance"
                      ? "Advance / deferred revenue"
                      : "Delivered work"}
                  </dd>
                  <dt>Invoice date</dt>
                  <dd>{day(invoice.issue_date)}</dd>
                  <dt>Due date</dt>
                  <dd>{day(invoice.due_date)}</dd>
                </dl>
              ) : (
                <p>
                  Option: {quote?.option_name}
                  <br />
                  Version {quote?.revision}
                </p>
              )}
            </div>
            <Table
              headers={[
                "Description",
                "Quantity",
                "Unit price",
                "Discount",
                "Tax %",
                "Total",
              ]}
            >
              {doc.lines.map((l, i) => (
                <tr key={i}>
                  <td className="preserve">
                    {l.section ? <small>{l.section}</small> : null}
                    {l.description}
                  </td>
                  <td>
                    {l.quantity} {l.unit}
                  </td>
                  <td>
                    {doc.currency} {l.price}
                  </td>
                  <td>{money(l.discountMinor || "0", doc.currency)}</td>
                  <td>{l.tax}%</td>
                  <td className="num">
                    {money(
                      BigInt(l.subtotal || "0") + BigInt(l.taxMinor || "0"),
                      doc.currency,
                    )}
                  </td>
                </tr>
              ))}
            </Table>
            <dl className="totals">
              <dt>Subtotal</dt>
              <dd>{money(doc.net_minor, doc.currency)}</dd>
              <dt>Tax</dt>
              <dd>{money(doc.tax_minor, doc.currency)}</dd>
              <dt>Total</dt>
              <dd>
                <strong>{money(doc.total_minor, doc.currency)}</strong>
              </dd>
              {invoice ? (
                <>
                  <dt>Settled (cash + withholding)</dt>
                  <dd>{money(invoice.paid_minor, invoice.currency)}</dd>
                  <dt>Credit applied</dt>
                  <dd>{money(invoice.credited_minor, invoice.currency)}</dd>
                  <dt>Balance</dt>
                  <dd>{money(invoiceBalance(invoice), invoice.currency)}</dd>
                </>
              ) : null}
            </dl>
            <DocumentExtras details={doc.details || {}} />
            {doc.terms ? (
              <>
                <h3>Terms</h3>
                <p className="preserve">{doc.terms}</p>
              </>
            ) : null}
            <p className="muted small">
              {invoice?.quote_id
                ? "Partial billing allocates tax from the accepted quote, including any final rounding remainder. "
                : ""}
              Sample build. Not a tax-compliance-certified document. No email is
              sent from this preview.
            </p>
          </article>
          <aside
            className="document-context"
            aria-label="Document actions and history"
          >
            {invoice && finance(me) ? (
              <div className="vertical-actions">
                {["Issued", "Paid", "Settled"].includes(invoice.status) ? (
                  <a href={`#credits/${invoice.id}`}>Create credit note</a>
                ) : null}
                {data.credits
                  .filter((c) => c.invoice_id === id)
                  .map((c) => (
                    <a key={c.id} href={`#credit/${c.id}`}>
                      {c.number} · {money(c.total_minor, c.currency)}
                      {c.reversal_date ? " · Reversed" : ""}
                    </a>
                  ))}
                {invoice.status === "Draft" ? (
                  <button onClick={() => edit({ kind: "edit-invoice", id })}>
                    Edit draft details
                  </button>
                ) : null}
                {invoice.status === "Draft" ? (
                  <button onClick={() => edit({ kind: "cancel-invoice", id })}>
                    Cancel draft
                  </button>
                ) : null}
                {invoice.billing_kind === "advance" &&
                ["Issued", "Paid", "Settled"].includes(invoice.status) ? (
                  <>
                    <h3>Revenue recognition</h3>
                    <p>
                      Deferred subtotal:{" "}
                      {money(
                        BigInt(invoice.net_minor) -
                          data.recognitions
                            .filter((r) => r.invoice_id === id)
                            .reduce((s, r) => s + BigInt(r.net_minor), 0n) -
                          data.credits
                            .filter(
                              (c) =>
                                c.invoice_id === id &&
                                c.treatment === "deferred" &&
                                !c.reversal_date,
                            )
                            .reduce((s, c) => s + BigInt(c.net_minor), 0n),
                        invoice.currency,
                      )}
                    </p>
                    <button onClick={() => edit({ kind: "recognise", id })}>
                      Recognise delivered work
                    </button>
                    {data.recognitions
                      .filter((r) => r.invoice_id === id)
                      .map((r) => (
                        <p key={r.id}>
                          {day(r.recognition_date)} ·{" "}
                          {money(r.net_minor, invoice.currency)}
                          <small>{r.reference}</small>
                        </p>
                      ))}
                  </>
                ) : null}
              </div>
            ) : null}
            <h3>Linked records</h3>
            {deal ? (
              <a href={`#deal/${deal.id}`}>{deal.name}</a>
            ) : invoice ? (
              <a href={`#company/${invoice.company_id}`}>
                {invoice.customer_name}
              </a>
            ) : null}
            <p>{entity?.code} · base PKR</p>
            {invoice ? (
              <>
                <h3 className="space-top">Delivery</h3>
                {data.invoiceDeliveryEvents.filter((e) => e.invoice_id === id)
                  .length ? (
                  data.invoiceDeliveryEvents
                    .filter((e) => e.invoice_id === id)
                    .map((e, i) => (
                      <div className="association-item" key={i}>
                        <Badge>Sent</Badge>
                        <span>{e.reference}</span>
                        <small>{day(e.created_at)}</small>
                      </div>
                    ))
                ) : (
                  <p className="muted">
                    Not marked as sent. Issuing an invoice does not send email.
                  </p>
                )}
                <h3 className="space-top">Payments</h3>
                {data.payments
                  .filter((p) => p.invoice_id === id)
                  .map((p) => (
                    <div className="association-item" key={p.id}>
                      <strong>{money(p.amount_minor, invoice.currency)}</strong>
                      <span>{p.reference}</span>
                      <small>{day(p.payment_date)}</small>
                    </div>
                  ))}
                {invoice.status === "Issued" &&
                invoice.paid_minor === "0" &&
                invoice.credited_minor === "0" &&
                finance(me) ? (
                  <button onClick={() => edit({ kind: "void", id })}>
                    Void unpaid invoice
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <h3 className="space-top">Sharing and acceptance</h3>
                {data.quoteEvents
                  .filter((e) => e.quote_id === id)
                  .map((e, i) => (
                    <p key={i}>
                      <Badge>{e.kind === "Shared" ? "Sent" : e.kind}</Badge>
                      <br />
                      {e.reference}
                    </p>
                  ))}
                <p className="small muted">
                  Creating a customer link does not send email. Delivery is
                  recorded only when you mark the quote as sent with evidence.
                </p>
              </>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
export function Ledger({ report, mode }: { report: Report; mode: string }) {
  if (mode === "journals")
    return report.journals.length ? (
      <div className="journals">
        {report.journals.map((j) => (
          <section key={j.id}>
            <div className="section-title">
              <h3>{j.description}</h3>
              <span>{day(j.posted_on)}</span>
            </div>
            <Table headers={["Account", "Debit", "Credit"]}>
              {j.lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    {l.account} ·{" "}
                    {report.trial.find((a) => a.code === l.account)?.name}
                  </td>
                  <td className="num">{money(l.debit)}</td>
                  <td className="num">{money(l.credit)}</td>
                </tr>
              ))}
            </Table>
          </section>
        ))}
      </div>
    ) : (
      <Empty title="No postings in this period">
        Issuing an invoice, recording a payment or posting an expense creates
        balanced journal entries here.
      </Empty>
    );
  const debit = report.trial.reduce((n, r) => n + BigInt(r.debit), 0n),
    credit = report.trial.reduce((n, r) => n + BigInt(r.credit), 0n);
  return (
    <>
      <Table headers={["Account", "Type", "Debit", "Credit", "Balance"]}>
        {report.trial.map((r) => (
          <tr key={r.code}>
            <td>
              <strong>
                {r.code} · {r.name}
              </strong>
            </td>
            <td>{r.type}</td>
            <td className="num">{money(r.debit)}</td>
            <td className="num">{money(r.credit)}</td>
            <td className="num">{money(BigInt(r.debit) - BigInt(r.credit))}</td>
          </tr>
        ))}
        <tr className="table-total">
          <td>Total</td>
          <td>{debit === credit ? "Balanced" : "Out of balance"}</td>
          <td className="num">{money(debit)}</td>
          <td className="num">{money(credit)}</td>
          <td className="num">{money(debit - credit)}</td>
        </tr>
      </Table>
      <p className="muted">
        Period movements in PKR. Debit balances are positive; credit balances
        are negative. This is not yet a statutory financial statement.
      </p>
    </>
  );
}
