import type { Data, Deal, Editor, Invoice, Me, Report } from "./model";
import { day, money } from "./model";
import { Badge, Empty, Heading, Table } from "./components";
import { ArrowLeft, ArrowUpRight, Plus } from "lucide-react";
type Props = {
  data: Data;
  me: Me;
  edit: (e: Editor) => void;
  run: (c: Record<string, unknown>) => Promise<void>;
};
const finance = (me: Me) => ["admin", "finance"].includes(me.user.role),
  sales = (me: Me) => ["admin", "sales"].includes(me.user.role);
export function DealRecord({ deal, data, me, edit }: Props & { deal: Deal }) {
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
      </div>
      <div className="record-layout">
        <aside className="properties">
          <h3>Deal details</h3>
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
                        {accepted ? "Accepted" : shared ? "Shared" : "Draft"}
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
                              Mark shared
                            </button>
                            <button
                              onClick={() => edit({ kind: "accept", id: q.id })}
                            >
                              Accept
                            </button>
                          </>
                        ) : null}
                        {accepted && !invoices.length && finance(me) ? (
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
          <div className="section-title space-top">
            <h2>Activity</h2>
            {sales(me) ? (
              <button onClick={() => edit({ kind: "note", id: deal.id })}>
                <Plus size={15} />
                Add note
              </button>
            ) : null}
          </div>
          <Timeline events={events} />
        </section>
        <aside className="associations">
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
    invoices = data.invoices.filter((i) => ids.has(i.deal_id));
  const events = data.events.filter(
    (e) =>
      e.record_id === id ||
      ids.has(e.record_id) ||
      invoices.some((i) => i.id === e.record_id) ||
      e.details.contact_id === id ||
      e.details.company_id === id,
  );
  const balances = new Map<string, bigint>();
  for (const i of invoices.filter((i) => i.status === "Issued"))
    balances.set(
      i.currency,
      (balances.get(i.currency) || 0n) +
        BigInt(i.total_minor) -
        BigInt(i.paid_minor),
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
      <div className="record-layout">
        <aside className="properties">
          <h3>Properties</h3>
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
              </>
            )}
          </dl>
        </aside>
        <section className="record-main">
          <h2>Projects and deals</h2>
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
            <p className="muted">No projects linked yet.</p>
          )}
          <h2 className="space-top">Activity</h2>
          <Timeline events={events} />
        </section>
        <aside className="associations">
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
export function DocumentRecord({
  type,
  id,
  data,
  me,
  edit,
}: Props & { type: string; id: string }) {
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
  const action = invoice
    ? invoice.status === "Draft"
      ? "Issue invoice"
      : invoice.status === "Issued"
        ? "Record payment"
        : undefined
    : undefined;
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
            : `${quote!.option_name} · v${quote!.revision}`
        }
        action={finance(me) ? action : undefined}
        onAction={() =>
          edit({ kind: invoice?.status === "Draft" ? "issue" : "payment", id })
        }
      />
      <div className="document-layout">
        <article className="document">
          <div className="document-masthead">
            <div>
              <p className="eyebrow">{invoice ? "INVOICE" : "QUOTE"}</p>
              <h2>{doc.issuer_name}</h2>
              <p>{invoice?.issuer_address || entity?.address}</p>
              {invoice?.issuer_tax_id || entity?.tax_id ? (
                <p>Tax ID: {invoice?.issuer_tax_id || entity?.tax_id}</p>
              ) : null}
            </div>
            <Badge>
              {invoice?.status ||
                (deal?.accepted_quote_id === id ? "Accepted" : "Quote version")}
            </Badge>
          </div>
          <div className="document-parties">
            <div>
              <small>Bill to</small>
              <h3>{doc.customer_name}</h3>
              <a href={`#deal/${doc.deal_id}`}>{deal?.name}</a>
            </div>
            {invoice ? (
              <dl>
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
              "Tax %",
              "Total",
            ]}
          >
            {doc.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.description}</td>
                <td>{l.quantity}</td>
                <td>
                  {doc.currency} {l.price}
                </td>
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
                <dt>Balance</dt>
                <dd>
                  {money(
                    invoice.status === "Voided"
                      ? 0n
                      : BigInt(invoice.total_minor) -
                          BigInt(invoice.paid_minor),
                    invoice.currency,
                  )}
                </dd>
              </>
            ) : null}
          </dl>
          {doc.terms ? (
            <>
              <h3>Terms</h3>
              <p className="preserve">{doc.terms}</p>
            </>
          ) : null}
          <p className="muted small">
            Sample build. Not a tax-compliance-certified document. No email is
            sent from this preview.
          </p>
        </article>
        <aside className="document-context">
          <h3>Linked records</h3>
          <a href={`#deal/${doc.deal_id}`}>{deal?.name}</a>
          <p>{entity?.code} · base PKR</p>
          {invoice ? (
            <>
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
                    <Badge>{e.kind}</Badge>
                    <br />
                    {e.reference}
                  </p>
                ))}
              {sales(me) && !["Won", "Lost"].includes(deal?.stage || "") ? (
                <div className="vertical-actions">
                  <button onClick={() => edit({ kind: "quote", id })}>
                    Create revision
                  </button>
                  <button onClick={() => edit({ kind: "share", id })}>
                    Mark shared
                  </button>
                  <button
                    className="primary"
                    onClick={() => edit({ kind: "accept", id })}
                  >
                    Accept this version
                  </button>
                </div>
              ) : null}
              {finance(me) &&
              deal?.accepted_quote_id === id &&
              !data.invoices.some((i) => i.deal_id === doc.deal_id) ? (
                <button
                  className="primary"
                  onClick={() => edit({ kind: "invoice", id })}
                >
                  Create invoice
                </button>
              ) : null}
            </>
          )}
        </aside>
      </div>
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
