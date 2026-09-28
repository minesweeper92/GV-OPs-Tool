import { randomUUID as uuid } from "node:crypto";
import { type SQL, type Row } from "./db.ts";
import { type Context, Problem, audit } from "./domain.ts";
const tables: Record<string, string> = {
  contact: "contacts",
  company: "companies",
  lead: "leads",
  deal: "deals",
};
async function record(tx: SQL, ctx: Context, type: string, id: string) {
  const table = tables[type];
  if (!table) throw new Problem(400, "Choose a supported CRM record.");
  const r = (
    await tx.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id])
  ).rows[0];
  if (!r) throw new Problem(404, "Record not found in this organization.");
  if (ctx.role === "sales" && r.owner_id !== ctx.userId)
    throw new Problem(403, "This record belongs to another team member.");
  return r;
}
function version(r: Row, c: Row) {
  if (r.version !== c.version)
    throw new Problem(409, "This record has changed. Refresh before editing.");
}
async function assignee(tx: SQL, ctx: Context, id: string, root: Row) {
  const m = (
    await tx.query("SELECT role FROM memberships WHERE user_id=$1 AND active", [
      id,
    ])
  ).rows[0];
  if (!m || m.role === "viewer")
    throw new Problem(
      409,
      "Choose an active team member who can update tasks.",
    );
  if (ctx.role === "sales" && id !== ctx.userId)
    throw new Problem(403, "Sales reps can assign tasks only to themselves.");
  if (m.role === "sales" && root.owner_id !== id)
    throw new Problem(409, "That sales rep cannot access the linked record.");
}
async function retry(tx: SQL, table: string, c: Row) {
  const r = (
    await tx.query(
      `SELECT id,request_payload FROM ${table} WHERE request_key=$1`,
      [c.request_key],
    )
  ).rows[0];
  if (
    r &&
    JSON.stringify(Object.entries(r.request_payload).sort()) !==
      JSON.stringify(Object.entries(c).sort())
  )
    throw new Problem(409, "Retry key already used for different details.");
  return r;
}
export async function executeCrm(tx: SQL, ctx: Context, c: Row) {
  if (ctx.role === "viewer")
    throw new Problem(403, "Read-only users cannot change CRM records.");
  let id = c.id || uuid(),
    auditRoot = c.record_id || c.id || id;
  if (c.action === "crm.contact-edit") {
    const r = await record(tx, ctx, "contact", id);
    version(r, c);
    if (
      c.service_entity_id &&
      !(
        await tx.query("SELECT id FROM entities WHERE id=$1", [
          c.service_entity_id,
        ])
      ).rows.length
    )
      throw new Problem(404, "Service entity not found.");
    if (
      c.marketing_consent !== "Unknown" &&
      (!c.consent_date || !c.consent_source)
    )
      throw new Problem(
        400,
        "Record the date and source of the communication preference.",
      );
    if (
      c.consent_date &&
      c.consent_date > new Date().toISOString().slice(0, 10)
    )
      throw new Problem(400, "Consent cannot be future-dated.");
    const emails = [c.email, ...c.additional_emails.map((x: Row) => x.value)]
      .filter(Boolean)
      .map((e: string) => e.toLowerCase());
    if (new Set(emails).size !== emails.length)
      throw new Problem(400, "Each email address must be listed once.");
    const fields = [
      "first_name",
      "last_name",
      "email",
      "phone",
      "title",
      "source",
      "notes",
      "lifecycle",
      "additional_emails",
      "additional_phones",
      "address",
      "social_url",
      "tags",
      "currency",
      "service_entity_id",
      "marketing_consent",
      "consent_date",
      "consent_source",
    ];
    const values = fields.map((k) =>
      k === "email"
        ? c[k].toLowerCase()
        : k === "additional_emails"
          ? JSON.stringify(
              c[k].map((x: Row) => ({ ...x, value: x.value.toLowerCase() })),
            )
          : k === "additional_phones"
            ? JSON.stringify(c[k])
            : k === "tags"
              ? [...new Set(c.tags)]
              : c[k],
    );
    await tx.query(
      `UPDATE contacts SET ${fields.map((k, n) => `${k}=$${n + 2}`).join(",")} WHERE id=$1`,
      [id, ...values],
    );
  } else if (c.action === "crm.company-edit") {
    const r = await record(tx, ctx, "company", id);
    version(r, c);
    if (
      c.service_entity_id &&
      !(
        await tx.query("SELECT id FROM entities WHERE id=$1", [
          c.service_entity_id,
        ])
      ).rows.length
    )
      throw new Problem(404, "Service entity not found.");
    if (
      (r.customer &&
        !c.customer &&
        (
          await tx.query("SELECT id FROM deals WHERE company_id=$1 LIMIT 1", [
            id,
          ])
        ).rows.length) ||
      (r.vendor &&
        !c.vendor &&
        (
          await tx.query("SELECT id FROM bills WHERE vendor_id=$1 LIMIT 1", [
            id,
          ])
        ).rows.length)
    )
      throw new Problem(
        409,
        "Keep customer/vendor classification while commercial records use it.",
      );
    const fields = [
      "name",
      "trading_name",
      "domain",
      "industry",
      "size",
      "tax_id",
      "address",
      "shipping_address",
      "customer",
      "vendor",
      "service_entity_id",
    ];
    await tx.query(
      `UPDATE companies SET ${fields.map((k, n) => `${k}=$${n + 2}`).join(",")} WHERE id=$1`,
      [id, ...fields.map((k) => c[k])],
    );
  } else if (c.action === "crm.lead-edit") {
    if (ctx.role === "finance")
      throw new Problem(403, "A sales role is required to qualify leads.");
    const r = await record(tx, ctx, "lead", id);
    version(r, c);
    if (r.status === "Converted")
      throw new Problem(
        409,
        "This lead is already converted. Update its deal instead.",
      );
    const closed = c.status === "Disqualified";
    if (closed && !c.reason)
      throw new Problem(400, "Give a reason for disqualifying this lead.");
    if (!closed && (!c.next_action || !c.due_date))
      throw new Problem(
        400,
        "Enter a next action and due date for an open lead.",
      );
    await tx.query(
      "UPDATE leads SET title=$2,source=$3,status=$4,next_action=$5,due_date=$6,disqualified_reason=$7 WHERE id=$1",
      [
        id,
        c.title,
        c.source,
        c.status,
        closed ? null : c.next_action,
        closed ? null : c.due_date,
        closed ? c.reason : "",
      ],
    );
  } else if (c.action === "crm.activity" || c.action === "crm.task") {
    const root = await record(tx, ctx, c.record_type, c.record_id),
      table = c.action === "crm.activity" ? "crm_activities" : "crm_tasks",
      prior = await retry(tx, table, c);
    if (prior) return { id: prior.id };
    if (c.action === "crm.activity") {
      if (new Date(c.occurred_at).getTime() > Date.now() + 60000)
        throw new Problem(
          400,
          "Log completed activity; schedule future work as a task.",
        );
      await tx.query(
        "INSERT INTO crm_activities(id,tenant_id,record_type,record_id,kind,subject,body,occurred_at,outcome,reference_url,actor_id,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          id,
          ctx.tenantId,
          c.record_type,
          c.record_id,
          c.kind,
          c.subject,
          c.body,
          c.occurred_at,
          c.outcome,
          c.reference_url,
          ctx.userId,
          c.request_key,
          JSON.stringify(c),
        ],
      );
    } else {
      await assignee(tx, ctx, c.assignee_id, root);
      await tx.query(
        "INSERT INTO crm_tasks(id,tenant_id,record_type,record_id,title,notes,due_at,priority,assignee_id,created_by,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          id,
          ctx.tenantId,
          c.record_type,
          c.record_id,
          c.title,
          c.notes,
          c.due_at,
          c.priority,
          c.assignee_id,
          ctx.userId,
          c.request_key,
          JSON.stringify(c),
        ],
      );
    }
  } else if (c.action === "crm.task-edit") {
    const r = (
      await tx.query("SELECT * FROM crm_tasks WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!r) throw new Problem(404, "Task not found.");
    const root = await record(tx, ctx, r.record_type, r.record_id);
    auditRoot = root.id;
    version(r, c);
    await assignee(tx, ctx, c.assignee_id, root);
    if (
      ctx.role !== "admin" &&
      r.assignee_id !== ctx.userId &&
      r.created_by !== ctx.userId
    )
      throw new Problem(
        403,
        "Only the assignee, creator or administrator can edit this task.",
      );
    await tx.query(
      "UPDATE crm_tasks SET title=$2,notes=$3,due_at=$4,priority=$5,assignee_id=$6,status=$7,completed_at=CASE WHEN $7='Done' THEN coalesce(completed_at,now()) ELSE NULL END WHERE id=$1",
      [id, c.title, c.notes, c.due_at, c.priority, c.assignee_id, c.status],
    );
  }
  await audit(tx, ctx, auditRoot, c.action, { ...c, crm_record_id: id });
  return { id };
}
export async function crmSnapshot(tx: SQL, ctx: Context) {
  // Root-record visibility is checked independently of task assignment. Assignment
  // never grants access to another rep's contact or commercial history.
  const visible = `EXISTS(SELECT 1 FROM contacts c WHERE r.record_type='contact' AND c.id=r.record_id AND c.owner_id=$1) OR EXISTS(SELECT 1 FROM companies c WHERE r.record_type='company' AND c.id=r.record_id AND c.owner_id=$1) OR EXISTS(SELECT 1 FROM leads c WHERE r.record_type='lead' AND c.id=r.record_id AND c.owner_id=$1) OR EXISTS(SELECT 1 FROM deals c WHERE r.record_type='deal' AND c.id=r.record_id AND c.owner_id=$1)`;
  const read = (table: string, order: string) =>
    tx
      .query(
        `SELECT r.* FROM ${table} r ${ctx.role === "sales" ? `WHERE ${visible}` : ""} ORDER BY ${order}`,
        ctx.role === "sales" ? [ctx.userId] : [],
      )
      .then((r) => r.rows);
  return {
    crmActivities: await read("crm_activities", "occurred_at DESC"),
    crmTasks: await read("crm_tasks", "due_at,id"),
  };
}
