import { randomUUID as uuid } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL, Row } from "./db.ts";
import { Problem, audit, type Context } from "./domain.ts";
import { minor } from "../shared/money.ts";
import { hasCapability } from "../shared/permissions.ts";
import { scheduleProblem, type ReminderStep } from "../shared/collections.ts";

const day = (v: unknown) => String(v).slice(0, 10);
const plusDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
async function row(tx: SQL, sql: string, params: unknown[], missing: string) {
  const r = (await tx.query(sql, params)).rows[0];
  if (!r) throw new Problem(404, missing);
  return r;
}
// Row-level security already hides other tenants and legal entities the
// person cannot open, so "not found" covers both without revealing which.
const entityRow = (tx: SQL, id: string) =>
  row(
    tx,
    "SELECT id,code,name FROM entities WHERE id=$1 FOR UPDATE",
    [id],
    "Legal entity not found.",
  );
const invoiceRow = (tx: SQL, id: string) =>
  row(
    tx,
    "SELECT * FROM invoices WHERE id=$1 FOR UPDATE",
    [id],
    "Invoice not found in this organization.",
  );
async function customerRow(tx: SQL, id: string) {
  const c = await row(
    tx,
    "SELECT id,name,customer FROM companies WHERE id=$1",
    [id],
    "Customer not found in this organization.",
  );
  if (!c.customer)
    throw new Problem(400, "This company is not marked as a customer.");
  return c;
}
const balance = (i: Row) =>
  BigInt(i.total_minor) - BigInt(i.paid_minor) - BigInt(i.credited_minor);
// Collections work is assigned only to active finance or administrator
// members who can open the legal entity concerned.
async function assignable(
  tx: SQL,
  ctx: Context,
  userId: string,
  entityId: string,
) {
  const m = (
    await tx.query(
      "SELECT role,active,entity_ids FROM memberships WHERE tenant_id=$1 AND user_id=$2",
      [ctx.tenantId, userId],
    )
  ).rows[0];
  if (!m || !m.active || !["admin", "finance"].includes(m.role))
    throw new Problem(
      409,
      "Choose an active finance or administrator team member.",
    );
  if (m.entity_ids && !m.entity_ids.includes(entityId))
    throw new Problem(409, "That team member cannot open this legal entity.");
}
async function retried(tx: SQL, table: string, c: Row) {
  const prior = (
    await tx.query(
      `SELECT id,request_payload FROM ${table} WHERE request_key=$1`,
      [c.request_key],
    )
  ).rows[0];
  if (prior && !isDeepStrictEqual(prior.request_payload, c))
    throw new Problem(409, "This retry key was used for different details.");
  return prior ? { id: prior.id as string } : null;
}
async function task(
  tx: SQL,
  ctx: Context,
  companyId: string,
  title: string,
  notes: string,
  due: string,
  assignee: string,
  priority: "Normal" | "High",
) {
  const id = uuid();
  await tx.query(
    "INSERT INTO crm_tasks(id,tenant_id,record_type,record_id,title,notes,due_at,priority,assignee_id,created_by,request_key,request_payload) VALUES($1,$2,'company',$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      id,
      ctx.tenantId,
      companyId,
      title,
      notes,
      `${due}T09:00:00Z`,
      priority,
      assignee,
      ctx.userId,
      uuid(),
      JSON.stringify({ source: "collections" }),
    ],
  );
  return id;
}
async function activity(
  tx: SQL,
  ctx: Context,
  companyId: string,
  kind: string,
  subject: string,
  body: string,
  on: string,
) {
  const id = uuid();
  await tx.query(
    "INSERT INTO crm_activities(id,tenant_id,record_type,record_id,kind,subject,body,occurred_at,actor_id,request_key,request_payload) VALUES($1,$2,'company',$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      id,
      ctx.tenantId,
      companyId,
      kind,
      subject.slice(0, 200),
      body,
      `${on}T09:00:00Z`,
      ctx.userId,
      uuid(),
      JSON.stringify({ source: "collections" }),
    ],
  );
  return id;
}
const actor = (ctx: Context) => ctx.name || "Team member";

