import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import type { Database } from "../server/db.ts";
import { inTenant } from "../server/db.ts";
import { seedAccounts, type Context } from "../server/domain.ts";
import { createApp } from "../server/app.ts";
import {
  executeJournalSchedule,
  runJournalSchedulesDue,
} from "../server/journal-schedules.ts";
import { periodPreview } from "../server/periods.ts";

const date = (value: Date) => value.toISOString().slice(0, 10);
export async function verifyJournalSchedules(t: TestContext, db: Database) {
  const tenant = uuid(),
    otherTenant = uuid(),
    entity = uuid(),
    otherEntity = uuid();
  const admin = uuid(),
    finance = uuid(),
    sales = uuid();
  const today = new Date(),
    prior = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth() - (today.getUTCDate() < 15 ? 2 : 1),
        15,
      ),
    );
  const first = date(prior);
  const next = date(
    new Date(Date.UTC(prior.getUTCFullYear(), prior.getUTCMonth() + 1, 15)),
  );
  const reversalDue = date(
    new Date(Date.UTC(prior.getUTCFullYear(), prior.getUTCMonth() + 1, 1)),
  );
  await db.transaction(async (tx) => {
    for (const [id, name] of [
      [tenant, "Journal schedules"],
      [otherTenant, "Other schedules"],
    ])
      await tx.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [id, name]);
    for (const [id, role] of [
      [admin, "admin"],
      [finance, "finance"],
      [sales, "sales"],
    ]) {
      await tx.query("INSERT INTO users(id,name,email) VALUES($1,$2,$3)", [
        id,
        role,
        `${id}@example.test`,
      ]);
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [tenant, id, role],
      );
    }
    for (const [id, owner, code] of [
      [entity, tenant, "JSC"],
      [otherEntity, otherTenant, "JOT"],
    ]) {
      await tx.query(
        "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,$3,$3)",
        [id, owner, code],
      );
      await seedAccounts(tx, owner, id);
    }
  });
  const origin = "http://127.0.0.1:4320",
    app = createApp(db, origin);
  await app.ready();
  t.after(() => app.close());
  async function login(userId: string) {
    const headers = { host: "127.0.0.1:4320", origin };
    const signed = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers,
      payload: { userId, tenantId: tenant },
    });
    assert.equal(signed.statusCode, 200, signed.body);
    const cookie = String(signed.headers["set-cookie"]).split(";")[0];
    const me = (
      await app.inject({ url: "/api/me", headers: { ...headers, cookie } })
    ).json();
    return async (payload?: Record<string, unknown>, expected = 200) => {
      const response = await app.inject({
        method: payload ? "POST" : "GET",
        url: payload ? "/api/commands" : "/api/data",
        headers: { ...headers, cookie, "x-csrf-token": me.csrf },
        payload,
      });
      assert.equal(response.statusCode, expected, response.body);
      return response.json();
    };
  }
  const owner = await login(admin),
    accountant = await login(finance),
    seller = await login(sales);
  const lines = [
    {
      account_code: "5000",
      debit: "125.25",
      credit: "0",
      memo: "Monthly accrual",
    },
    { account_code: "3000", debit: "0", credit: "125.25", memo: "Offset" },
  ];
  const create = {
    action: "journal-schedule.create",
    entity_id: entity,
    name: "Monthly accrual",
    reference: "ACCRUAL",
    memo: "Review and post monthly accrual",
    lines,
    start_date: first,
    end_date: null,
    frequency: "monthly",
    timezone: "UTC",
    occurrences: 2,
    reverse_next_month: true,
    request_key: uuid(),
  };
  await t.test(
    "schedule is entity-scoped, balanced and idempotent",
    async () => {
      await seller(create, 403);
      await owner(
        { ...create, entity_id: otherEntity, request_key: uuid() },
        404,
      );
      await owner(
        {
          ...create,
          lines: [lines[0], { ...lines[1], credit: "124" }],
          request_key: uuid(),
        },
        400,
      );
      await owner(
        {
          ...create,
          lines: [{ ...lines[0], account_code: "1100" }, lines[1]],
          request_key: uuid(),
        },
        400,
      );
      const made = await accountant(create);
      assert.equal((await accountant(create)).id, made.id);
      await accountant({ ...create, name: "Different" }, 409);
      const salesData = await seller();
      assert.equal(salesData.journalSchedules.length, 0);
      const data = await accountant();
      assert.equal(
        data.journalSchedules.find((p: { id: string }) => p.id === made.id)
          .status,
        "Active",
      );
    },
  );
  const scheduleId = (await accountant()).journalSchedules.find(
    (p: { name: string }) => p.name === create.name,
  ).id;
  const ctx: Context = { tenantId: tenant, userId: admin, role: "admin" };
  const closePreview = (month: string) =>
    inTenant(db, tenant, (tx) => periodPreview(tx, ctx, entity, month));
  const previousMonth = first.slice(0, 7);
  assert.equal(
    (await closePreview(previousMonth)).checks.find(
      (c) => c.key === "journal-schedules",
    )?.count,
    1,
  );
  await t.test(
    "worker creates review drafts once, never books money",
    async () => {
      await runJournalSchedulesDue(db, today);
      await runJournalSchedulesDue(db, today);
      const data = await accountant();
      const occurrences = data.journalOccurrences.filter(
        (o: { schedule_id: string }) => o.schedule_id === scheduleId,
      );
      assert.equal(occurrences.length, 2);
      assert.deepEqual(
        occurrences
          .map((o: { scheduled_date: string }) => o.scheduled_date)
          .sort(),
        [first, next],
      );
      assert.ok(
        occurrences.every(
          (o: { status: string }) => o.status === "Pending review",
        ),
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM journals WHERE entity_id=$1",
            [entity],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        data.journalSchedules.find((p: { id: string }) => p.id === scheduleId)
          .status,
        "Completed",
      );
      assert.equal(
        (await closePreview(previousMonth)).checks.find(
          (c) => c.key === "journal-schedules",
        )?.count,
        1,
      );
    },
  );
  const occurrences = (await accountant()).journalOccurrences.filter(
    (o: { schedule_id: string }) => o.schedule_id === scheduleId,
  );
  const firstId = occurrences.find(
    (o: { scheduled_date: string }) => o.scheduled_date === first,
  ).id;
  const secondId = occurrences.find(
    (o: { scheduled_date: string }) => o.scheduled_date === next,
  ).id;
  await t.test(
    "reviewed posting is exact, idempotent and queues a reversal",
    async () => {
      await seller({ action: "journal-schedule.post", id: firstId }, 403);
      const posted = await accountant({
        action: "journal-schedule.post",
        id: firstId,
      });
      assert.equal(
        (await accountant({ action: "journal-schedule.post", id: firstId })).id,
        posted.id,
      );
      const data = await accountant();
      const occurrence = data.journalOccurrences.find(
        (o: { id: string }) => o.id === firstId,
      );
      assert.equal(occurrence.status, "Posted");
      assert.equal(occurrence.journal_id, posted.id);
      const task = data.journalReversalTasks.find(
        (r: { original_journal_id: string }) =>
          r.original_journal_id === posted.id,
      );
      assert.equal(task.due_date, reversalDue);
      assert.equal(task.status, "Pending review");
      assert.equal(
        (await closePreview(previousMonth)).checks.find(
          (c) => c.key === "journal-schedules",
        )?.count,
        0,
      );
      assert.equal(
        (await closePreview(reversalDue.slice(0, 7))).checks.find(
          (c) => c.key === "journal-reversals",
        )?.count,
        1,
      );
      const ledger = (
        await db.query(
          "SELECT account_code,debit_minor,credit_minor FROM journal_lines WHERE journal_id=$1 ORDER BY line_number",
          [posted.id],
        )
      ).rows;
      assert.deepEqual(
        ledger.map((l) => [l.account_code, l.debit_minor, l.credit_minor]),
        [
          ["5000", "12525", "0"],
          ["3000", "0", "12525"],
        ],
      );
      await accountant(
        {
          action: "journal-reversal.post",
          id: task.id,
          date: first,
          reason: "Too early",
        },
        400,
      );
      const reversed = await accountant({
        action: "journal-reversal.post",
        id: task.id,
        date: reversalDue,
        reason: "Next-period reversal",
      });
      assert.equal(
        (
          await accountant({
            action: "journal-reversal.post",
            id: task.id,
            date: reversalDue,
            reason: "Next-period reversal",
          })
        ).id,
        reversed.id,
      );
      assert.equal(
        (await accountant()).journalReversalTasks.find(
          (r: { id: string }) => r.id === task.id,
        ).status,
        "Posted",
      );
      await accountant(
        {
          action: "journal-reversal.post",
          id: task.id,
          date: reversalDue,
          reason: "Different retry",
        },
        409,
      );
      assert.equal(
        (await closePreview(reversalDue.slice(0, 7))).checks.find(
          (c) => c.key === "journal-reversals",
        )?.count,
        0,
      );
      assert.equal(
        (
          await db.query(
            "SELECT reverses_journal_id FROM journals WHERE id=$1",
            [reversed.id],
          )
        ).rows[0].reverses_journal_id,
        posted.id,
      );
    },
  );
  await t.test("manual journals may schedule a reviewed reversal", async () => {
    const due = reversalDue;
    const original = await accountant({
      action: "manual-journal.create",
      entity_id: entity,
      date: first,
      reference: "MANUAL-ACCRUAL",
      memo: "Temporary accrual",
      lines,
      auto_reverse_on: due,
      request_key: uuid(),
    });
    const task = (await accountant()).journalReversalTasks.find(
      (r: { original_journal_id: string }) =>
        r.original_journal_id === original.id,
    );
    assert.equal(task.due_date, due);
    const reversal = await accountant({
      action: "journal-reversal.post",
      id: task.id,
      date: due,
      reason: "Reverse temporary accrual",
    });
    assert.equal(
      (await accountant()).journalReversalTasks.find(
        (r: { id: string }) => r.id === task.id,
      ).reversal_journal_id,
      reversal.id,
    );
  });
  await t.test(
    "pause and resume do not create drafts while paused",
    async () => {
      const made = await owner({
        ...create,
        name: "Pause test",
        occurrences: 1,
        reverse_next_month: false,
        request_key: uuid(),
      });
      await owner({
        action: "journal-schedule.status",
        id: made.id,
        version: 1,
        status: "Paused",
      });
      await owner(
        {
          action: "journal-schedule.status",
          id: made.id,
          version: 1,
          status: "Active",
        },
        409,
      );
      await runJournalSchedulesDue(db, today);
      assert.equal(
        (await owner()).journalOccurrences.some(
          (o: { schedule_id: string }) => o.schedule_id === made.id,
        ),
        false,
      );
      await owner({
        action: "journal-schedule.status",
        id: made.id,
        version: 2,
        status: "Active",
      });
      await runJournalSchedulesDue(db, today);
      const draft = (await owner()).journalOccurrences.find(
        (o: { schedule_id: string }) => o.schedule_id === made.id,
      );
      assert.equal(draft.status, "Pending review");
      await owner({
        action: "journal-schedule.skip",
        id: draft.id,
        reason: "Not needed",
      });
    },
  );
  await t.test(
    "skips are audited, posted journals stay immutable, locks prevent backdating",
    async () => {
      await owner({
        action: "journal-schedule.skip",
        id: secondId,
        reason: "No accrual this month",
      });
      await accountant({ action: "journal-schedule.post", id: secondId }, 409);
      await assert.rejects(
        db.query(
          "UPDATE journal_schedule_occurrences SET memo='tampered' WHERE id=$1",
          [firstId],
        ),
        /immutable/i,
      );
      await inTenant(db, tenant, (tx) =>
        tx.query("UPDATE entities SET lock_date=$2 WHERE id=$1", [
          entity,
          next,
        ]),
      );
      const draft = {
        ...create,
        name: "Another accrual",
        start_date: next,
        reverse_next_month: false,
        occurrences: 1,
        request_key: uuid(),
      };
      const made = await owner(draft);
      await inTenant(db, tenant, (tx) =>
        executeJournalSchedule(
          tx,
          ctx,
          { action: "journal-schedule.run", id: made.id },
          today,
        ),
      );
      const pending = (await owner()).journalOccurrences.find(
        (o: { schedule_id: string }) => o.schedule_id === made.id,
      );
      await accountant(
        { action: "journal-schedule.post", id: pending.id },
        409,
      );
    },
  );
  await t.test(
    "manual generation after worker completion is a no-op, not a paused warning",
    async () => {
      const made = await owner({
        ...create,
        name: "Completed retry",
        occurrences: 1,
        request_key: uuid(),
      });
      await runJournalSchedulesDue(db, today);
      const before = await owner();
      const schedule = before.journalSchedules.find(
        (p: { id: string }) => p.id === made.id,
      );
      assert.equal(schedule.status, "Completed");
      const occurrences = before.journalOccurrences.filter(
        (o: { schedule_id: string }) => o.schedule_id === made.id,
      );
      assert.equal(occurrences.length, 1);
      const retry = await owner({
        action: "journal-schedule.run",
        id: made.id,
      });
      assert.equal(retry.generated, 0);
      await seller({ action: "journal-schedule.run", id: made.id }, 403);
      const after = await owner();
      assert.equal(
        after.journalSchedules.find((p: { id: string }) => p.id === made.id)
          .version,
        schedule.version,
      );
      assert.deepEqual(
        after.journalOccurrences.filter(
          (o: { schedule_id: string }) => o.schedule_id === made.id,
        ),
        occurrences,
      );
    },
  );
  await t.test("revoked creator cannot generate drafts", async () => {
    const made = await owner({
      ...create,
      name: "Revoked",
      start_date: first,
      occurrences: 1,
      request_key: uuid(),
    });
    await db.query(
      "UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2",
      [tenant, admin],
    );
    await runJournalSchedulesDue(db, today);
    const occurrence = (await accountant()).journalOccurrences.find(
      (o: { schedule_id: string }) => o.schedule_id === made.id,
    );
    assert.equal(occurrence, undefined);
    assert.match(
      (await accountant()).journalSchedules.find(
        (p: { id: string }) => p.id === made.id,
      ).last_error,
      /no longer has finance access/,
    );
  });
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM journal_schedule_occurrences WHERE tenant_id=$1",
        [otherTenant],
      )
    ).rows[0].n,
    0,
  );
}
