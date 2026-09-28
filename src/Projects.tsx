import { useState, type FormEvent } from "react";
import {
  Heading,
  Table,
  Empty,
  Badge,
  Drawer,
  Field,
  ErrorBox,
} from "./components";
import { money, decimal, day, today, type Data, type Editor } from "./model";
import { baseAmount } from "../shared/money";
type Props = {
  data: Data;
  entity: string;
  id?: string;
  initialQuote?: string;
  edit: (e: Editor) => void;
  run: (c: Record<string, unknown>) => Promise<void>;
};
export function Projects({ data, entity, id, initialQuote, edit, run }: Props) {
  const project = data.projects.find(
    (p) => p.id === id && (entity === "all" || p.entity_id === entity),
  );
  const [form, setForm] = useState(initialQuote ? "create" : ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false),
    [quoteId, setQuoteId] = useState(initialQuote || "");
  const quote = data.quotes.find((q) => q.id === quoteId);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const eligible = data.quotes.filter(
    (q) =>
      (entity === "all" || q.entity_id === entity) &&
      data.deals.some((d) => d.accepted_quote_id === q.id) &&
      !data.projects.some((p) => p.deal_id === q.deal_id) &&
      !data.recurringProfiles.some(
        (p) => p.kind === "invoice" && p.deal_id === q.deal_id,
      ),
  );
  const open = (kind: string) => {
    setError("");
    setDirty(false);
    setForm(kind);
    setRequestKey(crypto.randomUUID());
  };
  const close = () => {
    if (!busy && (!dirty || confirm("Discard unsaved changes?"))) setForm("");
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const f = Object.fromEntries(new FormData(event.currentTarget)) as Record<
      string,
      string
    >;
    try {
      if (form === "create")
        await run({
          action: "project.create",
          ...f,
          quote_id: quoteId,
          end_date: f.end_date || null,
        });
      else if (form === "edit")
        await run({
          action: "project.update",
          ...f,
          id: project!.id,
          version: project!.version,
          end_date: f.end_date || null,
        });
      else if (form === "milestone")
        await run({
          action: "project.milestone",
          request_key: requestKey,
          ...f,
          project_id: project!.id,
        });
      else
        await run({
          action: "project.cancel-milestone",
          id: form.slice(7),
          reason: f.reason,
        });
      setForm("");
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const input = (
    name: string,
    label: string,
    value = "",
    type = "text",
    required = true,
  ) => (
    <Field label={label}>
      <input
        name={name}
        type={type}
        defaultValue={value}
        required={required}
        maxLength={200}
      />
    </Field>
  );
  const invoices = project
    ? data.invoices.filter((i) => i.deal_id === project.deal_id)
    : [];
  const milestones = project
    ? data.milestones.filter((m) => m.project_id === project.id)
    : [];
  const free = project
    ? BigInt(project.quote_net) -
      BigInt(project.billed_net) -
      BigInt(project.reserved_net) -
      BigInt(project.planned_net)
    : 0n;
  const budget = BigInt(project?.budget_minor || 0),
    cost = BigInt(project?.cost || 0);
  return (
    <>
      {id && !project ? (
        <Empty title="Project unavailable">
          Choose a project belonging to this organization.
        </Empty>
      ) : project ? (
        <>
          <a className="back" href="#projects">
            ← All projects
          </a>
          <Heading
            title={project.name}
            subtitle={`${project.code} · ${project.customer_name} · ${data.entities.find((e) => e.id === project.entity_id)?.name}`}
            action="Edit project"
            onAction={() => open("edit")}
          />
          <div className="record-summary">
            <Badge>{project.status}</Badge>
            <span>
              {day(project.start_date)} —{" "}
              {project.end_date ? day(project.end_date) : "No end date"}
            </span>
            <a href={`#deal/${project.deal_id}`}>Source deal</a>
            <a href={`#quote/${project.quote_id}`}>Accepted quote</a>
            <a href={`#contact/${project.contact_id}`}>Client contact</a>
          </div>
          <div className="project-metrics">
            {[
              ["Contract subtotal", money(project.quote_net, project.currency)],
              [
                "Invoiced subtotal",
                money(project.billed_net, project.currency),
              ],
              [
                "Drafts reserved",
                money(project.reserved_net, project.currency),
              ],
              [
                "Remaining to invoice",
                money(
                  BigInt(project.quote_net) - BigInt(project.billed_net),
                  project.currency,
                ),
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <section className="project-finance">
            <h2>Project profitability</h2>
            <p className="muted">
              PKR · All recorded dates · Posted entries only. Draft costs are
              excluded. Tax, equipment and prepayments are not treated as
              production expense. No unrecorded labour or overhead is estimated.
            </p>
            <div className="project-metrics">
              {[
                ["Earned revenue", project.revenue],
                ["Posted costs", project.cost],
                ["Operating margin", String(BigInt(project.revenue) - cost)],
                ["Exchange gain / (loss)", project.fx_result],
                [
                  "Net project result",
                  String(
                    BigInt(project.revenue) - cost + BigInt(project.fx_result),
                  ),
                ],
                ["Cash collected", project.cash],
                ["Refunds paid", project.refunded],
                ["Withholding receivable", project.withholding],
                ["Customer balance", project.receivable],
                ["Deferred revenue", project.deferred],
                ["Cost budget", project.budget_minor],
                ["Budget remaining", String(budget - cost)],
                [
                  "Quoted revenue at agreed FX",
                  String(
                    baseAmount(
                      BigInt(project.quote_net),
                      BigInt(project.fx_micros),
                    ),
                  ),
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{money(value)}</strong>
                </div>
              ))}
            </div>
            {budget > 0n && cost * 100n >= budget * 80n ? (
              <p className="posting-notice" role="status">
                {cost >= budget
                  ? "Cost budget reached or exceeded."
                  : "At least 80% of the cost budget has been used."}{" "}
                {money(budget - cost)} remaining.
              </p>
            ) : null}
          </section>
          <section>
            <div className="section-title space-top">
              <h2>Billing milestones</h2>
              {project.status === "Active" ? (
                <button onClick={() => open("milestone")}>Add milestone</button>
              ) : null}
            </div>
            <p className="muted">
              Unallocated subtotal: {money(free, project.currency)}. Milestones
              reserve the contract amount; invoicing one replaces its
              reservation with a draft.
            </p>
            {milestones.length ? (
              <Table
                headers={[
                  "Milestone",
                  "Due",
                  "Subtotal",
                  "Treatment",
                  "Status",
                  "Actions",
                ]}
              >
                {milestones.map((m) => {
                  const invoice = invoices.find(
                    (i) =>
                      i.milestone_id === m.id &&
                      !["Cancelled", "Voided"].includes(i.status),
                  );
                  return (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td>{day(m.due_date)}</td>
                      <td className="num">
                        {money(m.net_minor, project.currency)}
                      </td>
                      <td>
                        {m.billing_kind === "advance"
                          ? "Advance"
                          : "Delivered work"}
                      </td>
                      <td>
                        <Badge>
                          {m.status === "Cancelled"
                            ? "Cancelled"
                            : invoice?.status || "Planned"}
                        </Badge>
                      </td>
                      <td>
                        {invoice ? (
                          <a href={`#invoice/${invoice.id}`}>
                            {invoice.number || "Open draft"}
                          </a>
                        ) : m.status !== "Cancelled" ? (
                          <div className="row-actions">
                            {project.status === "Active" ? (
                              <button
                                onClick={() =>
                                  edit({ kind: "milestone-invoice", id: m.id })
                                }
                              >
                                Create invoice
                              </button>
                            ) : null}
                            <button onClick={() => open(`cancel:${m.id}`)}>
                              Cancel milestone
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            ) : (
              <Empty title="Plan how this project will be billed">
                Add an advance or delivered-work milestone, with a subtotal and
                due date.
              </Empty>
            )}
          </section>
          <section>
            <div className="section-title space-top">
              <h2>Invoices</h2>
              {project.status === "Active" && free > 0n ? (
                <button
                  onClick={() =>
                    edit({ kind: "invoice", id: project.quote_id })
                  }
                >
                  Invoice unallocated work
                </button>
              ) : null}
            </div>
            <Table
              headers={[
                "Invoice",
                "Stage",
                "Date",
                "Total",
                "Settled",
                "Status",
              ]}
            >
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>
                    <a href={`#invoice/${i.id}`}>
                      {i.number || "Invoice draft"}
                    </a>
                  </td>
                  <td>{i.label}</td>
                  <td>{day(i.issue_date)}</td>
                  <td className="num">{money(i.total_minor, i.currency)}</td>
                  <td className="num">{money(i.paid_minor, i.currency)}</td>
                  <td>
                    <Badge>{i.status}</Badge>
                  </td>
                </tr>
              ))}
            </Table>
          </section>
          <section>
            <div className="section-title space-top">
              <h2>Costs and purchases</h2>
              <div className="row-actions">
                <a href="#expenses">Record paid expense</a>
                <a href="#bills">Add vendor bill</a>
              </div>
            </div>
            <p className="muted">
              Choose this project's deal on the expense or bill. Existing linked
              costs are included automatically; general company expenses stay
              outside project margin.
            </p>
            <Table headers={["Source", "Description", "Amount", "Status"]}>
              {data.expenses
                .filter((e) => e.deal_id === project.deal_id)
                .map((e) => (
                  <tr key={e.id}>
                    <td>Paid expense</td>
                    <td>{e.description}</td>
                    <td className="num">{money(e.amount_minor)}</td>
                    <td>Posted</td>
                  </tr>
                ))}
              {data.bills
                .filter((b) => b.deal_id === project.deal_id)
                .map((b) => (
                  <tr key={b.id}>
                    <td>
                      <a href={`#bill/${b.id}`}>{b.reference}</a>
                    </td>
                    <td>{b.vendor_name}</td>
                    <td className="num">{money(b.total_minor, b.currency)}</td>
                    <td>
                      <Badge>{b.status}</Badge>
                    </td>
                  </tr>
                ))}
            </Table>
          </section>
        </>
      ) : (
        <>
          <Heading
            title="Projects"
            subtitle="Accepted work, billing milestones and the costs behind your margin."
            action="Start project"
            onAction={() => open("create")}
          />
          {data.projects.filter(
            (p) => entity === "all" || p.entity_id === entity,
          ).length ? (
            <Table
              headers={[
                "Project",
                "Client / entity",
                "Status",
                "Contract subtotal",
                "Earned revenue · PKR",
                "Costs · PKR",
                "Net result · PKR",
              ]}
            >
              {data.projects
                .filter((p) => entity === "all" || p.entity_id === entity)
                .map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a href={`#project/${p.id}`}>{p.name}</a>
                      <small>{p.code}</small>
                    </td>
                    <td>
                      {p.customer_name}
                      <small>
                        {data.entities.find((e) => e.id === p.entity_id)?.code}
                      </small>
                    </td>
                    <td>
                      <Badge>{p.status}</Badge>
                    </td>
                    <td className="num">{money(p.quote_net, p.currency)}</td>
                    <td className="num">{money(p.revenue)}</td>
                    <td className="num">{money(p.cost)}</td>
                    <td className="num">
                      {money(
                        BigInt(p.revenue) -
                          BigInt(p.cost) +
                          BigInt(p.fx_result),
                      )}
                    </td>
                  </tr>
                ))}
            </Table>
          ) : (
            <Empty title="Turn accepted work into a project">
              Start from an accepted quote. Its client, contact and issuing
              entity stay linked, while its existing invoices and costs remain
              intact.
            </Empty>
          )}
        </>
      )}
      {form ? (
        <Drawer
          title={
            form === "create"
              ? "Start project"
              : form === "edit"
                ? "Edit project"
                : form === "milestone"
                  ? "Add milestone"
                  : "Cancel milestone"
          }
          close={() => {
            if (!busy) setForm("");
          }}
          dirty={dirty}
        >
          <form onSubmit={submit} onChange={() => setDirty(true)}>
            <div className="editor-fields">
              {form === "create" ? (
                <>
                  <Field label="Accepted quote">
                    <select
                      value={quoteId}
                      onChange={(e) => setQuoteId(e.target.value)}
                      required
                    >
                      <option value="">Choose accepted work</option>
                      {eligible.map((q) => (
                        <option value={q.id} key={q.id}>
                          {data.deals.find((d) => d.id === q.deal_id)?.name} ·{" "}
                          {q.option_name} v{q.revision}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {quote ? (
                    <p>
                      {quote.customer_name} ·{" "}
                      {money(quote.net_minor, quote.currency)} before tax ·{" "}
                      {quote.issuer_name}
                    </p>
                  ) : null}
                  <Field label="Confirm issuing entity">
                    <select
                      name="entity_id"
                      required
                      defaultValue=""
                      key={quoteId}
                    >
                      <option value="">Confirm legal entity</option>
                      {data.entities
                        .filter((e) => e.id === quote?.entity_id)
                        .map((e) => (
                          <option value={e.id} key={e.id}>
                            {e.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  {input("code", "Project code", "", "text")}
                </>
              ) : null}
              {form === "create" || form === "edit" ? (
                <div key={form + quoteId}>
                  {input(
                    "name",
                    "Project name",
                    project?.name ||
                      data.deals.find((d) => d.id === quote?.deal_id)?.name ||
                      "",
                  )}
                  {input(
                    "start_date",
                    "Start date",
                    project?.start_date.slice(0, 10) || today(),
                    "date",
                  )}
                  {input(
                    "end_date",
                    "Target end date",
                    project?.end_date?.slice(0, 10) || "",
                    "date",
                    false,
                  )}
                  {input(
                    "budget",
                    "Cost budget (PKR)",
                    project ? decimal(project.budget_minor) : "0",
                  )}
                  {form === "edit" ? (
                    <Field label="Project status">
                      <select name="status" defaultValue={project?.status}>
                        {["Active", "On hold", "Completed"].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </Field>
                  ) : null}
                  <p className="muted">
                    One project per accepted deal. Existing invoices and
                    deal-linked costs will appear here. Budget changes are
                    audited; they do not post to the books.
                  </p>
                </div>
              ) : form === "milestone" ? (
                <>
                  {input("name", "Milestone name")}
                  {input("due_date", "Planned billing date", today(), "date")}
                  {input(
                    "amount",
                    `Milestone subtotal (${project?.currency})`,
                    decimal(free),
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
                  <p className="muted">
                    Tax is allocated from the accepted quote when invoiced.
                    Advance revenue remains deferred until finance records
                    delivery.
                  </p>
                </>
              ) : form.startsWith("cancel:") ? (
                <>
                  {input("reason", "Reason")}
                  <p>
                    Retain the milestone in history and release its reserved
                    amount. Cancel its invoice first if one exists.
                  </p>
                </>
              ) : null}
              {error ? <ErrorBox error={error} /> : null}
            </div>
            <div className="editor-footer">
              <button type="button" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy
                  ? "Saving…"
                  : form === "create"
                    ? "Create project"
                    : form === "milestone"
                      ? "Save milestone"
                      : "Save changes"}
              </button>
            </div>
          </form>
        </Drawer>
      ) : null}
    </>
  );
}