// Called by sales workflows before a new quote or invoice is created or
// issued. A "warn" hold is shown in the interface and never blocks.
export async function assertSaleAllowed(
  tx: SQL,
  entityId: string,
  companyId: string | null | undefined,
) {
  if (!companyId) return;
  const hold = (
    await tx.query(
      `SELECT h.reason FROM customer_credit_holds h WHERE h.entity_id=$1 AND h.company_id=$2 AND h.mode='block'
        AND NOT EXISTS(SELECT 1 FROM customer_credit_hold_releases r WHERE r.hold_id=h.id) LIMIT 1`,
      [entityId, companyId],
    )
  ).rows[0];
  if (hold)
    throw new Problem(
      409,
      `New sales to this customer are on credit hold in this legal entity: ${hold.reason}. Finance can release the hold under Collections.`,
    );
}

export async function executeCollection(tx: SQL, ctx: Context, c: Row) {
  if (c.action === "collection.schedule-save") return saveSchedule(tx, ctx, c);
  if (!hasCapability(ctx, "books.post"))
    throw new Problem(
      403,
      "Permission to record financial transactions is required for collections.",
    );
  const id = uuid(),
    t = ctx.tenantId;
  if (c.action === "collection.contact") {
    const entity = await entityRow(tx, c.entity_id);
    const prior = await retried(tx, "collection_contacts", c);
    if (prior) return prior;
    const company = await customerRow(tx, c.company_id);
    let invoice: Row | null = null;
    if (c.invoice_id) {
      invoice = await invoiceRow(tx, c.invoice_id);
      if (invoice.entity_id !== entity.id || invoice.company_id !== company.id)
        throw new Problem(
          400,
          "That invoice belongs to a different customer or legal entity.",
        );
    }
    if ((c.promise_date === null) !== (c.promise_amount === null))
      throw new Problem(
        400,
        "A promise to pay needs both a date and an amount.",
      );
    if (c.promise_date && c.promise_date < c.contacted_on)
      throw new Problem(
        400,
        "A promise to pay cannot be dated before the contact.",
      );
    const promise = c.promise_amount === null ? null : minor(c.promise_amount);
    if (promise !== null && promise <= 0n)
      throw new Problem(400, "Enter the amount the customer promised.");
    const follow = c.next_action !== "";
    if (
      follow !== (c.next_action_due !== null) ||
      follow !== (c.assignee_id !== null)
    )
      throw new Problem(
        400,
        "A next action needs a due date and someone responsible.",
      );
    if (follow) await assignable(tx, ctx, c.assignee_id, entity.id);
    const about = invoice ? invoice.number : "account";
    const body = [
      c.summary,
      c.promise_date
        ? `Promised ${c.promise_amount} ${invoice?.currency || ""} by ${c.promise_date}.`.replace(
            "  ",
            " ",
          )
        : "",
      follow ? `Next: ${c.next_action} (due ${c.next_action_due}).` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const activityId = await activity(
      tx,
      ctx,
      company.id,
      c.kind,
      `Collections · ${about} · ${entity.code}`,
      body,
      c.contacted_on,
    );
    const taskId = follow
      ? await task(
          tx,
          ctx,
          company.id,
          c.next_action,
          `Collections follow-up for ${company.name} (${about}, ${entity.code}).`,
          c.next_action_due,
          c.assignee_id,
          "Normal",
        )
      : null;
    await tx.query(
      "INSERT INTO collection_contacts(id,tenant_id,entity_id,company_id,invoice_id,kind,summary,contacted_on,promise_date,promise_amount_minor,next_action,next_action_due,assignee_id,activity_id,task_id,created_by,created_by_name,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
      [
        id,
        t,
        entity.id,
        company.id,
        invoice?.id || null,
        c.kind,
        c.summary,
        c.contacted_on,
        c.promise_date,
        promise === null ? null : String(promise),
        c.next_action,
        c.next_action_due,
        c.assignee_id,
        activityId,
        taskId,
        ctx.userId,
        actor(ctx),
        c.request_key,
        JSON.stringify(c),
      ],
    );
    await audit(tx, ctx, invoice?.id || company.id, c.action, {
      actorName: ctx.name || null,
      contactId: id,
      text: `Logged a collections ${c.kind.toLowerCase()} with ${company.name} about ${about}${c.promise_date ? `; promise to pay by ${c.promise_date}` : ""}.`,
    });
    return { id };
  }
  if (c.action === "collection.dispute-open") {
    const i = await invoiceRow(tx, c.invoice_id);
    const prior = await retried(tx, "invoice_disputes", c);
    if (prior) return prior;
    if (i.status !== "Issued" || balance(i) <= 0n)
      throw new Problem(
        409,
        "Only an issued invoice with a balance can be disputed.",
      );
    const amount = minor(c.amount);
    if (amount <= 0n || amount > balance(i))
      throw new Problem(
        400,
        "The disputed amount must be within the invoice balance.",
      );
    if (c.date < day(i.issue_date))
      throw new Problem(400, "A dispute cannot be dated before the invoice.");
    const open = (
      await tx.query(
        "SELECT d.id FROM invoice_disputes d WHERE d.invoice_id=$1 AND NOT EXISTS(SELECT 1 FROM invoice_dispute_resolutions r WHERE r.dispute_id=d.id)",
        [i.id],
      )
    ).rows[0];
    if (open)
      throw new Problem(409, "This invoice already has an open dispute.");
    await assignable(tx, ctx, c.owner_id, i.entity_id);
    const taskId = await task(
      tx,
      ctx,
      i.company_id,
      `Resolve dispute on ${i.number}`,
      `Customer disputes ${c.amount} ${i.currency}: ${c.reason}`,
      plusDays(c.date, 7),
      c.owner_id,
      "High",
    );
    await activity(
      tx,
      ctx,
      i.company_id,
      "Note",
      `Dispute opened · ${i.number}`,
      `Disputed ${c.amount} ${i.currency}: ${c.reason}`,
      c.date,
    );
    await tx.query(
      "INSERT INTO invoice_disputes(id,tenant_id,entity_id,company_id,invoice_id,reason,amount_minor,owner_id,task_id,opened_by,opened_by_name,opened_on,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
      [
        id,
        t,
        i.entity_id,
        i.company_id,
        i.id,
        c.reason,
        String(amount),
        c.owner_id,
        taskId,
        ctx.userId,
        actor(ctx),
        c.date,
        c.request_key,
        JSON.stringify(c),
      ],
    );
    await audit(tx, ctx, i.id, c.action, {
      actorName: ctx.name || null,
      text: `Flagged ${i.number} as disputed for ${c.amount} ${i.currency}: ${c.reason}. Reminders are paused and a task was assigned.`,
    });
    return { id };
  }
  if (c.action === "collection.dispute-resolve") {
    const d = await row(
      tx,
      "SELECT * FROM invoice_disputes WHERE id=$1 FOR UPDATE",
      [c.id],
      "Dispute not found in this organization.",
    );
    const prior = (
      await tx.query(
        "SELECT * FROM invoice_dispute_resolutions WHERE dispute_id=$1",
        [d.id],
      )
    ).rows[0];
    if (prior) {
      if (
        day(prior.resolved_on) !== c.date ||
        prior.resolution !== c.resolution
      )
        throw new Problem(
          409,
          "This dispute was already resolved with different details.",
        );
      return { id: prior.id };
    }
    if (c.date < day(d.opened_on))
      throw new Problem(
        400,
        "A dispute cannot be resolved before it was opened.",
      );
    await tx.query(
      "INSERT INTO invoice_dispute_resolutions(id,tenant_id,dispute_id,resolution,resolved_on,resolved_by,resolved_by_name) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, t, d.id, c.resolution, c.date, ctx.userId, actor(ctx)],
    );
    await tx.query(
      "UPDATE crm_tasks SET status='Done',completed_at=now() WHERE id=$1 AND status='Open'",
      [d.task_id],
    );
    await activity(
      tx,
      ctx,
      d.company_id,
      "Note",
      "Dispute resolved",
      c.resolution,
      c.date,
    );
    await audit(tx, ctx, d.invoice_id, c.action, {
      actorName: ctx.name || null,
      text: `Resolved the dispute: ${c.resolution}. Reminders can resume.`,
    });
    return { id };
  }
  if (c.action === "collection.hold-place") {
    const entity = await entityRow(tx, c.entity_id);
    const prior = await retried(tx, "customer_credit_holds", c);
    if (prior) return prior;
    const company = await customerRow(tx, c.company_id);
    const active = (
      await tx.query(
        "SELECT h.id FROM customer_credit_holds h WHERE h.entity_id=$1 AND h.company_id=$2 AND NOT EXISTS(SELECT 1 FROM customer_credit_hold_releases r WHERE r.hold_id=h.id)",
        [entity.id, company.id],
      )
    ).rows[0];
    if (active)
      throw new Problem(
        409,
        "This customer already has a credit hold in this legal entity. Release it before placing another.",
      );
    await tx.query(
      "INSERT INTO customer_credit_holds(id,tenant_id,entity_id,company_id,mode,reason,placed_by,placed_by_name,placed_on,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
        t,
        entity.id,
        company.id,
        c.mode,
        c.reason,
        ctx.userId,
        actor(ctx),
        c.date,
        c.request_key,
        JSON.stringify(c),
      ],
    );
    await activity(
      tx,
      ctx,
      company.id,
      "Note",
      `Credit hold placed · ${entity.code}`,
      `${c.mode === "block" ? "New sales are blocked" : "New sales show a warning"}: ${c.reason}`,
      c.date,
    );
    await audit(tx, ctx, company.id, c.action, {
      actorName: ctx.name || null,
      text: `Placed a credit hold on ${company.name} in ${entity.code} (${c.mode === "block" ? "blocks" : "warns on"} new sales): ${c.reason}.`,
    });
    return { id };
  }
  if (c.action === "collection.hold-release") {
    const h = await row(
      tx,
      "SELECT * FROM customer_credit_holds WHERE id=$1 FOR UPDATE",
      [c.id],
      "Credit hold not found in this organization.",
    );
    const prior = (
      await tx.query(
        "SELECT * FROM customer_credit_hold_releases WHERE hold_id=$1",
        [h.id],
      )
    ).rows[0];
    if (prior) {
      if (day(prior.released_on) !== c.date || prior.reason !== c.reason)
        throw new Problem(
          409,
          "This credit hold was already released with different details.",
        );
      return { id: prior.id };
    }
    if (c.date < day(h.placed_on))
      throw new Problem(400, "A hold cannot be released before it was placed.");
    await tx.query(
      "INSERT INTO customer_credit_hold_releases(id,tenant_id,hold_id,reason,released_on,released_by,released_by_name) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, t, h.id, c.reason, c.date, ctx.userId, actor(ctx)],
    );
    await activity(
      tx,
      ctx,
      h.company_id,
      "Note",
      "Credit hold released",
      c.reason,
      c.date,
    );
    await audit(tx, ctx, h.company_id, c.action, {
      actorName: ctx.name || null,
      text: `Released the credit hold: ${c.reason}.`,
    });
    return { id };
  }
  if (c.action === "collection.followup") {
    const i = await invoiceRow(tx, c.invoice_id);
    const schedule = (
      await tx.query(
        "SELECT * FROM reminder_schedules WHERE entity_id=$1 ORDER BY version DESC LIMIT 1",
        [i.entity_id],
      )
    ).rows[0];
    const step = (schedule?.steps as ReminderStep[] | undefined)?.find(
      (s) => s.key === c.step_key,
    );
    if (!schedule || !step)
      throw new Problem(
        409,
        "That reminder step is not in the current schedule. Refresh and try again.",
      );
    const prior = (
      await tx.query(
        "SELECT * FROM reminder_followups WHERE invoice_id=$1 AND step_key=$2",
        [i.id, c.step_key],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.outcome !== c.outcome ||
        prior.note !== c.note ||
        day(prior.followed_up_on) !== c.date
      )
        throw new Problem(409, "This reminder step was already followed up.");
      return { id: prior.id };
    }
    if (i.status !== "Issued" || balance(i) <= 0n)
      throw new Problem(409, "This invoice no longer has a balance to chase.");
    if (c.date < plusDays(day(i.due_date), step.offset_days))
      throw new Problem(409, "This reminder step is not due yet.");
    const disputed = (
      await tx.query(
        "SELECT 1 FROM invoice_disputes d WHERE d.invoice_id=$1 AND NOT EXISTS(SELECT 1 FROM invoice_dispute_resolutions r WHERE r.dispute_id=d.id)",
        [i.id],
      )
    ).rows.length;
    if (disputed && c.outcome !== "Skipped")
      throw new Problem(
        409,
        "Reminders are paused while this invoice is disputed. Resolve the dispute or skip the step.",
      );
    await tx.query(
      "INSERT INTO reminder_followups(id,tenant_id,entity_id,invoice_id,schedule_id,step_key,outcome,note,followed_up_on,created_by,created_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
        t,
        i.entity_id,
        i.id,
        schedule.id,
        c.step_key,
        c.outcome,
        c.note,
        c.date,
        ctx.userId,
        actor(ctx),
      ],
    );
    await audit(tx, ctx, i.id, c.action, {
      actorName: ctx.name || null,
      text: `${c.outcome === "Skipped" ? "Skipped" : "Followed up manually on"} reminder “${step.subject}” for ${i.number}. The system did not send a message.`,
    });
    return { id };
  }
  throw new Problem(400, "Unknown collections action.");
}

