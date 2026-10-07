import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import type { Database } from "../server/db.ts";
import { inTenant } from "../server/db.ts";
import { seedAccounts } from "../server/domain.ts";
import { createApp } from "../server/app.ts";
import { partyStatement } from "../server/statements.ts";
import { ageing, financialReports } from "../server/financial-reports.ts";
import { bankDetail } from "../server/banking.ts";
import {
  executeBillSchedule,
  runRecurringBillsDue,
} from "../server/recurring-bills.ts";

export async function verifyPayables(t: TestContext, db: Database) {
  const tenant = uuid(),
    other = uuid(),
    entity = uuid(),
    secondEntity = uuid(),
    admin = uuid(),
    finance = uuid(),
    sales = uuid();
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO tenants VALUES($1,$2),($3,$4)", [
      tenant,
      "Payables test",
      other,
      "Other payables tenant",
    ]);
    for (const [id, role] of [
      [admin, "admin"],
      [finance, "finance"],
      [sales, "sales"],
    ]) {
      await tx.query("INSERT INTO users VALUES($1,$2,$3)", [
        id,
        role,
        `${id}@example.test`,
      ]);
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [tenant, id, role],
      );
    }
    for (const [id, code] of [
      [entity, "AP"],
      [secondEntity, "AP2"],
    ]) {
      await tx.query(
        "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,$3,$4)",
        [id, tenant, `Payables ${code}`, code],
      );
      await seedAccounts(tx, tenant, id);
    }
  });
  const origin = "http://127.0.0.1:4320",
    app = createApp(db, origin);
  await app.ready();
  t.after(() => app.close());
  async function login(id: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers: { host: "127.0.0.1:4320", origin },
      payload: { tenantId: tenant, userId: id },
    });
    const cookie = response.headers["set-cookie"]!.toString().split(";")[0];
    const headers = { host: "127.0.0.1:4320", origin, cookie };
    const me = (await app.inject({ url: "/api/me", headers })).json();
    return {
      get: async () => (await app.inject({ url: "/api/data", headers })).json(),
      command: async (payload: Record<string, unknown>, expected = 200) => {
        const result = await app.inject({
          method: "POST",
          url: "/api/commands",
          headers: { ...headers, "x-csrf-token": me.csrf },
          payload,
        });
        assert.equal(result.statusCode, expected, result.body);
        return result.json();
      },
    };
  }
  const owner = await login(admin),
    accountant = await login(finance),
    rep = await login(sales);
  const vendor = await accountant.command({
    action: "company.create",
    name: `Vendor ${uuid()}`,
    vendor: true,
    customer: false,
    domain: "",
    industry: "",
    tax_id: "",
    address: "",
    service_entity_id: null,
  });
  const date = "2026-09-20";
  await t.test(
    "recurring vendor bills create reviewable anchored drafts with exact retries and future-only changes",
    async () => {
      const ctx = {
        tenantId: tenant,
        userId: finance,
        role: "finance" as const,
      };
      const run = (id: string, now = "2034-03-31T12:00:00Z") =>
        inTenant(db, tenant, (tx) =>
          executeBillSchedule(
            tx,
            ctx,
            { action: "bill-schedule.run", id },
            new Date(now),
          ),
        );
      const create = {
        action: "bill-schedule.create",
        entity_id: entity,
        vendor_id: vendor.id,
        deal_id: null,
        name: "Monthly rent",
        currency: "USD",
        fx: "280",
        lines: [
          {
            description: "Rent",
            quantity: "1",
            price: "100",
            tax: "18",
            account_code: "5200",
          },
        ],
        tax_treatment: "recoverable",
        due_days: 15,
        notes: "Review vendor invoice",
        start_date: "2034-01-31",
        end_date: null,
        frequency: "monthly",
        timezone: "Asia/Karachi",
        occurrences: 4,
        request_key: uuid(),
      };
      await rep.command(create, 403);
      const p = await accountant.command(create);
      assert.equal((await accountant.command(create)).id, p.id);
      await accountant.command({ ...create, name: "Changed retry" }, 409);
      await accountant.command(
        { ...create, request_key: uuid(), currency: "PKR", fx: "280" },
        400,
      );
      await accountant.command(
        { ...create, request_key: uuid(), end_date: "2034-01-01" },
        400,
      );
      const before = await accountant.get();
      assert.equal(
        before.billSchedules.find((s: any) => s.id === p.id).next_index,
        0,
      );
      assert.equal((await rep.get()).billSchedules.length, 0);
      const initialJournals = (
        await db.query(
          "SELECT count(*) AS n FROM journals WHERE tenant_id=$1",
          [tenant],
        )
      ).rows[0].n;
      assert.equal((await run(p.id, "2034-01-30T12:00:00Z")).generated, 0);
      const results = await Promise.all([run(p.id), run(p.id), run(p.id)]);
      assert.equal(
        results.reduce((n, r) => n + (r.generated ?? 0), 0),
        3,
      );
      let data = await accountant.get(),
        profile = data.billSchedules.find((s: any) => s.id === p.id);
      const cycles = data.billScheduleOccurrences
        .filter((o: any) => o.schedule_id === p.id)
        .sort((a: any, b: any) => a.cycle - b.cycle);
      assert.deepEqual(
        cycles.map((o: any) => o.scheduled_date),
        ["2034-01-31", "2034-02-28", "2034-03-31"],
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*) AS n FROM journals WHERE tenant_id=$1",
            [tenant],
          )
        ).rows[0].n,
        initialJournals,
      );
      for (const o of cycles) {
        const b = data.bills.find((b: any) => b.id === o.bill_id);
        assert.equal(b.status, "Draft");
        assert.equal(b.total_minor, "11800");
        assert.equal(b.fx_micros, "280000000");
        assert.equal(o.template.version, o.cycle + 1);
      }
      const edit = {
        action: "bill-schedule.edit",
        id: p.id,
        version: profile.version,
        name: "Updated rent",
        lines: [{ ...create.lines[0], price: "200" }],
        fx: "300",
        tax_treatment: "recoverable",
        due_days: 30,
        notes: "Future only",
        end_date: null,
        occurrences: 4,
      };
      await accountant.command({ ...edit, version: 1 }, 409);
      await accountant.command(edit);
      assert.equal((await run(p.id, "2034-04-30T12:00:00Z")).generated, 1);
      data = await accountant.get();
      profile = data.billSchedules.find((s: any) => s.id === p.id);
      assert.equal(profile.status, "Completed");
      const last = data.billScheduleOccurrences.find(
          (o: any) => o.schedule_id === p.id && o.cycle === 3,
        ),
        lastBill = data.bills.find((b: any) => b.id === last.bill_id);
      assert.equal(lastBill.total_minor, "23600");
      assert.equal(lastBill.fx_micros, "300000000");
      assert.equal(
        data.bills.find((b: any) => b.id === cycles[0].bill_id).total_minor,
        "11800",
      );
      assert.equal((await run(p.id, "2035-01-01T12:00:00Z")).generated, 0);
      await accountant.command({ ...edit, version: profile.version }, 409);
      await accountant.command({
        action: "bill.submit",
        id: lastBill.id,
        version: lastBill.version,
      });
      const submitted = (await accountant.get()).bills.find(
        (b: any) => b.id === lastBill.id,
      );
      await owner.command({
        action: "bill.approve",
        id: lastBill.id,
        version: submitted.version,
      });
      assert.equal(
        (await accountant.get()).bills.find((b: any) => b.id === lastBill.id)
          .base_minor,
        "7080000",
      );
      await assert.rejects(
        () =>
          inTenant(db, other, (tx) =>
            executeBillSchedule(
              tx,
              { ...ctx, tenantId: other },
              { action: "bill-schedule.run", id: p.id },
            ),
          ),
        /not found/,
      );
      await assert.rejects(
        () =>
          inTenant(db, tenant, (tx) =>
            tx.query(
              "UPDATE bill_schedule_occurrences SET reason='rewrite' WHERE id=$1",
              [last.id],
            ),
          ),
        /immutable|permission denied/,
      );
    },
  );
  await t.test(
    "recurring bill pause, skip, period locks, duplicate protection and revoked worker access preserve history",
    async () => {
      const ctx = {
        tenantId: tenant,
        userId: finance,
        role: "finance" as const,
      };
      const create = {
        action: "bill-schedule.create",
        entity_id: secondEntity,
        vendor_id: vendor.id,
        deal_id: null,
        name: "Office lease",
        currency: "PKR",
        fx: "1",
        lines: [
          {
            description: "Lease",
            quantity: "1",
            price: "123.45",
            tax: "0",
            account_code: "5200",
          },
        ],
        tax_treatment: "expense",
        due_days: 0,
        notes: "",
        start_date: "2035-01-31",
        end_date: "2035-04-30",
        frequency: "monthly",
        timezone: "UTC",
        occurrences: null,
        request_key: uuid(),
      };
      const p = await accountant.command(create);
      const read = async () =>
        (await accountant.get()).billSchedules.find((s: any) => s.id === p.id);
      const act = (
        command: Record<string, unknown>,
        date = "2035-04-30T12:00:00Z",
      ) =>
        inTenant(db, tenant, (tx) =>
          executeBillSchedule(tx, ctx, command, new Date(date)),
        );
      await accountant.command({
        action: "bill-schedule.status",
        id: p.id,
        version: 1,
        status: "Paused",
        reason: "Review lease",
      });
      await assert.rejects(
        () => act({ action: "bill-schedule.run", id: p.id }),
        /Resume/,
      );
      await assert.rejects(
        () =>
          act(
            {
              action: "bill-schedule.skip",
              id: p.id,
              version: 2,
              reason: "Too early",
            },
            "2035-01-01T00:00:00Z",
          ),
        /due/,
      );
      await act({
        action: "bill-schedule.skip",
        id: p.id,
        version: 2,
        reason: "First month waived",
      });
      await accountant.command({
        action: "bill-schedule.status",
        id: p.id,
        version: 3,
        status: "Active",
        reason: "Lease confirmed",
      });
      await db.query("UPDATE entities SET lock_date='2035-02-28' WHERE id=$1", [
        secondEntity,
      ]);
      await runRecurringBillsDue(db, new Date("2035-04-30T12:00:00Z"));
      assert.match((await read()).last_error, /locked period/);
      let profile = await read();
      await act({
        action: "bill-schedule.skip",
        id: p.id,
        version: profile.version,
        reason: "Already entered at cutover",
      });
      await accountant.command({
        action: "bill.create",
        entity_id: secondEntity,
        vendor_id: vendor.id,
        deal_id: null,
        reference: `Manual lease ${uuid()}`,
        bill_date: "2035-03-31",
        due_date: "2035-03-31",
        currency: "PKR",
        fx: "1",
        lines: create.lines,
        tax_treatment: "expense",
        notes: "",
        request_key: uuid(),
      });
      await runRecurringBillsDue(db, new Date("2035-04-30T12:00:00Z"));
      profile = await read();
      assert.match(profile.last_error, /Possible duplicate/);
      assert.equal(profile.next_index, 2);
      await act({
        action: "bill-schedule.skip",
        id: p.id,
        version: profile.version,
        reason: "Manual vendor invoice already entered",
      });
      await db.query(
        "UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [tenant, finance],
      );
      await runRecurringBillsDue(db, new Date("2035-04-30T12:00:00Z"));
      assert.equal(
        (
          await db.query("SELECT next_index FROM bill_schedules WHERE id=$1", [
            p.id,
          ])
        ).rows[0].next_index,
        3,
      );
      await db.query(
        "UPDATE memberships SET active=true WHERE tenant_id=$1 AND user_id=$2",
        [tenant, finance],
      );
      await runRecurringBillsDue(db, new Date("2035-04-30T12:00:00Z"));
      assert.equal((await read()).status, "Completed");
      const stopped = await accountant.command({
        ...create,
        request_key: uuid(),
        start_date: "2036-01-01",
        end_date: null,
      });
      await accountant.command({
        action: "bill-schedule.status",
        id: stopped.id,
        version: 1,
        status: "Stopped",
        reason: "Cancelled lease",
      });
      await accountant.command(
        {
          action: "bill-schedule.status",
          id: stopped.id,
          version: 2,
          status: "Active",
          reason: "Reopen",
        },
        409,
      );
      await db.query("UPDATE entities SET lock_date=NULL WHERE id=$1", [
        secondEntity,
      ]);
    },
  );
  await t.test(
    "vendor advances retain historical prepayment costs, settle bills once and reverse exactly",
    async () => {
      const vendor = await accountant.command({
        action: "company.create",
        name: `Advance vendor ${uuid()}`,
        vendor: true,
        customer: false,
        domain: "",
        industry: "",
        tax_id: "",
        address: "",
        service_entity_id: null,
      });
      const create = {
        action: "vendor-advance.create",
        entity_id: entity,
        vendor_id: vendor.id,
        deal_id: null,
        currency: "USD",
        date: "2038-01-01",
        amount: "100",
        wht: "0",
        fee: "1",
        fx: "280",
        bank_account_id: null,
        purpose: "operating",
        reference: `ADV-${uuid()}`,
        notes: "Purchase prepayment, not a security deposit",
        request_key: uuid(),
      };
      await rep.command(create, 403);
      const a = await accountant.command(create);
      assert.equal((await accountant.command(create)).id, a.id);
      await assert.rejects(
        inTenant(db, tenant, (tx) =>
          tx.query(
            "UPDATE vendor_advances SET reference='Silent change' WHERE id=$1",
            [a.id],
          ),
        ),
        /immutable/i,
      );
      await inTenant(db, other, async (tx) => {
        assert.equal(
          (await tx.query("SELECT id FROM vendor_advances WHERE id=$1", [a.id]))
            .rows.length,
          0,
        );
      });
      await accountant.command({ ...create, amount: "101" }, 409);
      await accountant.command(
        { ...create, request_key: uuid(), currency: "PKR", fx: "280" },
        400,
      );
      const bill = await accountant.command({
        action: "bill.create",
        entity_id: entity,
        vendor_id: vendor.id,
        deal_id: null,
        reference: `ADV-BILL-${uuid()}`,
        bill_date: "2038-01-02",
        due_date: "2038-02-02",
        currency: "USD",
        fx: "300",
        lines: [
          {
            description: "Service purchase",
            quantity: "1",
            price: "100",
            tax: "0",
            account_code: "5000",
          },
        ],
        tax_treatment: "expense",
        notes: "",
        request_key: uuid(),
      });
      let b = (await accountant.get()).bills.find((b: any) => b.id === bill.id);
      await accountant.command(
        {
          action: "vendor-advance.apply",
          id: a.id,
          bill_id: bill.id,
          date: "2038-01-02",
          amount: "40",
          request_key: uuid(),
        },
        400,
      );
      await accountant.command({
        action: "bill.submit",
        id: b.id,
        version: b.version,
      });
      b = (await accountant.get()).bills.find((b: any) => b.id === bill.id);
      await owner.command({
        action: "bill.approve",
        id: b.id,
        version: b.version,
      });
      const apply = {
        action: "vendor-advance.apply",
        id: a.id,
        bill_id: bill.id,
        date: "2038-01-03",
        amount: "40",
        request_key: uuid(),
      };
      const application = await accountant.command(apply);
      assert.equal((await accountant.command(apply)).id, application.id);
      await accountant.command({ ...apply, amount: "41" }, 409);
      const journal = (
        await db.query(
          "SELECT l.account_code,l.debit_minor,l.credit_minor FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type='vendor-advance-application' AND j.source_id=$1",
          [application.id],
        )
      ).rows;
      assert.equal(
        journal.find((l) => l.account_code === "2000")!.debit_minor,
        "1200000",
      );
      assert.equal(
        journal.find((l) => l.account_code === "1400")!.credit_minor,
        "1120000",
      );
      assert.equal(
        journal.find((l) => l.account_code === "5000")!.credit_minor,
        "80000",
      );
      assert.ok(
        !journal.some((l) => ["4100", "5100", "1000"].includes(l.account_code)),
      );
      await accountant.command(
        {
          action: "vendor-credit.create",
          bill_id: bill.id,
          date: "2038-01-03",
          reference: "Credit",
          reason: "Return",
          lines: [{ index: 0, amount: "10" }],
          request_key: uuid(),
        },
        409,
      );
      await inTenant(db, tenant, async (tx) => {
        const ctx = {
          tenantId: tenant,
          userId: finance,
          role: "finance" as const,
        };
        const statement = await partyStatement(tx, ctx, {
          kind: "vendor",
          companyId: vendor.id,
          entityId: entity,
          from: "2038-01-01",
          to: "2038-01-03",
        });
        const group = statement.groups.find((g) => g.currency === "USD")!;
        assert.equal(group.availableAdvance, "6000");
        assert.equal(group.closing, "0");
        assert.equal(group.closingBase, "120000");
        const historical = await ageing(
          tx,
          [entity],
          "2038-01-02",
          "ap",
          3000000n,
          vendor.id,
        );
        assert.equal(
          historical.documents.find((d) => d.id === bill.id)?.outstanding,
          "10000",
        );
        const current = await ageing(
          tx,
          [entity],
          "2038-01-03",
          "ap",
          1800000n,
          vendor.id,
        );
        assert.equal(current.difference, "0");
      });
      const final = await accountant.command({
        ...apply,
        date: "2038-01-04",
        amount: "60",
        request_key: uuid(),
      });
      b = (await accountant.get()).bills.find((b: any) => b.id === bill.id);
      assert.equal(b.status, "Paid");
      assert.equal(b.paid_base_minor, "3000000");
      await accountant.command(
        {
          action: "vendor-advance.reverse",
          id: a.id,
          date: "2038-01-05",
          reason: "Correction",
        },
        409,
      );
      await accountant.command(
        {
          action: "vendor-advance.refund",
          id: a.id,
          date: "2038-01-05",
          amount: "1",
          fee: "0",
          fx: "290",
          bank_account_id: null,
          reference: "Too much",
          request_key: uuid(),
        },
        400,
      );
      const reverse = {
        action: "vendor-advance.reverse-application",
        id: final.id,
        date: "2038-01-05",
        reason: "Correction",
      };
      const reversed = await accountant.command(reverse);
      assert.equal((await accountant.command(reverse)).id, reversed.id);
      await accountant.command({ ...reverse, reason: "Changed" }, 409);
      await accountant.command({
        action: "vendor-advance.reverse-application",
        id: application.id,
        date: "2038-01-06",
        reason: "Correction",
      });
      const refund = {
        action: "vendor-advance.refund",
        id: a.id,
        date: "2038-01-07",
        amount: "100",
        fee: "2",
        fx: "290",
        bank_account_id: null,
        reference: "Refund received",
        request_key: uuid(),
      };
      const f = await accountant.command(refund);
      assert.equal((await accountant.command(refund)).id, f.id);
      const refundJournal = (
        await db.query(
          "SELECT l.account_code,l.debit_minor,l.credit_minor FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type='vendor-advance-refund' AND j.source_id=$1",
          [f.id],
        )
      ).rows;
      assert.equal(
        refundJournal.find((l) => l.account_code === "1000")!.debit_minor,
        "2842000",
      );
      assert.equal(
        refundJournal.find((l) => l.account_code === "4100")!.credit_minor,
        "100000",
      );
      await accountant.command({
        action: "vendor-advance.reverse-refund",
        id: f.id,
        date: "2038-01-08",
        reason: "Bank correction",
      });
      await accountant.command({
        action: "vendor-advance.reverse",
        id: a.id,
        date: "2038-01-09",
        reason: "Bank correction",
      });
      await db.query("UPDATE entities SET lock_date='2038-01-09' WHERE id=$1", [
        entity,
      ]);
      assert.equal((await accountant.command(create)).id, a.id);
      await accountant.command({ ...create, request_key: uuid() }, 409);
      await db.query("UPDATE entities SET lock_date=NULL WHERE id=$1", [
        entity,
      ]);
      assert.equal((await rep.get()).vendorAdvances.length, 0);
      const balance = (
        await db.query(
          "SELECT sum(l.debit_minor-l.credit_minor)::text AS n FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type LIKE 'vendor-advance%' AND j.entity_id=$1 GROUP BY l.account_code",
          [entity],
        )
      ).rows;
      assert.ok(balance.every((l) => l.n === "0"));
    },
  );
  await t.test(
    "capital vendor advances classify actual cash and withholding without accruing an expense",
    async () => {
      const bank = await owner.command({
        action: "bank.create",
        entity_id: secondEntity,
        name: "Advance bank",
        reference: "VA-TEST",
        opening_on: "2039-01-01",
        opening: "1000",
        offset_code: "3000",
        request_key: uuid(),
      });
      const c = {
        action: "vendor-advance.create",
        entity_id: secondEntity,
        vendor_id: vendor.id,
        deal_id: null,
        currency: "PKR",
        date: "2039-01-02",
        amount: "90",
        wht: "10",
        fee: "1",
        fx: "1",
        bank_account_id: bank.id,
        purpose: "investing",
        reference: `Equipment deposit ${uuid()}`,
        notes: "",
        request_key: uuid(),
      };
      const a = await accountant.command(c);
      await inTenant(db, tenant, async (tx) => {
        const report = await financialReports(
          tx,
          { tenantId: tenant, userId: admin, role: "admin" },
          { entityId: secondEntity, from: "2039-01-02", to: "2039-01-02" },
        );
        assert.equal(report.cash.investing, "-9000");
        assert.equal(report.cash.operating, "-100");
        assert.equal(report.cash.difference, "0");
        assert.deepEqual(report.cash.unsupported, []);
      });
      const b = await accountant.command({
        action: "bill.create",
        entity_id: secondEntity,
        vendor_id: vendor.id,
        deal_id: null,
        reference: `Equipment bill ${uuid()}`,
        bill_date: "2039-01-03",
        due_date: "2039-01-03",
        currency: "PKR",
        fx: "1",
        lines: [
          {
            description: "Equipment",
            quantity: "1",
            price: "100",
            tax: "0",
            account_code: "1500",
          },
        ],
        tax_treatment: "expense",
        notes: "",
        request_key: uuid(),
      });
      await accountant.command({ action: "bill.submit", id: b.id, version: 1 });
      await owner.command({ action: "bill.approve", id: b.id, version: 2 });
      await accountant.command({
        action: "vendor-advance.apply",
        id: a.id,
        bill_id: b.id,
        date: "2039-01-04",
        amount: "100",
        request_key: uuid(),
      });
      const profile = (await accountant.get()).vendorAdvances.find(
        (v: any) => v.id === a.id,
      );
      assert.equal(profile.applied_minor, "10000");
      assert.equal(profile.applied_base_minor, "10000");
      await inTenant(db, tenant, async (tx) => {
        const report = await financialReports(
          tx,
          { tenantId: tenant, userId: admin, role: "admin" },
          { entityId: secondEntity, from: "2039-01-02", to: "2039-01-04" },
        );
        assert.equal(report.cash.investing, "-9000");
        assert.equal(report.cash.operating, "-100");
        assert.equal(report.cash.difference, "0");
        assert.equal(report.balanceDifference, "0");
        const statement = await partyStatement(
          tx,
          { tenantId: tenant, userId: admin, role: "admin" },
          {
            kind: "vendor",
            companyId: vendor.id,
            entityId: secondEntity,
            from: "2039-01-01",
            to: "2039-01-04",
          },
        );
        assert.equal(
          statement.groups.find((g) => g.currency === "PKR")!.availableAdvance,
          "0",
        );
      });
    },
  );
  await t.test(
    "purchase orders reserve partial bills, retry safely and never post directly",
    async () => {
      const command = {
        action: "purchase-order.create",
        entity_id: entity,
        vendor_id: vendor.id,
        deal_id: null,
        order_date: date,
        delivery_date: null,
        currency: "PKR",
        fx: "1",
        lines: [
          {
            description: "Ordered production",
            quantity: "10",
            price: "100",
            tax: "18",
            account_code: "5200",
          },
        ],
        tax_treatment: "expense",
        reference: "PO reference",
        notes: "",
        terms: "",
        delivery_address: "",
        request_key: uuid(),
      };
      await rep.command(command, 403);
      const p = await accountant.command(command);
      await accountant.command(
        { ...command, reference: "Changed retry payload" },
        409,
      );
      assert.equal((await rep.get()).purchaseOrders.length, 0);
      await inTenant(db, other, async (tx) =>
        assert.equal(
          (await tx.query("SELECT * FROM purchase_orders")).rows.length,
          0,
        ),
      );
      const series = await accountant.command({
        action: "number-series.create",
        entity_id: entity,
        kind: "purchase-order",
        name: "Production orders",
        prefix: "PROD-PO-",
        next_number: 8,
        padding: 4,
      });
      const numbered = await accountant.command({
        ...command,
        number_series_id: series.id,
        request_key: uuid(),
      });
      assert.equal(
        (await accountant.get()).purchaseOrders.find(
          (r: any) => r.id === numbered.id,
        ).number,
        "PROD-PO-0008",
      );
      assert.equal((await accountant.command(command)).id, p.id);
      const order = async () =>
        (await accountant.get()).purchaseOrders.find((r: any) => r.id === p.id);
      assert.equal((await order()).number, "AP-PO-00001");
      await inTenant(db, tenant, async (tx) =>
        assert.equal(
          (await tx.query("SELECT * FROM journals WHERE source_id=$1", [p.id]))
            .rows.length,
          0,
        ),
      );
      await accountant.command({
        action: "purchase-order.status",
        id: p.id,
        version: 1,
        status: "Issued",
        reason: "Vendor order approved",
      });
      await assert.rejects(
        inTenant(db, tenant, (tx) =>
          tx.query(
            "UPDATE purchase_orders SET notes='Change issued details',version=version+1 WHERE id=$1",
            [p.id],
          ),
        ),
      );
      await accountant.command(
        {
          ...command,
          action: "purchase-order.edit",
          id: p.id,
          version: 2,
          entity_id: undefined,
          request_key: undefined,
        },
        409,
      );
      const conversion = {
        action: "purchase-order.bill",
        id: p.id,
        version: 2,
        reference: `PO-B-${uuid()}`,
        bill_date: date,
        due_date: "2026-10-20",
        fx: "1",
        allocations: [{ index: 0, quantity: "4" }],
        acknowledge_duplicate: false,
        request_key: uuid(),
      };
      const first = await accountant.command(conversion);
      assert.equal((await accountant.command(conversion)).id, first.id);
      assert.equal((await order()).allocations.length, 1);
      const created = (await accountant.get()).bills.find(
        (r: any) => r.id === first.id,
      );
      assert.equal(created.purchase_order_id, p.id);
      assert.equal(created.total_minor, "47200");
      assert.equal(created.status, "Draft");
      await assert.rejects(
        inTenant(db, tenant, (tx) =>
          tx.query(
            "UPDATE purchase_order_bill_lines SET quantity_millis=1 WHERE bill_id=$1",
            [first.id],
          ),
        ),
      );
      await accountant.command(
        {
          ...conversion,
          reference: `Over-${uuid()}`,
          allocations: [{ index: 0, quantity: "7" }],
          request_key: uuid(),
        },
        409,
      );
      await accountant.command(
        {
          action: "purchase-order.status",
          id: p.id,
          version: 2,
          status: "Cancelled",
          reason: "Cancel",
        },
        409,
      );
      await accountant.command({
        action: "bill.void",
        id: first.id,
        version: 1,
        reason: "Vendor corrected quantities",
        date,
      });
      const full = await accountant.command({
        ...conversion,
        reference: `Full-${uuid()}`,
        allocations: [{ index: 0, quantity: "10" }],
        request_key: uuid(),
      });
      await accountant.command({
        action: "bill.submit",
        id: full.id,
        version: 1,
      });
      await owner.command({ action: "bill.approve", id: full.id, version: 2 });
      assert.equal(
        (await order()).allocations.filter((a: any) => a.status !== "Voided")
          .length,
        1,
      );
      await accountant.command(
        {
          ...conversion,
          reference: `Extra-${uuid()}`,
          allocations: [{ index: 0, quantity: "1" }],
          request_key: uuid(),
        },
        409,
      );
      await accountant.command({
        action: "purchase-order.status",
        id: p.id,
        version: 2,
        status: "Closed",
        reason: "Complete",
      });
      await accountant.command(
        { ...conversion, reference: `Closed-${uuid()}`, request_key: uuid() },
        409,
      );
      await inTenant(db, tenant, async (tx) =>
        assert.equal(
          (await tx.query("SELECT * FROM journals WHERE source_id=$1", [p.id]))
            .rows.length,
          0,
        ),
      );
    },
  );
  function draft(overrides: Record<string, unknown> = {}) {
    return {
      action: "bill.create",
      entity_id: entity,
      vendor_id: vendor.id,
      deal_id: null,
      reference: `B-${uuid()}`,
      bill_date: date,
      due_date: "2026-10-20",
      currency: "PKR",
      fx: "1",
      lines: [
        {
          description: "Production",
          quantity: "1",
          price: "1000",
          tax: "18",
          account_code: "5200",
        },
      ],
      tax_treatment: "recoverable",
      notes: "",
      request_key: uuid(),
      acknowledge_duplicate: true,
      ...overrides,
    };
  }
  async function bill(id: string) {
    return (await owner.get()).bills.find((b: any) => b.id === id);
  }
  async function advance(
    id: string,
    action: string,
    extra: Record<string, unknown> = {},
  ) {
    return owner.command({
      action: `bill.${action}`,
      id,
      version: (await bill(id)).version,
      ...extra,
    });
  }
  async function posted(overrides: Record<string, unknown> = {}) {
    const result = await accountant.command(draft(overrides));
    await advance(result.id, "submit");
    await advance(result.id, "approve");
    return result.id;
  }
  await t.test(
    "multi-bill payments post one bank entry, allocate exactly, retry and reverse atomically",
    async () => {
      const a = await posted({
          currency: "USD",
          fx: "280",
          bill_date: "2032-01-01",
          due_date: "2032-02-01",
        }),
        b = await posted({
          currency: "USD",
          fx: "300",
          bill_date: "2032-01-01",
          due_date: "2032-02-01",
        });
      const c = {
        action: "vendor-payment.batch-create",
        date: "2032-01-02",
        fx: "290.123456",
        fee: "1.01",
        reference: `BATCH-${uuid()}`,
        request_key: uuid(),
        allocations: [
          { bill_id: a, amount: "1080", wht: "100" },
          { bill_id: b, amount: "500", wht: "20" },
        ],
      };
      await rep.command(c, 403);
      await accountant.command(
        { ...c, allocations: [c.allocations[0], c.allocations[0]] },
        400,
      );
      await accountant.command(
        {
          ...c,
          allocations: [
            { ...c.allocations[0], amount: "1181" },
            c.allocations[1],
          ],
        },
        400,
      );
      assert.equal((await bill(a)).paid_minor, "0");
      const p = await accountant.command(c);
      assert.equal((await accountant.command(c)).id, p.id);
      const retries = await Promise.all([
        accountant.command(c),
        owner.command(c),
      ]);
      assert.ok(retries.every((r) => r.id === p.id));
      await accountant.command({ ...c, reference: "different" }, 409);
      assert.equal((await bill(a)).status, "Paid");
      assert.equal((await bill(b)).paid_minor, "52000");
      const lines = await ledger("vendor-payment-batch", p.id);
      assert.equal(lines.filter((l) => l.account_code === "1000").length, 1);
      assert.equal(
        lines.reduce(
          (s, l) => s + BigInt(l.debit_minor) - BigInt(l.credit_minor),
          0n,
        ),
        0n,
      );
      const allocations = (
        await db.query(
          "SELECT * FROM vendor_payment_batch_allocations WHERE payment_id=$1",
          [p.id],
        )
      ).rows;
      assert.equal(
        allocations.reduce(
          (s, a) => s + BigInt(a.cash_base_minor) + BigInt(a.fee_base_minor),
          0n,
        ),
        BigInt(lines.find((l) => l.account_code === "1000")!.credit_minor),
      );
      assert.equal(
        allocations.reduce((s, a) => s + BigInt(a.carrying_minor), 0n),
        BigInt(lines.find((l) => l.account_code === "2000")!.debit_minor),
      );
      assert.equal((await rep.get()).vendorPaymentBatches.length, 0);
      const statement = await inTenant(db, tenant, (tx) =>
        partyStatement(
          tx,
          { tenantId: tenant, userId: admin, role: "admin" },
          {
            kind: "vendor",
            companyId: vendor.id,
            entityId: entity,
            from: "2032-01-01",
            to: "2032-01-02",
          },
        ),
      );
      const group = statement.groups.find((g) => g.currency === "USD")!;
      assert.equal(group.closing, "66000");
      assert.equal(group.closingBase, "19800000");
      assert.equal(
        group.entries.filter((e) => e.type === "vendor-payment-batch").length,
        1,
      );
      assert.equal(group.documents.find((d) => d.id === b)!.base, "19800000");
      await inTenant(db, tenant, async (tx) => {
        const control = (
          await tx.query(
            "SELECT coalesce(sum(l.credit_minor-l.debit_minor),0)::text AS total FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.entity_id=$1 AND j.posted_on<=$2 AND l.account_code='2000'",
            [entity, "2032-01-02"],
          )
        ).rows[0].total;
        const report = await ageing(
          tx,
          [entity],
          "2032-01-02",
          "ap",
          BigInt(control),
        );
        assert.equal(
          report.documents.find((i) => i.id === b)!.base,
          "19800000",
        );
        assert.equal(
          report.documents.some((i) => i.id === a),
          false,
        );
        assert.equal(report.difference, "0");
      });
      await inTenant(db, other, async (tx) =>
        assert.equal(
          (await tx.query("SELECT * FROM vendor_payment_batches")).rows.length,
          0,
        ),
      );
      const r = {
        action: "vendor-payment.batch-reverse",
        id: p.id,
        date: "2032-01-03",
        reason: "Wrong bank reference",
      };
      await accountant.command({ ...r, date: "2032-01-01" }, 400);
      const reversal = await accountant.command(r);
      assert.equal((await accountant.command(r)).id, reversal.id);
      await accountant.command({ ...r, reason: "Changed reason" }, 409);
      for (const id of [a, b]) assert.equal((await bill(id)).paid_minor, "0");
      const inverse = await ledger(
        "vendor-payment-batch-reversal",
        reversal.id,
      );
      for (const l of lines) {
        const other = inverse.find((x) => x.account_code === l.account_code)!;
        assert.equal(other.debit_minor, l.credit_minor);
        assert.equal(other.credit_minor, l.debit_minor);
      }
      await accountant.command(c); // Retry remains safe even after reversal.
      for (const id of [a, b])
        await advance(id, "void", {
          date: "2032-01-03",
          reason: "Test cleanup",
        });
    },
  );
  await t.test(
    "grouped payment boundaries and capital cash-flow attribution remain correct",
    async () => {
      const otherVendor = await accountant.command({
        action: "company.create",
        name: `Other batch vendor ${uuid()}`,
        vendor: true,
        customer: false,
        service_entity_id: null,
      });
      const base = {
        bill_date: "2033-01-01",
        due_date: "2033-02-01",
        lines: [
          {
            description: "Grouped payment fixture",
            quantity: "1",
            price: "50",
            tax: "0",
            account_code: "5200",
          },
        ],
        tax_treatment: "expense",
      };
      const operating = await posted(base),
        capital = await posted({
          ...base,
          lines: [{ ...base.lines[0], account_code: "1500" }],
        }),
        wrongVendor = await posted({ ...base, vendor_id: otherVendor.id }),
        wrongEntity = await posted({ ...base, entity_id: secondEntity }),
        wrongCurrency = await posted({ ...base, currency: "USD", fx: "280" });
      const bank = await accountant.command({
        action: "bank.create",
        entity_id: entity,
        name: `Grouped payment bank ${uuid()}`,
        reference: "Batch test",
        opening_on: "2032-12-31",
        opening: "1000",
        offset_code: "3900",
        request_key: uuid(),
      });
      const c = {
        action: "vendor-payment.batch-create",
        bank_account_id: bank.id,
        date: "2033-01-02",
        fx: "1",
        fee: "1",
        reference: `CAPITAL-BATCH-${uuid()}`,
        request_key: uuid(),
        allocations: [
          { bill_id: operating, amount: "50", wht: "0" },
          { bill_id: capital, amount: "50", wht: "0" },
        ],
      };
      for (const bill_id of [wrongVendor, wrongEntity, wrongCurrency])
        await accountant.command(
          {
            ...c,
            allocations: [c.allocations[0], { ...c.allocations[1], bill_id }],
          },
          400,
        );
      await accountant.command({ ...c, fx: "2" }, 400);
      await accountant.command({ ...c, date: "2032-12-31" }, 400);
      assert.equal((await bill(operating)).paid_minor, "0");
      const p = await accountant.command(c);
      await inTenant(db, tenant, async (tx) => {
        const ctx = { tenantId: tenant, userId: admin, role: "admin" as const };
        const detail = await bankDetail(tx, ctx, bank.id);
        const entries = detail.books.filter(
          (e) => e.source_type === "vendor-payment-batch",
        );
        assert.equal(entries.length, 1);
        assert.equal(entries[0].amount, "-10100");
        const report = await financialReports(tx, ctx, {
          entityId: entity,
          from: "2033-01-01",
          to: "2033-01-02",
        });
        assert.equal(report.cash.investing, "-5000");
        assert.equal(report.cash.operating, "-5100");
        assert.equal(report.cash.difference, "0");
        assert.deepEqual(report.cash.unsupported, []);
      });
      await accountant.command({
        action: "vendor-payment.batch-reverse",
        id: p.id,
        date: "2033-01-03",
        reason: "Fixture cleanup",
      });
      await inTenant(db, tenant, async (tx) => {
        const report = await financialReports(
          tx,
          { tenantId: tenant, userId: admin, role: "admin" },
          { entityId: entity, from: "2033-01-01", to: "2033-01-03" },
        );
        assert.equal(report.cash.investing, "0");
        assert.equal(report.cash.operating, "0");
        assert.equal(report.cash.difference, "0");
      });
      for (const id of [
        operating,
        capital,
        wrongVendor,
        wrongEntity,
        wrongCurrency,
      ])
        await advance(id, "void", {
          date: "2033-01-03",
          reason: "Fixture cleanup",
        });
    },
  );
  await t.test(
    "vendor credits apply, refund and reverse with exact FX, historical statements and payable ageing",
    async () => {
      const source = await posted({ currency: "USD", fx: "280" }),
        target = await posted({ currency: "USD", fx: "300" });
      const issue = {
        action: "vendor-credit.create",
        bill_id: source,
        date: "2026-09-21",
        reference: `VC-${uuid()}`,
        reason: "Vendor price correction",
        lines: [{ index: 0, amount: "500" }],
        request_key: uuid(),
      };
      await rep.command(issue, 403);
      const credit = await accountant.command(issue);
      assert.equal((await rep.get()).vendorCredits.length, 0);
      await accountant.command(
        {
          ...issue,
          request_key: uuid(),
          reference: `Too much-${uuid()}`,
          lines: [{ index: 0, amount: "1001" }],
        },
        409,
      );
      await accountant.command({ ...issue, request_key: uuid() }, 409);
      const wrongCurrency = await posted();
      await accountant.command(
        {
          action: "vendor-credit.apply",
          credit_id: credit.id,
          bill_id: wrongCurrency,
          date: "2026-09-21",
          amount: "1",
          request_key: uuid(),
        },
        409,
      );
      const wrongVendor = await accountant.command({
        action: "company.create",
        name: `Other credit vendor ${uuid()}`,
        vendor: true,
        customer: false,
        service_entity_id: null,
      });
      const wrongVendorBill = await posted({
        vendor_id: wrongVendor.id,
        currency: "USD",
        fx: "300",
      });
      await accountant.command(
        {
          action: "vendor-credit.apply",
          credit_id: credit.id,
          bill_id: wrongVendorBill,
          date: "2026-09-21",
          amount: "1",
          request_key: uuid(),
        },
        409,
      );
      assert.equal((await accountant.command(issue)).id, credit.id);
      await accountant.command({ ...issue, reason: "Changed retry" }, 409);
      const snapshot = async () =>
        (await owner.get()).vendorCredits.find((v: any) => v.id === credit.id);
      assert.equal((await snapshot()).total_minor, "59000");
      assert.equal((await snapshot()).base_minor, "16520000");
      await inTenant(db, other, async (tx) =>
        assert.equal(
          (await tx.query("SELECT * FROM vendor_credits")).rows.length,
          0,
        ),
      );
      await assert.rejects(
        inTenant(db, tenant, (tx) =>
          tx.query("UPDATE vendor_credits SET reason='mutate' WHERE id=$1", [
            credit.id,
          ]),
        ),
      );
      await owner.command(
        {
          action: "bill.void",
          id: source,
          version: (await bill(source)).version,
          date: "2026-09-21",
          reason: "Wrong bill",
        },
        409,
      );
      const apply = {
        action: "vendor-credit.apply",
        credit_id: credit.id,
        bill_id: target,
        date: "2026-09-21",
        amount: "300",
        request_key: uuid(),
      };
      const allocation = await accountant.command(apply);
      assert.equal((await accountant.command(apply)).id, allocation.id);
      assert.equal((await bill(target)).credited_minor, "30000");
      const journal = (
        await db.query(
          "SELECT l.* FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type='vendor-credit-application' AND j.source_id=$1",
          [allocation.id],
        )
      ).rows;
      assert.equal(
        journal.find((l) => l.account_code === "4100")!.credit_minor,
        "600000",
      );
      const refund = {
        action: "vendor-credit.refund",
        credit_id: credit.id,
        date: "2026-09-21",
        amount: "290",
        fx: "320",
        bank_account_id: null,
        reference: `Refund-${uuid()}`,
        request_key: uuid(),
      };
      const cash = await accountant.command(refund);
      assert.equal((await accountant.command(refund)).id, cash.id);
      assert.equal((await snapshot()).available, "0");
      await accountant.command(
        { ...refund, amount: "0.01", request_key: uuid() },
        409,
      );
      await accountant.command(
        {
          action: "vendor-credit.reverse",
          id: credit.id,
          date: "2026-09-21",
          reason: "Correction",
        },
        409,
      );
      const report = await inTenant(db, tenant, (tx) =>
        partyStatement(
          tx,
          { tenantId: tenant, userId: admin, role: "admin" },
          {
            kind: "vendor",
            companyId: vendor.id,
            entityId: entity,
            from: "2026-09-20",
            to: "2026-09-21",
          },
        ),
      );
      const group = report.groups.find((g) => g.currency === "USD")!;
      assert.equal(group.availableCredit, "0");
      assert.equal(group.closing, "206000");
      assert.equal(group.closingBase, "59440000");
      assert.ok(group.entries.some((e) => e.type === "vendor-refund"));
      assert.equal(
        group.documents.find((d) => d.id === target)!.outstanding,
        "88000",
      );
      const reverseCash = {
        action: "vendor-credit.reverse-refund",
        id: cash.id,
        date: "2026-09-22",
        reason: "Returned deposit",
      };
      const reversed = await accountant.command(reverseCash);
      assert.equal((await accountant.command(reverseCash)).id, reversed.id);
      await accountant.command(
        { ...reverseCash, reason: "Different retry" },
        409,
      );
      await accountant.command({
        action: "vendor-credit.unapply",
        id: allocation.id,
        date: "2026-09-22",
        reason: "Wrong allocation",
      });
      assert.equal((await bill(target)).credited_minor, "0");
      assert.equal((await snapshot()).available, "59000");
      await accountant.command({
        action: "vendor-credit.reverse",
        id: credit.id,
        date: "2026-09-22",
        reason: "Correction",
      });
      assert.equal((await snapshot()).available, "0");
      const restored = await inTenant(db, tenant, (tx) =>
        partyStatement(
          tx,
          { tenantId: tenant, userId: admin, role: "admin" },
          {
            kind: "vendor",
            companyId: vendor.id,
            entityId: entity,
            from: "2026-09-20",
            to: "2026-09-22",
          },
        ),
      );
      assert.equal(
        restored.groups
          .find((g) => g.currency === "USD")!
          .documents.find((d) => d.id === target)!.outstanding,
        "118000",
      );
      await advance(source, "void", {
        date: "2026-09-22",
        reason: "Wrong bill",
      });
    },
  );
  await t.test(
    "vendor credits settle bills without cash and preserve rounding across expense and recoverable tax",
    async () => {
      for (const tax_treatment of ["expense", "recoverable"]) {
        const source = await posted({
          tax_treatment,
          fx: "0.017321",
          currency: "USD",
          lines: [
            {
              description: "Tiny fee",
              quantity: "1",
              price: "7.31",
              tax: "18",
              account_code: "5000",
            },
            {
              description: "Cost",
              quantity: "1",
              price: "8.23",
              tax: "16",
              account_code: "5200",
            },
          ],
        });
        const first = await accountant.command({
          action: "vendor-credit.create",
          bill_id: source,
          date: "2026-09-21",
          reference: `Partial-${uuid()}`,
          reason: "Partial return",
          lines: [{ index: 0, amount: "3.01" }],
          request_key: uuid(),
        });
        const last = await accountant.command({
          action: "vendor-credit.create",
          bill_id: source,
          date: "2026-09-21",
          reference: `Rest-${uuid()}`,
          reason: "Remaining return",
          lines: [
            { index: 0, amount: "4.30" },
            { index: 1, amount: "8.23" },
          ],
          request_key: uuid(),
        });
        const credits = (await owner.get()).vendorCredits.filter((v: any) =>
          [first.id, last.id].includes(v.id),
        );
        assert.equal(
          credits.reduce((n: bigint, v: any) => n + BigInt(v.base_minor), 0n),
          BigInt((await bill(source)).base_minor),
        );
        for (const v of credits)
          await accountant.command({
            action: "vendor-credit.apply",
            credit_id: v.id,
            bill_id: source,
            date: "2026-09-21",
            amount: `${BigInt(v.total_minor) / 100n}.${String(BigInt(v.total_minor) % 100n).padStart(2, "0")}`,
            request_key: uuid(),
          });
        assert.equal((await bill(source)).status, "Paid");
        assert.equal((await bill(source)).paid_minor, "0");
        assert.equal(
          (await bill(source)).credited_minor,
          (await bill(source)).total_minor,
        );
        await accountant.command(
          {
            action: "vendor-payment.create",
            bill_id: source,
            date: "2026-09-21",
            amount: "1",
            wht: "0",
            fee: "0",
            fx: "1",
            reference: "Extra",
            request_key: uuid(),
          },
          409,
        );
      }
    },
  );
  async function ledger(source: string, id: string) {
    // Assertions below use immutable journal lines, not presentation totals.
    return (
      await db.query(
        "SELECT l.* FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.tenant_id=$1 AND j.source_type=$2 AND j.source_id=$3",
        [tenant, source, id],
      )
    ).rows;
  }
  await t.test(
    "draft, review, explicit approval and balanced posting",
    async () => {
      const c = draft(),
        made = await accountant.command(c);
      assert.deepEqual(await accountant.command(c), made);
      await accountant.command({ ...c, reference: "different" }, 409);
      assert.equal((await ledger("bill", made.id)).length, 0);
      // Assert the actual rejected transition through the API.
      await owner.command(
        { action: "bill.approve", id: made.id, version: 1 },
        409,
      );
      await advance(made.id, "submit");
      await accountant.command(
        { action: "bill.approve", id: made.id, version: 2 },
        403,
      );
      await advance(made.id, "return", { reason: "Confirm costs" });
      const { action, entity_id, request_key, ...edit } = c;
      await accountant.command({
        ...edit,
        action: "bill.edit",
        id: made.id,
        version: 3,
        notes: "Reviewed",
      });
      await accountant.command(
        { ...edit, action: "bill.edit", id: made.id, version: 3 },
        409,
      );
      await advance(made.id, "submit");
      await advance(made.id, "approve");
      const lines = await ledger("bill", made.id);
      assert.equal(
        lines.find((l) => l.account_code === "5200")!.debit_minor,
        "100000",
      );
      assert.equal(
        lines.find((l) => l.account_code === "1300")!.debit_minor,
        "18000",
      );
      assert.equal(
        lines.find((l) => l.account_code === "2000")!.credit_minor,
        "118000",
      );
      await accountant.command(
        { ...edit, action: "bill.edit", id: made.id, version: 6 },
        409,
      );
      await assert.rejects(
        () =>
          db.query(
            "UPDATE bills SET reference='mutated',version=version+1 WHERE id=$1",
            [made.id],
          ),
        /immutable/,
      );
      await accountant.command(
        draft({ reference: c.reference.toLowerCase() }),
        409,
      );
      const possible = draft({ acknowledge_duplicate: false });
      await accountant.command(possible, 409);
      await accountant.command({ ...possible, acknowledge_duplicate: true });
    },
  );
  await t.test(
    "partial cash, WHT and charges settle once; overpayment and early dates rejected",
    async () => {
      const id = await posted(),
        pay = {
          action: "vendor-payment.create",
          bill_id: id,
          date,
          amount: "400",
          wht: "100",
          fee: "5",
          fx: "1",
          reference: "BANK-1",
          request_key: uuid(),
        };
      const first = await accountant.command(pay);
      assert.deepEqual(await accountant.command(pay), first);
      await accountant.command({ ...pay, amount: "401" }, 409);
      assert.equal((await bill(id)).paid_minor, "50000");
      const rows = await ledger("vendor-payment", first.id);
      assert.equal(
        rows.find((l) => l.account_code === "2000")!.debit_minor,
        "50000",
      );
      assert.equal(
        rows.find((l) => l.account_code === "1000")!.credit_minor,
        "40500",
      );
      assert.equal(
        rows.find((l) => l.account_code === "2200")!.credit_minor,
        "10000",
      );
      assert.equal(
        rows.find((l) => l.account_code === "5300")!.debit_minor,
        "500",
      );
      await accountant.command(
        { ...pay, request_key: uuid(), amount: "681", wht: "0" },
        400,
      );
      await accountant.command(
        { ...pay, request_key: uuid(), date: "2026-09-19" },
        400,
      );
      await owner.command(
        {
          action: "bill.void",
          id,
          version: (await bill(id)).version,
          date,
          reason: "Wrong bill",
        },
        409,
      );
      await accountant.command({
        ...pay,
        request_key: uuid(),
        amount: "680",
        wht: "0",
        fee: "0",
        reference: "BANK-2",
      });
      assert.equal((await bill(id)).status, "Paid");
      assert.equal((await bill(id)).paid_base_minor, "118000");
      const reversal = {
        action: "vendor-payment.reverse",
        id: first.id,
        date: "2026-09-21",
        reason: "Duplicate bank entry",
      };
      const reversed = await accountant.command(reversal);
      assert.deepEqual(await accountant.command(reversal), reversed);
      assert.equal((await bill(id)).status, "Open");
      assert.equal((await bill(id)).paid_minor, "68000");
      const inverse = await ledger("vendor-payment-reversal", reversed.id);
      assert.equal(
        inverse.find((l) => l.account_code === "1000")!.debit_minor,
        "40500",
      );
      await assert.rejects(
        () =>
          db.query(
            "UPDATE vendor_payments SET reference='change' WHERE id=$1",
            [first.id],
          ),
        /immutable/,
      );
    },
  );
  await t.test(
    "foreign exchange, rounding and complete reversals leave zero payable",
    async () => {
      const id = await posted({
        currency: "USD",
        fx: "280",
        tax_treatment: "expense",
        lines: [
          {
            description: "Services",
            quantity: "1",
            price: "1.01",
            tax: "0",
            account_code: "5000",
          },
        ],
      });
      const pay = {
        action: "vendor-payment.create",
        bill_id: id,
        date,
        amount: "0.50",
        wht: "0",
        fee: "0",
        fx: "290",
        reference: "USD-1",
        request_key: uuid(),
      };
      const first = await accountant.command(pay),
        last = await accountant.command({
          ...pay,
          amount: "0.51",
          fx: "270",
          reference: "USD-2",
          request_key: uuid(),
        });
      assert.equal((await bill(id)).paid_base_minor, "28280");
      assert.equal(
        (await ledger("vendor-payment", first.id)).find(
          (l) => l.account_code === "5100",
        )!.debit_minor,
        "500",
      );
      assert.equal(
        (await ledger("vendor-payment", last.id)).find(
          (l) => l.account_code === "4100",
        )!.credit_minor,
        "510",
      );
      const reversalIds = [];
      for (const p of [first, last])
        reversalIds.push(
          (
            await accountant.command({
              action: "vendor-payment.reverse",
              id: p.id,
              date: "2026-09-21",
              reason: "Correction",
            })
          ).id,
        );
      await advance(id, "void", {
        date: "2026-09-22",
        reason: "Cancelled purchase",
      });
      assert.equal((await bill(id)).status, "Voided");
      const entries = (
        await db.query(
          "SELECT l.account_code,sum(l.debit_minor-l.credit_minor)::text AS net FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.tenant_id=$1 AND j.source_id=ANY($2::uuid[]) GROUP BY l.account_code",
          [tenant, [id, first.id, last.id, ...reversalIds]],
        )
      ).rows;
      for (const entry of entries)
        assert.equal(entry.net, "0", entry.account_code);
      assert.equal(
        (await ledger("bill-void", id)).find((l) => l.account_code === "2000")!
          .debit_minor,
        "28280",
      );
    },
  );
  await t.test("entity, tenant, role and period boundaries hold", async () => {
    const contactId = uuid(),
      projectId = uuid(),
      customerId = uuid();
    await db.query(
      "INSERT INTO contacts(id,tenant_id,first_name,owner_id) VALUES($1,$2,$3,$4)",
      [contactId, tenant, "Project contact", admin],
    );
    await db.query(
      "INSERT INTO deals(id,tenant_id,company_id,contact_id,entity_id,name,stage,owner_id) VALUES($1,$2,$3,$4,$5,'Other entity project','Lost',$6)",
      [projectId, tenant, vendor.id, contactId, secondEntity, admin],
    );
    await accountant.command(draft({ deal_id: projectId }), 400);
    await db.query(
      "INSERT INTO companies(id,tenant_id,name,owner_id) VALUES($1,$2,$3,$4)",
      [customerId, tenant, "Not a vendor", admin],
    );
    await accountant.command(draft({ vendor_id: customerId }), 400);
    await rep.command(draft(), 403);
    assert.deepEqual((await rep.get()).bills, []);
    const made = await accountant.command(draft());
    assert.equal(
      (
        await inTenant(db, other, (tx) =>
          tx.query("SELECT id FROM bills WHERE id=$1", [made.id]),
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await inTenant(db, other, (tx) =>
          tx.query(
            "UPDATE bills SET status='Pending approval',version=version+1 WHERE id=$1 RETURNING id",
            [made.id],
          ),
        )
      ).rows.length,
      0,
    );
    await owner.command({
      action: "period.close",
      entity_id: entity,
      date,
      reason: "Reviewed period",
    });
    await advance(made.id, "submit");
    await owner.command(
      { action: "bill.approve", id: made.id, version: 2 },
      409,
    );
    assert.equal((await ledger("bill", made.id)).length, 0);
    await accountant.command(draft({ entity_id: uuid() }), 404);
    const safe = await posted({ entity_id: secondEntity });
    assert.equal((await bill(safe)).status, "Open");
    const p = await accountant.command({
      action: "vendor-payment.create",
      bill_id: safe,
      date: "2026-09-21",
      amount: "1180",
      wht: "0",
      fee: "0",
      fx: "1",
      reference: "LOCK-TEST",
      request_key: uuid(),
    });
    await owner.command({
      action: "period.close",
      entity_id: secondEntity,
      date: "2026-09-21",
      reason: "Reviewed",
    });
    await accountant.command(
      {
        action: "vendor-payment.reverse",
        id: p.id,
        date: "2026-09-21",
        reason: "Correction",
      },
      409,
    );
    await accountant.command({
      action: "vendor-payment.reverse",
      id: p.id,
      date: "2026-09-22",
      reason: "Correction",
    });
    assert.equal((await bill(safe)).paid_minor, "0");
  });
}
