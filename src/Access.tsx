import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Heading, Field, Table, ErrorBox, Drawer } from "./components";
import { request, day, type Me } from "./model";
import {
  capabilities,
  hasCapability,
  roles as policyRoles,
  type Capability,
} from "../shared/permissions";

const roles = [
  ["sales", "Sales — own CRM and quotes"],
  ["finance", "Finance — books and shared contacts"],
  ["viewer", "Viewer — read-only CRM and sales"],
  ["admin", "Administrator — all current modules and team access"],
] as const;
type Role = (typeof roles)[number][0];
function RoleSelect({
  value,
  onChange,
  ...labelProps
}: {
  value: Role;
  onChange: (value: Role) => void;
  id?: string;
  "aria-describedby"?: string;
}) {
  return (
    <select
      {...labelProps}
      value={value}
      onChange={(e) => onChange(e.target.value as Role)}
    >
      {roles.map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  );
}
function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
async function switchTo(id: string, me: Me) {
  await request("organizations/switch", "POST", { id }, me.csrf);
  // Clear all in-memory records, selected entity, editors and CSRF together.
  location.hash = "home";
  location.reload();
}
interface OrgList {
  organizations: { id: string; name: string; role: string }[];
  invitations: {
    id: string;
    organization: string;
    role: string;
    expires_at: string;
  }[];
}
export function Organizations({ me }: { me: Me }) {
  const q = useQuery({
      queryKey: ["organizations", me.user.id],
      queryFn: () => request<OrgList>("organizations"),
    }),
    action = useAction();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Heading
        title={me.onboarding ? "Welcome to your workspace" : "Organizations"}
        subtitle="One organization groups your team, shared CRM and legal entities. Organizations are completely separate workspaces."
        action="Create organization"
        onAction={() => setCreating(true)}
      />
      {action.error || q.error ? (
        <ErrorBox error={action.error || q.error!.message} />
      ) : null}
      {q.isPending ? <p aria-busy="true">Loading your organizations…</p> : null}
      <div className="access-grid">
        {q.data?.organizations.map((o) => (
          <section className="panel access-card" key={o.id}>
            <h2>{o.name}</h2>
            <p className="muted">Your role: {o.role}</p>
            <button
              disabled={action.busy || o.id === me.organization.id}
              onClick={() => void action.run(() => switchTo(o.id, me))}
            >
              {o.id === me.organization.id
                ? "Current organization"
                : "Open organization"}
            </button>
          </section>
        ))}
      </div>
      {!q.isPending && !q.error && !q.data?.organizations.length ? (
        <section className="panel">
          <h2>No organization yet</h2>
          <p>
            Create one for your business, or ask its administrator to invite{" "}
            <strong>{me.user.email}</strong>. If your company already has a
            workspace, join it rather than creating a duplicate.
          </p>
        </section>
      ) : null}
      <section className="panel">
        <h2>Invitations for {me.user.email}</h2>
        <p>
          Only invitations addressed to your signed-in email can be accepted.
        </p>
        {q.data?.invitations.length ? (
          q.data.invitations.map((i) => (
            <div className="invitation-row" key={i.id}>
              <div>
                <strong>{i.organization}</strong>
                <p className="muted">
                  {i.role} · expires {day(i.expires_at)}
                </p>
              </div>
              <button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    try {
                      const joined = await request<{ id: string }>(
                        "team/accept-invitation",
                        "POST",
                        { id: i.id },
                        me.csrf,
                      );
                      await switchTo(joined.id, me);
                    } finally {
                      await q.refetch();
                    }
                  })
                }
              >
                Accept invitation
              </button>
            </div>
          ))
        ) : (
          <p className="muted">No pending invitations.</p>
        )}
      </section>
      {creating ? (
        <CreateOrganization me={me} close={() => setCreating(false)} />
      ) : null}
    </>
  );
}
function CreateOrganization({ me, close }: { me: Me; close: () => void }) {
  const [name, setName] = useState(""),
    [entityName, setEntityName] = useState(""),
    [entityCode, setEntityCode] = useState(""),
    [requestKey] = useState(() => crypto.randomUUID()),
    action = useAction();
  return (
    <Drawer
      title="Create organization"
      close={close}
      dirty={!!(name || entityName || entityCode)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const created = await request<{ id: string }>(
              "organizations",
              "POST",
              { name, entityName, entityCode, requestKey },
              me.csrf,
            );
            await switchTo(created.id, me);
          });
        }}
      >
        <div className="editor-body">
          <p>
            Your shared workspace can contain multiple invoicing legal entities.
            Start with the first one here.
          </p>
          <Field label="Organization name">
            <input
              required
              minLength={2}
              maxLength={150}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="First legal entity name">
            <input
              required
              minLength={2}
              maxLength={150}
              value={entityName}
              onChange={(e) => setEntityName(e.target.value)}
            />
          </Field>
          <Field
            label="Entity code"
            hint="2–8 uppercase letters or numbers, for example PVT."
          >
            <input
              required
              pattern="[A-Z0-9]{2,8}"
              maxLength={8}
              value={entityCode}
              onChange={(e) => setEntityCode(e.target.value.toUpperCase())}
            />
          </Field>
          <p className="muted">
            Base currency: PKR. A starter chart of accounts is created with no
            opening balances. Review it before entering financial records.
          </p>
          {action.error ? <ErrorBox error={action.error} /> : null}
        </div>
        <div className="editor-footer">
          <button
            type="button"
            disabled={action.busy}
            onClick={() => {
              if (
                !(name || entityName || entityCode) ||
                confirm("Discard your unsaved changes?")
              )
                close();
            }}
          >
            Cancel
          </button>
          <button className="primary" disabled={action.busy}>
            {action.busy ? "Creating…" : "Create and open"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  version: number;
  role_profile_id: string | null;
  entity_ids: string[] | null;
}
interface Invitation {
  id: string;
  email: string;
  role: Role;
  role_profile_id: string | null;
  entity_ids: string[] | null;
  expires_at: string;
  accepted_by: string | null;
  revoked_at: string | null;
}
type Template = Exclude<Role, "admin">;
interface RoleProfile {
  id: string;
  name: string;
  base_role: Template;
  capabilities: Capability[];
  version: number;
}
const roleLabel = (
  role: Role,
  profileId: string | null,
  profiles?: RoleProfile[],
) => {
  const profile = profileId && profiles?.find((p) => p.id === profileId);
  return profile ? `${profile.name} (${role} template)` : role;
};
// A custom role narrows one built-in template; admins always keep full access.
function ProfileSelect({
  role,
  value,
  onChange,
  profiles,
  ...labelProps
}: {
  role: Role;
  value: string | null;
  onChange: (value: string | null) => void;
  profiles: RoleProfile[];
  id?: string;
  "aria-describedby"?: string;
}) {
  const options = profiles.filter((p) => p.base_role === role);
  return (
    <select
      {...labelProps}
      value={value || ""}
      disabled={role === "admin" || !options.length}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">
        {role === "admin"
          ? "Not available for administrators"
          : options.length
            ? "None — full template permissions"
            : "No custom roles for this template"}
      </option>
      {options.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
interface LegalEntity {
  id: string;
  code: string;
  name: string;
}
const entityLabel = (ids: string[] | null, entities: LegalEntity[] = []) =>
  ids
    ? entities
        .filter((e) => ids.includes(e.id))
        .map((e) => e.code)
        .join(", ")
    : "All entities";
// Null grants every legal entity. Administrators always keep every entity.
function EntityAccess({
  role,
  value,
  onChange,
  entities,
}: {
  role: Role;
  value: string[] | null;
  onChange: (value: string[] | null) => void;
  entities: LegalEntity[];
}) {
  if (role === "admin")
    return (
      <p className="muted">Administrators always have every legal entity.</p>
    );
  return (
    <fieldset className="role-permissions">
      <legend>Legal entities</legend>
      <div className="check">
        <label>
          <input
            type="radio"
            checked={value === null}
            onChange={() => onChange(null)}
          />
          All legal entities, including ones added later
        </label>
      </div>
      <div className="check">
        <label>
          <input
            type="radio"
            checked={value !== null}
            onChange={() => onChange(value ?? [])}
          />
          Only selected legal entities
        </label>
      </div>
      {value !== null
        ? entities.map((e) => (
            <div key={e.id} className="check entity-choice">
              <label>
                <input
                  type="checkbox"
                  checked={value.includes(e.id)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...value, e.id]
                        : value.filter((id) => id !== e.id),
                    )
                  }
                />
                {e.code} — {e.name}
              </label>
            </div>
          ))
        : null}
      {value !== null && !value.length ? (
        <small className="muted">Choose at least one legal entity.</small>
      ) : null}
      <small className="muted">
        Books, quotes, deals and leads of other entities are hidden. Contacts
        and companies stay shared.
      </small>
    </fieldset>
  );
}
const sameEntities = (a: string[] | null, b: string[] | null) =>
  a === b ||
  (!!a && !!b && a.length === b.length && a.every((id) => b.includes(id)));
export function Team({ me }: { me: Me }) {
  const cache = useQueryClient();
  const q = useQuery({
    queryKey: ["team", me.organization.id],
    queryFn: () =>
      request<{
        members: Member[];
        invitations: Invitation[];
        profiles: RoleProfile[];
        entities: LegalEntity[];
      }>("team"),
    enabled: me.user.role === "admin",
  });
  const [member, setMember] = useState<Member | null>(null),
    [email, setEmail] = useState(""),
    [role, setRole] = useState<Role>("sales"),
    [inviteProfile, setInviteProfile] = useState<string | null>(null),
    [inviteEntities, setInviteEntities] = useState<string[] | null>(null),
    [profile, setProfile] = useState<RoleProfile | "new" | null>(null),
    [link, setLink] = useState(""),
    action = useAction();
  async function refresh() {
    await Promise.all([
      q.refetch(),
      cache.invalidateQueries({ queryKey: ["data"] }),
    ]);
  }
  if (me.user.role !== "admin")
    return (
      <>
        <Heading title="Team & access" />
        <p>Only an organization administrator can manage team access.</p>
      </>
    );
  return (
    <>
      <Heading
        title="Team & access"
        subtitle={`Manage access to ${me.organization.name}. Changes are recorded in the activity log.`}
      />
      <details>
        <summary>Built-in role permissions</summary>
        <p>
          Current action permissions are shared by the interface and server.
          Sales ownership checks still apply. Viewer access is read-only CRM and
          sales, not accounting. Custom roles below can narrow a template.
          Per-entity grants are not available yet.
        </p>
        <Table
          label="Built-in role permissions"
          headers={[
            "Action",
            ...policyRoles.map((r) => r[0].toUpperCase() + r.slice(1)),
          ]}
        >
          {capabilities.map((c) => (
            <tr key={c.key}>
              <td>{c.label}</td>
              {policyRoles.map((r) => (
                <td key={r}>
                  {hasCapability(r, c.key) ? "Allowed" : "Not allowed"}
                </td>
              ))}
            </tr>
          ))}
        </Table>
      </details>
      {action.error || q.error ? (
        <ErrorBox error={action.error || q.error!.message} />
      ) : null}
      <section className="panel">
        <h2>Invite a teammate</h2>
        <p>
          Invitations expire after seven days. Create a link and share it
          yourself; this app does not send an email.
        </p>
        {me.mode === "sample" ? (
          <p className="notice">
            Sample preview: access changes are demonstrations only. Real
            accounts require the configured secure sign-in service.
          </p>
        ) : null}
        <form
          className="invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const r = await request<{ id: string }>(
                "team/invite",
                "POST",
                {
                  email,
                  role,
                  roleProfileId: inviteProfile,
                  entityIds: inviteEntities,
                },
                me.csrf,
              );
              setLink(`${location.origin}/#join/${r.id}`);
              setEmail("");
              setInviteProfile(null);
              setInviteEntities(null);
              await refresh();
            });
          }}
        >
          <Field label="Teammate email">
            <input
              type="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Invitation role">
            <RoleSelect
              value={role}
              onChange={(r) => {
                setRole(r);
                setInviteProfile(null);
                if (r === "admin") setInviteEntities(null);
              }}
            />
          </Field>
          <Field label="Invitation custom role">
            <ProfileSelect
              role={role}
              value={inviteProfile}
              onChange={setInviteProfile}
              profiles={q.data?.profiles || []}
            />
          </Field>
          <EntityAccess
            role={role}
            value={inviteEntities}
            onChange={setInviteEntities}
            entities={q.data?.entities || []}
          />
          <button
            className="primary"
            disabled={action.busy || inviteEntities?.length === 0}
          >
            {action.busy ? "Saving…" : "Create invitation"}
          </button>
        </form>
        {link ? (
          <Field
            label="Invitation link"
            hint="The recipient must sign in using the invited, verified email. Select and copy this link."
          >
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
          </Field>
        ) : null}
      </section>
      <section className="panel">
        <h2>Members</h2>
        <p className="muted">
          Changing a role or removing access signs that person out of this
          organization. At least one administrator must remain active.
        </p>
        {q.isPending ? (
          <p aria-busy="true">Loading team…</p>
        ) : (
          <Table headers={["Person", "Role", "Entities", "Access", "Actions"]}>
            {q.data?.members.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>
                    {m.name}
                    {m.id === me.user.id ? " (you)" : ""}
                  </strong>
                  <small>{m.email}</small>
                </td>
                <td>
                  {roleLabel(m.role, m.role_profile_id, q.data?.profiles)}
                </td>
                <td>{entityLabel(m.entity_ids, q.data?.entities)}</td>
                <td>{m.active ? "Active" : "Removed"}</td>
                <td>
                  <button
                    aria-label={`Manage ${m.name}`}
                    onClick={() => setMember(m)}
                  >
                    Manage
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Custom roles</h2>
          <button onClick={() => setProfile("new")}>New custom role</button>
        </div>
        <p className="muted">
          A custom role starts from a built-in template and can only remove
          permissions. Saving a change signs out everyone assigned to it.
        </p>
        {q.data?.profiles.length ? (
          <Table
            label="Custom roles"
            headers={["Role", "Template", "Permissions", "Actions"]}
          >
            {q.data.profiles.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.name}</strong>
                </td>
                <td>{p.base_role}</td>
                <td>
                  {p.capabilities.length
                    ? capabilities
                        .filter((c) => p.capabilities.includes(c.key))
                        .map((c) => c.label)
                        .join(", ")
                    : "Read-only"}
                </td>
                <td>
                  <button
                    aria-label={`Edit ${p.name}`}
                    onClick={() => setProfile(p)}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="muted">No custom roles yet.</p>
        )}
      </section>
      <section className="panel">
        <h2>Invitations</h2>
        {q.data?.invitations.length ? (
          <Table headers={["Email", "Role", "Entities", "Status", "Actions"]}>
            {q.data.invitations.map((i) => {
              const status = i.accepted_by
                ? "Accepted"
                : i.revoked_at
                  ? "Revoked"
                  : Date.parse(i.expires_at) < Date.now()
                    ? "Expired"
                    : "Pending";
              return (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td>
                    {roleLabel(i.role, i.role_profile_id, q.data?.profiles)}
                  </td>
                  <td>{entityLabel(i.entity_ids, q.data?.entities)}</td>
                  <td>
                    {status}
                    <small>Expires {day(i.expires_at)}</small>
                  </td>
                  <td>
                    {status === "Pending" ? (
                      <div className="row-actions">
                        <button
                          onClick={() =>
                            setLink(`${location.origin}/#join/${i.id}`)
                          }
                        >
                          Show link
                        </button>
                        <button
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              if (
                                !confirm(
                                  `Revoke the invitation for ${i.email}?`,
                                )
                              )
                                return;
                              await request(
                                "team/revoke-invitation",
                                "POST",
                                { id: i.id },
                                me.csrf,
                              );
                              setLink("");
                              await refresh();
                            })
                          }
                        >
                          Revoke
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <p className="muted">No invitations created yet.</p>
        )}
      </section>
      {member ? (
        <MemberEditor
          key={member.id}
          member={member}
          me={me}
          profiles={q.data?.profiles || []}
          entities={q.data?.entities || []}
          close={() => setMember(null)}
          saved={refresh}
        />
      ) : null}
      {profile ? (
        <ProfileEditor
          key={profile === "new" ? "new" : profile.id}
          profile={profile === "new" ? null : profile}
          me={me}
          close={() => setProfile(null)}
          saved={refresh}
        />
      ) : null}
    </>
  );
}
const requires: Partial<Record<Capability, Capability>> = {
  "books.post": "books.view",
  "crm.sales": "contacts.manage",
};
function ProfileEditor({
  profile,
  me,
  close,
  saved,
}: {
  profile: RoleProfile | null;
  me: Me;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [name, setName] = useState(profile?.name || ""),
    [base, setBase] = useState<Template>(profile?.base_role || "sales"),
    [selected, setSelected] = useState<Capability[]>(
      profile?.capabilities ||
        capabilities
          .filter((c) => hasCapability("sales", c.key))
          .map((c) => c.key),
    ),
    action = useAction();
  const allowed = capabilities.filter((c) => hasCapability(base, c.key));
  const dirty = profile
    ? name !== profile.name ||
      [...selected].sort().join() !== [...profile.capabilities].sort().join()
    : !!name;
  function toggle(key: Capability, on: boolean) {
    let next = on ? [...selected, key] : selected.filter((k) => k !== key);
    // Keep dependent permissions valid instead of letting the server reject them.
    for (const [cap, needs] of Object.entries(requires) as [
      Capability,
      Capability,
    ][]) {
      if (on && key === cap && !next.includes(needs)) next.push(needs);
      if (!on && key === needs) next = next.filter((k) => k !== cap);
    }
    setSelected([...new Set(next)]);
  }
  return (
    <Drawer
      title={profile ? `Edit ${profile.name}` : "New custom role"}
      close={close}
      dirty={dirty}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            if (
              profile &&
              !confirm(
                `Save ${name}? Everyone assigned to this role will be signed out of this organization.`,
              )
            )
              return;
            await request(
              "team/role",
              "POST",
              {
                ...(profile
                  ? { id: profile.id, version: profile.version }
                  : {}),
                name,
                baseRole: base,
                capabilities: selected.filter((k) => hasCapability(base, k)),
              },
              me.csrf,
            );
            await saved();
            close();
          });
        }}
      >
        <div className="editor-body">
          <Field label="Role name">
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Template"
            hint={
              profile
                ? "The template cannot change after creation. Create another role instead."
                : "Permissions can be removed from the template, never added."
            }
          >
            <select
              value={base}
              disabled={!!profile}
              onChange={(e) => {
                const next = e.target.value as Template;
                setBase(next);
                setSelected(
                  capabilities
                    .filter((c) => hasCapability(next, c.key))
                    .map((c) => c.key),
                );
              }}
            >
              {roles
                .filter(([id]) => id !== "admin")
                .map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
            </select>
          </Field>
          <fieldset className="role-permissions">
            <legend>Permissions</legend>
            {allowed.length ? (
              allowed.map((c) => (
                <div key={c.key} className="check">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(c.key)}
                      aria-describedby={
                        requires[c.key] ? `needs-${c.key}` : undefined
                      }
                      onChange={(e) => toggle(c.key, e.target.checked)}
                    />
                    {c.label}
                  </label>
                  {requires[c.key] ? (
                    <small id={`needs-${c.key}`} className="muted">
                      Also needs “
                      {
                        capabilities.find((x) => x.key === requires[c.key])
                          ?.label
                      }
                      ”
                    </small>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="muted">This template is read-only.</p>
            )}
          </fieldset>
          <p className="muted">
            Sales ownership limits still apply. Unchecked permissions are
            enforced by the server.
          </p>
          {action.error ? <ErrorBox error={action.error} /> : null}
        </div>
        <div className="editor-footer">
          <button
            type="button"
            onClick={() => {
              if (!dirty || confirm("Discard your unsaved changes?")) close();
            }}
            disabled={action.busy}
          >
            Cancel
          </button>
          <button className="primary" disabled={action.busy || !dirty}>
            {action.busy ? "Saving…" : profile ? "Save role" : "Create role"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
function MemberEditor({
  member,
  me,
  profiles,
  entities,
  close,
  saved,
}: {
  member: Member;
  me: Me;
  profiles: RoleProfile[];
  entities: LegalEntity[];
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [role, setRole] = useState(member.role),
    [profileId, setProfileId] = useState(member.role_profile_id),
    [active, setActive] = useState(member.active),
    [entityIds, setEntityIds] = useState(member.entity_ids),
    action = useAction();
  const dirty =
    role !== member.role ||
    active !== member.active ||
    profileId !== member.role_profile_id ||
    !sameEntities(entityIds, member.entity_ids);
  return (
    <Drawer title={`Access for ${member.name}`} close={close} dirty={dirty}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            if (
              !confirm(
                `Save access for ${member.name}? Their sessions in this organization will end.`,
              )
            )
              return;
            const result = await request<{ self: boolean }>(
              "team/member",
              "POST",
              {
                userId: member.id,
                role,
                active,
                version: member.version,
                roleProfileId: profileId,
                entityIds: role === "admin" ? null : entityIds,
              },
              me.csrf,
            );
            if (result.self) {
              location.reload();
              return;
            }
            await saved();
            close();
          });
        }}
      >
        <div className="editor-body">
          <p>{member.email}</p>
          <Field label="Role">
            <RoleSelect
              value={role}
              onChange={(r) => {
                setRole(r);
                setProfileId(null);
              }}
            />
          </Field>
          <Field label="Custom role">
            <ProfileSelect
              role={role}
              value={profileId}
              onChange={setProfileId}
              profiles={profiles}
            />
          </Field>
          <EntityAccess
            role={role}
            value={entityIds}
            onChange={setEntityIds}
            entities={entities}
          />
          <Field label="Organization access">
            <select
              value={active ? "active" : "removed"}
              onChange={(e) => setActive(e.target.value === "active")}
            >
              <option value="active">Active</option>
              <option value="removed">
                Removed — cannot open this organization
              </option>
            </select>
          </Field>
          <p>
            Removing access keeps their records and audit history. An
            administrator can restore their membership here later.
          </p>
          {action.error ? <ErrorBox error={action.error} /> : null}
        </div>
        <div className="editor-footer">
          <button
            type="button"
            onClick={() => {
              if (!dirty || confirm("Discard your unsaved changes?")) close();
            }}
            disabled={action.busy}
          >
            Cancel
          </button>
          <button
            className="primary"
            disabled={
              action.busy ||
              !dirty ||
              (role !== "admin" && entityIds?.length === 0)
            }
          >
            {action.busy ? "Saving…" : "Save access"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
export function Onboarding({ me }: { me: Me }) {
  const action = useAction();
  return (
    <main className="onboarding">
      <div className="toolbar">
        <a href="#home" className="brand">
          <span className="brand-mark">gv</span>
          <strong>Workspace</strong>
        </a>
        <button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await request("logout", "POST", {}, me.csrf);
              location.reload();
            })
          }
        >
          Sign out
        </button>
      </div>
      {action.error ? <ErrorBox error={action.error} /> : null}
      <Organizations me={me} />
    </main>
  );
}
