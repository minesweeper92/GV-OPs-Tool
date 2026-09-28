import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import { openDatabase, openPostgres, migrate, inTenant } from "../server/db.ts";
import { seed } from "../server/seed.ts";
import { createApp } from "../server/app.ts";
import { minor, totals, baseAmount } from "../shared/money.ts";
import { post, type Context } from "../server/domain.ts";
import { verifyPayables } from "./payables-cases.ts";

test("integer pricing, tax rounding and FX remain exact", () => {
  assert.equal(minor("90071992547.41"), 9007199254741n);
  assert.equal(
    totals([{ description: "A", quantity: "1", price: "100000", tax: "18" }])
      .total,
    "11800000",
  );
  assert.equal(
    totals([{ description: "A", quantity: "0.5", price: "0.01", tax: "0" }])
      .total,
    "1",
  );
  assert.equal(baseAmount(12345n, 280_500000n), 3462773n);
  assert.throws(() => minor("-1"));
  assert.throws(() =>
    totals([{ description: "A", quantity: "0", price: "1", tax: "0" }]),
  );
  for (let n = 1; n < 500; n++) {
    const result = totals([
      {
        description: "Random line",
        quantity: String(n),
        price: "13.27",
        tax: "18",
      },
    ]);
    assert.equal(BigInt(result.net) + BigInt(result.tax), BigInt(result.total));
  }
});

