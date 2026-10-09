import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import { openDatabase, migrate, inTenant } from "../server/db.ts";
import { seed } from "../server/seed.ts";
import { executeRecurring, runRecurringDue } from "../server/recurring.ts";
import {
  executeJournalSchedule,
  runJournalSchedulesDue,
} from "../server/journal-schedules.ts";
import {
  executeBillSchedule,
  runRecurringBillsDue,
} from "../server/recurring-bills.ts";

test("scheduled drafts stop when creator entity access or effective posting permission is removed", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  const member = (
    await db.query("SELECT * FROM memberships WHERE role='finance'")
  ).rows[0];
  const entities = (
    await db.query("SELECT id FROM entities WHERE tenant_id=$1 ORDER BY code", [
      member.tenant_id,
    ])
  ).rows;
  const entity = entities[0].id,
    other = entities[1].id;
  const ctx = {
    tenantId: member.tenant_id,
    userId: member.user_id,
    role: "finance" as const,
  };
  const vendor = uuid();
  await db.query(
    "INSERT INTO companies(id,tenant_id,name,vendor,owner_id) VALUES($1,$2,'Scheduled access sample',true,$3)",
    [vendor, ctx.tenantId, ctx.userId],
  );
  const schedule = {
    entity_id: entity,
    name: "Access boundary",
    start_date: "2035-01-01",
    end_date: null,
    frequency: "monthly",
    timezone: "UTC",
    occurrences: 1,
  };
  const expense = await inTenant(db, ctx.tenantId, (tx) =>
    executeRecurring(tx, ctx, {
      ...schedule,
      action: "recurring.expense",
      request_key: uuid(),
      description: "Sample rent",
      deal_id: null,
      amount: "100",
    }),
  );
  const journal = await inTenant(db, ctx.tenantId, (tx) =>
    executeJournalSchedule(tx, ctx, {
      ...schedule,
      action: "journal-schedule.create",
      request_key: uuid(),
      reference: "Sample schedule",
      memo: "Sample only",
      reverse_next_month: false,
      lines: [
        { account_code: "5000", debit: "100", credit: "0", memo: "Expense" },
        { account_code: "3000", debit: "0", credit: "100", memo: "Offset" },
      ],
    }),
  );
  const bill = await inTenant(db, ctx.tenantId, (tx) =>
    executeBillSchedule(tx, ctx, {
      ...schedule,
      action: "bill-schedule.create",
      request_key: uuid(),
      vendor_id: vendor,
      deal_id: null,
      currency: "PKR",
      fx: "1",
      tax_treatment: "expense",
      due_days: 30,
      notes: "",
      lines: [
        {
          description: "Sample rent",
          quantity: "1",
          price: "100",
          tax: "0",
          account_code: "5000",
        },
      ],
    }),
  );
  const now = new Date("2035-01-15T12:00:00Z");
  async function run() {
    await runRecurringDue(db, now);
    await runJournalSchedulesDue(db, now);
    await runRecurringBillsDue(db, now);
  }
  async function rows() {
    return Promise.all(
      ["recurring_profiles", "journal_schedules", "bill_schedules"].map(
        (table, i) =>
          db
            .query(`SELECT next_index,last_error FROM ${table} WHERE id=$1`, [
              [expense.id, journal.id, bill.id][i],
            ])
            .then((r) => r.rows[0]),
      ),
    );
  }
  await db.query(
    "UPDATE memberships SET entity_ids=$3 WHERE tenant_id=$1 AND user_id=$2",
    [ctx.tenantId, ctx.userId, [other]],
  );
  await run();
  for (const row of await rows()) {
    assert.equal(row.next_index, 0);
    assert.match(row.last_error, /no longer has access to this legal entity/);
  }
  // Keep the Finance template but remove posting through a custom role.
  const profile = uuid();
  await db.query(
    "INSERT INTO role_profiles(id,tenant_id,name,base_role,capabilities) VALUES($1,$2,'Sample reviewer','finance','[\"books.view\"]')",
    [profile, ctx.tenantId],
  );
  await db.query(
    "UPDATE memberships SET entity_ids=NULL,role_profile_id=$3 WHERE tenant_id=$1 AND user_id=$2",
    [ctx.tenantId, ctx.userId, profile],
  );
  await run();
  for (const row of await rows()) {
    assert.equal(row.next_index, 0);
    assert.match(row.last_error, /finance access is required/);
  }
  // Restored permission allows exactly the original due cycle, still unposted.
  await db.query(
    "UPDATE memberships SET role_profile_id=NULL WHERE tenant_id=$1 AND user_id=$2",
    [ctx.tenantId, ctx.userId],
  );
  await run();
  for (const row of await rows()) {
    assert.equal(row.next_index, 1);
    assert.equal(row.last_error, "");
  }
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM journals WHERE tenant_id=$1",
        [ctx.tenantId],
      )
    ).rows[0].n,
    0,
  );
});
