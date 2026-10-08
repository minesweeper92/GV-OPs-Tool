import { lazy, Suspense, useState } from "react";
import {
  ArrowLeft,
  Building2,
  CalendarPlus,
  Mail,
  Phone,
  StickyNote,
} from "lucide-react";
import type { Data, Me, Editor } from "./model";
import { day } from "./model";
import type { CrmOpen } from "./Crm";
import { Badge, Empty } from "./components";
import { ProfileSummary } from "./ProfileFields";

const CrmPanel = lazy(() =>
  import("./Crm").then((m) => ({ default: m.CrmPanel })),
);

export function ContactRecord({
  id,
  data,
  me,
  edit,
  crmEdit,
}: {
  id: string;
  data: Data;
  me: Me;
  edit: (e: Editor) => void;
  crmEdit: CrmOpen;
}) {
  const [tab, setTab] = useState<"Overview" | "Activities">("Overview");
  const contact = data.contacts.find((c) => c.id === id);
  if (!contact)
    return (
      <Empty title="Contact unavailable">
        This contact may not belong to your organization or role.
      </Empty>
    );
  const name = `${contact.first_name} ${contact.last_name}`.trim();
  const affiliations = data.affiliations.filter((a) => a.contact_id === id);
  const current = affiliations.filter((a) => !a.ended_on);
  const leads = data.leads.filter((l) => l.contact_id === id);
  const deals = data.deals.filter((d) => d.contact_id === id);
  const relatedIds = new Set([
    id,
    ...leads.map((l) => l.id),
    ...deals.map((d) => d.id),
  ]);
  const events = data.events.filter(
    (e) => relatedIds.has(e.record_id) || e.details.contact_id === id,
  );
  const activities = data.crmActivities.filter((a) =>
    relatedIds.has(a.record_id),
  );
  const tasks = data.crmTasks.filter(
    (t) => relatedIds.has(t.record_id) && t.status === "Open",
  );
  const recentTasks = data.crmTasks
    .filter((t) => relatedIds.has(t.record_id))
    .slice(0, 5);
  const latest = [...activities].sort((a, b) =>
    b.occurred_at.localeCompare(a.occurred_at),
  )[0];
  const owner =
    data.crmMembers.find((m) => m.id === contact.owner_id)?.name ||
    "Former team member";
  const canEdit = me.user.role !== "viewer";
  const canCreateLead = ["admin", "sales"].includes(me.user.role);
  const quick = (kind: string) => crmEdit("activity", "contact", id, kind);
  return (
    <>
      <a className="back" href="#contacts">
        <ArrowLeft size={15} /> All contacts
      </a>
      <div className="contact-record-layout">
        <aside className="contact-profile-card" aria-label="Contact profile">
          <div className="contact-avatar" aria-hidden="true">
            {(
              contact.first_name[0] ||
              contact.last_name[0] ||
              "?"
            ).toUpperCase()}
          </div>
          <h1>{name}</h1>
          <p className="muted">
            {contact.title || "No job title"}
            {current.length
              ? ` · ${current
                  .map(
                    (a) =>
                      data.companies.find((c) => c.id === a.company_id)?.name,
                  )
                  .filter(Boolean)
                  .join(", ")}`
              : ""}
          </p>
          {contact.email ? (
            <a href={`mailto:${contact.email}`}>{contact.email}</a>
          ) : (
            <span className="muted">No email saved</span>
          )}
          {contact.additional_emails.map((email) => (
            <a key={email.value} href={`mailto:${email.value}`}>
              {email.label}: {email.value}
            </a>
          ))}
          {contact.phone ? (
            <a href={`tel:${contact.phone}`}>{contact.phone}</a>
          ) : null}
          {canEdit ? (
            <div className="contact-quick-actions" aria-label="Contact actions">
              <button onClick={() => quick("Note")}>
                <StickyNote size={17} /> Note
              </button>
              <button onClick={() => quick("Email")}>
                <Mail size={17} /> Log email
              </button>
              <button onClick={() => quick("Call")}>
                <Phone size={17} /> Call
              </button>
              <button onClick={() => crmEdit("task", "contact", id)}>
                <CalendarPlus size={17} /> Task
              </button>
              <button onClick={() => quick("Meeting")}>
                <CalendarPlus size={17} /> Meeting
              </button>
            </div>
          ) : null}
          <div className="section-title contact-section-title">
            <h2>About this contact</h2>
            {canEdit ? (
              <button onClick={() => crmEdit("contact", "contact", id)}>
                Edit contact
              </button>
            ) : null}
          </div>
          <dl className="contact-properties">
            <dt>Contact owner</dt>
            <dd>{owner}</dd>
            <dt>Lifecycle stage</dt>
            <dd>
              <Badge>{contact.lifecycle}</Badge>
            </dd>
            <dt>Lead status</dt>
            <dd>{contact.profile?.lead_status || "New"}</dd>
            <dt>Job title</dt>
            <dd>{contact.title || "Not set"}</dd>
            <dt>Source</dt>
            <dd>{contact.source || "Not set"}</dd>
            <dt>Phone</dt>
            <dd>{contact.phone || "Not set"}</dd>
            <dt>Primary email</dt>
            <dd>{contact.email || "Not set"}</dd>
            <dt>Usually serviced by</dt>
            <dd>
              {data.entities.find((e) => e.id === contact.service_entity_id)
                ?.name || "Choose for each project"}
            </dd>
            <dt>Tags</dt>
            <dd>{contact.tags.join(", ") || "None"}</dd>
          </dl>
          <details className="contact-more">
            <summary>More properties</summary>
            <dl className="contact-properties">
              <dt>Additional emails</dt>
              <dd>
                {contact.additional_emails
                  .map((e) => `${e.label}: ${e.value}`)
                  .join(" · ") || "None"}
              </dd>
              <dt>Additional phones</dt>
              <dd>
                {contact.additional_phones
                  .map((p) => `${p.label}: ${p.value}`)
                  .join(" · ") || "None"}
              </dd>
              <dt>Address</dt>
              <dd>{contact.address || "Not set"}</dd>
              <dt>Notes</dt>
              <dd>{contact.notes || "None"}</dd>
              <dt>Currency</dt>
              <dd>{contact.currency}</dd>
            </dl>
          </details>
          <ProfileSummary value={contact.profile || {}} data={data} />
        </aside>
        <section className="contact-workspace" aria-label="Contact workspace">
          <div
            className="contact-tabs"
            role="tablist"
            aria-label="Contact view"
          >
            {(["Overview", "Activities"] as const).map((value) => (
              <button
                key={value}
                role="tab"
                id={`contact-tab-${value}`}
                aria-controls="contact-tab-panel"
                tabIndex={tab === value ? 0 : -1}
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                onKeyDown={(e) => {
                  if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                  ) {
                    e.preventDefault();
                    const next =
                      e.key === "Home"
                        ? "Overview"
                        : e.key === "End"
                          ? "Activities"
                          : tab === "Overview"
                            ? "Activities"
                            : "Overview";
                    setTab(next);
                    document.getElementById(`contact-tab-${next}`)?.focus();
                  }
                }}
              >
                {value}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="contact-tab-panel"
            aria-labelledby={`contact-tab-${tab}`}
          >
            {tab === "Overview" ? (
              <>
                <div className="contact-highlight-grid">
                  <div>
                    <span>Open tasks</span>
                    <strong>{tasks.length}</strong>
                  </div>
                  <div>
                    <span>Last activity</span>
                    <strong>
                      {latest ? day(latest.occurred_at) : "None recorded"}
                    </strong>
                  </div>
                  <div>
                    <span>Deals</span>
                    <strong>{deals.length}</strong>
                  </div>
                </div>
                <section className="contact-panel">
                  <div className="section-title">
                    <h2>Recent activity</h2>
                    <button onClick={() => setTab("Activities")}>
                      View all
                    </button>
                  </div>
                  {latest ? (
                    <p>
                      <Badge>{latest.kind}</Badge>{" "}
                      <strong>{latest.subject}</strong>
                      <br />
                      <small>{day(latest.occurred_at)}</small>
                    </p>
                  ) : (
                    <p className="muted">
                      No activity logged yet. Use Note, Call, Email or Meeting
                      above to record an interaction.
                    </p>
                  )}
                </section>
                <section className="contact-panel">
                  <h2>Tasks</h2>
                  {recentTasks.length ? (
                    recentTasks.map((t) => (
                      <div className="association-item" key={t.id}>
                        <strong>{t.title}</strong>
                        <Badge>{t.status}</Badge>
                        <small>Due {day(t.due_at)}</small>
                        <button
                          onClick={() => crmEdit("task", "contact", id, t.id)}
                        >
                          Review task
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="muted">Nothing due for this contact.</p>
                  )}
                </section>
              </>
            ) : (
              <Suspense fallback={<p>Loading activity…</p>}>
                <CrmPanel
                  data={data}
                  me={me}
                  open={crmEdit}
                  type="contact"
                  id={id}
                  events={events}
                />
              </Suspense>
            )}
          </div>
        </section>
        <aside className="contact-related" aria-label="Related records">
          <section>
            <div className="section-title">
              <h2>
                Companies <small>{affiliations.length}</small>
              </h2>
              {canEdit ? (
                <button onClick={() => edit({ kind: "association", id })}>
                  Add
                </button>
              ) : null}
            </div>
            {affiliations.length ? (
              affiliations.map((a) => (
                <div className="association-item" key={a.id}>
                  <a href={`#company/${a.company_id}`}>
                    <Building2 size={15} />{" "}
                    {data.companies.find((c) => c.id === a.company_id)?.name ||
                      "Company"}
                  </a>
                  <small>
                    {a.role} ·{" "}
                    {a.ended_on
                      ? `${day(a.started_on)}–${day(a.ended_on)}`
                      : `Since ${day(a.started_on)}`}
                  </small>
                  {!a.ended_on && canEdit ? (
                    <button
                      onClick={() =>
                        edit({ kind: "end-association", id: a.id })
                      }
                    >
                      End association
                    </button>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="muted">No company linked yet.</p>
            )}
          </section>
          <section>
            <div className="section-title">
              <h2>
                Leads <small>{leads.length}</small>
              </h2>
              {canCreateLead ? (
                <button onClick={() => edit({ kind: "lead", id })}>Add</button>
              ) : null}
            </div>
            {leads.map((l) => (
              <a className="association-item" href={`#lead/${l.id}`} key={l.id}>
                <strong>{l.title}</strong>
                <Badge>{l.status}</Badge>
              </a>
            ))}
          </section>
          <section>
            <div className="section-title">
              <h2>
                Deals <small>{deals.length}</small>
              </h2>
            </div>
            {deals.map((d) => (
              <a className="association-item" href={`#deal/${d.id}`} key={d.id}>
                <strong>{d.name}</strong>
                <Badge>{d.stage}</Badge>
              </a>
            ))}
          </section>
        </aside>
      </div>
    </>
  );
}