test("fresh integrated platform", async (t) => {
  const connection = process.env.GV_TEST_DATABASE_URL;
  if (connection) {
    const url = new URL(connection);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
        url.pathname === "/gv_workspace_test",
      "Use only a disposable local gv_workspace_test database.",
    );
  }
  const db = connection
    ? await openPostgres(connection)
    : await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  const origin = "http://127.0.0.1:4320",
    app = createApp(db, origin);
  await app.ready();
  t.after(() => app.close());
  const accounts = (
    await app.inject({
      method: "GET",
      url: "/api/demo-accounts",
      headers: { host: "127.0.0.1:4320" },
    })
  ).json();
  async function login(role: string, second = false) {
    const a = accounts.find(
      (a: any) =>
        a.role === role &&
        a.organization.startsWith(second ? "Separate" : "Grid"),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers: { host: "127.0.0.1:4320", origin },
      payload: { userId: a.user_id, tenantId: a.tenant_id },
    });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.headers["set-cookie"]!.toString().split(";")[0];
    const me = (
      await app.inject({
        url: "/api/me",
        headers: { host: "127.0.0.1:4320", cookie },
      })
    ).json();
    const call = async (url: string, payload?: unknown) =>
      app.inject({
        method: payload ? "POST" : "GET",
        url,
        headers: {
          host: "127.0.0.1:4320",
          origin,
          cookie,
          "x-csrf-token": me.csrf,
        },
        payload: payload as Record<string, unknown> | undefined,
      });
    const command = async (payload: unknown, expected = 200) => {
      const r = await call("/api/commands", payload);
      assert.equal(r.statusCode, expected, r.body);
      return r.json();
    };
    return { me, call, command, cookie };
  }
  const owner = await login("admin"),
    sales = await login("sales"),
    finance = await login("finance"),
    other = await login("admin", true);
  const initial = (await owner.call("/api/data")).json();
  const entity = initial.entities.find((e: any) => e.code === "PVT"),
    deal = initial.deals[0];
  const day = (await db.query("SELECT CURRENT_DATE::text AS day")).rows[0].day;
  let invoiceId: string;
  await t.test(
    "database RLS blocks forgotten predicates, writes across tenants, auth-table access and context leaks",
    async () => {
      const tenant = owner.me.organization.id,
        otherTenant = other.me.organization.id;
      assert.equal(
        (
          await inTenant(db, otherTenant, (tx) =>
            tx.query("SELECT * FROM companies"),
          )
        ).rows.length,
        0,
      );
      await assert.rejects(
        inTenant(db, otherTenant, (tx) =>
          tx.query(
            "INSERT INTO companies(id,tenant_id,name,owner_id) VALUES($1,$2,$3,$4)",
            [uuid(), tenant, "Escape", owner.me.user.id],
          ),
        ),
        /row-level security/,
      );
      await assert.rejects(
        inTenant(db, tenant, (tx) => tx.query("SELECT * FROM sessions")),
        /permission denied/,
      );
      await assert.rejects(
        inTenant(db, tenant, (tx) => tx.query("TRUNCATE companies CASCADE")),
        /permission denied/,
      );
      const counts = await Promise.all(
        [tenant, otherTenant, tenant, otherTenant].map((id) =>
          inTenant(
            db,
            id,
            async (tx) =>
              (await tx.query("SELECT count(*)::int AS n FROM companies"))
                .rows[0].n,
          ),
        ),
      );
      assert.deepEqual(counts, [1, 0, 1, 0]);
      assert.notEqual(
        (await db.query("SELECT current_user")).rows[0].current_user,
        "gv_workspace_runtime",
      );
    },
  );
  await t.test("strict requests, CSRF and role boundaries", async () => {
    const read = await app.inject({
      url: "/api/data",
      headers: { host: "127.0.0.1:4320" },
    });
    assert.equal(read.statusCode, 401);
    await owner.command(
      {
        action: "lead.convert",
        id: initial.leads[0].id,
        tenantId: other.me.organization.id,
      },
      400,
    );
    await other.command(
      { action: "lead.convert", id: initial.leads[0].id },
      404,
    );
    assert.equal(
      (
        await sales.call(
          `/api/reports?entityId=${entity.id}&from=2026-01-01&to=2026-12-31`,
        )
      ).statusCode,
      403,
    );
    await finance.command(
      { action: "lead.convert", id: initial.leads[0].id },
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/commands",
          headers: { host: "127.0.0.1:4320", cookie: owner.cookie, origin },
          payload: { action: "lead.convert", id: initial.leads[0].id },
        })
      ).statusCode,
      403,
    );
    const c = await owner.command({
      action: "company.create",
      name: "Owner private account",
      domain: "",
      industry: "",
      tax_id: "",
      address: "",
      customer: false,
      vendor: false,
      service_entity_id: null,
    });
    assert.ok(
      !(await sales.call("/api/data"))
        .json()
        .companies.some((x: any) => x.id === c.id),
    );
    await sales.command(
      { action: "note.create", record_id: c.id, text: "No access" },
      403,
    );
  });
  await t.test(
    "accept an older option explicitly, not the newest revision",
    async () => {
      const original = initial.quotes[0];
      await owner.command({
        action: "quote.create",
        deal_id: deal.id,
        option_name: "Outdoor",
        currency: "PKR",
        fx: "1",
        lines: [
          { description: "Outdoor", quantity: "1", price: "200000", tax: "0" },
        ],
        terms: "",
      });
      await owner.command({
        action: "quote.create",
        deal_id: deal.id,
        option_name: original.option_name,
        currency: "PKR",
        fx: "1",
        lines: [
          { description: "Latest", quantity: "1", price: "350000", tax: "0" },
        ],
        terms: "",
      });
      await owner.command({
        action: "quote.accept",
        id: original.id,
        reference: "Customer approved original studio route",
      });
      const data = (await owner.call("/api/data")).json(),
        won = data.deals.find((d: any) => d.id === deal.id);
      assert.equal(won.accepted_quote_id, original.id);
      assert.equal(won.stage, "Won");
      assert.equal(won.next_action, null);
      const i = await owner.command({
        action: "invoice.create",
        quote_id: original.id,
        issue_date: day,
        due_date: day,
      });
      invoiceId = i.id;
      assert.equal(
        (
          await owner.command({
            action: "invoice.create",
            quote_id: original.id,
            issue_date: day,
            due_date: day,
          })
        ).id,
        invoiceId,
      );
      await sales.command({ action: "invoice.issue", id: invoiceId }, 403);
      await Promise.all([
        owner.command({ action: "invoice.issue", id: invoiceId }),
        owner.command({ action: "invoice.issue", id: invoiceId }),
      ]);
      const rows = (
        await db.query(
          "SELECT * FROM journals WHERE source_type='invoice' AND source_id=$1",
          [invoiceId],
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(
        (
          await db.query("SELECT next_invoice FROM entities WHERE id=$1", [
            entity.id,
          ])
        ).rows[0].next_invoice,
        2,
      );
    },
  );
  await t.test(
    "partial payment and withholding settle without duplicate postings",
    async () => {
      const c = {
        action: "payment.create",
        invoice_id: invoiceId,
        date: day,
        amount: "100000",
        wht: "10000",
        fx: "1",
        reference: "Bank test",
        request_key: uuid(),
      };
      const [p, retry] = await Promise.all([
        owner.command(c),
        owner.command(c),
      ]);
      assert.equal(retry.id, p.id);
      await owner.command({ ...c, amount: "100001" }, 409);
      await owner.command({ ...c, amount: "200000", request_key: uuid() }, 400);
      await owner.command({
        ...c,
        amount: "140000",
        wht: "0",
        request_key: uuid(),
      });
      const i = (await owner.call("/api/data"))
        .json()
        .invoices.find((x: any) => x.id === invoiceId);
      assert.equal(i.status, "Paid");
      assert.equal(i.paid_minor, i.total_minor);
      const report = (
        await owner.call(
          `/api/reports?entityId=${entity.id}&from=2026-01-01&to=2026-12-31`,
        )
      ).json();
      const ar = report.trial.find((r: any) => r.code === "1100");
      assert.equal(ar.debit, ar.credit);
      const wht = report.trial.find((r: any) => r.code === "1200");
      assert.equal(wht.debit, "1000000");
      assert.equal(
        report.trial.reduce(
          (n: bigint, r: any) => n + BigInt(r.debit) - BigInt(r.credit),
          0n,
        ),
        0n,
      );
    },
  );
  await t.test(
    "foreign invoices settle at new rates with exact realised exchange differences",
    async () => {
      const lead = initial.leads.find((l: any) => l.status === "New");
      const d = await owner.command({ action: "lead.convert", id: lead.id });
      const q = await owner.command({
        action: "quote.create",
        deal_id: d.id,
        option_name: "Website",
        currency: "USD",
        fx: "280",
        lines: [
          { description: "Build", quantity: "1", price: "100", tax: "0" },
        ],
        terms: "",
      });
      await owner.command({
        action: "quote.accept",
        id: q.id,
        reference: "Approved",
      });
      const i = await owner.command({
        action: "invoice.create",
        quote_id: q.id,
        issue_date: day,
        due_date: day,
      });
      await owner.command({ action: "invoice.issue", id: i.id });
      await owner.command({
        action: "payment.create",
        invoice_id: i.id,
        date: day,
        amount: "40",
        wht: "0",
        fx: "282",
        reference: "First",
        request_key: uuid(),
      });
      await owner.command({
        action: "payment.create",
        invoice_id: i.id,
        date: day,
        amount: "60",
        wht: "0",
        fx: "278",
        reference: "Second",
        request_key: uuid(),
      });
      const r = (
        await owner.call(
          `/api/reports?entityId=${lead.entity_id}&from=2026-01-01&to=2026-12-31`,
        )
      ).json();
      assert.equal(r.trial.find((x: any) => x.code === "4100").credit, "8000");
      assert.equal(r.trial.find((x: any) => x.code === "5100").debit, "12000");
      const ar = r.trial.find((x: any) => x.code === "1100");
      assert.equal(ar.debit, ar.credit);
    },
  );
  await t.test(
    "journals cannot be unbalanced, edited or extended after commit",
    async () => {
      const ctx: Context = {
        tenantId: owner.me.organization.id,
        userId: owner.me.user.id,
        role: "admin",
      };
      await assert.rejects(
        inTenant(db, ctx.tenantId, (tx) =>
          post(tx, ctx, entity.id, day, "test", uuid(), "Bad posting", [
            { account: "1000", debit: 1n },
            { account: "4000", credit: 2n },
          ]),
        ),
      );
      await assert.rejects(
        db.query(
          "UPDATE journal_lines SET debit_minor=debit_minor+1 WHERE debit_minor>0",
        ),
        /immutable/,
      );
      const journal = (await db.query("SELECT id FROM journals LIMIT 1"))
        .rows[0].id;
      await assert.rejects(
        db.query(
          "INSERT INTO journal_lines(id,tenant_id,entity_id,journal_id,account_code,debit_minor) VALUES($1,$2,$3,$4,$5,1)",
          [uuid(), ctx.tenantId, entity.id, journal, "1000"],
        ),
        /committed journal/,
      );
      await assert.rejects(
        inTenant(db, ctx.tenantId, (tx) =>
          tx.query(
            "INSERT INTO journals(id,tenant_id,entity_id,source_type,source_id,posted_on,description,actor_id) VALUES($1,$2,$3,'bad',$4,$5,'empty',$6)",
            [uuid(), ctx.tenantId, entity.id, uuid(), day, ctx.userId],
          ),
        ),
        /balanced lines/,
      );
    },
  );
  await t.test("expense idempotency and period lock", async () => {
    const c = {
      action: "expense.create",
      entity_id: entity.id,
      deal_id: deal.id,
      description: "Location",
      amount: "2500",
      date: day,
      reference: "Receipt",
      request_key: uuid(),
    };
    const e = await owner.command(c);
    assert.equal((await owner.command(c)).id, e.id);
    await owner.command({ ...c, amount: "2600" }, 409);
    await owner.command({
      action: "period.close",
      entity_id: entity.id,
      date: day,
      reason: "Reviewed",
    });
    await owner.command({ ...c, request_key: uuid() }, 409);
  });
  await t.test(
    "employment changes keep old commercial links and audit history",
    async () => {
      const data = (await owner.call("/api/data")).json(),
        a = data.affiliations[0];
      await owner.command({
        action: "contact.end-association",
        id: a.id,
        ended_on: day,
      });
      const company = await owner.command({
        action: "company.create",
        name: "Next employer",
        domain: "",
        industry: "",
        tax_id: "",
        address: "",
        customer: false,
        vendor: false,
        service_entity_id: null,
      });
      await owner.command({
        action: "contact.associate",
        contact_id: a.contact_id,
        company_id: company.id,
        role: "Director",
        work_email: "new@example.test",
        started_on: day,
      });
      const after = (await owner.call("/api/data")).json();
      assert.equal(after.affiliations.length, 2);
      assert.equal(
        after.deals.find((d: any) => d.id === deal.id).company_id,
        deal.company_id,
      );
      assert.ok(
        after.events.some((e: any) => e.action === "contact.associate"),
      );
      assert.equal((await other.call("/api/data")).json().events.length, 0);
    },
  );
  await t.test("vendor bills and payments on the configured database", (sub) =>
    verifyPayables(sub, db),
  );
});
