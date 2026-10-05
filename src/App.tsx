import { useState, useEffect, useRef, lazy, Suspense } from "react";
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
  ChevronDown,
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
import { Brand } from "./Brand";
const Editor = lazy(() =>
  import("./Editor").then((m) => ({ default: m.Editor })),
);
import { Organizations, Team, Onboarding } from "./Access";
const Payables = lazy(() =>
  import("./Payables").then((m) => ({ default: m.Payables })),
);
const PurchaseOrders = lazy(() =>
  import("./PurchaseOrders").then((m) => ({ default: m.PurchaseOrders })),
);
const VendorCredits = lazy(() =>
  import("./VendorCredits").then((m) => ({ default: m.VendorCredits })),
);
import { FinancialReports } from "./FinancialReports";
const PartyStatements = lazy(() =>
  import("./PartyStatements").then((m) => ({ default: m.PartyStatements })),
);
import { Banking } from "./Banking";
import { Projects } from "./Projects";
import { QuoteComposer } from "./QuoteComposer";
import { InvoiceComposer } from "./InvoiceComposer";
import { ManualJournals } from "./ManualJournals";
import { ChartOfAccounts } from "./ChartOfAccounts";
const MonthEndClose = lazy(() =>
  import("./MonthEndClose").then((m) => ({ default: m.MonthEndClose })),
);
const OpeningBalances = lazy(() =>
  import("./OpeningBalances").then((m) => ({ default: m.OpeningBalances })),
);
import { ContactRecord } from "./ContactRecord";
import type { CrmEditorState, CrmOpen } from "./Crm";
const CrmEditor = lazy(() =>
  import("./Crm").then((m) => ({ default: m.CrmEditor })),
);
const Tasks = lazy(() => import("./Crm").then((m) => ({ default: m.Tasks })));
const LeadRecord = lazy(() =>
  import("./Crm").then((m) => ({ default: m.LeadRecord })),
);
const Credits = lazy(() =>
  import("./Billing").then((m) => ({ default: m.Credits })),
);
const Recurring = lazy(() =>
  import("./Recurring").then((m) => ({ default: m.Recurring })),
);
const RecurringBills = lazy(() => import("./RecurringBills"));
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
  { label: "Home", items: [["home", "My day", LayoutDashboard]] },
  {
    label: "CRM",
    items: [
      ["contacts", "Contacts", Users],
      ["companies", "Companies", Building2],
      ["leads", "Leads", Target],
      ["deals", "Deals", PanelsTopLeft],
      ["tasks", "Tasks", BookOpen],
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
      ["customer-statements", "Customer statements", BookOpen],
    ],
  },
  {
    label: "Purchases",
    items: [
      ["vendors", "Vendors", Building2],
      ["purchase-orders", "Purchase orders", FileText],
      ["vendor-credits", "Vendor credits & refunds", Receipt],
      ["bills", "Bills", FileText],
      ["recurring-bills", "Recurring bills", FileText],
      ["vendor-payments", "Payments made", Wallet],
      ["payables", "Payable balances", BookOpen],
      ["vendor-statements", "Vendor statements", BookOpen],
      ["expenses", "Expenses", Receipt],
      ["recurring-expenses", "Recurring expenses", Receipt],
    ],
  },
  { label: "Banking", items: [["banking", "Banking", Wallet]] },
  {
    label: "Accountant",
    items: [
      ["journals", "Manual journals", BookOpen],
      ["journal-schedules", "Recurring journals", BookOpen],
      ["accounts", "Chart of accounts", BookOpen],
      ["opening-balances", "Opening balances", BookOpen],
      ["period-close", "Month-end close", BookOpen],
      ["reports", "Trial balance", BookOpen],
    ],
  },
  {
    label: "Reports",
    items: [["financial-reports", "Financial reports", BookOpen]],
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
          <Brand />
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
        <Brand />
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
    [quoteFilter, setQuoteFilter] = useState("All"),
    [contactView, setContactView] = useState("All contacts"),
    [contactOwner, setContactOwner] = useState("All owners"),
    [contactLifecycle, setContactLifecycle] = useState("All stages"),
    [contactLeadStatus, setContactLeadStatus] = useState("All statuses"),
    [openGroups, setOpenGroups] = useState<string[]>(["CRM", "Sales"]),
    [crmEditor, setCrmEditor] = useState<CrmEditorState | null>(null),
    [menu, setMenu] = useState(false),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [layout, setLayout] = useState<"board" | "table">("board");
  const createMenu = useRef<HTMLDetailsElement>(null);
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
    setEditor(null);
    setCrmEditor(null);
    setEntity("all");
  }, [me?.organization.id, me?.user.id]);
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
      ["accounts", "journals", "journal-schedules", "reports"].includes(view),
  });
  useEffect(() => {
    setSearch("");
    setMenu(false);
    createMenu.current?.removeAttribute("open");
    setError("");
    document.getElementById("main")?.focus();
  }, [route]);
  useEffect(() => {
    const closeCreate = (event: PointerEvent) => {
      if (
        createMenu.current &&
        !createMenu.current.contains(event.target as Node)
      )
        createMenu.current.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeCreate);
    return () => document.removeEventListener("pointerdown", closeCreate);
  }, []);
  useEffect(() => {
    const group = groups.find((g) =>
      g.items.some(
        ([key]) =>
          key === view ||
          (key === "quotes" && view === "quote") ||
          (key === "invoices" && view === "invoice"),
      ),
    );
    if (group && !["Home", "Banking", "Reports"].includes(group.label))
      setOpenGroups((old) =>
        old.includes(group.label) ? old : [...old, group.label],
      );
  }, [view]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("gv-workspace-theme-v1", theme);
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  async function runWithResult(command: Record<string, unknown>) {
    setError("");
    setBusy(true);
    try {
      const result = await request<{ id: string }>(
        "commands",
        "POST",
        command,
        me!.csrf,
      );
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["data"] }),
        cache.invalidateQueries({ queryKey: ["report"] }),
        cache.invalidateQueries({ queryKey: ["financial-report"] }),
        cache.invalidateQueries({ queryKey: ["financial-detail"] }),
        cache.invalidateQueries({ queryKey: ["banking"] }),
        cache.invalidateQueries({ queryKey: ["period-close"] }),
      ]);
      setToast("Saved");
      return result;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  async function run(command: Record<string, unknown>) {
    await runWithResult(command);
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
    if (["contact", "company", "lead"].includes(value.kind)) {
      setCrmEditor({
        mode: value.kind as "contact" | "company" | "lead",
        record_type: value.kind,
        record_id: "",
        id: value.id,
        key: crypto.randomUUID(),
      });
      return;
    }
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
  const crmEdit: CrmOpen = (mode, record_type, record_id, id) =>
    setCrmEditor({
      mode,
      record_type,
      record_id,
      id,
      key: crypto.randomUUID(),
    });
  const props = data ? { data, me, edit, run, crmEdit } : null;
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
    if (view === "tasks")
      return <Tasks data={data} me={me!} open={crmEdit} entity={entity} />;
    if (view === "lead")
      return (
        <LeadRecord data={data} me={me!} open={crmEdit} id={id} run={run} />
      );
    if (view === "vendor-credits")
      return canFinance ? (
        <VendorCredits
          key={`${id || ""}/${entity}`}
          data={data}
          me={me!}
          entity={entity}
          id={id}
        />
      ) : (
        denied()
      );
    if (view === "purchase-orders")
      return canFinance ? (
        <PurchaseOrders
          key={`${id || ""}/${entity}`}
          data={data}
          me={me!}
          entity={entity}
          id={id}
        />
      ) : (
        denied()
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
    if (view === "customer-statements" || view === "vendor-statements")
      return canFinance ? (
        <PartyStatements
          key={`${me!.organization.id}/${me!.user.id}/${view}/${id || ""}`}
          data={data}
          me={me!}
          entity={entity}
          kind={view === "customer-statements" ? "customer" : "vendor"}
          initialCompanyId={id}
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
    if (["recurring-bills", "bill-schedule"].includes(view))
      return canFinance ? (
        <RecurringBills
          key={route + entity}
          data={data}
          me={me!}
          entity={entity}
          id={view === "bill-schedule" ? id : undefined}
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
    if (view === "contact")
      return (
        <ContactRecord
          id={id}
          data={data}
          me={me!}
          edit={edit}
          crmEdit={crmEdit}
        />
      );
    if (view === "company")
      return <PersonRecord {...props!} type={view} id={id} />;
    if (view === "quote" || view === "invoice")
      return (
        <div className="quote-workspace">
          <aside
            className="quote-workspace-list"
            aria-label={view === "quote" ? "Other quotes" : "Other invoices"}
          >
            <div className="quote-workspace-list-head">
              <a href={view === "quote" ? "#quotes" : "#invoices"}>
                {view === "quote" ? "All quotes" : "All invoices"}
              </a>
              {view === "quote" && canCRM ? (
                <button
                  aria-label="Quick add quote from navigation"
                  onClick={() => edit({ kind: "quote" })}
                >
                  <Plus size={16} />
                </button>
              ) : null}
              {view === "invoice" && canFinance ? (
                <button
                  aria-label="Quick add invoice from document list"
                  onClick={() => edit({ kind: "direct-invoice" })}
                >
                  <Plus size={16} />
                </button>
              ) : null}
            </div>
            {view === "quote"
              ? data.quotes
                  .filter((q) => inEntity(q.entity_id))
                  .map((q) => (
                    <a
                      className={q.id === id ? "selected" : ""}
                      href={`#quote/${q.id}`}
                      key={q.id}
                      aria-current={q.id === id ? "page" : undefined}
                    >
                      <strong>{q.customer_name}</strong>
                      <span>
                        {entityCode(q.entity_id)} ·{" "}
                        {q.number || `${q.option_name} · v${q.revision}`}
                      </span>
                      <small>
                        {q.option_name} · {money(q.total_minor, q.currency)}
                      </small>
                    </a>
                  ))
              : data.invoices
                  .filter((i) => inEntity(i.entity_id))
                  .map((i) => (
                    <a
                      className={i.id === id ? "selected" : ""}
                      href={`#invoice/${i.id}`}
                      key={i.id}
                      aria-current={i.id === id ? "page" : undefined}
                    >
                      <strong>{i.customer_name}</strong>
                      <span>
                        {entityCode(i.entity_id)} ·{" "}
                        {i.number || "Draft invoice"}
                      </span>
                      <small>
                        {i.status} · {money(i.total_minor, i.currency)}
                      </small>
                    </a>
                  ))}
          </aside>
          <div className="quote-workspace-detail">
            <DocumentRecord {...props!} type={view} id={id} />
          </div>
        </div>
      );
    if (view === "home") {
      const open = deals
          .filter((d) => !["Won", "Lost"].includes(d.stage))
          .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || "")),
        due = invoices.filter((i) => i.status === "Issued"),
        myTasks = data.crmTasks
          .filter((t) => {
            const root =
              t.record_type === "lead"
                ? data.leads.find((l) => l.id === t.record_id)
                : t.record_type === "deal"
                  ? data.deals.find((d) => d.id === t.record_id)
                  : null;
            return (
              t.status === "Open" &&
              t.assignee_id === me!.user.id &&
              (!root || inEntity(root.entity_id))
            );
          })
          .sort((a, b) => a.due_at.localeCompare(b.due_at));
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
                <h2>My tasks</h2>
                <a href="#tasks">
                  All tasks <ArrowRight size={15} />
                </a>
              </div>
              {myTasks.length ? (
                myTasks.slice(0, 5).map((t) => (
                  <a
                    className="work-item"
                    href={`#${t.record_type}/${t.record_id}`}
                    key={t.id}
                  >
                    <div>
                      <strong>{t.title}</strong>
                      <small>{t.priority} priority</small>
                    </div>
                    <span
                      className={
                        new Date(t.due_at).getTime() < Date.now()
                          ? "overdue"
                          : ""
                      }
                    >
                      {new Date(t.due_at).toLocaleString("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </span>
                  </a>
                ))
              ) : (
                <Empty title="No open tasks assigned to you">
                  Add a task from a contact, company, lead or deal.
                </Empty>
              )}
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
                <h2>Lead follow-ups</h2>
                <a href="#leads">
                  Open leads
                  <ArrowRight size={15} />
                </a>
              </div>
              {data.leads
                .filter(
                  (l) =>
                    !["Converted", "Disqualified"].includes(l.status) &&
                    inEntity(l.entity_id),
                )
                .map((l) => (
                  <div className="work-item" key={l.id}>
                    <div>
                      <a href={`#lead/${l.id}`}>{l.title}</a>
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
                              BigInt(b.total_minor) -
                                BigInt(b.paid_minor) -
                                BigInt(b.credited_minor),
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
    if (view === "contacts") {
      const contactRows = contacts
        .filter((c) =>
          match(
            c.first_name,
            c.last_name,
            c.email,
            c.phone,
            c.tags.join(" "),
            c.additional_emails.map((e) => e.value).join(" "),
            c.additional_phones.map((p) => p.value).join(" "),
          ),
        )
        .filter(
          (c) =>
            entity === "all" ||
            c.service_entity_id === entity ||
            data.affiliations.some(
              (a) =>
                a.contact_id === c.id &&
                !a.ended_on &&
                companies.some(
                  (co) =>
                    co.id === a.company_id && co.service_entity_id === entity,
                ),
            ),
        )
        .filter(
          (c) =>
            contactView !== "Open opportunities" ||
            data.deals.some(
              (d) =>
                d.contact_id === c.id && !["Won", "Lost"].includes(d.stage),
            ),
        )
        .filter(
          (c) =>
            contactView !== "Needs follow-up" ||
            data.crmTasks.some(
              (t) =>
                t.record_type === "contact" &&
                t.record_id === c.id &&
                t.status === "Open" &&
                t.due_at.slice(0, 10) <= today(),
            ),
        )
        .filter(
          (c) => contactOwner === "All owners" || c.owner_id === contactOwner,
        )
        .filter(
          (c) =>
            contactLifecycle === "All stages" ||
            c.lifecycle === contactLifecycle,
        )
        .filter(
          (c) =>
            contactLeadStatus === "All statuses" ||
            (c.profile?.lead_status || "New") === contactLeadStatus,
        );
      return (
        <>
          <Heading
            title="Contacts"
            subtitle="People stay connected to their company history and projects."
            action={canMaintainContacts ? "New contact" : undefined}
            onAction={() => edit({ kind: "contact" })}
          />
          <div
            className="contact-index-tabs"
            role="tablist"
            aria-label="Contact views"
          >
            {["All contacts", "Open opportunities", "Needs follow-up"].map(
              (name) => (
                <button
                  key={name}
                  role="tab"
                  aria-selected={contactView === name}
                  onClick={() => setContactView(name)}
                >
                  {name}
                </button>
              ),
            )}
          </div>
          <div className="contact-index-filters">
            {searchControl()}
            <label>
              Contact owner{" "}
              <select
                value={contactOwner}
                onChange={(e) => setContactOwner(e.target.value)}
              >
                <option>All owners</option>
                {data.crmMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Lifecycle stage{" "}
              <select
                value={contactLifecycle}
                onChange={(e) => setContactLifecycle(e.target.value)}
              >
                <option>All stages</option>
                {[
                  "Subscriber",
                  "Lead",
                  "MQL",
                  "SQL",
                  "Opportunity",
                  "Customer",
                  "Evangelist",
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Lead status{" "}
              <select
                value={contactLeadStatus}
                onChange={(e) => setContactLeadStatus(e.target.value)}
              >
                <option>All statuses</option>
                {[
                  "New",
                  "Attempted to contact",
                  "Connected",
                  "In progress",
                  "Open deal",
                  "Unqualified",
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted contact-index-count">
            {contactRows.length} contacts ·{" "}
            {entity === "all" ? "All legal entities" : entityCode(entity)}
          </p>
          <Table
            headers={[
              "Contact",
              "Email",
              "Phone",
              "Company",
              "Lead status",
              "Lifecycle",
            ]}
          >
            {contactRows.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href={`#contact/${c.id}`}>
                    <span className="contact-list-name">
                      <span className="contact-mini-avatar" aria-hidden="true">
                        {(
                          c.first_name[0] ||
                          c.last_name[0] ||
                          "?"
                        ).toUpperCase()}
                      </span>
                      <span>
                        {c.first_name} {c.last_name}
                      </span>
                    </span>
                  </a>
                </td>
                <td>{c.email || "Not provided"}</td>
                <td>{c.phone || "Not provided"}</td>
                <td>
                  {data.affiliations
                    .filter((a) => a.contact_id === c.id && !a.ended_on)
                    .map((a) => companyName(a.company_id))
                    .join(", ") || "No current company"}
                </td>
                <td>{c.profile?.lead_status || "New"}</td>
                <td>
                  <Badge>{c.lifecycle}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        </>
      );
    }
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
                    <a href={`#lead/${l.id}`}>{l.title}</a>
                    <small>{l.source}</small>
                  </td>
                  <td>
                    {companyName(l.company_id)}
                    <small>{contactName(l.contact_id)}</small>
                  </td>
                  <td>{entityCode(l.entity_id)}</td>
                  <td>
                    {l.status === "Converted"
                      ? "Moved to deal"
                      : l.status === "Disqualified"
                        ? l.disqualified_reason
                        : l.next_action}
                    <small>
                      {["Converted", "Disqualified"].includes(l.status)
                        ? ""
                        : day(l.due_date)}
                    </small>
                  </td>
                  <td>
                    <Badge>{l.status}</Badge>
                  </td>
                  <td>
                    {canCRM &&
                    !["Converted", "Disqualified"].includes(l.status) ? (
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
                    {canCRM && l.status !== "Converted" ? (
                      <button onClick={() => crmEdit("lead", "lead", l.id)}>
                        Update lead
                      </button>
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
            subtitle="Customer quotes, options and revisions in one place."
            action={canCRM ? "New quote" : undefined}
            onAction={() => edit({ kind: "quote" })}
          />
          <div className="toolbar">
            {searchControl()}
            <label className="quote-status-filter">
              Status{" "}
              <select
                aria-label="Quote status"
                value={quoteFilter}
                onChange={(e) => setQuoteFilter(e.target.value)}
              >
                {["All", "Draft", "Shared", "Accepted"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <span className="muted">
              {entity === "all" ? "All legal entities" : entityCode(entity)}
            </span>
          </div>
          <Table
            headers={[
              "Date",
              "Quote",
              "Customer / project",
              "Entity",
              "Total",
              "Status",
            ]}
          >
            {data.quotes
              .filter(
                (q) =>
                  inEntity(q.entity_id) &&
                  match(
                    q.option_name,
                    q.customer_name,
                    q.number || "",
                    q.details?.reference || "",
                  ) &&
                  (quoteFilter === "All" ||
                    quoteFilter ===
                      (data.deals.some((d) => d.accepted_quote_id === q.id)
                        ? "Accepted"
                        : data.quoteEvents.some(
                              (e) => e.quote_id === q.id && e.kind === "Shared",
                            )
                          ? "Shared"
                          : "Draft")),
              )
              .map((q) => (
                <tr key={q.id}>
                  <td>{day(q.details?.quote_date || q.created_at)}</td>
                  <td>
                    <a href={`#quote/${q.id}`}>{q.number || q.option_name}</a>
                    <small>
                      {q.option_name} · version {q.revision}
                    </small>
                  </td>
                  <td>
                    {q.customer_name}
                    <small>
                      {data.deals.find((d) => d.id === q.deal_id)?.name}
                    </small>
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
            action={canFinance ? "New invoice" : undefined}
            onAction={() => edit({ kind: "direct-invoice" })}
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
              title="Create an invoice directly or from an accepted quote"
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
    if (
      ["accounts", "journals", "journal-schedules", "reports"].includes(view)
    ) {
      if (!canFinance) return denied();
      return (
        <>
          <Heading
            title={
              view === "accounts"
                ? "Chart of accounts"
                : view === "journals"
                  ? "Journal entries"
                  : view === "journal-schedules"
                    ? "Recurring journals"
                    : "Trial balance"
            }
            subtitle={
              view === "journal-schedules"
                ? "Schedule balanced entries by legal entity; review each draft before it reaches the ledger."
                : "Each legal entity has its own ledger. Amounts shown in PKR."
            }
          />
          {entity === "all" ? (
            <Empty title="Select a legal entity">
              Choose an entity in the header to view its books without mixing
              balances.
            </Empty>
          ) : (
            <>
              {view !== "journal-schedules" ? (
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
              ) : null}
              {reportQuery.error ? (
                <ErrorBox error={reportQuery.error.message} />
              ) : reportQuery.data ? (
                view === "journals" || view === "journal-schedules" ? (
                  <ManualJournals
                    key={`${entity}-${view}`}
                    entity={data.entities.find((e) => e.id === entity)!}
                    report={reportQuery.data}
                    data={data}
                    focus={
                      view === "journal-schedules" ? "schedules" : "manual"
                    }
                    onRun={runWithResult}
                  />
                ) : view === "accounts" ? (
                  <ChartOfAccounts
                    key={entity}
                    entity={data.entities.find((e) => e.id === entity)!}
                    report={reportQuery.data}
                    canManage={me!.user.role === "admin"}
                    onRun={runWithResult}
                  />
                ) : (
                  <Ledger report={reportQuery.data} mode={view} />
                )
              ) : (
                <p aria-busy="true">Loading ledger…</p>
              )}
            </>
          )}
        </>
      );
    }
    if (view === "period-close") {
      if (!canFinance) return denied();
      return (
        <>
          <Heading
            title="Month-end close"
            subtitle="Review each legal entity separately before restricting postings."
          />
          {entity === "all" ? (
            <Empty title="Select a legal entity">
              Choose an entity in the header to review its accounting month.
            </Empty>
          ) : (
            <MonthEndClose
              key={entity}
              entity={data.entities.find((e) => e.id === entity)!}
              canClose={me!.user.role === "admin"}
              onRun={runWithResult}
            />
          )}
        </>
      );
    }
    if (view === "opening-balances") {
      if (!canFinance) return denied();
      return (
        <>
          <Heading
            title="Opening balances"
            subtitle="Import and reconcile a legal entity at cutover before posting anything."
          />
          {entity === "all" ? (
            <Empty title="Select a legal entity">
              Choose an entity in the header. Opening balances cannot be
              combined across entities.
            </Empty>
          ) : (
            <OpeningBalances
              key={entity}
              entity={data.entities.find((e) => e.id === entity)!}
              me={me!}
            />
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
              "Earlier date lock",
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
                    <button
                      onClick={() => {
                        setEntity(e.id);
                        location.hash = "period-close";
                      }}
                    >
                      Review month-end
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
      <aside
        className={`sidebar ${menu ? "open" : ""}`}
        aria-label="Workspace navigation"
      >
        <a className="brand" href="#home">
          <Brand />
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
                ![
                  "Purchases",
                  "Banking",
                  "Accountant",
                  "Reports",
                  "Delivery",
                ].includes(g.label),
            )
            .map((g) => {
              const items = g.items
                .filter(([key]) => key !== "team" || me.user.role === "admin")
                .filter(
                  ([key]) =>
                    canFinance ||
                    ![
                      "credits",
                      "recurring",
                      "recurring-expenses",
                      "recurring-bills",
                      "customer-statements",
                    ].includes(key),
                );
              const simple = ["Home", "Banking", "Reports"].includes(g.label);
              const groupOpen = openGroups.includes(g.label);
              const groupIcon =
                g.label === "CRM"
                  ? Users
                  : g.label === "Sales"
                    ? Receipt
                    : g.label === "Purchases"
                      ? Wallet
                      : g.label === "Accountant"
                        ? BookOpen
                        : g.label === "Delivery"
                          ? PanelsTopLeft
                          : Settings;
              const GroupIcon = groupIcon;
              return (
                <section
                  className={`nav-group ${simple ? "nav-simple" : ""}`}
                  key={g.label}
                >
                  {!simple ? (
                    <button
                      className="nav-group-toggle"
                      aria-expanded={groupOpen}
                      aria-controls={`nav-${g.label}`}
                      onClick={() =>
                        setOpenGroups((old) =>
                          old.includes(g.label)
                            ? old.filter((x) => x !== g.label)
                            : [...old, g.label],
                        )
                      }
                    >
                      <ChevronDown
                        className={groupOpen ? "" : "collapsed"}
                        size={16}
                      />
                      <GroupIcon size={19} />
                      <span>{g.label}</span>
                    </button>
                  ) : null}
                  {simple || groupOpen ? (
                    <div className="nav-group-items" id={`nav-${g.label}`}>
                      {items.map(([key, label, Icon]) => (
                        <div className="nav-item" key={key}>
                          <a
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
                                window.dispatchEvent(
                                  new PopStateEvent("popstate"),
                                );
                              }
                            }}
                            aria-label={label}
                            aria-current={
                              view === key ||
                              (key === "quotes" && view === "quote") ||
                              (key === "invoices" && view === "invoice")
                                ? "page"
                                : undefined
                            }
                          >
                            {simple ? <Icon size={19} /> : null}
                            <span>{label}</span>
                            {key === "leads" &&
                            data?.leads.filter((l) => l.status === "New")
                              .length ? (
                              <span className="nav-count">
                                {
                                  data.leads.filter((l) => l.status === "New")
                                    .length
                                }
                              </span>
                            ) : null}
                          </a>
                          {key === "quotes" && canCRM ? (
                            <button
                              className="nav-quick-add"
                              aria-label="Quick add quote from navigation"
                              onClick={() => edit({ kind: "quote" })}
                            >
                              <Plus size={16} />
                            </button>
                          ) : null}
                          {key === "invoices" && canFinance ? (
                            <button
                              className="nav-quick-add"
                              aria-label="Quick add invoice from navigation"
                              onClick={() => edit({ kind: "direct-invoice" })}
                            >
                              <Plus size={16} />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })}
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
            {canMaintainContacts ? (
              <details
                className="global-create"
                ref={createMenu}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    createMenu.current?.removeAttribute("open");
                    createMenu.current?.querySelector("summary")?.focus();
                  }
                }}
              >
                <summary>
                  <Plus size={18} /> Create <ChevronDown size={15} />
                </summary>
                <div
                  className="global-create-options"
                  aria-label="Create new record"
                >
                  {(
                    [
                      ["Contact", "contact", canMaintainContacts],
                      ["Company", "company", canMaintainContacts],
                      ["Lead", "lead", canCRM],
                      ["Quote", "quote", canCRM],
                      ["Invoice", "direct-invoice", canFinance],
                      ["Expense", "expense", canFinance],
                    ] as const
                  )
                    .filter(([, , allowed]) => allowed)
                    .map(([label, kind]) => (
                      <button
                        type="button"
                        key={kind}
                        onClick={() => {
                          createMenu.current?.removeAttribute("open");
                          edit({ kind });
                        }}
                      >
                        New {label.toLowerCase()}
                      </button>
                    ))}
                </div>
              </details>
            ) : null}
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {error && !editor ? <ErrorBox error={error} /> : null}
          <Suspense fallback={<p role="status">Opening workspace…</p>}>
            {editor?.kind === "quote" && data && me ? (
              <QuoteComposer
                key={`${me.organization.id}:${me.user.id}:${editor.id || "new-quote"}`}
                id={editor.id || ""}
                data={data}
                draftScope={`${me.organization.id}:${me.user.id}`}
                entityId={entity}
                canManageNumbering={
                  me.user.role === "admin" || me.user.role === "finance"
                }
                create={runWithResult}
                close={() => setEditor(null)}
                done={(quoteId) => {
                  setEditor(null);
                  location.hash = `#quote/${quoteId}`;
                }}
              />
            ) : (editor?.kind === "invoice" ||
                editor?.kind === "direct-invoice") &&
              data &&
              me ? (
              <InvoiceComposer
                key={`${me.organization.id}:${me.user.id}:${editor.kind}-${editor.id || "new"}`}
                id={editor.id || ""}
                kind={editor.kind}
                data={data}
                draftScope={`${me.organization.id}:${me.user.id}`}
                entityId={entity}
                create={runWithResult}
                close={() => setEditor(null)}
                done={(invoiceId) => {
                  setEditor(null);
                  location.hash = `#invoice/${invoiceId}`;
                }}
                canManageNumbering={
                  me.user.role === "admin" || me.user.role === "finance"
                }
              />
            ) : (
              content()
            )}
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
      {crmEditor && data ? (
        <Suspense fallback={<p role="status">Opening editor…</p>}>
          <CrmEditor
            key={crmEditor.key}
            state={crmEditor}
            data={data}
            me={me}
            save={run}
            createCompany={runWithResult}
            addAnother={() =>
              setCrmEditor({
                mode: "contact",
                record_type: "contact",
                record_id: "",
                key: crypto.randomUUID(),
              })
            }
            close={() => setCrmEditor(null)}
          />
        </Suspense>
      ) : null}
      {editor &&
      !["quote", "invoice", "direct-invoice"].includes(editor.kind) &&
      data ? (
        <Suspense fallback={<p role="status">Opening editor…</p>}>
          <Editor
            key={editor.kind + editor.id}
            editor={editor}
            data={data}
            me={me}
            entityId={entity}
            onClose={() => setEditor(null)}
            onSave={async (command) => {
              const result = await runWithResult(command);
              if (
                editor.kind === "invoice" &&
                command.action === "invoice.create"
              ) {
                location.hash = `#invoice/${result.id}`;
              }
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
