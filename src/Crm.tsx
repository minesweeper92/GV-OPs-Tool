import { useState, type FormEvent } from "react";
import { ContactCompanyField } from "./ContactCompanyField";
import { type Data, type Me, day, today } from "./model";
import {
  contactProfile,
  companyProfile,
  commercialProfile,
} from "../shared/profiles";
import {
  ProfileFields,
  type ProfileValue,
  ProfileSummary,
} from "./ProfileFields";
import {
  Heading,
  Table,
  Badge,
  Empty,
  Drawer,
  Field,
  ErrorBox,
} from "./components";
export type CrmEditorState = {
  mode: "contact" | "company" | "lead" | "deal" | "activity" | "task";
  record_type: string;
  record_id: string;
  id?: string;
  key: string;
};
export type CrmOpen = (
  mode: CrmEditorState["mode"],
  record_type: string,
  record_id: string,
  id?: string,
) => void;
type Props = { data: Data; me: Me; open: CrmOpen };
const localDate = (s: string) => {
  const d = new Date(s);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const when = (s: string) =>
  new Date(s).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
export function recordName(data: Data, type: string, id: string) {
  if (type === "contact") {
    const c = data.contacts.find((c) => c.id === id);
    return c ? `${c.first_name} ${c.last_name}` : "Unavailable contact";
  }
  return type === "company"
    ? data.companies.find((c) => c.id === id)?.name || "Unavailable company"
    : type === "lead"
      ? data.leads.find((l) => l.id === id)?.title || "Unavailable lead"
      : data.deals.find((d) => d.id === id)?.name || "Unavailable deal";
}
function related(data: Data, type: string, id: string) {
  const keys = new Set([id]);
  for (const d of data.deals) {
    if (
      (type === "contact" && d.contact_id === id) ||
      (type === "company" && d.company_id === id) ||
      (type === "deal" && d.id === id)
    ) {
      keys.add(d.id);
      if (d.lead_id) keys.add(d.lead_id);
    }
  }
  for (const l of data.leads) {
    if (
      (type === "contact" && l.contact_id === id) ||
      (type === "company" && l.company_id === id)
    )
      keys.add(l.id);
  }
  return keys;
}
export function CrmPanel({
  data,
  me,
  open,
  type,
  id,
  events = [],
}: Props & { type: string; id: string; events?: Data["events"] }) {
  const [filter, setFilter] = useState("All"),
    keys = related(data, type, id),
    activities = data.crmActivities.filter((a) => keys.has(a.record_id)),
    tasks = data.crmTasks.filter((t) => keys.has(t.record_id));
  const lastContact = activities
    .filter((a) => ["Call", "Meeting", "Email"].includes(a.kind))
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0];
  const nextTask = tasks
    .filter((t) => t.status === "Open")
    .sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
  const timeline = [
    ...activities.map((a) => ({
      id: a.id,
      kind: a.kind,
      date: a.occurred_at,
      title: a.subject,
      body: a.body,
      outcome: a.outcome,
      url: a.reference_url,
      actor: a.actor_id,
    })),
    ...events
      .filter((e) => e.action !== "crm.activity")
      .map((e) => ({
        id: e.id,
        kind: "System",
        date: e.created_at,
        title: e.action.replaceAll(".", " · "),
        body: String(
          e.details.text ||
            e.details.reference ||
            e.details.reason ||
            e.details.status ||
            "",
        ),
        outcome: "",
        url: "",
        actor: e.actor_id || "",
      })),
  ]
    .filter((e) => filter === "All" || filter === e.kind)
    .sort((a, b) => b.date.localeCompare(a.date));
  return (
    <section className="space-top">
      <div className="section-title">
        <h2>Tasks & activity</h2>
        {me.user.role !== "viewer" ? (
          <div className="actions">
            <button onClick={() => open("task", type, id)}>Add task</button>
            <button onClick={() => open("activity", type, id)}>
              Log activity
            </button>
          </div>
        ) : null}
      </div>
      <div className="project-metrics">
        <div>
          <span>Last recorded contact</span>
          <strong>
            {lastContact ? when(lastContact.occurred_at) : "Not recorded"}
          </strong>
        </div>
        <div>
          <span>Next open task</span>
          <strong>{nextTask?.title || "No open tasks"}</strong>
          {nextTask ? <small>{when(nextTask.due_at)}</small> : null}
        </div>
      </div>
      {tasks.length ? (
        <Table headers={["Task", "Due", "Assignee", "Status", "Action"]}>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>
                <strong>{t.title}</strong>
                <small>{t.priority} priority</small>
              </td>
              <td
                className={
                  t.status === "Open" && new Date(t.due_at) < new Date()
                    ? "overdue"
                    : ""
                }
              >
                {when(t.due_at)}
              </td>
              <td>
                {data.crmMembers.find((m) => m.id === t.assignee_id)?.name ||
                  "Former team member"}
              </td>
              <td>
                <Badge>{t.status}</Badge>
              </td>
              <td>
                {me.user.role !== "viewer" &&
                (me.user.role === "admin" ||
                  t.assignee_id === me.user.id ||
                  t.created_by === me.user.id) ? (
                  <button
                    onClick={() =>
                      open("task", t.record_type, t.record_id, t.id)
                    }
                  >
                    Review task
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <p className="muted">No tasks linked yet.</p>
      )}
      <Field label="Activity type">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {["All", "Call", "Meeting", "Email", "Note", "System"].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </Field>
      {timeline.length ? (
        <ol className="timeline">
          {timeline.map((a) => (
            <li key={a.id}>
              <strong>{a.title}</strong>
              <time>
                {when(a.date)} ·{" "}
                {a.kind === "Email" ? "Email · manually logged" : a.kind} ·{" "}
                {data.crmMembers.find((m) => m.id === a.actor)?.name ||
                  "Team member"}
              </time>
              {a.body ? <p className="preserve">{a.body}</p> : null}
              {a.outcome ? <p>Outcome: {a.outcome}</p> : null}
              {a.url ? (
                <a href={a.url} target="_blank" rel="noreferrer">
                  Open reference ↗
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No matching activity yet.</p>
      )}
    </section>
  );
}
export function Tasks({ data, me, open, entity }: Props & { entity: string }) {
  const [scope, setScope] = useState("mine"),
    [status, setStatus] = useState("Open"),
    [search, setSearch] = useState(""),
    [due, setDue] = useState("All");
  const tasks = data.crmTasks.filter((t) => {
    const linked =
      t.record_type === "deal"
        ? data.deals.find((d) => d.id === t.record_id)
        : t.record_type === "lead"
          ? data.leads.find((l) => l.id === t.record_id)
          : undefined;
    return (
      (scope === "all" || t.assignee_id === me.user.id) &&
      (status === "All" || t.status === status) &&
      (!linked || entity === "all" || linked.entity_id === entity) &&
      `${t.title} ${recordName(data, t.record_type, t.record_id)}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (due === "All" ||
        (due === "Overdue"
          ? t.status === "Open" && new Date(t.due_at) < new Date()
          : localDate(t.due_at).slice(0, 10) === today()))
    );
  });
  return (
    <>
      <Heading
        title="Tasks"
        subtitle="Your next actions, linked to the people and projects they belong to."
        action={me.user.role !== "viewer" ? "New task" : undefined}
        onAction={() => open("task", "", "")}
      />
      <div className="crm-filters">
        <Field label="Task owner">
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="mine">Assigned to me</option>
            <option value="all">All visible tasks</option>
          </select>
        </Field>
        <Field label="Task status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {["Open", "Done", "Cancelled", "All"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Due">
          <select value={due} onChange={(e) => setDue(e.target.value)}>
            {["All", "Today", "Overdue"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Search tasks">
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
      </div>
      {tasks.length ? (
        <Table
          headers={[
            "Task / record",
            "Due",
            "Priority",
            "Assignee",
            "Status",
            "Action",
          ]}
        >
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>
                <strong>{t.title}</strong>
                <a className="small" href={`#${t.record_type}/${t.record_id}`}>
                  {recordName(data, t.record_type, t.record_id)}
                </a>
              </td>
              <td
                className={
                  t.status === "Open" && new Date(t.due_at) < new Date()
                    ? "overdue"
                    : ""
                }
              >
                {when(t.due_at)}
              </td>
              <td>{t.priority}</td>
              <td>
                {data.crmMembers.find((m) => m.id === t.assignee_id)?.name ||
                  "Former team member"}
              </td>
              <td>
                <Badge>{t.status}</Badge>
              </td>
              <td>
                {me.user.role !== "viewer" &&
                (me.user.role === "admin" ||
                  t.assignee_id === me.user.id ||
                  t.created_by === me.user.id) ? (
                  <button
                    onClick={() =>
                      open("task", t.record_type, t.record_id, t.id)
                    }
                  >
                    Review task
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty title="No matching tasks">
          Change the filters or add a task from a contact, company, lead or
          deal.
        </Empty>
      )}
    </>
  );
}
export function LeadRecord({
  data,
  me,
  open,
  id,
  run,
}: Props & { id: string; run: (c: Record<string, unknown>) => Promise<void> }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    l = data.leads.find((l) => l.id === id);
  if (!l)
    return (
      <Empty title="Lead unavailable">Choose a lead you can access.</Empty>
    );
  const deal = data.deals.find((d) => d.lead_id === id),
    closed = ["Converted", "Disqualified"].includes(l.status),
    can = ["admin", "sales"].includes(me.user.role);
  async function convert() {
    setBusy(true);
    setError("");
    try {
      await run({ action: "lead.convert", id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <a className="back" href="#leads">
        ← All leads
      </a>
      <Heading
        title={l.title}
        action={can && l.status !== "Converted" ? "Update lead" : undefined}
        onAction={() => open("lead", "lead", id)}
      />
      {error ? <ErrorBox error={error} /> : null}
      <div className="panel">
        <Badge>{l.status}</Badge>
        <p>
          <a href={`#company/${l.company_id}`}>
            {recordName(data, "company", l.company_id)}
          </a>{" "}
          ·{" "}
          <a href={`#contact/${l.contact_id}`}>
            {recordName(data, "contact", l.contact_id)}
          </a>
        </p>
        <p>
          Service entity:{" "}
          {data.entities.find((e) => e.id === l.entity_id)?.name}
        </p>
        <p>
          {closed
            ? l.status === "Disqualified"
              ? `Disqualified: ${l.disqualified_reason}`
              : "Converted; commercial work continues on the deal."
            : `${l.next_action} · ${day(l.due_date)}`}
        </p>
        {deal ? (
          <a href={`#deal/${deal.id}`}>Open linked deal →</a>
        ) : can && !closed ? (
          <button disabled={busy} onClick={convert}>
            Qualify & create deal
          </button>
        ) : null}
      </div>
      <ProfileSummary value={l.profile || {}} data={data} />
      <CrmPanel
        {...{ data, me, open, type: "lead", id }}
        events={data.events.filter((e) => e.record_id === id)}
      />
    </>
  );
}
export function CrmEditor({
  state,
  data,
  me,
  save,
  createCompany,
  close,
}: {
  state: CrmEditorState;
  data: Data;
  me: Me;
  save: (c: Record<string, unknown>) => Promise<void>;
  createCompany: (c: Record<string, unknown>) => Promise<{ id: string }>;
  close: () => void;
}) {
  const isNew = !state.record_id;
  const [addingCompany, setAddingCompany] = useState(false);
  const [companyBusy, setCompanyBusy] = useState(false);
  const contact =
      data.contacts.find((c) => c.id === state.record_id) ||
      (state.mode === "contact"
        ? {
            id: "",
            version: 1,
            first_name: "",
            last_name: "",
            email: "",
            phone: "",
            title: "",
            source: "",
            notes: "",
            lifecycle: "Lead",
            additional_emails: [],
            additional_phones: [],
            address: "",
            social_url: "",
            tags: [],
            currency: "PKR",
            service_entity_id: null,
            marketing_consent: "Unknown",
            consent_date: null,
            consent_source: "",
            owner_id: me.user.id,
            profile: {},
          }
        : undefined),
    company =
      data.companies.find((c) => c.id === state.record_id) ||
      (state.mode === "company"
        ? {
            id: "",
            version: 1,
            name: "",
            trading_name: "",
            domain: "",
            industry: "",
            size: "",
            tax_id: "",
            address: "",
            shipping_address: "",
            customer: false,
            vendor: state.id === "vendor",
            service_entity_id: null,
            owner_id: me.user.id,
            profile: {},
          }
        : undefined),
    lead =
      data.leads.find((l) => l.id === state.record_id) ||
      (state.mode === "lead"
        ? {
            id: "",
            version: 1,
            title: "",
            source: "",
            status: "New",
            disqualified_reason: "",
            next_action: "",
            due_date: today(),
            company_id: "",
            contact_id: "",
            entity_id: "",
            owner_id: me.user.id,
            profile: {},
          }
        : undefined),
    deal = data.deals.find((d) => d.id === state.record_id),
    task = data.crmTasks.find((t) => t.id === state.id);
  const profileMode = ["contact", "company", "lead", "deal"].includes(
    state.mode,
  );
  const [profile, setProfile] = useState<ProfileValue>(() =>
    state.mode === "contact"
      ? contactProfile.parse(contact?.profile || {})
      : state.mode === "company"
        ? companyProfile.parse(company?.profile || {})
        : commercialProfile.parse(
            (state.mode === "deal" ? deal?.profile : lead?.profile) || {},
          ),
  );
  const [selectedCompany, setSelectedCompany] = useState(
    lead?.company_id || "",
  );
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [type, setType] = useState(state.record_type || "contact"),
    [record, setRecord] = useState(state.record_id || ""),
    [leadStatus, setLeadStatus] = useState(lead?.status || "New");
  const [emails, setEmails] = useState(contact?.additional_emails || []),
    [phones, setPhones] = useState(contact?.additional_phones || []);
  const title =
    state.mode === "activity"
      ? "Log activity"
      : state.mode === "task"
        ? task
          ? "Review task"
          : "New task"
        : state.mode === "lead"
          ? isNew
            ? "New lead"
            : "Update lead"
          : `${isNew ? "New" : "Edit"} ${state.mode}`;
  const input = (
    name: string,
    label: string,
    value: string = "",
    required = false,
    kind = "text",
  ) => (
    <Field label={label}>
      <input
        name={name}
        defaultValue={value}
        type={kind}
        required={required}
        maxLength={kind === "text" ? 200 : undefined}
      />
    </Field>
  );
  const root =
    type === "contact"
      ? data.contacts.find((c) => c.id === record)
      : type === "company"
        ? data.companies.find((c) => c.id === record)
        : type === "lead"
          ? data.leads.find((c) => c.id === record)
          : data.deals.find((c) => c.id === record);
  const assignees = data.crmMembers.filter(
    (m) =>
      m.role !== "viewer" &&
      (m.role !== "sales" || !root || root.owner_id === m.id),
  );
  const selectedAssignee = task?.assignee_id || me.user.id;
  const currentOwner =
    (state.mode === "contact"
      ? contact
      : state.mode === "company"
        ? company
        : state.mode === "lead"
          ? lead
          : deal
    )?.owner_id || me.user.id;
  const owners = data.crmMembers.filter(
    (m) =>
      m.role !== "viewer" &&
      (!["lead", "deal"].includes(state.mode) || m.role !== "finance") &&
      (me.user.role === "admin" || m.id === currentOwner),
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (addingCompany || companyBusy || busy) return;
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget),
      v = (k: string) => String(f.get(k) || "");
    try {
      let c: Record<string, unknown>;
      if (state.mode === "contact")
        c = {
          action: "profile.contact",
          ...(isNew ? {} : { id: contact!.id, version: contact!.version }),
          company_id: isNew ? v("company_id") || null : null,
          role: v("role") || "Contact",
          ...Object.fromEntries(
            [
              "first_name",
              "last_name",
              "email",
              "phone",
              "title",
              "source",
              "notes",
              "lifecycle",
              "address",
              "social_url",
              "currency",
              "marketing_consent",
              "consent_source",
            ].map((k) => [k, v(k)]),
          ),
          additional_emails: emails,
          additional_phones: phones,
          tags: v("tags")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          service_entity_id: v("service_entity_id") || null,
          consent_date: v("consent_date") || null,
        };
      else if (state.mode === "company")
        c = {
          action: "profile.company",
          ...(isNew ? {} : { id: company!.id, version: company!.version }),
          ...Object.fromEntries(
            [
              "name",
              "trading_name",
              "domain",
              "industry",
              "size",
              "tax_id",
              "address",
              "shipping_address",
            ].map((k) => [k, v(k)]),
          ),
          customer: f.has("customer"),
          vendor: f.has("vendor"),
          service_entity_id: v("service_entity_id") || null,
        };
      else if (state.mode === "lead")
        c = {
          action: "profile.lead",
          ...(isNew ? {} : { id: lead!.id, version: lead!.version }),
          company_id: isNew ? v("company_id") : lead!.company_id,
          contact_id: isNew ? v("contact_id") : lead!.contact_id,
          entity_id: isNew ? v("entity_id") : lead!.entity_id,
          title: v("title"),
          source: v("source"),
          status: leadStatus,
          next_action: v("next_action"),
          due_date: v("due_date") || null,
          reason: v("reason"),
        };
      else if (state.mode === "deal")
        c = {
          action: "profile.deal",
          id: deal!.id,
          version: deal!.version,
          name: v("name"),
        };
      else if (state.mode === "activity")
        c = {
          action: "crm.activity",
          record_type: type,
          record_id: record,
          kind: v("kind"),
          subject: v("subject"),
          body: v("body"),
          occurred_at: new Date(v("occurred_at")).toISOString(),
          outcome: v("outcome"),
          reference_url: v("reference_url"),
          request_key: state.key,
        };
      else
        c = {
          action: task ? "crm.task-edit" : "crm.task",
          ...(task
            ? { id: task.id, version: task.version, status: v("status") }
            : { record_type: type, record_id: record, request_key: state.key }),
          title: v("title"),
          notes: v("notes"),
          due_at: new Date(v("due_at")).toISOString(),
          priority: v("priority"),
          assignee_id: v("assignee_id"),
        };
      if (profileMode) {
        c.profile = profile;
        c.owner_id = v("owner_id");
      }
      await save(c);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      title={title}
      dirty={dirty}
      close={() => {
        if (!busy && !companyBusy) close();
      }}
    >
      <form
        className="editor-body billing-editor"
        onSubmit={submit}
        onChange={() => setDirty(true)}
      >
        <fieldset disabled={busy}>
          {error ? <ErrorBox error={error} /> : null}
          {state.mode === "contact" && contact ? (
            <>
              <div className="form-row">
                {input("first_name", "First name", contact.first_name, true)}
                {input("last_name", "Last name", contact.last_name)}
              </div>
              {input("title", "Job title", contact.title)}
              {input("email", "Primary email", contact.email, false, "email")}
              {input("phone", "Primary phone", contact.phone)}
              {isNew ? (
                <>
                  <ContactCompanyField
                    companies={data.companies}
                    create={createCompany}
                    onOpenChange={setAddingCompany}
                    onBusyChange={setCompanyBusy}
                    onChange={() => setDirty(true)}
                  />
                  {input("role", "Relationship role", "Contact")}
                </>
              ) : null}
              <details open={!isNew}>
                <summary>Communication, relationship and preferences</summary>
                <h3>Additional email addresses</h3>
                {emails.map((email, n) => (
                  <div className="crm-channel" key={n}>
                    <Field label={`Email ${n + 2} label`}>
                      <input
                        value={email.label}
                        required
                        maxLength={200}
                        onChange={(e) =>
                          setEmails(
                            emails.map((x, i) =>
                              i === n ? { ...x, label: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label={`Email ${n + 2}`}>
                      <input
                        type="email"
                        value={email.value}
                        required
                        onChange={(e) =>
                          setEmails(
                            emails.map((x, i) =>
                              i === n ? { ...x, value: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </Field>
                    <button
                      type="button"
                      aria-label={`Remove email ${n + 2}`}
                      onClick={() => {
                        setEmails(emails.filter((_, i) => i !== n));
                        setDirty(true);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={emails.length >= 10}
                  onClick={() => {
                    setEmails([...emails, { label: "Work", value: "" }]);
                    setDirty(true);
                  }}
                >
                  Add email
                </button>
                <h3>Additional phone numbers</h3>
                {phones.map((phone, n) => (
                  <div className="crm-channel" key={n}>
                    <Field label={`Phone ${n + 2} type`}>
                      <select
                        value={phone.label}
                        onChange={(e) =>
                          setPhones(
                            phones.map((x, i) =>
                              i === n ? { ...x, label: e.target.value } : x,
                            ),
                          )
                        }
                      >
                        {["Work", "Mobile", "Home", "Other"].map((k) => (
                          <option key={k}>{k}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label={`Phone ${n + 2}`}>
                      <input
                        value={phone.value}
                        required
                        maxLength={80}
                        onChange={(e) =>
                          setPhones(
                            phones.map((x, i) =>
                              i === n ? { ...x, value: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </Field>
                    <button
                      type="button"
                      aria-label={`Remove phone ${n + 2}`}
                      onClick={() => {
                        setPhones(phones.filter((_, i) => i !== n));
                        setDirty(true);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={phones.length >= 10}
                  onClick={() => {
                    setPhones([...phones, { label: "Mobile", value: "" }]);
                    setDirty(true);
                  }}
                >
                  Add phone
                </button>
                <h3>Relationship</h3>
                <Field label="Lifecycle stage">
                  <select name="lifecycle" defaultValue={contact.lifecycle}>
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
                </Field>
                {input("source", "Lead source", contact.source)}
                {input(
                  "tags",
                  "Tags (comma separated)",
                  contact.tags.join(", "),
                )}
                <Field label="Address">
                  <textarea
                    name="address"
                    defaultValue={contact.address}
                    maxLength={4000}
                  />
                </Field>
                {input(
                  "social_url",
                  "Social profile (HTTPS)",
                  contact.social_url,
                  false,
                  "url",
                )}
                <Field label="Default currency">
                  <select name="currency" defaultValue={contact.currency}>
                    {["PKR", "USD", "AED", "EUR", "GBP"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Usually serviced by">
                  <select
                    name="service_entity_id"
                    defaultValue={contact.service_entity_id || ""}
                  >
                    <option value="">Choose for each project</option>
                    {data.entities.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="muted">
                  This is a preference, not a restriction. Existing deals and
                  financial documents keep their issuing entity.
                </p>
                <h3>Communication preference</h3>
                <Field label="Marketing consent">
                  <select
                    name="marketing_consent"
                    defaultValue={contact.marketing_consent}
                  >
                    {["Unknown", "Opted in", "Opted out"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </Field>
                {input(
                  "consent_date",
                  "Consent date",
                  contact.consent_date?.slice(0, 10) || "",
                  false,
                  "date",
                )}
                {input(
                  "consent_source",
                  "Consent source / evidence",
                  contact.consent_source,
                )}
                <Field label="Contact notes">
                  <textarea
                    name="notes"
                    defaultValue={contact.notes}
                    maxLength={4000}
                  />
                </Field>
              </details>
            </>
          ) : state.mode === "company" && company ? (
            <>
              {input("name", "Company name", company.name, true)}
              {input("trading_name", "Trading name", company.trading_name)}
              {input("domain", "Website domain", company.domain)}
              {input("industry", "Industry", company.industry)}
              {input("size", "Company size", company.size)}
              {input("tax_id", "Tax registration", company.tax_id)}
              <Field label="Billing address">
                <textarea
                  name="address"
                  defaultValue={company.address}
                  maxLength={4000}
                />
              </Field>
              <Field label="Shipping address">
                <textarea
                  name="shipping_address"
                  defaultValue={company.shipping_address}
                  maxLength={4000}
                />
              </Field>
              <div className="checks">
                <label>
                  <input
                    type="checkbox"
                    name="customer"
                    defaultChecked={company.customer}
                  />
                  Customer
                </label>
                <label>
                  <input
                    type="checkbox"
                    name="vendor"
                    defaultChecked={company.vendor}
                  />
                  Vendor
                </label>
              </div>
              <Field label="Usually serviced by">
                <select
                  name="service_entity_id"
                  defaultValue={company.service_entity_id || ""}
                >
                  <option value="">Choose for each project</option>
                  {data.entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="muted">
                Changes do not rewrite the customer name, addresses or entity on
                existing quotes and invoices.
              </p>
            </>
          ) : state.mode === "lead" && lead ? (
            <>
              {isNew ? (
                <>
                  <Field label="Company">
                    <select
                      name="company_id"
                      required
                      value={selectedCompany}
                      onChange={(e) => setSelectedCompany(e.target.value)}
                    >
                      <option value="">Choose company</option>
                      {data.companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Contact">
                    <select name="contact_id" required key={selectedCompany}>
                      <option value="">Choose associated contact</option>
                      {data.contacts
                        .filter((c) =>
                          data.affiliations.some(
                            (a) =>
                              a.company_id === selectedCompany &&
                              a.contact_id === c.id &&
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
                  <Field label="Legal entity">
                    <select name="entity_id" required>
                      <option value="">Choose explicitly</option>
                      {data.entities.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name} ({e.code})
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              ) : null}
              {input("title", "Lead title", lead.title, true)}
              {input("source", "Lead source", lead.source)}
              <Field label="Lead status">
                <select
                  value={leadStatus}
                  onChange={(e) => setLeadStatus(e.target.value)}
                >
                  {[
                    "New",
                    "Attempted",
                    "Connected",
                    "Qualified",
                    "Disqualified",
                  ].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              {leadStatus === "Disqualified" ? (
                input(
                  "reason",
                  "Disqualification reason",
                  lead.disqualified_reason,
                  true,
                )
              ) : (
                <>
                  {input(
                    "next_action",
                    "Next action",
                    lead.next_action || "",
                    true,
                  )}
                  {input(
                    "due_date",
                    "Next action due",
                    lead.due_date || today(),
                    true,
                    "date",
                  )}
                </>
              )}
            </>
          ) : state.mode === "deal" && deal ? (
            input("name", "Deal name", deal.name, true)
          ) : (
            <>
              {state.record_id ? (
                <p>Linked to {recordName(data, type, record)}</p>
              ) : (
                <>
                  <Field label="Record type">
                    <select
                      value={type}
                      onChange={(e) => {
                        setType(e.target.value);
                        setRecord("");
                      }}
                    >
                      {["contact", "company", "lead", "deal"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Linked record">
                    <select
                      required
                      value={record}
                      onChange={(e) => setRecord(e.target.value)}
                    >
                      <option value="">Choose a record</option>
                      {(type === "contact"
                        ? data.contacts
                        : type === "company"
                          ? data.companies
                          : type === "lead"
                            ? data.leads
                            : data.deals
                      ).map((r) => (
                        <option key={r.id} value={r.id}>
                          {recordName(data, type, r.id)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
              {state.mode === "activity" ? (
                <>
                  <Field label="Activity kind">
                    <select name="kind">
                      {["Call", "Meeting", "Email", "Note"].map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  </Field>
                  {input("subject", "Subject", "", true)}
                  {input(
                    "occurred_at",
                    "Occurred at (local time)",
                    localDate(new Date().toISOString()),
                    true,
                    "datetime-local",
                  )}
                  <Field label="Activity notes">
                    <textarea name="body" maxLength={4000} />
                  </Field>
                  {input("outcome", "Outcome")}
                  {input(
                    "reference_url",
                    "Reference link (HTTPS)",
                    "",
                    false,
                    "url",
                  )}
                  <p className="muted">
                    This is a manual log. A pasted email link does not verify
                    delivery or sync your inbox. Nothing is sent.
                  </p>
                </>
              ) : (
                <>
                  {input("title", "Task title", task?.title || "", true)}
                  <Field label="Task notes">
                    <textarea
                      name="notes"
                      defaultValue={task?.notes || ""}
                      maxLength={4000}
                    />
                  </Field>
                  {input(
                    "due_at",
                    "Due at (local time)",
                    localDate(task?.due_at || new Date().toISOString()),
                    true,
                    "datetime-local",
                  )}
                  <Field label="Priority">
                    <select
                      name="priority"
                      defaultValue={task?.priority || "Normal"}
                    >
                      {["Low", "Normal", "High"].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Assignee">
                    <select
                      name="assignee_id"
                      key={record}
                      defaultValue={
                        assignees.some((m) => m.id === selectedAssignee)
                          ? selectedAssignee
                          : ""
                      }
                      required
                    >
                      <option value="" disabled>
                        Choose an active teammate
                      </option>
                      {assignees.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {task ? (
                    <Field label="Task status">
                      <select name="status" defaultValue={task.status}>
                        {["Open", "Done", "Cancelled"].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </Field>
                  ) : null}
                  <p className="muted">
                    Shown in Tasks and the linked record. Completing a task does
                    not close a lead or deal. No email or device reminders are
                    sent.
                  </p>
                </>
              )}
            </>
          )}
          {profileMode ? (
            <>
              <Field label="Record owner">
                <select name="owner_id" defaultValue={currentOwner}>
                  {!owners.some((m) => m.id === currentOwner) ? (
                    <option value={currentOwner}>
                      Current owner (unavailable; ask an administrator to
                      reassign)
                    </option>
                  ) : null}
                  {owners.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
              <details open={!isNew}>
                <summary>Full details and custom fields</summary>
                <ProfileFields
                  kind={state.mode}
                  value={profile}
                  onChange={(v) => {
                    setProfile(v);
                    setDirty(true);
                  }}
                  data={data}
                />
              </details>
            </>
          ) : null}
          <button
            type="submit"
            className="primary"
            disabled={addingCompany || companyBusy}
          >
            {busy
              ? "Saving…"
              : state.mode === "activity"
                ? "Save activity"
                : state.mode === "task"
                  ? "Save task"
                  : isNew
                    ? "Save"
                    : "Save changes"}
          </button>
        </fieldset>
      </form>
    </Drawer>
  );
}
