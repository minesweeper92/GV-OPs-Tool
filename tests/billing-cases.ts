import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import { inTenant, type Database } from "../server/db.ts";
import { seedAccounts, type Context } from "../server/domain.ts";
import { createApp } from "../server/app.ts";
import { executeRecurring, runRecurringDue } from "../server/recurring.ts";
import { occurrenceDate } from "../shared/recurring.ts";

export async function verifyBilling(t: TestContext, db: Database) {
  const tenant = uuid(),
    user = uuid(),
    sales = uuid(),
    entity = uuid(),
    other = uuid();
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO tenants VALUES($1,'Billing QA')", [tenant]);
    for (const [id, role] of [
      [user, "admin"],
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
      [entity, "BILLING"],
      [other, "ALT"],
    ]) {
      await tx.query(
        "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,$3,$3)",
        [id, tenant, code],
      );
      await seedAccounts(tx, tenant, id);
    }
  });
  const app = createApp(db, "http://127.0.0.1:4320");
  await app.ready();
  t.after(() => app.close());
  async function login(userId: string) {
    const headers = { host: "127.0.0.1:4320", origin: "http://127.0.0.1:4320" };
    const r = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers,
      payload: { userId, tenantId: tenant },
    });
    const cookie = String(r.headers["set-cookie"]).split(";")[0];
    const me = (
      await app.inject({ url: "/api/me", headers: { ...headers, cookie } })
    ).json();
    return async (
      url: string,
      payload?: Record<string, unknown>,
      status = 200,
    ) => {
      const r = await app.inject({
        method: payload ? "POST" : "GET",
        url,
        headers: { ...headers, cookie, "x-csrf-token": me.csrf },
        payload,
      });
      assert.equal(r.statusCode, status, r.body);
      return r.json();
    };
  }
  const call = await login(user),
    rep = await login(sales),
    cmd = (c: Record<string, unknown>, s = 200) => call("/api/commands", c, s),
    data = () => call("/api/data");
  const ctx: Context = { tenantId: tenant, userId: user, role: "admin" };
  const company = (
    await cmd({
      action: "company.create",
      name: "Billing client",
      customer: true,
      vendor: false,
      service_entity_id: null,
    })
  ).id;
  const contact = (
    await cmd({
      action: "contact.create",
      first_name: "Client",
      email: "",
      company_id: company,
      role: "Buyer",
    })
  ).id;
  async function accepted(name: string, currency = "USD", entityId = entity) {
    const lead = (
      await cmd({
        action: "lead.create",
        company_id: company,
        contact_id: contact,
        entity_id: entityId,
        title: name,
        next_action: "Quote",
        due_date: "2026-01-01",
      })
    ).id;
    const deal = (await cmd({ action: "lead.convert", id: lead })).id;
    const quote = (
      await cmd({
        action: "quote.create",
        deal_id: deal,
        option_name: "Approved",
        currency,
        fx: currency === "PKR" ? "1" : "280",
        lines: [
          { description: "Service", quantity: "1", price: "100", tax: "18" },
        ],
      })
    ).id;
    await cmd({ action: "quote.accept", id: quote, reference: "Signed" });
    return { deal, quote };
  }
  async function issued(name: string, currency = "USD", entityId = entity) {
    const a = await accepted(name, currency, entityId);
    const id = (
      await cmd({
        action: "invoice.create",
        quote_id: a.quote,
        issue_date: "2026-01-01",
        due_date: "2026-01-31",
        request_key: uuid(),
      })
    ).id;
    await cmd({ action: "invoice.issue", id });
    return { ...a, id };
  }
  const base = await issued("Credit adjustments");
  const creditCommand = {
    action: "credit.create",
    invoice_id: base.id,
    date: "2026-01-02",
    lines: [{ index: 0, amount: "40" }],
    treatment: "earned",
    reason: "Reduced scope",
    request_key: uuid(),
  };
  let credit: string, application: string;
  await t.test(
    "partial credit retains tax, caps line value, enforces roles and retry identity",
    async () => {
      credit = (await cmd(creditCommand)).id;
      assert.equal((await cmd(creditCommand)).id, credit);
      await cmd({ ...creditCommand, reason: "Other" }, 409);
      await cmd(
        {
          ...creditCommand,
          request_key: uuid(),
          lines: [{ index: 0, amount: "61" }],
        },
        409,
      );
      await cmd(
        {
          ...creditCommand,
          request_key: uuid(),
          lines: [
            { index: 0, amount: "1" },
            { index: 0, amount: "1" },
          ],
        },
        400,
      );
      await rep(
        "/api/commands",
        { ...creditCommand, request_key: uuid() },
        403,
      );
      assert.equal((await rep("/api/data")).credits.length, 0);
      const c = (await data()).credits.find((c: any) => c.id === credit);
      assert.equal(c.net_minor, "4000");
      assert.equal(c.tax_minor, "720");
      assert.equal(c.total_minor, "4720");
      assert.equal(c.available, "4720");
      assert.equal(
        (await data()).invoices.find((i: any) => i.id === base.id).total_minor,
        "11800",
      );
      await assert.rejects(() =>
        inTenant(db, tenant, (tx) =>
          tx.query("UPDATE credit_notes SET reason=$2 WHERE id=$1", [
            credit,
            "Changed",
          ]),
        ),
      );
      assert.equal(
        (
          await inTenant(db, uuid(), (tx) =>
            tx.query("SELECT * FROM credit_notes"),
          )
        ).rows.length,
        0,
      );
    },
  );
  await t.test(
    "credit allocations reduce receivables, not cash, and historical ageing agrees with GL",
    async () => {
      const c = {
        action: "credit.apply",
        credit_id: credit,
        invoice_id: base.id,
        date: "2026-01-03",
        amount: "47.20",
        request_key: uuid(),
      };
      application = (await cmd(c)).id;
      assert.equal((await cmd(c)).id, application);
      await cmd({ ...c, request_key: uuid(), amount: "0.01" }, 409);
      let i = (await data()).invoices.find((i: any) => i.id === base.id);
      assert.equal(i.paid_minor, "0");
      assert.equal(i.credited_minor, "4720");
      assert.equal(i.status, "Issued");
      for (const [to, balance] of [
        ["2026-01-02", "11800"],
        ["2026-01-03", "7080"],
      ]) {
        const r = await call(
          `/api/financial-reports?entityId=${entity}&from=2026-01-01&to=${to}`,
        );
        assert.equal(
          r.receivables.documents.find((d: any) => d.id === base.id)
            .outstanding,
          balance,
        );
        assert.equal(r.receivables.difference, "0");
        assert.equal(r.balanceDifference, "0");
        assert.equal(r.cash.difference, "0");
      }
      await cmd(
        {
          action: "payment.create",
          invoice_id: base.id,
          date: "2026-01-04",
          amount: "70.81",
          wht: "0",
          fx: "285",
          reference: "Too much",
          request_key: uuid(),
        },
        400,
      );
      await cmd({
        action: "payment.create",
        invoice_id: base.id,
        date: "2026-01-04",
        amount: "70.80",
        wht: "0",
        fx: "285",
        reference: "Balance",
        request_key: uuid(),
      });
      i = (await data()).invoices.find((i: any) => i.id === base.id);
      assert.equal(i.status, "Settled");
      await cmd(
        {
          action: "credit.reverse",
          id: credit,
          date: "2026-01-05",
          reason: "Undo",
        },
        409,
      );
      await cmd({
        action: "credit.unapply",
        id: application,
        date: "2026-01-05",
        reason: "Reopen",
      });
      i = (await data()).invoices.find((i: any) => i.id === base.id);
      assert.equal(i.status, "Issued");
      assert.equal(i.credited_minor, "0");
      await cmd(
        {
          action: "credit.refund",
          credit_id: credit,
          date: "2026-01-04",
          amount: "1",
          fx: "280",
          bank_account_id: null,
          reference: "Backdated",
          request_key: uuid(),
        },
        409,
      );
      await cmd({
        action: "credit.reverse",
        id: credit,
        date: "2026-01-06",
        reason: "Reversed scope adjustment",
      });
      const r = await call(
        `/api/financial-reports?entityId=${entity}&from=2026-01-01&to=2026-01-31`,
      );
      assert.equal(r.receivables.difference, "0");
      assert.equal(r.balanceDifference, "0");
      assert.equal(r.cash.difference, "0");
    },
  );
  await t.test(
    "paid invoice refund and reversal preserve exact FX and never exceed available credit",
    async () => {
      const a = await issued("Refundable job");
      await cmd({
        action: "payment.create",
        invoice_id: a.id,
        date: "2026-02-01",
        amount: "118",
        wht: "0",
        fx: "282",
        reference: "Paid",
        request_key: uuid(),
      });
      const c = (
        await cmd({
          ...creditCommand,
          invoice_id: a.id,
          date: "2026-02-02",
          lines: [{ index: 0, amount: "100" }],
          request_key: uuid(),
        })
      ).id;
      const refund = {
        action: "credit.refund",
        credit_id: c,
        date: "2026-02-03",
        amount: "59",
        fx: "285",
        bank_account_id: null,
        reference: "Bank transfer",
        request_key: uuid(),
      };
      const r = (await cmd(refund)).id;
      assert.equal((await cmd(refund)).id, r);
      await cmd({ ...refund, amount: "60" }, 409);
      await cmd({ ...refund, request_key: uuid(), amount: "59.01" }, 409);
      assert.equal(
        (await data()).credits.find((n: any) => n.id === c).available,
        "5900",
      );
      const report = await call(
        `/api/financial-reports?entityId=${entity}&from=2026-02-01&to=2026-02-28`,
      );
      assert.equal(report.cash.difference, "0");
      assert.deepEqual(report.cash.unsupported, []);
      assert.equal(report.balanceDifference, "0");
      assert.equal(report.receivables.difference, "0");
      await cmd({
        action: "credit.reverse-refund",
        id: r,
        date: "2026-03-01",
        reason: "Transfer returned",
      });
      assert.equal(
        (await data()).credits.find((n: any) => n.id === c).available,
        "11800",
      );
      await cmd({
        action: "credit.reverse",
        id: c,
        date: "2026-03-02",
        reason: "Cancelled credit",
      });
      assert.equal(
        (await data()).invoices.find((i: any) => i.id === a.id).status,
        "Paid",
      );
    },
  );
  await t.test(
    "credit applications reject other entities and currencies; full-credit settlement is reversible",
    async () => {
      const c = (
        await cmd({ ...creditCommand, date: "2026-04-01", request_key: uuid() })
      ).id;
      const alt = await issued("Other entity", "USD", other),
        pkr = await issued("Other currency", "PKR");
      for (const target of [alt.id, pkr.id])
        await cmd(
          {
            action: "credit.apply",
            credit_id: c,
            invoice_id: target,
            date: "2026-04-02",
            amount: "1",
            request_key: uuid(),
          },
          409,
        );
      const a = (
        await cmd({
          action: "credit.apply",
          credit_id: c,
          invoice_id: base.id,
          date: "2026-04-02",
          amount: "47.20",
          request_key: uuid(),
        })
      ).id;
      assert.equal(
        (await data()).invoices.find((i: any) => i.id === base.id).status,
        "Settled",
      );
      await cmd({
        action: "credit.unapply",
        id: a,
        date: "2026-04-03",
        reason: "Undo",
      });
      assert.equal(
        (await data()).invoices.find((i: any) => i.id === base.id).status,
        "Issued",
      );
    },
  );
  await t.test(
    "advance credit reduces deferred revenue and limits subsequent recognition and project profit",
    async () => {
      const a = await accepted("Advance project");
      const project = (
        await cmd({
          action: "project.create",
          quote_id: a.quote,
          entity_id: entity,
          name: "Advance project",
          code: "CREDIT-PRJ",
          start_date: "2026-01-01",
          end_date: null,
          budget: "1000",
        })
      ).id;
      const milestone = (
        await cmd({
          action: "project.milestone",
          project_id: project,
          name: "Advance",
          due_date: "2026-01-01",
          amount: "100",
          billing_kind: "advance",
          request_key: uuid(),
        })
      ).id;
      const id = (
        await cmd({
          action: "invoice.create",
          quote_id: a.quote,
          milestone_id: milestone,
          issue_date: "2026-01-01",
          due_date: "2026-01-31",
          request_key: uuid(),
        })
      ).id;
      await cmd({ action: "invoice.issue", id });
      await cmd({ ...creditCommand, invoice_id: id, request_key: uuid() }, 409);
      const c = (
        await cmd({
          ...creditCommand,
          invoice_id: id,
          treatment: "deferred",
          request_key: uuid(),
        })
      ).id;
      await cmd(
        {
          action: "invoice.recognise",
          id,
          date: "2026-01-03",
          amount: "60.01",
          reference: "Excess",
          request_key: uuid(),
        },
        409,
      );
      await cmd({
        action: "invoice.recognise",
        id,
        date: "2026-01-03",
        amount: "60",
        reference: "Delivered",
        request_key: uuid(),
      });
      const p = (await data()).projects.find((p: any) => p.id === project);
      assert.equal(p.deferred, "0");
      assert.equal(p.revenue, "1680000");
      await cmd({
        action: "credit.apply",
        credit_id: c,
        invoice_id: id,
        date: "2026-01-04",
        amount: "47.20",
        request_key: uuid(),
      });
      assert.equal(
        (await data()).projects.find((p: any) => p.id === project).receivable,
        "1982400",
      );
    },
  );
  await t.test(
    "anchored recurrence handles month ends, leap years and weekly cycles",
    () => {
      assert.equal(occurrenceDate("2024-01-31", "monthly", 1), "2024-02-29");
      assert.equal(occurrenceDate("2024-01-31", "monthly", 2), "2024-03-31");
      assert.equal(occurrenceDate("2024-02-29", "yearly", 1), "2025-02-28");
      assert.equal(occurrenceDate("2026-01-31", "quarterly", 1), "2026-04-30");
      assert.equal(occurrenceDate("2026-12-28", "weekly", 1), "2027-01-04");
    },
  );
  await t.test(
    "refund bank matching and reconciled-period reversal protection",
    async () => {
      const a = await issued("Reconciled refund");
      const c = (
        await cmd({
          ...creditCommand,
          invoice_id: a.id,
          date: "2026-01-02",
          request_key: uuid(),
        })
      ).id;
      const create = {
        action: "bank.create",
        entity_id: entity,
        name: "Refund bank",
        reference: "QA",
        opening_on: "2025-12-31",
        opening: "0",
        offset_code: "3900",
        request_key: uuid(),
      };
      const bank = (await cmd(create)).id,
        wrong = (
          await cmd({ ...create, entity_id: other, request_key: uuid() })
        ).id;
      const refund = {
        action: "credit.refund",
        credit_id: c,
        date: "2026-01-03",
        amount: "1",
        fx: "280",
        bank_account_id: bank,
        reference: "Refund to match",
        request_key: uuid(),
      };
      await cmd({ ...refund, bank_account_id: wrong }, 400);
      const r = (await cmd(refund)).id;
      const statement = (
        await cmd({
          action: "bank.import",
          bank_id: bank,
          from: "2026-01-01",
          to: "2026-01-31",
          opening: "0",
          closing: "-280",
          reference: "January refund",
          lines: [
            {
              date: "2026-01-03",
              description: "Customer refund",
              reference: "REF",
              amount: "-280",
            },
          ],
          request_key: uuid(),
        })
      ).id;
      const detail = await call(
        `/api/banking?bankId=${bank}&statementId=${statement}`,
      );
      await cmd({
        action: "bank.match",
        statement_id: statement,
        statement_line_ids: detail.lines.map((l: any) => l.id),
        journal_line_ids: detail.books
          .filter((l: any) => l.description.endsWith("Refund to match"))
          .map((l: any) => l.id),
      });
      await cmd({ action: "bank.close", id: statement });
      await cmd(
        {
          action: "credit.reverse-refund",
          id: r,
          date: "2026-01-04",
          reason: "In closed bank period",
        },
        409,
      );
      await cmd({
        action: "credit.reverse-refund",
        id: r,
        date: "2026-02-01",
        reason: "Later returned transfer",
      });
      assert.equal(
        (await call(`/api/banking?bankId=${bank}&statementId=${statement}`))
          .difference,
        "0",
      );
    },
  );
  const schedule = {
    entity_id: entity,
    name: "Monthly service",
    start_date: "2026-01-31",
    end_date: null,
    frequency: "monthly",
    timezone: "Asia/Karachi",
    occurrences: 4,
    request_key: uuid(),
  };
  let profile: string;
  const generate = (id: string, date: string) =>
    inTenant(db, tenant, (tx) =>
      executeRecurring(
        tx,
        ctx,
        { action: "recurring.run", id },
        new Date(date + "T12:00:00Z"),
      ),
    );
  await t.test(
    "recurring invoices are distinct contracts, generate only due drafts once, and snapshot future FX",
    async () => {
      await cmd(
        {
          action: "recurring.invoice",
          ...schedule,
          quote_id: base.quote,
          amount: "100",
          fx: "280",
          due_days: 30,
        },
        409,
      );
      const a = await accepted("Ongoing service");
      const command = {
        action: "recurring.invoice",
        ...schedule,
        quote_id: a.quote,
        amount: "100",
        fx: "280",
        due_days: 30,
      };
      profile = (await cmd(command)).id;
      assert.equal((await cmd(command)).id, profile);
      await cmd({ ...command, amount: "101" }, 409);
      await cmd(
        {
          action: "invoice.create",
          quote_id: a.quote,
          issue_date: "2026-01-01",
          due_date: "2026-01-31",
          request_key: uuid(),
        },
        409,
      );
      await Promise.all([
        generate(profile, "2026-02-28"),
        generate(profile, "2026-02-28"),
      ]);
      let d = await data();
      let occurrences = d.recurringOccurrences.filter(
        (o: any) => o.profile_id === profile,
      );
      assert.equal(occurrences.length, 2);
      assert.deepEqual(occurrences.map((o: any) => o.scheduled_date).sort(), [
        "2026-01-31",
        "2026-02-28",
      ]);
      for (const o of occurrences) {
        const i = d.invoices.find((i: any) => i.id === o.invoice_id);
        assert.equal(i.status, "Draft");
        assert.equal(i.total_minor, "11800");
        assert.equal(
          (
            await inTenant(db, tenant, (tx) =>
              tx.query("SELECT id FROM journals WHERE source_id=$1", [i.id]),
            )
          ).rows.length,
          0,
        );
      }
      const p = d.recurringProfiles.find((p: any) => p.id === profile);
      const update = {
        action: "recurring.update",
        id: profile,
        version: p.version,
        status: "Active",
        name: p.name,
        description: "",
        amount: "120",
        fx: "290",
        end_date: null,
        occurrences: 4,
        due_days: 15,
      };
      await cmd(update);
      await cmd(update, 409);
      await generate(profile, "2026-03-31");
      d = await data();
      occurrences = d.recurringOccurrences.filter(
        (o: any) => o.profile_id === profile,
      );
      const march = d.invoices.find(
        (i: any) =>
          i.id ===
          occurrences.find((o: any) => o.scheduled_date === "2026-03-31")
            .invoice_id,
      );
      assert.equal(march.fx_micros, "290000000");
      assert.equal(march.net_minor, "12000");
      assert.equal(
        d.invoices.find(
          (i: any) =>
            i.id ===
            occurrences.find((o: any) => o.scheduled_date === "2026-01-31")
              .invoice_id,
        ).fx_micros,
        "280000000",
      );
      await cmd({ action: "invoice.issue", id: march.id });
      const lines = (
        await inTenant(db, tenant, (tx) =>
          tx.query(
            "SELECT l.* FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_id=$1 AND account_code='1100'",
            [march.id],
          ),
        )
      ).rows;
      assert.equal(lines[0].debit_minor, "4106400");
      await generate(profile, "2026-04-30");
      assert.equal(
        (await data()).recurringProfiles.find((p: any) => p.id === profile)
          .status,
        "Completed",
      );
      await cmd({ action: "recurring.run", id: profile }, 409);
    },
  );
  await t.test(
    "expense recurrence queues review, supports pause and skips, and posts once with exact payment details",
    async () => {
      const id = (
        await cmd({
          action: "recurring.expense",
          ...schedule,
          name: "Software subscription",
          occurrences: 3,
          request_key: uuid(),
          deal_id: null,
          description: "Subscription",
          amount: "1000",
        })
      ).id;
      let p = (await data()).recurringProfiles.find((p: any) => p.id === id);
      const change = (status: string) => ({
        action: "recurring.update",
        id,
        version: p.version,
        status,
        name: p.name,
        description: p.description,
        amount: "1000",
        fx: "1",
        end_date: null,
        occurrences: 3,
        due_days: 0,
      });
      await cmd(change("Paused"));
      await assert.rejects(() => generate(id, "2026-01-31"));
      p = (await data()).recurringProfiles.find((p: any) => p.id === id);
      await cmd(change("Active"));
      await generate(id, "2026-02-28");
      let d = await data();
      const os = d.recurringOccurrences.filter((o: any) => o.profile_id === id);
      assert.equal(os.length, 2);
      assert.ok(os.every((o: any) => o.status === "Pending review"));
      assert.ok(!d.expenses.some((e: any) => e.description === "Subscription"));
      const post = {
        action: "recurring.post-expense",
        id: os[0].id,
        date: "2026-03-01",
        bank_account_id: null,
        reference: "Bank debit",
      };
      await cmd(post);
      await cmd(post);
      await cmd({ ...post, reference: "Different" }, 409);
      await cmd({
        action: "recurring.skip",
        id: os[1].id,
        reason: "No charge",
      });
      d = await data();
      assert.equal(
        d.expenses.filter((e: any) => e.description === "Subscription").length,
        1,
      );
      assert.equal(
        d.recurringOccurrences.find((o: any) => o.id === os[1].id).status,
        "Skipped",
      );
      await rep("/api/commands", { action: "recurring.run", id }, 403);
      assert.equal((await rep("/api/data")).recurringProfiles.length, 0);
      assert.equal(
        (
          await inTenant(db, uuid(), (tx) =>
            tx.query("SELECT * FROM recurring_profiles"),
          )
        ).rows.length,
        0,
      );
      await assert.rejects(() =>
        inTenant(db, tenant, (tx) =>
          tx.query(
            "UPDATE recurring_occurrences SET status='Pending review' WHERE id=$1",
            [os[0].id],
          ),
        ),
      );
    },
  );
  await t.test(
    "worker respects period locks and revoked creator; explicit skips preserve missed cycles",
    async () => {
      const id = (
        await cmd({
          action: "recurring.expense",
          ...schedule,
          name: "Blocked charge",
          occurrences: 1,
          request_key: uuid(),
          deal_id: null,
          description: "Blocked",
          amount: "100",
        })
      ).id;
      await inTenant(db, tenant, (tx) =>
        tx.query("UPDATE entities SET lock_date='2026-01-31' WHERE id=$1", [
          entity,
        ]),
      );
      await runRecurringDue(db, new Date("2026-02-01T12:00:00Z"));
      let p = (await data()).recurringProfiles.find((p: any) => p.id === id);
      assert.match(p.last_error, /locked period/);
      assert.equal(p.next_index, 0);
      await cmd({
        action: "recurring.skip",
        id,
        reason: "Prior closed period",
      });
      await runRecurringDue(db, new Date("2026-02-01T12:00:00Z"));
      assert.equal(
        (await data()).recurringProfiles.find((p: any) => p.id === id).status,
        "Completed",
      );
      const future = (
        await cmd({
          action: "recurring.expense",
          ...schedule,
          start_date: "2026-05-01",
          name: "Revoked user",
          occurrences: 1,
          request_key: uuid(),
          deal_id: null,
          description: "No access",
          amount: "100",
        })
      ).id;
      await db.query(
        "UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [tenant, user],
      );
      await runRecurringDue(db, new Date("2026-05-02T12:00:00Z"));
      assert.equal(
        (
          await db.query(
            "SELECT next_index FROM recurring_profiles WHERE id=$1",
            [future],
          )
        ).rows[0].next_index,
        0,
      );
      await assert.rejects(() => generate(future, "2026-05-02"));
      await db.query(
        "UPDATE memberships SET active=true WHERE tenant_id=$1 AND user_id=$2",
        [tenant, user],
      );
    },
  );
}