async function saveSchedule(tx: SQL, ctx: Context, c: Row) {
  if (!hasCapability(ctx, "team.manage"))
    throw new Problem(
      403,
      "Only an administrator can change reminder schedules.",
    );
  const entity = await entityRow(tx, c.entity_id);
  const problem = scheduleProblem(c.steps);
  if (problem) throw new Problem(400, problem);
  const current = Number(
    (
      await tx.query(
        "SELECT coalesce(max(version),0) AS v FROM reminder_schedules WHERE entity_id=$1",
        [entity.id],
      )
    ).rows[0].v,
  );
  if (current !== c.version)
    throw new Problem(
      409,
      "The reminder schedule changed. Refresh before saving.",
    );
  const id = uuid();
  await tx.query(
    "INSERT INTO reminder_schedules(id,tenant_id,entity_id,version,name,steps,pause_on_promise,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      id,
      ctx.tenantId,
      entity.id,
      current + 1,
      c.name,
      JSON.stringify(c.steps),
      c.pause_on_promise,
      ctx.userId,
    ],
  );
  await audit(tx, ctx, entity.id, c.action, {
    actorName: ctx.name || null,
    version: current + 1,
    text: `Saved reminder schedule “${c.name}” version ${current + 1} for ${entity.name} with ${c.steps.length} step${c.steps.length === 1 ? "" : "s"}. Reminders are manual follow-ups; nothing is sent automatically.`,
  });
  return { id };
}

