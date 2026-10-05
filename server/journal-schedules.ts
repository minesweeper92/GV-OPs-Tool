import { createHash, randomUUID as uuid } from "node:crypto";
import { inTenant, type Database, type Row, type SQL } from "./db.ts";
import { audit, Problem, type Context } from "./domain.ts";
import {
  executeManualJournal,
  validatedManualLines,
} from "./manual-journals.ts";
import { occurrenceDate } from "../shared/recurring.ts";
import type { Command } from "../shared/commands.ts";

type ScheduleCommand = Extract<
  Command,
  {
    action:
      | "journal-schedule.create"
      | "journal-schedule.status"
      | "journal-schedule.run"
      | "journal-schedule.skip"
      | "journal-schedule.post"
      | "journal-reversal.post";
  }
>;
const day = (value: unknown) => String(value).slice(0, 10);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const localToday = (zone: string, now: Date) =>
  now.toLocaleDateString("en-CA", { timeZone: zone });
const nextMonth = (date: string) => {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
};
async function one(
  tx: SQL,
  table:
    | "journal_schedules"
    | "journal_schedule_occurrences"
    | "journal_reversal_tasks",
  id: string,
) {
  const row = (
    await tx.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id])
  ).rows[0];
  if (!row) throw new Problem(404, "Journal schedule record not found.");
  return row;
}
export async function journalScheduleSnapshot(tx: SQL, ctx: Context) {
  if (!["admin", "finance"].includes(ctx.role))
    return {
      journalSchedules: [],
      journalOccurrences: [],
      journalReversalTasks: [],
    };
  return {
    journalSchedules: (
      await tx.query(
        "SELECT * FROM journal_schedules ORDER BY created_at DESC,id DESC",
      )
    ).rows,
    journalOccurrences: (
      await tx.query(
        "SELECT * FROM journal_schedule_occurrences ORDER BY scheduled_date DESC,created_at DESC",
      )
    ).rows,
    journalReversalTasks: (
      await tx.query(
        `SELECT t.*,j.external_reference,j.description FROM journal_reversal_tasks t
       JOIN journals j ON j.id=t.original_journal_id ORDER BY t.due_date DESC,t.created_at DESC`,
      )
    ).rows,
  };
}
async function generate(tx: SQL, ctx: Context, profile: Row, now: Date) {
  const membership = (
    await tx.query(
      "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active",
      [ctx.tenantId, ctx.userId],
    )
  ).rows[0];
  if (!membership || !["admin", "finance"].includes(membership.role))
    throw new Problem(
      403,
      "Active finance access is required to generate journal drafts.",
    );
  // A worker may have completed the schedule after the UI loaded its Active state.
  if (profile.status === "Completed") return { id: profile.id, generated: 0 };
  if (profile.status !== "Active")
    throw new Problem(409, "Resume this schedule before generating entries.");
  const today = localToday(profile.timezone, now);
  let next = Number(profile.next_index),
    count = 0,
    status = profile.status;
  while (count < 12) {
    const date = occurrenceDate(
      day(profile.start_date),
      profile.frequency,
      next,
    );
    if (
      (profile.occurrences !== null && next >= profile.occurrences) ||
      (profile.end_date && date > day(profile.end_date))
    ) {
      status = "Completed";
      break;
    }
    if (date > today) break;
    const id = uuid();
    await tx.query(
      `INSERT INTO journal_schedule_occurrences
       (id,tenant_id,entity_id,schedule_id,cycle,scheduled_date,reference,memo,lines,reverse_next_month)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        ctx.tenantId,
        profile.entity_id,
        profile.id,
        next,
        date,
        `${profile.reference.slice(0, 180)}-${next + 1}`,
        profile.memo,
        JSON.stringify(profile.lines),
        profile.reverse_next_month,
      ],
    );
    await audit(tx, ctx, id, "journal-schedule.generated", {
      schedule_id: profile.id,
      date,
      cycle: next,
    });
    next++;
    count++;
  }
  const upcoming = occurrenceDate(
    day(profile.start_date),
    profile.frequency,
    next,
  );
  if (
    (profile.occurrences !== null && next >= profile.occurrences) ||
    (profile.end_date && upcoming > day(profile.end_date))
  )
    status = "Completed";
  if (count || status !== profile.status || profile.last_error)
    await tx.query(
      "UPDATE journal_schedules SET next_index=$2,status=$3,last_error='',version=version+1 WHERE id=$1",
      [profile.id, next, status],
    );
  return { id: profile.id, generated: count };
}
export async function executeJournalSchedule(
  tx: SQL,
  ctx: Context,
  c: ScheduleCommand,
  now = new Date(),
) {
  if (!["admin", "finance"].includes(ctx.role))
    throw new Problem(403, "Only finance staff can manage journal schedules.");
  if (c.action === "journal-schedule.create") {
    const entity = (
      await tx.query("SELECT id FROM entities WHERE id=$1 FOR UPDATE", [
        c.entity_id,
      ])
    ).rows[0];
    if (!entity) throw new Problem(404, "Legal entity not found.");
    const payloadHash = hash(c);
    const prior = (
      await tx.query(
        "SELECT id,payload_hash FROM journal_schedules WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (prior.payload_hash !== payloadHash)
        throw new Problem(
          409,
          "Retry key already used for a different schedule.",
        );
      return { id: prior.id };
    }
    if (c.end_date && c.end_date < c.start_date)
      throw new Problem(400, "End date cannot precede the start date.");
    await validatedManualLines(tx, c.entity_id, c.lines);
    const id = uuid();
    await tx.query(
      `INSERT INTO journal_schedules
       (id,tenant_id,entity_id,name,reference,memo,lines,start_date,end_date,frequency,timezone,occurrences,reverse_next_month,request_key,payload_hash,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        ctx.tenantId,
        c.entity_id,
        c.name,
        c.reference,
        c.memo,
        JSON.stringify(c.lines),
        c.start_date,
        c.end_date,
        c.frequency,
        c.timezone,
        c.occurrences,
        c.reverse_next_month,
        c.request_key,
        payloadHash,
        ctx.userId,
      ],
    );
    await audit(tx, ctx, id, "journal-schedule.create", {
      entity_id: c.entity_id,
      name: c.name,
    });
    return { id };
  }
  if (c.action === "journal-schedule.status") {
    const p = await one(tx, "journal_schedules", c.id);
    if (p.version !== c.version)
      throw new Problem(409, "Schedule changed. Refresh and retry.");
    if (["Stopped", "Completed"].includes(p.status))
      throw new Problem(409, "This schedule has ended.");
    if (c.status === p.status) return { id: p.id };
    await tx.query(
      "UPDATE journal_schedules SET status=$2,version=version+1 WHERE id=$1",
      [p.id, c.status],
    );
    await audit(tx, ctx, p.id, "journal-schedule.status", {
      from: p.status,
      to: c.status,
    });
    return { id: p.id };
  }
  if (c.action === "journal-schedule.run")
    return generate(tx, ctx, await one(tx, "journal_schedules", c.id), now);
  if (c.action === "journal-schedule.skip") {
    const o = await one(tx, "journal_schedule_occurrences", c.id);
    if (o.status !== "Pending review")
      throw new Problem(409, "Only pending journal drafts can be skipped.");
    await tx.query(
      "UPDATE journal_schedule_occurrences SET status='Skipped',reason=$2 WHERE id=$1",
      [o.id, c.reason],
    );
    await audit(tx, ctx, o.id, "journal-schedule.skip", { reason: c.reason });
    return { id: o.id };
  }
  if (c.action === "journal-schedule.post") {
    const o = await one(tx, "journal_schedule_occurrences", c.id);
    if (o.status === "Posted") return { id: o.journal_id };
    if (o.status !== "Pending review")
      throw new Problem(409, "This journal draft was skipped.");
    const zone = (
      await tx.query("SELECT timezone FROM journal_schedules WHERE id=$1", [
        o.schedule_id,
      ])
    ).rows[0]?.timezone;
    if (day(o.scheduled_date) > localToday(zone || "UTC", now))
      throw new Problem(409, "This occurrence is not due yet.");
    const posted = await executeManualJournal(tx, ctx, {
      action: "manual-journal.create",
      entity_id: o.entity_id,
      date: day(o.scheduled_date),
      reference: o.reference,
      memo: o.memo,
      lines: o.lines,
      auto_reverse_on: o.reverse_next_month
        ? nextMonth(day(o.scheduled_date))
        : null,
      request_key: o.id,
    });
    await tx.query(
      "UPDATE journal_schedule_occurrences SET status='Posted',journal_id=$2 WHERE id=$1",
      [o.id, posted.id],
    );
    await audit(tx, ctx, o.id, "journal-schedule.post", {
      journal_id: posted.id,
    });
    return posted;
  }
  const task = await one(tx, "journal_reversal_tasks", c.id);
  if (task.status === "Posted") {
    const reversal = (
      await tx.query("SELECT memo FROM journals WHERE id=$1", [
        task.reversal_journal_id,
      ])
    ).rows[0];
    if (day(task.posted_on) !== c.date || reversal?.memo !== c.reason)
      throw new Problem(
        409,
        "This reversal task was already completed with different details.",
      );
    return { id: task.reversal_journal_id };
  }
  if (c.date < day(task.due_date) || c.date > localToday("UTC", now))
    throw new Problem(
      400,
      "Choose a posting date from the due date through today.",
    );
  // The ordinary reversal enforces the original's entity, period locks,
  // exact inverse lines and one-reversal constraint, then completes this task.
  return executeManualJournal(tx, ctx, {
    action: "manual-journal.reverse",
    id: task.original_journal_id,
    date: c.date,
    reason: c.reason,
    request_key: task.id,
  });
}
export async function runJournalSchedulesDue(db: Database, now = new Date()) {
  const profiles = (
    await db.query(
      `SELECT p.id,p.tenant_id,p.created_by,m.role FROM journal_schedules p
     LEFT JOIN memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.created_by
      AND m.active AND m.role IN ('admin','finance')
     WHERE p.status='Active' ORDER BY p.created_at`,
    )
  ).rows;
  for (const p of profiles) {
    if (!p.role) {
      await inTenant(db, p.tenant_id, (tx) =>
        tx.query(
          "UPDATE journal_schedules SET last_error=$2,version=version+1 WHERE id=$1 AND status='Active' AND last_error<>$2",
          [
            p.id,
            "The schedule creator no longer has finance access. An administrator should stop and recreate this schedule.",
          ],
        ),
      );
      continue;
    }
    const ctx: Context = {
      tenantId: p.tenant_id,
      userId: p.created_by,
      role: p.role,
    };
    try {
      await inTenant(db, p.tenant_id, (tx) =>
        executeJournalSchedule(
          tx,
          ctx,
          { action: "journal-schedule.run", id: p.id },
          now,
        ),
      );
    } catch (error) {
      const message =
        error instanceof Problem
          ? error.message
          : "Journal draft generation failed. Review this schedule.";
      await inTenant(db, p.tenant_id, (tx) =>
        tx.query(
          "UPDATE journal_schedules SET last_error=$2,version=version+1 WHERE id=$1 AND status='Active' AND last_error<>$2",
          [p.id, message],
        ),
      );
    }
  }
}
