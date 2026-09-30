import { createHash, randomUUID as uuid } from "node:crypto";
import type { SQL } from "./db.ts";
import { audit, Problem, type Context } from "./domain.ts";
import type { Command } from "../shared/commands.ts";

type Transition = Extract<Command, { action: "period.transition" }>;
type LegacyUnlock = Extract<Command, { action: "period.legacy-unlock" }>;
type PeriodStatus = "Open" | "Soft closed" | "Closed";
type Check = {
  key: string;
  label: string;
  count: number;
  detail: string;
  severity: "pass" | "warning" | "blocker";
};

export function monthDates(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new Problem(400, "Choose a valid accounting month.");
  const [year, number] = month.split("-").map(Number);
  if (year < 1000) throw new Problem(400, "Choose a valid accounting year.");
  const end = new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
  return { start: `${month}-01`, end };
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function periodPreview(
  tx: SQL,
  ctx: Context,
  entityId: string,
  month: string,
) {
  if (!["admin", "finance"].includes(ctx.role))
    throw new Problem(403, "Only finance staff can review accounting periods.");
  const { start, end } = monthDates(month);
  const entity = (
    await tx.query("SELECT id,name,lock_date FROM entities WHERE id=$1", [
      entityId,
    ])
  ).rows[0];
  if (!entity) throw new Problem(404, "Legal entity not found.");
  const period = (
    await tx.query(
      "SELECT status,version,note,changed_at,changed_by FROM accounting_periods WHERE entity_id=$1 AND month=$2",
      [entityId, start],
    )
  ).rows[0];
  const [banks, invoiceDrafts, billDrafts, recurringReview, balances] =
    await Promise.all([
      tx.query(
        "SELECT name,last_reconciled_on FROM bank_accounts WHERE entity_id=$1 AND opening_on<=$2 AND last_reconciled_on<$2 ORDER BY name",
        [entityId, end],
      ),
      tx.query(
        "SELECT count(*)::integer AS count FROM invoices WHERE entity_id=$1 AND issue_date<=$2 AND status='Draft'",
        [entityId, end],
      ),
      tx.query(
        "SELECT count(*)::integer AS count FROM bills WHERE entity_id=$1 AND bill_date<=$2 AND status IN ('Draft','Pending approval')",
        [entityId, end],
      ),
      tx.query(
        `SELECT count(*)::integer AS count FROM recurring_occurrences o
         JOIN recurring_profiles p ON p.id=o.profile_id
         WHERE p.entity_id=$1 AND o.scheduled_date<=$2 AND o.status='Pending review'`,
        [entityId, end],
      ),
      tx.query(
        `SELECT coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS difference,
         coalesce(sum(CASE WHEN l.account_code='3900' THEN l.debit_minor-l.credit_minor ELSE 0 END),0)::text AS clearing
         FROM journals j JOIN journal_lines l ON l.journal_id=j.id
         WHERE j.entity_id=$1 AND j.posted_on<=$2`,
        [entityId, end],
      ),
    ]);
  const bankNames = banks.rows.map((r) => r.name as string);
  const bankCount = bankNames.length;
  const invoices = Number(invoiceDrafts.rows[0].count);
  const bills = Number(billDrafts.rows[0].count);
  const recurring = Number(recurringReview.rows[0].count);
  const difference = balances.rows[0].difference as string;
  const clearing = balances.rows[0].clearing as string;
  const check = (
    key: string,
    label: string,
    count: number,
    detail: string,
    blocker = false,
  ): Check => ({
    key,
    label,
    count,
    detail,
    severity: count ? (blocker ? "blocker" : "warning") : "pass",
  });
  const checks: Check[] = [
    check(
      "trial",
      "Ledger balances",
      difference === "0" ? 0 : 1,
      difference === "0"
        ? "Debits equal credits through this month."
        : `Ledger difference: ${difference} minor units.`,
      true,
    ),
    check(
      "banks",
      "Bank accounts awaiting reconciliation",
      bankCount,
      bankCount
        ? bankNames.join(", ")
        : "All opened bank accounts are reconciled through month-end.",
    ),
    check(
      "invoices",
      "Unissued invoice drafts",
      invoices,
      invoices
        ? `${invoices} draft invoice(s) dated on or before month-end.`
        : "No older invoice drafts.",
    ),
    check(
      "bills",
      "Bills needing review or approval",
      bills,
      bills
        ? `${bills} bill(s) dated on or before month-end.`
        : "No older bills awaiting posting.",
    ),
    check(
      "recurring",
      "Recurring expenses awaiting review",
      recurring,
      recurring
        ? `${recurring} occurrence(s) due on or before month-end.`
        : "No due recurring expenses awaiting review.",
    ),
    check(
      "clearing",
      "Opening balance clearing account",
      clearing === "0" ? 0 : 1,
      clearing === "0"
        ? "Clearing account is zero."
        : `Balance: ${clearing} minor units.`,
    ),
  ];
  const history = (
    await tx.query(
      `SELECT id,from_status,to_status,reason,warnings,created_at,actor_id,actor_name
       FROM accounting_period_events
       WHERE entity_id=$1 AND month=$2 ORDER BY created_at DESC,id DESC`,
      [entityId, start],
    )
  ).rows;
  const legacyHistory = (
    await tx.query(
      `SELECT id,lock_date,reason,actor_name,created_at
       FROM legacy_period_unlocks WHERE entity_id=$1 ORDER BY created_at DESC,id DESC`,
      [entityId],
    )
  ).rows;
  return {
    entityId,
    entityName: entity.name as string,
    month,
    start,
    end,
    status: (period?.status || "Open") as PeriodStatus,
    version: Number(period?.version || 0),
    note: (period?.note || "") as string,
    legacyLock: (entity.lock_date || null) as string | null,
    checks,
    preflightHash: fingerprint({ entityId, month, checks }),
    history,
    legacyHistory,
  };
}

export async function unlockLegacyPeriod(
  tx: SQL,
  ctx: Context,
  command: LegacyUnlock,
) {
  if (ctx.role !== "admin")
    throw new Problem(
      403,
      "Only an administrator can release an earlier date lock.",
    );
  const payloadHash = fingerprint(command);
  const entity = (
    await tx.query("SELECT id,lock_date FROM entities WHERE id=$1 FOR UPDATE", [
      command.entity_id,
    ])
  ).rows[0];
  if (!entity) throw new Problem(404, "Legal entity not found.");
  const prior = (
    await tx.query(
      "SELECT id,payload_hash FROM legacy_period_unlocks WHERE request_key=$1",
      [command.request_key],
    )
  ).rows[0];
  if (prior) {
    if (prior.payload_hash !== payloadHash)
      throw new Problem(409, "This retry key was used for a different unlock.");
    return { id: prior.id };
  }
  if (entity.lock_date !== command.expected_lock_date)
    throw new Problem(
      409,
      "The earlier date lock changed. Refresh before unlocking.",
    );
  await tx.query("UPDATE entities SET lock_date=NULL WHERE id=$1", [
    command.entity_id,
  ]);
  const id = uuid();
  await tx.query(
    `INSERT INTO legacy_period_unlocks(id,tenant_id,entity_id,lock_date,reason,request_key,payload_hash,actor_id,actor_name)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      ctx.tenantId,
      command.entity_id,
      command.expected_lock_date,
      command.reason,
      command.request_key,
      payloadHash,
      ctx.userId,
      ctx.name || ctx.userId,
    ],
  );
  await audit(tx, ctx, id, "period.legacy-unlock", {
    entity_id: command.entity_id,
    lock_date: command.expected_lock_date,
    reason: command.reason,
  });
  return { id };
}

export async function transitionPeriod(
  tx: SQL,
  ctx: Context,
  command: Transition,
) {
  if (!["admin", "finance"].includes(ctx.role))
    throw new Problem(403, "Only finance staff can manage accounting periods.");
  if (command.to === "Closed" || command.to === "Open") {
    if (ctx.role !== "admin")
      throw new Problem(
        403,
        "Only an administrator can close or reopen a month.",
      );
  }
  const payloadHash = fingerprint(command);
  // Serialize period changes with journal posting via the entity row lock.
  const entity = (
    await tx.query("SELECT id FROM entities WHERE id=$1 FOR UPDATE", [
      command.entity_id,
    ])
  ).rows[0];
  if (!entity) throw new Problem(404, "Legal entity not found.");
  const prior = (
    await tx.query(
      "SELECT id,payload_hash FROM accounting_period_events WHERE request_key=$1",
      [command.request_key],
    )
  ).rows[0];
  if (prior) {
    if (prior.payload_hash !== payloadHash)
      throw new Problem(
        409,
        "This retry key was used for a different transition.",
      );
    return { id: prior.id };
  }
  const preview = await periodPreview(
    tx,
    ctx,
    command.entity_id,
    command.month,
  );
  if (preview.legacyLock && preview.legacyLock >= preview.start)
    throw new Problem(
      409,
      "This month is covered by the older date lock. It cannot be reopened here.",
    );
  if (preview.version !== command.version)
    throw new Problem(409, "The period changed. Refresh before continuing.");
  if (command.preflight_hash !== preview.preflightHash)
    throw new Problem(
      409,
      "The close checks changed. Review the latest results.",
    );
  if (command.to === "Soft closed" && preview.status !== "Open")
    throw new Problem(409, "Only an open month can be soft-closed.");
  if (command.to === "Closed" && preview.status !== "Soft closed")
    throw new Problem(409, "Soft-close the month before final close.");
  if (command.to === "Open" && preview.status === "Open")
    throw new Problem(409, "This month is already open.");
  if (
    command.to !== "Open" &&
    preview.end > new Date().toISOString().slice(0, 10)
  )
    throw new Problem(409, "Wait until the month has ended before closing it.");
  if (command.to === "Open") {
    const later = (
      await tx.query(
        "SELECT month FROM accounting_periods WHERE entity_id=$1 AND month>$2 AND status<>'Open' LIMIT 1",
        [command.entity_id, preview.start],
      )
    ).rows[0];
    if (later) throw new Problem(409, "Reopen later closed months first.");
  } else {
    if (preview.checks.some((c) => c.severity === "blocker"))
      throw new Problem(409, "Resolve the ledger balance before closing.");
    if (
      preview.checks.some((c) => c.severity === "warning") &&
      !command.acknowledge_warnings
    )
      throw new Problem(
        409,
        "Review and acknowledge the outstanding close checks.",
      );
  }
  if (preview.version === 0)
    await tx.query(
      `INSERT INTO accounting_periods(tenant_id,entity_id,month,status,version,note,changed_by)
       VALUES($1,$2,$3,$4,1,$5,$6)`,
      [
        ctx.tenantId,
        command.entity_id,
        preview.start,
        command.to,
        command.reason,
        ctx.userId,
      ],
    );
  else
    await tx.query(
      `UPDATE accounting_periods SET status=$3,version=version+1,note=$4,changed_by=$5,changed_at=now()
       WHERE entity_id=$1 AND month=$2`,
      [
        command.entity_id,
        preview.start,
        command.to,
        command.reason,
        ctx.userId,
      ],
    );
  const eventId = uuid();
  const warnings = preview.checks.filter((c) => c.severity === "warning");
  await tx.query(
    `INSERT INTO accounting_period_events(id,tenant_id,entity_id,month,from_status,to_status,reason,warnings,request_key,payload_hash,actor_id,actor_name)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      eventId,
      ctx.tenantId,
      command.entity_id,
      preview.start,
      preview.status,
      command.to,
      command.reason,
      JSON.stringify(warnings),
      command.request_key,
      payloadHash,
      ctx.userId,
      ctx.name || ctx.userId,
    ],
  );
  await audit(tx, ctx, eventId, "period.transition", {
    entity_id: command.entity_id,
    month: command.month,
    from: preview.status,
    to: command.to,
    reason: command.reason,
    warnings,
  });
  return { id: eventId };
}
