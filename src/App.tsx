import { useState, useEffect, lazy, Suspense } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Users,
  Target,
  PanelsTopLeft,
  FileText,
  Receipt,
  Wallet,
  BookOpen,
  Settings,
  LayoutDashboard,
  ArrowRight,
  LogOut,
  Search,
  Menu,
  X,
  Plus,
  Sun,
  Moon,
} from "lucide-react";
import {
  request,
  invoiceBalance,
  money,
  day,
  today,
  type Me,
  type Data,
  type Editor as EditorState,
  type Report,
} from "./model";
import { Heading, Badge, Table, Empty, ErrorBox } from "./components";
import { Editor } from "./Editor";
import { Organizations, Team, Onboarding } from "./Access";
import { Payables } from "./Payables";
import { FinancialReports } from "./FinancialReports";
import { Banking } from "./Banking";
import { Projects } from "./Projects";
const Credits = lazy(() =>
  import("./Billing").then((m) => ({ default: m.Credits })),
);
const Recurring = lazy(() =>
  import("./Recurring").then((m) => ({ default: m.Recurring })),
);
import {
  DealRecord,
  PersonRecord,
  DocumentRecord,
  Ledger,
  Timeline,
} from "./Records";
function useRoute() {
  const currentRoute = () =>
    location.hash.slice(1) ||
    new URLSearchParams(location.search).get("view") ||
    "home";
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const change = () => setRoute(currentRoute());
    window.addEventListener("hashchange", change);
    window.addEventListener("popstate", change);
    return () => {
      window.removeEventListener("hashchange", change);
      window.removeEventListener("popstate", change);
    };
  }, []);
  return route;
}
const groups = [
  { label: "Workspace", items: [["home", "My day", LayoutDashboard]] },
  {
    label: "CRM",
    items: [
      ["contacts", "Contacts", Users],
      ["companies", "Companies", Building2],
      ["leads", "Leads", Target],
      ["deals", "Deals", PanelsTopLeft],
    ],
  },
  {
    label: "Sales",
    items: [
      ["quotes", "Quotes", FileText],
      ["invoices", "Invoices", Receipt],
      ["payments", "Payments received", Wallet],
      ["credits", "Credit notes & refunds", Receipt],
      ["recurring", "Recurring invoices", FileText],
    ],
  },
  {
    label: "Purchases",
    items: [
      ["vendors", "Vendors", Building2],
      ["bills", "Bills", FileText],
      ["vendor-payments", "Payments made", Wallet],
      ["payables", "Payable balances", BookOpen],
      ["expenses", "Expenses", Receipt],
      ["recurring-expenses", "Recurring expenses", Receipt],
    ],
  },
  {
    label: "Accounting",
    items: [
      ["banking", "Banking", Wallet],
      ["accounts", "Chart of accounts", BookOpen],
      ["journals", "Journals", BookOpen],
      ["reports", "Trial balance", BookOpen],
      ["financial-reports", "Financial reports", BookOpen],
    ],
  },
  {
    label: "Delivery",
    items: [["projects", "Projects", PanelsTopLeft]],
  },
  {
    label: "Organization",
    items: [
      ["settings", "Entities & settings", Settings],
      ["team", "Team & access", Users],
      ["activity", "Activity log", BookOpen],
    ],
  },
] as const;
function Login({ done }: { done: () => void }) {
  useEffect(() => {
    if (/^#join\/[a-f0-9-]{36}$/.test(location.hash))
      sessionStorage.setItem("gv-signin-return", location.hash);
  }, []);
  const config = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => request<{ mode: string }>("auth/config"),
  });
  const q = useQuery({
      queryKey: ["demo-accounts"],
      enabled: config.data?.mode === "sample",
      queryFn: () =>
        request<
          {
            user_id: string;
            tenant_id: string;
            role: string;
            name: string;
            organization: string;
          }[]
        >("demo-accounts"),
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  if (config.isPending)
    return (
      <main className="loading" aria-busy="true">
        Opening sign-in…
      </main>
    );
  if (config.error)
    return (
      <main className="login">
        <ErrorBox error={config.error.message} />
        <button onClick={() => config.refetch()}>Try again</button>
      </main>
    );
  if (config.data?.mode === "oidc")
    return (
      <main className="login">
        <div className="brand">
          <span className="brand-mark">gv</span>
          <strong>Workspace</strong>
        </div>
        <h1>
          Your relationships.
          <br />
          Your business. Together.
        </h1>
        <p className="login-copy">
          Sign in securely to open your organizations or accept an invitation.
          Use the email address your administrator invited.
        </p>
        {new URLSearchParams(location.search).get("signin") === "failed" ? (
          <ErrorBox error="Sign-in could not be completed. The request may have expired, or the account's email could not be verified. Start again; if it persists, contact your administrator." />
        ) : null}
        <a className="button primary" href="/auth/login">
          Continue to secure sign-in
        </a>
        <p className="muted">
          Your identity provider handles your password. This workspace never
          receives it.
        </p>
      </main>
    );
  return (
    <main className="login">
      <div className="brand">
        <span className="brand-mark">gv</span>
        <strong>Workspace</strong>
      </div>
      <p className="eyebrow space-top">FRESH BUILD · LOCAL PREVIEW</p>
      <h1>
        One workspace.
        <br />
        From relationship to revenue.
      </h1>
      <p className="login-copy">
        Explore the new CRM and books workflow with fictional records. Your
        existing app and business data are separate.
      </p>
      <h2>Choose a sample role</h2>
      {q.data?.map((a) => (
        <button
          className="login-account"
          key={a.user_id + a.tenant_id}
          disabled={busy}
          onClick={async () => {
            setError("");
            setBusy(true);
            try {
              await request("demo-login", "POST", {
                userId: a.user_id,
                tenantId: a.tenant_id,
              });
              done();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span>
            <strong>{a.name}</strong>
            <small>{a.organization}</small>
          </span>
          <ArrowRight size={19} />
        </button>
      ))}
      {q.isPending ? <p>Loading sample accounts…</p> : null}
      {error || q.error ? <ErrorBox error={error || q.error!.message} /> : null}
      <p className="muted small">
        Development identities only. This server cannot be used as public
        authentication or deployed in production.
      </p>
    </main>
  );
}
export default function App() {
  const cache = useQueryClient(),
    route = useRoute(),
    [view, id] = route.split("/");
  const [entity, setEntity] = useState("all"),
    [search, setSearch] = useState(""),
    [editor, setEditor] = useState<EditorState | null>(null),
    [menu, setMenu] = useState(false),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [layout, setLayout] = useState<"board" | "table">("board");
  const [theme, setTheme] = useState(
    () => localStorage.getItem("gv-workspace-theme-v1") || "light",
  );
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`),
    [to, setTo] = useState(`${today().slice(0, 4)}-12-31`);
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => request<Me>("me"),
    retry: false,
  });
  const me = meQuery.data;
  useEffect(() => {
    if (!me) return;
    const intended = sessionStorage.getItem("gv-signin-return");
    sessionStorage.removeItem("gv-signin-return");
    if (intended && /^#join\/[a-f0-9-]{36}$/.test(intended))
      location.hash = intended;
  }, [me?.user.id]);
  const dataQuery = useQuery({
    queryKey: ["data", me?.organization.id, me?.user.id],
    queryFn: () => request<Data>("data"),
    enabled: !!me && !me.onboarding,
    retry: 1,
  });
  const data = dataQuery.data;
  const canFinance = !!me && ["admin", "finance"].includes(me.user.role),
    canCRM = !!me && ["admin", "sales"].includes(me.user.role);
  const canMaintainContacts = canCRM || canFinance;
  const reportQuery = useQuery({
    queryKey: ["report", me?.organization.id, entity, from, to],
    queryFn: () =>
      request<Report>(`reports?entityId=${entity}&from=${from}&to=${to}`),
    enabled:
      !!me &&
      canFinance &&
      entity !== "all" &&
      ["accounts", "journals", "reports"].includes(view),
  });
  useEffect(() => {
    setSearch("");
    setMenu(false);
    setError("");
    document.getElementById("main")?.focus();
  }, [route]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("gv-workspace-theme-v1", theme);
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  async function run(command: Record<string, unknown>) {
    setError("");
    setBusy(true);
    try {
      await request("commands", "POST", command, me!.csrf);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["data"] }),
        cache.invalidateQueries({ queryKey: ["report"] }),
        cache.invalidateQueries({ queryKey: ["financial-report"] }),
        cache.invalidateQueries({ queryKey: ["financial-detail"] }),
        cache.invalidateQueries({ queryKey: ["banking"] }),
      ]);
      setToast("Saved");
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const invoke = (command: Record<string, unknown>) => {
    void run(command).catch(() => {});
  };
  if (meQuery.isPending)
    return (
      <main className="loading" aria-busy="true">
        Opening workspace…
      </main>
    );
  if (meQuery.error) {
    if ((meQuery.error as Error & { status?: number }).status === 401)
      return (
        <Login
          done={() => {
            if (!location.hash.startsWith("#join/")) location.hash = "home";
            location.reload();
          }}
        />
      );
    return (
      <main className="loading">
        <ErrorBox error={meQuery.error.message} />
        <button onClick={() => meQuery.refetch()}>Try again</button>
      </main>
    );
  }
  if (!me) return null;
  if (me.onboarding) return <Onboarding me={me} />;
  const edit = (value: EditorState) => {
    setError("");
    setEditor(value);
  };
  const match = (...values: unknown[]) =>
    values.join(" ").toLowerCase().includes(search.toLowerCase());
  const inEntity = (value: string | null) =>
    entity === "all" || value === entity;
  const companies = data?.companies || [],
    contacts = data?.contacts || [],
    deals = data?.deals.filter((d) => inEntity(d.entity_id)) || [],
    invoices = data?.invoices.filter((i) => inEntity(i.entity_id)) || [];
  const companyName = (id: string) =>
      companies.find((c) => c.id === id)?.name || "Unknown company",
    entityCode = (id: string) =>
      data?.entities.find((e) => e.id === id)?.code || "",
    contactName = (id: string) => {
      const c = contacts.find((c) => c.id === id);
      return c ? `${c.first_name} ${c.last_name}` : "Unknown contact";
    };
  const props = data ? { data, me, edit, run } : null;
  function content() {
    if (view === "organizations" || view === "join")
      return <Organizations me={me!} />;
    if (view === "team") return <Team me={me!} />;
    if (dataQuery.isPending)
      return (
        <div className="skeleton" aria-label="Loading records" aria-busy="true">
          <div />
          <div />
          <div />
        </div>
      );
    if (dataQuery.error || !data)
      return (
        <ErrorBox
          error={dataQuery.error?.message || "Unable to load records."}
        />
      );
    if (
      ["vendors", "bills", "bill", "vendor-payments", "payables"].includes(view)
    )
      return canFinance ? (
        <Payables
          key={view + "/" + (id || "") + "/" + entity}
          data={data}
          me={me!}
          entity={entity}
          view={view}
          id={id}
          newVendor={() => edit({ kind: "company", id: "vendor" })}
        />
      ) : (
        denied()
      );
    if (view === "financial-reports")
      return canFinance ? (
        <FinancialReports key={me!.organization.id} me={me!} entity={entity} />
      ) : (
        denied()
      );
    if (view === "credits" || view === "credit")
      return canFinance ? (
        <Credits
          key={route}
          data={data!}
          entity={entity}
          id={view === "credit" ? id : undefined}
          initialInvoice={view === "credits" ? id : undefined}
          run={run}
        />
      ) : (
        denied()
      );
    if (["recurring", "recurring-expenses", "schedule"].includes(view))
      return canFinance ? (
        <Recurring
          key={route}
          data={data!}
          entity={entity}
          id={view === "schedule" ? id : undefined}
          kind={view === "recurring-expenses" ? "expense" : "invoice"}
          run={run}
        />
      ) : (
        denied()
      );
    if (view === "projects" || view === "project")
      return canFinance ? (
        <Projects
          key={view + (id || "") + entity}
          data={data}
          entity={entity}
          id={view === "project" ? id : undefined}
          initialQuote={view === "projects" ? id : undefined}
          edit={edit}
          run={run}
        />
      ) : (
        denied()
      );
    if (view === "banking" || view === "bank")
      return canFinance ? (
        <Banking
          key={view + (id || "") + entity}
          me={me!}
          data={data}
          entity={entity}
          id={id}
        />
      ) : (
        denied()
      );
    if (view === "deal") {
      const deal = data.deals.find((d) => d.id === id);
      return deal ? (
        <DealRecord {...props!} deal={deal} />
      ) : (
        <Empty title="Deal unavailable">Choose a deal from the list.</Empty>
      );
    }
    if (view === "company" || view === "contact")
      return <PersonRecord {...props!} type={view} id={id} />;
    if (view === "quote" || view === "invoice")
      return <DocumentRecord {...props!} type={view} id={id} />;
    if (view === "home") {
      const open = deals
          .filter((d) => !["Won", "Lost"].includes(d.stage))
          .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || "")),
        due = invoices.filter((i) => i.status === "Issued");
      return (
        <>
          <Heading
            title="My day"
            subtitle={new Date().toLocaleDateString("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          />
          <div className="home-columns">
            <section>
              <div className="section-title">
                <h2>Follow-ups</h2>
                <a href="#deals">
                  All deals
                  <ArrowRight size={15} />
                </a>
              </div>
              {open.length ? (
                open.map((d) => (
                  <a className="work-item" href={`#deal/${d.id}`} key={d.id}>
                    <div>
                      <strong>{d.name}</strong>
                      <p>{d.next_action}</p>
                      <small>
                        {companyName(d.company_id)} · {entityCode(d.entity_id)}
                      </small>
                    </div>
                    <div>
                      <span
                        className={
                          d.due_date && d.due_date < today() ? "overdue" : ""
                        }
                      >
                        {day(d.due_date)}
                      </span>
                      <Badge>{d.stage}</Badge>
                    </div>
                  </a>
                ))
              ) : (
                <Empty title="No open deal follow-ups">
                  Qualify a lead to create a deal and its next action.
                </Empty>
              )}
              <div className="section-title space-top">
                <h2>New leads</h2>
                <a href="#leads">
                  Open leads
                  <ArrowRight size={15} />
                </a>
              </div>
              {data.leads
                .filter((l) => l.status === "New" && inEntity(l.entity_id))
                .map((l) => (
                  <div className="work-item" key={l.id}>
                    <div>
                      <strong>{l.title}</strong>
                      <p>
                        {companyName(l.company_id)} · {l.next_action}
                      </p>
                    </div>
                    {canCRM ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          invoke({ action: "lead.convert", id: l.id })
                        }
                      >
                        Qualify
                        <ArrowRight size={14} />
                      </button>
                    ) : null}
                  </div>
                ))}
            </section>
            <section>
              <div className="section-title">
                <h2>Money to collect</h2>
                <a href="#invoices">
                  Invoices
                  <ArrowRight size={15} />
                </a>
              </div>
              {due.length ? (
                due.map((i) => (
                  <a className="work-item" key={i.id} href={`#invoice/${i.id}`}>
                    <div>
                      <strong>{i.customer_name}</strong>
                      <small>
                        {i.number} · due {day(i.due_date)}
                      </small>
                    </div>
                    <strong>{money(invoiceBalance(i), i.currency)}</strong>
                  </a>
                ))
              ) : (
                <Empty title="No invoices awaiting payment">
                  Accepted quotes become invoice drafts, then enter the books
                  when issued.
                </Empty>
              )}
              {canFinance ? (
                <>
                  <div className="section-title space-top">
                    <h2>Money to pay</h2>
                    <a href="/?view=payables">
                      Payable balances <ArrowRight size={15} />
                    </a>
                  </div>
                  {(data.bills || []).some(
                    (b) => b.status === "Open" && inEntity(b.entity_id),
                  ) ? (
                    (data.bills || [])
                      .filter(
                        (b) => b.status === "Open" && inEntity(b.entity_id),
                      )
                      .sort((a, b) => a.due_date.localeCompare(b.due_date))
                      .slice(0, 5)
                      .map((b) => (
                        <a
                          className="work-item"
                          key={b.id}
                          href={`#bill/${b.id}`}
                        >
                          <div>
                            <strong>{b.vendor_name}</strong>
                            <small>
                              {b.reference} · {entityCode(b.entity_id)} · due{" "}
                              {day(b.due_date)}
                            </small>
                          </div>
                          <strong>
                            {money(
                              BigInt(b.total_minor) - BigInt(b.paid_minor),
                              b.currency,
                            )}
                          </strong>
                        </a>
                      ))
                  ) : (
                    <p className="muted">No approved bills awaiting payment.</p>
                  )}
                </>
              ) : null}
              <h2 className="space-top">Latest activity</h2>
              <Timeline events={data.events.slice(0, 5)} />
            </section>
          </div>
        </>
      );
    }
    if (view === "companies")
      return (
        <>
          <Heading
            title="Companies"
            subtitle="Customers, vendors and prospects share one record."
            action={canMaintainContacts ? "New company" : undefined}
            onAction={() => edit({ kind: "company" })}
          />
          {toolbar()}
          <Table
            headers={["Company", "Industry", "Relationship", "Service entity"]}
          >
            {companies
              .filter(
                (c) =>
                  match(c.name, c.industry) && inEntity(c.service_entity_id),
              )
              .map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href={`#company/${c.id}`}>{c.name}</a>
                    <small>{c.domain}</small>
                  </td>
                  <td>{c.industry || "Not set"}</td>
                  <td>
                    {c.customer ? "Customer" : c.vendor ? "Vendor" : "Prospect"}
                    {c.customer && c.vendor ? " & vendor" : ""}
                  </td>
                  <td>
                    {c.service_entity_id
                      ? entityCode(c.service_entity_id)
                      : "Shared"}
                  </td>
                </tr>
              ))}
          </Table>
        </>
      );
    if (view === "contacts")
      return (
        <>
          <Heading
            title="Contacts"
            subtitle="People stay connected to their company history and projects."
            action={canMaintainContacts ? "New contact" : undefined}
            onAction={() => edit({ kind: "contact" })}
          />
          {toolbar()}
          <Table
            headers={["Contact", "Company", "Email", "Title", "Lifecycle"]}
          >
            {contacts
              .filter((c) => match(c.first_name, c.last_name, c.email))
              .filter(
                (c) =>
                  entity === "all" ||
                  data.affiliations.some(
                    (a) =>
                      a.contact_id === c.id &&
                      !a.ended_on &&
                      companies.some(
                        (co) =>
                          co.id === a.company_id &&
                          co.service_entity_id === entity,
                      ),
                  ),
              )
              .map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href={`#contact/${c.id}`}>
                      {c.first_name} {c.last_name}
                    </a>
                  </td>
                  <td>
                    {data.affiliations
                      .filter((a) => a.contact_id === c.id && !a.ended_on)
                      .map((a) => companyName(a.company_id))
                      .join(", ") || "No current company"}
                  </td>
                  <td>{c.email || "Not provided"}</td>
                  <td>{c.title || "Not set"}</td>
                  <td>
                    <Badge>{c.lifecycle}</Badge>
                  </td>
                </tr>
              ))}
          </Table>
        </>
      );
    if (view === "leads")
      return (
        <>
          <Heading
            title="Leads"
            subtitle="Qualify a project once. Its people and company carry into the deal."
            action={canCRM ? "New lead" : undefined}
            onAction={() => edit({ kind: "lead" })}
          />
          {toolbar()}
          <Table
            headers={[
              "Opportunity",
              "Company / contact",
              "Entity",
              "Next action",
              "Status",
              "Actions",
            ]}
          >
            {data.leads
              .filter(
                (l) =>
                  inEntity(l.entity_id) &&
                  match(l.title, companyName(l.company_id)),
              )
              .map((l) => (
                <tr key={l.id}>
                  <td>
                    <strong>{l.title}</strong>
                    <small>{l.source}</small>
                  </td>
                  <td>
                    {companyName(l.company_id)}
                    <small>{contactName(l.contact_id)}</small>
                  </td>
                  <td>{entityCode(l.entity_id)}</td>
                  <td>
                    {l.status === "Converted" ? "Moved to deal" : l.next_action}
                    <small>
                      {l.status === "Converted" ? "" : day(l.due_date)}
                    </small>
                  </td>
                  <td>
                    <Badge>{l.status}</Badge>
                  </td>
                  <td>
                    {canCRM && l.status === "New" ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          invoke({ action: "lead.convert", id: l.id })
                        }
                      >
                        Qualify & create deal
                      </button>
                    ) : l.status === "Converted" ? (
                      <a
                        href={`#deal/${data.deals.find((d) => d.lead_id === l.id)?.id}`}
                      >
                        View deal
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
          </Table>
        </>
      );
    if (view === "deals")
      return (
        <>
          <Heading
            title="Deals"
            subtitle="One project, with every quote option and revision kept together."
          />
          <div className="toolbar">
            {searchControl()}
            <div className="segmented">
              <button
                aria-pressed={layout === "board"}
                onClick={() => setLayout("board")}
              >
                Board
              </button>
              <button
                aria-pressed={layout === "table"}
                onClick={() => setLayout("table")}
              >
                Table
              </button>
            </div>
          </div>
          {layout === "board" ? (
            <div className="board">
              {["Qualified", "Proposal", "Negotiation", "Won", "Lost"].map(
                (stage) => (
                  <section className="stage" key={stage}>
                    <h2>
                      {stage}
                      <span>
                        {deals.filter((d) => d.stage === stage).length}
                      </span>
                    </h2>
                    {deals
                      .filter(
                        (d) =>
                          d.stage === stage &&
                          match(d.name, companyName(d.company_id)),
                      )
                      .map((d) => {
                        const q = data.quotes.find(
                          (q) => q.id === d.accepted_quote_id,
                        );
                        return (
                          <a
                            className="deal-card"
                            href={`#deal/${d.id}`}
                            key={d.id}
                          >
                            <small>{companyName(d.company_id)}</small>
                            <strong>{d.name}</strong>
                            <span className="entity-label">
                              {entityCode(d.entity_id)}
                            </span>
                            {q ? (
                              <b>{money(q.total_minor, q.currency)}</b>
                            ) : (
                              <span>
                                {
                                  data.quotes.filter((q) => q.deal_id === d.id)
                                    .length
                                }{" "}
                                quote versions
                              </span>
                            )}
                            {d.next_action ? (
                              <footer>
                                <span>{d.next_action}</span>
                                <small>{day(d.due_date)}</small>
                              </footer>
                            ) : null}
                          </a>
                        );
                      })}
                    {!deals.some((d) => d.stage === stage) ? (
                      <p className="stage-empty">No deals here</p>
                    ) : null}
                  </section>
                ),
              )}
            </div>
          ) : (
            <Table
              headers={["Deal", "Company", "Entity", "Stage", "Next action"]}
            >
              {deals
                .filter((d) => match(d.name, companyName(d.company_id)))
                .map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a href={`#deal/${d.id}`}>{d.name}</a>
                    </td>
                    <td>{companyName(d.company_id)}</td>
                    <td>{entityCode(d.entity_id)}</td>
                    <td>
                      <Badge>{d.stage}</Badge>
                    </td>
                    <td>{d.next_action || "Closed"}</td>
                  </tr>
                ))}
            </Table>
          )}
        </>
      );
    if (view === "quotes")
      return (
        <>
          <Heading
            title="Quotes"
            subtitle="All alternatives and versions, with explicit acceptance."
          />
          {toolbar()}
          <Table
            headers={[
              "Option / version",
              "Project",
              "Entity",
              "Total",
              "Status",
            ]}
          >
            {data.quotes
              .filter(
                (q) =>
                  inEntity(q.entity_id) &&
                  match(q.option_name, q.customer_name),
              )
              .map((q) => (
                <tr key={q.id}>
                  <td>
                    <a href={`#quote/${q.id}`}>{q.option_name}</a>
                    <small>Version {q.revision}</small>
                  </td>
                  <td>
                    <a href={`#deal/${q.deal_id}`}>
                      {data.deals.find((d) => d.id === q.deal_id)?.name}
                    </a>
                    <small>{q.customer_name}</small>
                  </td>
                  <td>{entityCode(q.entity_id)}</td>
                  <td className="num">{money(q.total_minor, q.currency)}</td>
                  <td>
                    <Badge>
                      {data.deals.some((d) => d.accepted_quote_id === q.id)
                        ? "Accepted"
                        : data.quoteEvents.some(
                              (e) => e.quote_id === q.id && e.kind === "Shared",
                            )
                          ? "Shared"
                          : "Draft"}
                    </Badge>
                  </td>
                </tr>
              ))}
          </Table>
        </>
      );
    if (view === "invoices")
      return (
        <>
          <Heading
            title="Invoices"
            subtitle="Drafts stay out of the ledger until they are issued."
          />
          {toolbar()}
          <Table
            headers={[
              "Invoice",
              "Customer / project",
              "Entity",
              "Due",
              "Total",
              "Balance",
              "Status",
            ]}
          >
            {invoices
              .filter((i) => match(i.number, i.customer_name, i.deal_name))
              .map((i) => (
                <tr key={i.id}>
                  <td>
                    <a href={`#invoice/${i.id}`}>
                      {i.number || "Draft invoice"}
                    </a>
                  </td>
                  <td>
                    {i.customer_name}
                    <small>{i.deal_name}</small>
                  </td>
                  <td>{entityCode(i.entity_id)}</td>
                  <td>{day(i.due_date)}</td>
                  <td className="num">{money(i.total_minor, i.currency)}</td>
                  <td className="num">
                    {money(
                      i.status === "Voided" ? 0n : invoiceBalance(i),
                      i.currency,
                    )}
                  </td>
                  <td>
                    <Badge>
                      {i.status === "Issued" && i.due_date < today()
                        ? "Overdue"
                        : i.status === "Issued" && BigInt(i.paid_minor) > 0n
                          ? "Partially paid"
                          : i.status}
                    </Badge>
                  </td>
                </tr>
              ))}
          </Table>
          {!invoices.length ? (
            <Empty
              title="Your first invoice starts with an accepted quote"
              action="Open quotes"
              onAction={() => (location.hash = "quotes")}
            >
              Accept a quote version, create its invoice draft, then review and
              issue it.
            </Empty>
          ) : null}
        </>
      );
    if (view === "payments")
      return (
        <>
          <Heading
            title="Payments received"
            subtitle="Cash receipts and withholding linked to their invoices."
          />
          {toolbar()}
          <Table
            headers={[
              "Reference",
              "Invoice",
              "Date",
              "Entity",
              "Amount received",
              "Withholding",
            ]}
          >
            {data.payments
              .filter((p) => inEntity(p.entity_id) && match(p.reference))
              .map((p) => {
                const i = data.invoices.find((i) => i.id === p.invoice_id);
                return (
                  <tr key={p.id}>
                    <td>{p.reference}</td>
                    <td>
                      <a href={`#invoice/${p.invoice_id}`}>{i?.number}</a>
                    </td>
                    <td>{day(p.payment_date)}</td>
                    <td>{entityCode(p.entity_id)}</td>
                    <td className="num">
                      {money(p.amount_minor, i?.currency)}
                    </td>
                    <td className="num">{money(p.wht_minor, i?.currency)}</td>
                  </tr>
                );
              })}
          </Table>
          {!data.payments.length ? (
            <Empty title="No payments recorded">
              Open an issued invoice to record cash received and any withholding
              deduction.
            </Empty>
          ) : null}
        </>
      );
    if (view === "expenses") {
      if (!canFinance) return denied();
      return (
        <>
          <Heading
            title="Expenses"
            subtitle="Paid project costs and general company spending."
            action="Record expense"
            onAction={() => edit({ kind: "expense" })}
          />
          {toolbar()}
          <Table
            headers={[
              "Expense",
              "Project",
              "Entity",
              "Date",
              "Reference",
              "Amount",
            ]}
          >
            {data.expenses
              .filter(
                (e) =>
                  inEntity(e.entity_id) && match(e.description, e.reference),
              )
              .map((e) => (
                <tr key={e.id}>
                  <td>{e.description}</td>
                  <td>
                    {e.deal_id ? (
                      <a href={`#deal/${e.deal_id}`}>
                        {data.deals.find((d) => d.id === e.deal_id)?.name}
                      </a>
                    ) : (
                      "General company expense"
                    )}
                  </td>
                  <td>{entityCode(e.entity_id)}</td>
                  <td>{day(e.expense_date)}</td>
                  <td>{e.reference}</td>
                  <td className="num">{money(e.amount_minor)}</td>
                </tr>
              ))}
          </Table>
          {!data.expenses.length ? (
            <Empty title="Keep business costs beside the work">
              Choose a legal entity and optionally link an expense to its
              project.
            </Empty>
          ) : null}
        </>
      );
    }
    if (["accounts", "journals", "reports"].includes(view)) {
      if (!canFinance) return denied();
      return (
        <>
          <Heading
            title={
              view === "accounts"
                ? "Chart of accounts"
                : view === "journals"
                  ? "Journal entries"
                  : "Trial balance"
            }
            subtitle="Each legal entity has its own ledger. Amounts shown in PKR."
          />
          {entity === "all" ? (
            <Empty title="Select a legal entity">
              Choose an entity in the header to view its books without mixing
              balances.
            </Empty>
          ) : (
            <>
              <div className="toolbar">
                <label>
                  From{" "}
                  <input
                    type="date"
                    aria-label="Report start date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label>
                  Through{" "}
                  <input
                    type="date"
                    aria-label="Report end date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
              </div>
              {reportQuery.error ? (
                <ErrorBox error={reportQuery.error.message} />
              ) : reportQuery.data ? (
                <Ledger report={reportQuery.data} mode={view} />
              ) : (
                <p aria-busy="true">Loading ledger…</p>
              )}
            </>
          )}
        </>
      );
    }
    if (view === "settings")
      return (
        <>
          <Heading
            title="Entities & settings"
            subtitle="Shared relationships. Separate legal names, numbering and ledgers."
            action={me!.user.role === "admin" ? "Add legal entity" : undefined}
            onAction={() => edit({ kind: "entity" })}
          />
          <Table
            headers={[
              "Legal entity",
              "Code",
              "Base currency",
              "Tax registration",
              "Locked through",
              "Actions",
            ]}
          >
            {data.entities.map((e) => (
              <tr key={e.id}>
                <td>
                  <strong>{e.name}</strong>
                  <small>{e.address}</small>
                </td>
                <td>{e.code}</td>
                <td>{e.currency}</td>
                <td>{e.tax_id || "Not configured"}</td>
                <td>{e.lock_date ? day(e.lock_date) : "No lock"}</td>
                <td>
                  {me!.user.role === "admin" ? (
                    <button onClick={() => edit({ kind: "close", id: e.id })}>
                      Lock period
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
          <section className="settings-note">
            <h2>Build scope</h2>
            <p>
              This fresh development build covers the first connected
              CRM-to-ledger workflow.{" "}
              {me!.mode === "sample"
                ? "It uses fictional data and local sample roles."
                : "This identity-enabled environment requires release validation before live financial use."}
            </p>
            <p>
              Custom roles, per-entity grants, bank connections, email delivery,
              tax compliance, subscriptions and the remaining requirements are
              not enabled yet.{" "}
              {me!.mode === "sample"
                ? "Secure sign-in is available only on a separately configured identity-enabled server; this preview uses sample accounts."
                : "Sign-in is handled by the configured identity provider."}
            </p>
            <h3>Display</h3>
            <label>
              Theme{" "}
              <select
                aria-label="Theme"
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="contrast">High contrast</option>
              </select>
            </label>
          </section>
        </>
      );
    if (view === "activity")
      return (
        <>
          <Heading
            title="Activity log"
            subtitle="Changes and their source records, recorded together."
          />
          <Timeline
            events={data.events.filter((e) =>
              match(e.action, JSON.stringify(e.details)),
            )}
          />
        </>
      );
    return (
      <Empty
        title="Page not found"
        action="Go to My day"
        onAction={() => (location.hash = "home")}
      >
        Choose a section from the navigation.
      </Empty>
    );
  }
  function denied() {
    return (
      <Empty title="This section needs a finance role">
        {me!.mode === "sample"
          ? "Switch sample accounts to review the books."
          : "Ask your administrator if you need access to the books."}{" "}
        The API enforces this restriction too.
      </Empty>
    );
  }
  function searchControl() {
    return (
      <label className="search">
        <Search size={17} />
        <input
          aria-label="Search this view"
          placeholder="Search this view…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search ? (
          <button aria-label="Clear search" onClick={() => setSearch("")}>
            <X size={14} />
          </button>
        ) : null}
      </label>
    );
  }
  function toolbar() {
    return (
      <div className="toolbar">
        {searchControl()}
        <span className="muted">
          {entity === "all" ? "All legal entities" : entityCode(entity)}
        </span>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <a className="brand" href="#home">
          <span className="brand-mark">gv</span>
          <strong>Workspace</strong>
        </a>
        <a
          className="organization-name organization-link"
          href="#organizations"
          aria-label={`Switch organization: ${me.organization.name}`}
        >
          {me.organization.name}
          <small>Switch organization →</small>
        </a>
        <nav aria-label="Main navigation">
          {groups
            .filter(
              (g) =>
                canFinance ||
                !["Purchases", "Accounting", "Delivery"].includes(g.label),
            )
            .map((g) => (
              <section className="nav-group" key={g.label}>
                <h2>{g.label}</h2>
                {g.items
                  .filter(([key]) => key !== "team" || me.user.role === "admin")
                  .filter(
                    ([key]) =>
                      canFinance ||
                      !["credits", "recurring", "recurring-expenses"].includes(
                        key,
                      ),
                  )
                  .map(([key, label, Icon]) => (
                    <a
                      key={key}
                      href={`/?view=${key}`}
                      onClick={(e) => {
                        if (
                          e.button === 0 &&
                          !e.ctrlKey &&
                          !e.metaKey &&
                          !e.shiftKey &&
                          !e.altKey
                        ) {
                          e.preventDefault();
                          history.pushState(null, "", `/?view=${key}`);
                          window.dispatchEvent(new PopStateEvent("popstate"));
                        }
                      }}
                      aria-label={label}
                      aria-current={view === key ? "page" : undefined}
                    >
                      <Icon size={17} />
                      <span>{label}</span>
                      {key === "leads" &&
                      data?.leads.filter((l) => l.status === "New").length ? (
                        <span className="nav-count">
                          {data.leads.filter((l) => l.status === "New").length}
                        </span>
                      ) : null}
                    </a>
                  ))}
              </section>
            ))}
        </nav>
        <div className="profile">
          <span className="avatar">{me.user.name[0]}</span>
          <div>
            <strong>{me.user.name}</strong>
            <small>{me.user.role}</small>
          </div>
          <button
            aria-label="Sign out"
            onClick={async () => {
              try {
                await request("logout", "POST", {}, me.csrf);
                cache.clear();
                location.reload();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu"
            aria-label="Toggle navigation"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Menu size={20} />
          </button>
          <label className="entity-switcher">
            <Building2 size={17} />
            <span className="sr-only">Legal entity view</span>
            <select
              aria-label="Legal entity view"
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
            >
              <option value="all">All legal entities</option>
              {data?.entities.map((e) => (
                <option value={e.id} key={e.id}>
                  {e.code} · {e.name}
                </option>
              ))}
            </select>
          </label>
          <div className="topbar-actions">
            <span className="sample-label">
              {me.mode === "sample" ? "Sample workspace" : "Secure workspace"}
            </span>
            <button
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            {canCRM ? (
              <button onClick={() => edit({ kind: "lead" })}>
                <Plus size={17} />
                <span className="quick-label">New lead</span>
              </button>
            ) : null}
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {error && !editor ? <ErrorBox error={error} /> : null}
          <Suspense fallback={<p role="status">Opening workspace…</p>}>
            {content()}
          </Suspense>
        </main>
        <footer className="app-footer">
          {me.mode === "sample"
            ? "Fresh build · Synthetic data only · No live integrations"
            : "GV Workspace · CRM and books"}
        </footer>
      </div>
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
      {editor && data ? (
        <Editor
          key={editor.kind + editor.id}
          editor={editor}
          data={data}
          me={me}
          entityId={entity}
          onClose={() => setEditor(null)}
          onSave={run}
        />
      ) : null}
    </div>
  );
}
