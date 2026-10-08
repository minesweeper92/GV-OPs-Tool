import { randomUUID as uuid } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { inTenant, type SQL, type Row, type Database } from "./db.ts";
import { Problem, audit, type Context } from "./domain.ts";
import { executePayable } from "./payables.ts";
import { scaled, totals, baseAmount } from "../shared/money.ts";
import { occurrenceDate } from "../shared/recurring.ts";
import { hasCapability } from "../shared/permissions.ts";
const day = (value: unknown) => String(value).slice(0, 10);
const rate = (value: string) =>
  `${BigInt(value) / 1000000n}.${String(BigInt(value) % 1000000n).padStart(6, "0")}`;
async function get(
  tx: SQL,
  table: "bill_schedules" | "entities" | "companies" | "deals",
  id: string,
  lock = false,
) {
  const row = (
    await tx.query(
      `SELECT * FROM ${table} WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  if (!row) throw new Problem(404, "Record not found in this organization.");
  return row;
}
function validate(p: Row) {
  if (p.end_date && day(p.end_date) < day(p.start_date))
    throw new Problem(400, "End date cannot precede the start date.");
  try {
    const sum = totals(p.lines),
      fx = scaled(p.fx, 6);
    if (
      fx <= 0n ||
      (p.currency === "PKR" && fx !== 1000000n) ||
      baseAmount(BigInt(sum.total), fx) <= 0n
    )
      throw new Error(
        "Enter a positive total and exchange rate; PKR must use 1.",
      );
    return { total: sum.total, fx: String(fx) };
  } catch (error) {
    throw new Problem(400, (error as Error).message);
  }
}
function finished(p: Row, next: number) {
  return (
    (p.occurrences !== null && next >= p.occurrences) ||
    (p.end_date &&
      occurrenceDate(day(p.start_date), p.frequency, next) > day(p.end_date))
  );
}
function snapshot(p: Row) {
  return {
    name: p.name,
    currency: p.currency,
    lines: p.lines,
    fx_micros: p.fx_micros,
    total_minor: p.total_minor,
    tax_treatment: p.tax_treatment,
    due_days: p.due_days,
    notes: p.notes,
    version: p.version,
  };
}
export async function billScheduleSnapshot(tx: SQL, ctx: Context) {
  if (!hasCapability(ctx.role, "books.view"))
    return { billSchedules: [], billScheduleOccurrences: [] };
  return {
    billSchedules: (
      await tx.query(
        `SELECT p.id,p.entity_id,p.vendor_id,c.name AS vendor_name,p.deal_id,p.name,p.currency,p.lines,p.total_minor,p.fx_micros,p.tax_treatment,p.due_days,p.notes,p.start_date,p.end_date,p.frequency,p.timezone,p.occurrences,p.next_index,p.status,p.version,p.last_error FROM bill_schedules p JOIN companies c ON c.id=p.vendor_id ORDER BY p.created_at DESC`,
      )
    ).rows,
    billScheduleOccurrences: (
      await tx.query(
        "SELECT id,schedule_id,cycle,scheduled_date,bill_id,status,reason,template FROM bill_schedule_occurrences ORDER BY scheduled_date DESC,created_at DESC",
      )
    ).rows,
  };
}
export async function executeBillSchedule(
  tx: SQL,
  ctx: Context,
  c: Row,
  now = new Date(),
) {
  if (!hasCapability(ctx.role, "books.post"))
    throw new Problem(403, "Finance access is required for recurring bills.");
  if (c.action === "bill-schedule.create") {
    await get(tx, "entities", c.entity_id, true);
    const prior = (
      await tx.query(
        "SELECT id,request_payload FROM bill_schedules WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (!isDeepStrictEqual(prior.request_payload, c))
        throw new Problem(
          409,
          "This retry key was used for a different schedule.",
        );
      return { id: prior.id };
    }
    if (!(await get(tx, "companies", c.vendor_id)).vendor)
      throw new Problem(400, "Choose a company marked as a vendor.");
    if (
      c.deal_id &&
      (await get(tx, "deals", c.deal_id)).entity_id !== c.entity_id
    )
      throw new Problem(400, "The project must belong to this legal entity.");
    const values = validate(c),
      id = uuid();
    await tx.query(
      `INSERT INTO bill_schedules(id,tenant_id,entity_id,vendor_id,deal_id,name,currency,lines,total_minor,fx_micros,tax_treatment,due_days,notes,start_date,end_date,frequency,timezone,occurrences,request_key,request_payload,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        id,
        ctx.tenantId,
        c.entity_id,
        c.vendor_id,
        c.deal_id,
        c.name,
        c.currency,
        JSON.stringify(c.lines),
        values.total,
        values.fx,
        c.tax_treatment,
        c.due_days,
        c.notes,
        c.start_date,
        c.end_date,
        c.frequency,
        c.timezone,
        c.occurrences,
        c.request_key,
        JSON.stringify(c),
        ctx.userId,
      ],
    );
    await audit(tx, ctx, id, c.action, c);
    return { id };
  }
  const p = await get(tx, "bill_schedules", c.id, true);
  if (c.action === "bill-schedule.run" && p.status === "Completed")
    return { id: p.id, generated: 0 };
  if (["Stopped", "Completed"].includes(p.status))
    throw new Problem(
      409,
      "This schedule has ended. Create a new schedule to continue.",
    );
  if (c.action !== "bill-schedule.run" && c.version !== p.version)
    throw new Problem(409, "Schedule changed. Reload before continuing.");
  if (c.action === "bill-schedule.edit") {
    const values = validate({ ...p, ...c });
    if (c.occurrences !== null && c.occurrences < p.next_index)
      throw new Problem(409, "The count cannot remove generated history.");
    const status = finished({ ...p, ...c }, p.next_index)
      ? "Completed"
      : p.status;
    await tx.query(
      "UPDATE bill_schedules SET name=$2,lines=$3,total_minor=$4,fx_micros=$5,tax_treatment=$6,due_days=$7,notes=$8,end_date=$9,occurrences=$10,status=$11,last_error='',version=version+1 WHERE id=$1",
      [
        p.id,
        c.name,
        JSON.stringify(c.lines),
        values.total,
        values.fx,
        c.tax_treatment,
        c.due_days,
        c.notes,
        c.end_date,
        c.occurrences,
        status,
      ],
    );
  } else if (c.action === "bill-schedule.status") {
    const status =
      c.status === "Active" && finished(p, p.next_index)
        ? "Completed"
        : c.status;
    await tx.query(
      "UPDATE bill_schedules SET status=$2,last_error='',version=version+1 WHERE id=$1",
      [p.id, status],
    );
  } else {
    const today = now.toLocaleDateString("en-CA", { timeZone: p.timezone });
    let next = p.next_index,
      generated = 0;
    if (c.action === "bill-schedule.run") {
      if (p.status !== "Active")
        throw new Problem(409, "Resume the schedule before generating bills.");
      const membership = (
        await tx.query(
          "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active",
          [ctx.tenantId, ctx.userId],
        )
      ).rows[0];
      if (!membership || !hasCapability(membership.role, "books.post"))
        throw new Problem(
          403,
          "Active finance access is required to generate bills.",
        );
      const entity = await get(tx, "entities", p.entity_id, true);
      while (generated < 1 && !finished(p, next)) {
        const date = occurrenceDate(day(p.start_date), p.frequency, next);
        if (date > today) break;
        if (entity.lock_date && date <= day(entity.lock_date))
          throw new Problem(
            409,
            "The next cycle is in a locked period. Review and explicitly skip it before continuing.",
          );
        const occurrenceId = uuid(),
          due = new Date(date + "T00:00:00Z");
        due.setUTCDate(due.getUTCDate() + p.due_days);
        const bill = await executePayable(tx, ctx, {
          action: "bill.create",
          entity_id: p.entity_id,
          vendor_id: p.vendor_id,
          deal_id: p.deal_id,
          reference: `Recurring draft ${p.id} · ${date}`,
          bill_date: date,
          due_date: due.toISOString().slice(0, 10),
          currency: p.currency,
          fx: rate(p.fx_micros),
          lines: p.lines,
          tax_treatment: p.tax_treatment,
          notes: p.notes,
          request_key: occurrenceId,
          acknowledge_duplicate: false,
        });
        await tx.query(
          "INSERT INTO bill_schedule_occurrences(id,tenant_id,schedule_id,cycle,scheduled_date,bill_id,status,template) VALUES($1,$2,$3,$4,$5,$6,'Draft created',$7)",
          [
            occurrenceId,
            ctx.tenantId,
            p.id,
            next,
            date,
            bill.id,
            JSON.stringify(snapshot(p)),
          ],
        );
        await audit(tx, ctx, bill.id, "bill-schedule.generated", {
          schedule_id: p.id,
          scheduled_date: date,
          text: "Recurring bill draft created; review the vendor reference before approval.",
        });
        next++;
        generated++;
      }
    } else if (c.action === "bill-schedule.skip") {
      const date = occurrenceDate(day(p.start_date), p.frequency, next);
      if (finished(p, next) || date > today)
        throw new Problem(409, "Only the next due cycle can be skipped.");
      await tx.query(
        "INSERT INTO bill_schedule_occurrences(id,tenant_id,schedule_id,cycle,scheduled_date,status,reason,template) VALUES($1,$2,$3,$4,$5,'Skipped',$6,$7)",
        [
          uuid(),
          ctx.tenantId,
          p.id,
          next,
          date,
          c.reason,
          JSON.stringify(snapshot(p)),
        ],
      );
      next++;
    } else throw new Problem(400, "Unknown recurring bill action.");
    const status = finished(p, next) ? "Completed" : p.status;
    if (next !== p.next_index || status !== p.status || p.last_error)
      await tx.query(
        "UPDATE bill_schedules SET next_index=$2,status=$3,last_error='',version=version+1 WHERE id=$1",
        [p.id, next, status],
      );
    if (next !== p.next_index || status !== p.status)
      await audit(tx, ctx, p.id, c.action, {
        ...c,
        generated,
        next_index: next,
      });
    return { id: p.id, generated };
  }
  await audit(tx, ctx, p.id, c.action, c);
  return { id: p.id };
}
export async function runRecurringBillsDue(db: Database, now = new Date()) {
  const profiles = (
    await db.query(
      "SELECT p.id,p.tenant_id,p.created_by,m.role FROM bill_schedules p JOIN memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.created_by AND m.active AND m.role IN ('admin','finance') WHERE p.status='Active' ORDER BY p.created_at",
    )
  ).rows;
  for (const p of profiles) {
    const ctx: Context = {
      tenantId: p.tenant_id,
      userId: p.created_by,
      role: p.role,
    };
    try {
      // Commit each cycle separately: a blocked later cycle cannot roll back
      // valid earlier drafts or move the cursor past the blocked cycle.
      for (let cycle = 0; cycle < 12; cycle++) {
        const result = await inTenant(db, p.tenant_id, (tx) =>
          executeBillSchedule(
            tx,
            ctx,
            { action: "bill-schedule.run", id: p.id },
            now,
          ),
        );
        if (!result.generated) break;
      }
    } catch (error) {
      const message =
        error instanceof Problem
          ? error.message
          : "Bill draft generation failed. Review this schedule and retry.";
      await inTenant(db, p.tenant_id, (tx) =>
        tx.query(
          "UPDATE bill_schedules SET last_error=$2,version=version+1 WHERE id=$1 AND status='Active' AND last_error<>$2",
          [p.id, message],
        ),
      );
    }
  }
}
