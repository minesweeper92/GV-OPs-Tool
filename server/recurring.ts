import { randomUUID as uuid } from "node:crypto";
import { inTenant, type SQL, type Row, type Database } from "./db.ts";
import { Problem, audit, execute, type Context } from "./domain.ts";
import { minor, scaled, totals, round, baseAmount } from "../shared/money.ts";
import { occurrenceDate } from "../shared/recurring.ts";
import { runJournalSchedulesDue } from "./journal-schedules.ts";
import { runRecurringBillsDue } from "./recurring-bills.ts";
import { currentMemberContext } from "./permission-checks.ts";
import { hasCapability } from "../shared/permissions.ts";
const day = (x: unknown) => String(x).slice(0, 10);
const decimal = (x: bigint) =>
  `${x / 100n}.${String(x % 100n).padStart(2, "0")}`;
async function get(
  tx: SQL,
  table: string,
  id: string,
  lock = true,
): Promise<Row> {
  const p = (
    await tx.query(
      `SELECT * FROM ${table} WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  if (!p) throw new Problem(404, "Record not found.");
  return p;
}
function validate(p: Row, currency: string) {
  if (p.end_date && day(p.end_date) < day(p.start_date))
    throw new Problem(400, "End date cannot precede the start.");
  if (
    BigInt(p.amount_minor) <= 0n ||
    BigInt(p.fx_micros) <= 0n ||
    (currency === "PKR" && BigInt(p.fx_micros) !== 1000000n)
  )
    throw new Problem(
      400,
      "Enter a positive amount and a valid exchange rate.",
    );
  baseAmount(BigInt(p.amount_minor), BigInt(p.fx_micros));
}
export async function recurringSnapshot(tx: SQL, ctx: Context) {
  if (!hasCapability(ctx, "books.view"))
    return { recurringProfiles: [], recurringOccurrences: [] };
  return {
    recurringProfiles: (
      await tx.query(
        "SELECT p.*,coalesce(q.currency,'PKR') AS currency FROM recurring_profiles p LEFT JOIN quotes q ON q.id=p.quote_id ORDER BY p.created_at DESC",
      )
    ).rows,
    recurringOccurrences: (
      await tx.query(
        "SELECT * FROM recurring_occurrences ORDER BY scheduled_date DESC,created_at DESC",
      )
    ).rows,
  };
}
async function runProfile(tx: SQL, ctx: Context, p: Row, now: Date) {
  ctx = await currentMemberContext(tx, ctx);
  if (!hasCapability(ctx, "books.post"))
    throw new Problem(
      403,
      "Active finance access is required to generate drafts.",
    );
  const membership = (
    await tx.query(
      "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active",
      [ctx.tenantId, ctx.userId],
    )
  ).rows[0];
  if (!membership || !["admin", "finance"].includes(membership.role))
    throw new Problem(
      403,
      "Active finance access is required to generate drafts.",
    );
  if (p.status !== "Active")
    throw new Problem(409, "Resume this schedule before generating drafts.");
  const today = now.toLocaleDateString("en-CA", { timeZone: p.timezone }),
    e = await get(tx, "entities", p.entity_id),
    q = p.quote_id ? await get(tx, "quotes", p.quote_id, false) : null;
  let next = p.next_index,
    count = 0;
  while (count < 12) {
    const date = occurrenceDate(day(p.start_date), p.frequency, next);
    if (
      (p.occurrences !== null && next >= p.occurrences) ||
      (p.end_date && date > day(p.end_date))
    ) {
      p.status = "Completed";
      break;
    }
    if (date > today) break;
    if (e.lock_date && date <= day(e.lock_date))
      throw new Problem(
        409,
        "The next occurrence falls in a locked period. Review and skip it explicitly before continuing.",
      );
    const id = uuid();
    let invoiceId = null;
    if (q) {
      let running = 0n,
        allocated = 0n;
      const lines = q.lines
        .map((line: Row) => {
          running += BigInt(line.subtotal);
          const n =
            round(BigInt(p.amount_minor) * running, BigInt(q.net_minor)) -
            allocated;
          allocated += n;
          return {
            description: line.description,
            quantity: "1",
            price: decimal(n),
            tax: line.tax,
          };
        })
        .filter((line: Row) => minor(line.price) > 0n);
      const calculation = totals(lines);
      if (baseAmount(BigInt(calculation.total), BigInt(p.fx_micros)) <= 0n)
        throw new Problem(400, "Recurring invoice rounds to zero.");
      const due = new Date(date + "T00:00:00Z");
      due.setUTCDate(due.getUTCDate() + p.due_days);
      invoiceId = uuid();
      await tx.query(
        `INSERT INTO invoices(id,tenant_id,entity_id,deal_id,quote_id,issue_date,due_date,lines,net_minor,tax_minor,total_minor,billing_kind,label,currency,fx_micros)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'earned',$12,$13,$14)`,
        [
          invoiceId,
          ctx.tenantId,
          p.entity_id,
          p.deal_id,
          p.quote_id,
          date,
          due.toISOString().slice(0, 10),
          JSON.stringify(calculation.lines),
          calculation.net,
          calculation.tax,
          calculation.total,
          `${p.name} · ${date}`,
          q.currency,
          p.fx_micros,
        ],
      );
      await audit(tx, ctx, invoiceId, "invoice.create", {
        recurring_profile_id: p.id,
        scheduled_date: date,
        deal_id: p.deal_id,
      });
    }
    await tx.query(
      "INSERT INTO recurring_occurrences(id,tenant_id,profile_id,cycle,scheduled_date,amount_minor,fx_micros,description,invoice_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        id,
        ctx.tenantId,
        p.id,
        next,
        date,
        p.amount_minor,
        p.fx_micros,
        p.description,
        invoiceId,
        q ? "Draft created" : "Pending review",
      ],
    );
    await audit(tx, ctx, id, "recurring.generated", {
      profile_id: p.id,
      scheduled_date: date,
      invoice_id: invoiceId,
    });
    next++;
    count++;
  }
  const after = occurrenceDate(day(p.start_date), p.frequency, next);
  if (
    (p.occurrences !== null && next >= p.occurrences) ||
    (p.end_date && after > day(p.end_date))
  )
    p.status = "Completed";
  if (count || p.status !== "Active" || p.last_error)
    await tx.query(
      "UPDATE recurring_profiles SET next_index=$2,status=$3,last_error=$4,version=version+1 WHERE id=$1",
      [p.id, next, p.status, ""],
    );
  return { id: p.id, generated: count };
}
export async function executeRecurring(
  tx: SQL,
  ctx: Context,
  c: Row,
  now = new Date(),
) {
  if (!hasCapability(ctx, "books.post"))
    throw new Problem(403, "A finance role is required for recurring billing.");
  let id = c.id || uuid();
  if (c.action === "recurring.invoice" || c.action === "recurring.expense") {
    // Entity lock serializes creation, including retry keys and contract choice.
    await get(tx, "entities", c.entity_id);
    const prior = (
      await tx.query(
        "SELECT id,request_payload FROM recurring_profiles WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (
        JSON.stringify(Object.entries(prior.request_payload).sort()) !==
        JSON.stringify(Object.entries(c).sort())
      )
        throw new Problem(409, "Retry key already used.");
      return { id: prior.id };
    }
    let deal = c.deal_id || null,
      currency = "PKR";
    const kind = c.action === "recurring.invoice" ? "invoice" : "expense";
    if (kind === "invoice") {
      const q = await get(tx, "quotes", c.quote_id, false),
        d = await get(tx, "deals", q.deal_id);
      deal = d.id;
      currency = q.currency;
      if (d.accepted_quote_id !== q.id || d.entity_id !== c.entity_id)
        throw new Problem(
          409,
          "Choose an accepted quote from this issuing entity.",
        );
      if (
        (
          await tx.query(
            "SELECT id FROM projects WHERE deal_id=$1 UNION ALL SELECT id FROM invoices WHERE deal_id=$1",
            [d.id],
          )
        ).rows.length
      )
        throw new Problem(
          409,
          "Use a separate recurring-services deal. This deal already uses fixed-project billing.",
        );
    } else if (
      deal &&
      (await get(tx, "deals", deal, false)).entity_id !== c.entity_id
    )
      throw new Problem(409, "Project must belong to the same entity.");
    const p = {
      ...c,
      amount_minor: String(minor(c.amount)),
      fx_micros: kind === "invoice" ? String(scaled(c.fx, 6)) : "1000000",
    };
    validate(p, currency);
    await tx.query(
      `INSERT INTO recurring_profiles(id,tenant_id,entity_id,kind,quote_id,deal_id,name,description,amount_minor,fx_micros,start_date,end_date,frequency,timezone,occurrences,due_days,request_key,request_payload,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        id,
        ctx.tenantId,
        c.entity_id,
        kind,
        c.quote_id || null,
        deal,
        c.name,
        c.description || "",
        p.amount_minor,
        p.fx_micros,
        c.start_date,
        c.end_date,
        c.frequency,
        c.timezone,
        c.occurrences,
        c.due_days ?? 0,
        c.request_key,
        JSON.stringify(c),
        ctx.userId,
      ],
    );
  } else if (c.action === "recurring.update") {
    const p = await get(tx, "recurring_profiles", id);
    if (p.version !== c.version)
      throw new Problem(409, "Schedule changed. Reload before editing.");
    if (["Stopped", "Completed"].includes(p.status))
      throw new Problem(409, "This schedule has ended.");
    const currency = p.quote_id
      ? (await get(tx, "quotes", p.quote_id, false)).currency
      : "PKR";
    validate(
      {
        ...p,
        ...c,
        amount_minor: String(minor(c.amount)),
        fx_micros: String(scaled(c.fx, 6)),
      },
      currency,
    );
    if (c.occurrences !== null && c.occurrences < p.next_index)
      throw new Problem(
        409,
        "Occurrence count cannot remove generated history.",
      );
    await tx.query(
      "UPDATE recurring_profiles SET name=$2,description=$3,amount_minor=$4,fx_micros=$5,end_date=$6,occurrences=$7,due_days=$8,status=$9,version=version+1,last_error=$10 WHERE id=$1",
      [
        id,
        c.name,
        c.description,
        String(minor(c.amount)),
        String(scaled(c.fx, 6)),
        c.end_date,
        c.occurrences,
        c.due_days,
        c.status,
        "",
      ],
    );
  } else if (c.action === "recurring.run") {
    return runProfile(tx, ctx, await get(tx, "recurring_profiles", id), now);
  } else if (c.action === "recurring.post-expense") {
    const o = await get(tx, "recurring_occurrences", id),
      p = await get(tx, "recurring_profiles", o.profile_id, false);
    if (o.status === "Posted") {
      const expense = await get(tx, "expenses", o.expense_id, false);
      if (
        day(expense.expense_date) !== c.date ||
        expense.reference !== c.reference ||
        expense.bank_account_id !== c.bank_account_id
      )
        throw new Problem(
          409,
          "This occurrence was already posted with different payment details.",
        );
      return { id: o.expense_id };
    }
    if (p.kind !== "expense" || o.status !== "Pending review")
      throw new Problem(409, "Only a pending expense can be posted.");
    if (c.date < day(o.scheduled_date))
      throw new Problem(400, "Payment date cannot precede this occurrence.");
    const result = await execute(tx, ctx, {
      action: "expense.create",
      entity_id: p.entity_id,
      deal_id: p.deal_id,
      description: o.description,
      amount: decimal(BigInt(o.amount_minor)),
      date: c.date,
      reference: c.reference,
      bank_account_id: c.bank_account_id,
      request_key: o.id,
    });
    await tx.query(
      "UPDATE recurring_occurrences SET expense_id=$2,status='Posted' WHERE id=$1",
      [id, result.id],
    );
  } else if (c.action === "recurring.skip") {
    // Skip either a pending expense occurrence or the next blocked/missed cycle.
    const occurrence = (
      await tx.query(
        "SELECT * FROM recurring_occurrences WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (occurrence) {
      if (occurrence.status === "Skipped") return { id };
      if (occurrence.status !== "Pending review")
        throw new Problem(
          409,
          "Cancel the generated invoice through its own screen.",
        );
      await tx.query(
        "UPDATE recurring_occurrences SET status='Skipped',reason=$2 WHERE id=$1",
        [id, c.reason],
      );
    } else {
      const p = await get(tx, "recurring_profiles", id),
        date = occurrenceDate(day(p.start_date), p.frequency, p.next_index);
      if (
        !["Active", "Paused"].includes(p.status) ||
        (p.occurrences !== null && p.next_index >= p.occurrences) ||
        (p.end_date && date > day(p.end_date)) ||
        date > now.toLocaleDateString("en-CA", { timeZone: p.timezone })
      )
        throw new Problem(409, "Only a due occurrence can be skipped.");
      id = uuid();
      await tx.query(
        "INSERT INTO recurring_occurrences(id,tenant_id,profile_id,cycle,scheduled_date,amount_minor,fx_micros,description,status,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Skipped',$9)",
        [
          id,
          ctx.tenantId,
          p.id,
          p.next_index,
          date,
          p.amount_minor,
          p.fx_micros,
          p.description,
          c.reason,
        ],
      );
      await tx.query(
        "UPDATE recurring_profiles SET next_index=next_index+1,version=version+1,last_error='' WHERE id=$1",
        [p.id],
      );
    }
  }
  await audit(tx, ctx, id, c.action, c);
  return { id };
}
export async function runRecurringDue(db: Database, now = new Date()) {
  const profiles = (
    await db.query(
      "SELECT p.id,p.tenant_id,p.created_by,m.role FROM recurring_profiles p JOIN memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.created_by AND m.active AND m.role IN ('admin','finance') WHERE p.status='Active' ORDER BY p.created_at",
    )
  ).rows;
  for (const p of profiles) {
    const ctx: Context = {
      tenantId: p.tenant_id,
      userId: p.created_by,
      role: p.role,
    };
    try {
      await inTenant(db, p.tenant_id, (tx) =>
        executeRecurring(tx, ctx, { action: "recurring.run", id: p.id }, now),
      );
    } catch (error) {
      const message =
        error instanceof Problem
          ? error.message
          : "Draft generation failed. Review this schedule and try again.";
      await inTenant(db, p.tenant_id, (tx) =>
        tx.query(
          "UPDATE recurring_profiles SET last_error=$2,version=version+1 WHERE id=$1 AND status='Active' AND last_error<>$2",
          [p.id, message],
        ),
      );
    }
  }
}
export function startRecurringWorker(db: Database) {
  let pending: Promise<void> | undefined,
    stopped = false;
  const run = () => {
    if (stopped || pending) return;
    pending = (async () => {
      await runRecurringDue(db);
      await runJournalSchedulesDue(db);
      await runRecurringBillsDue(db);
    })()
      .catch(() => console.error("Recurring draft worker failed; will retry."))
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(run, 60000);
  timer.unref();
  run();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