export async function collectionSnapshot(tx: SQL, ctx: Context) {
  const q = async (sql: string) => (await tx.query(sql)).rows;
  // Anyone who can sell needs to see holds so the warning appears before they
  // quote; the detail of collections stays with people who can see the books.
  const creditHolds =
    hasCapability(ctx, "books.view") || hasCapability(ctx, "crm.sales")
      ? await q(`SELECT h.id,h.entity_id,h.company_id,h.mode,h.reason,h.placed_on,h.placed_by_name,r.released_on
          FROM customer_credit_holds h LEFT JOIN customer_credit_hold_releases r ON r.hold_id=h.id ORDER BY h.placed_on DESC,h.created_at DESC`)
      : [];
  if (!hasCapability(ctx, "books.view"))
    return {
      creditHolds,
      collectionContacts: [],
      invoiceDisputes: [],
      reminderSchedules: [],
      reminderFollowups: [],
      collectionPeople: [],
    };
  return {
    creditHolds,
    // Who collections work can be assigned to: the same rule the server
    // enforces when a next action or dispute owner is saved.
    collectionPeople: (
      await tx.query(
        "SELECT d.id,d.name,m.entity_ids FROM memberships m JOIN gv_approval_directory() d ON d.id=m.user_id WHERE m.tenant_id=$1 AND m.active AND m.role IN ('admin','finance') ORDER BY d.name",
        [ctx.tenantId],
      )
    ).rows,
    collectionContacts:
      await q(`SELECT id,entity_id,company_id,invoice_id,kind,summary,contacted_on,promise_date,promise_amount_minor::text,
      next_action,next_action_due,assignee_id,created_by_name FROM collection_contacts ORDER BY contacted_on DESC,created_at DESC`),
    invoiceDisputes:
      await q(`SELECT d.id,d.entity_id,d.company_id,d.invoice_id,d.reason,d.amount_minor::text,d.owner_id,d.opened_on,d.opened_by_name,
      r.resolved_on,r.resolution FROM invoice_disputes d LEFT JOIN invoice_dispute_resolutions r ON r.dispute_id=d.id ORDER BY d.opened_on DESC,d.created_at DESC`),
    reminderSchedules: await q(
      "SELECT s.id,s.entity_id,s.version,s.name,s.steps,s.pause_on_promise FROM reminder_schedules s WHERE s.version=(SELECT max(version) FROM reminder_schedules x WHERE x.entity_id=s.entity_id)",
    ),
    reminderFollowups: await q(
      "SELECT id,invoice_id,schedule_id,step_key,outcome,note,followed_up_on,created_by_name FROM reminder_followups ORDER BY followed_up_on DESC,created_at DESC",
    ),
  };
}
