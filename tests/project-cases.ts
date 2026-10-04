import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import { inTenant, type Database } from "../server/db.ts";
import { seedAccounts } from "../server/domain.ts";
import { createApp } from "../server/app.ts";
import { allocateInvoice } from "../server/projects.ts";
import { totals } from "../shared/money.ts";

export async function verifyProjects(t: TestContext, db: Database) {
  const tenant = uuid(),
    user = uuid(),
    sales = uuid(),
    entity = uuid(),
    other = uuid();
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO tenants VALUES($1,'Project QA')", [tenant]);
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
      [entity, "PRJ"],
      [other, "OTHER"],
    ]) {
      await tx.query(
        "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,$3,$3)",
        [id, tenant, code],
      );
      await seedAccounts(tx, tenant, id);
    }
  });
  const quoteForAllocation = {
    net_minor: "10000",
    adjustment_minor: "500",
    lines: [
      {
        description: "Work",
        quantity: "1",
        price: "100",
        tax: "18",
        subtotal: "10000",
        taxMinor: "1800",
      },
    ],
  };
  const firstPart = allocateInvoice(quoteForAllocation, [], 5000n);
  const lastPart = allocateInvoice(
    quoteForAllocation,
    [{ net_minor: firstPart.net, lines: firstPart.lines }],
    5000n,
    500n,
  );
  assert.equal(firstPart.adjustment, "0");
  assert.equal(lastPart.adjustment, "500");
  assert.equal(
    BigInt(firstPart.total) + BigInt(lastPart.total),
    12300n,
    "split invoices include the quote adjustment exactly once",
  );
  const app = createApp(db, "http://127.0.0.1:4320");
  await app.ready();
  t.after(() => app.close());
  async function login(userId: string) {
    const headers = { host: "127.0.0.1:4320", origin: "http://127.0.0.1:4320" };
    const response = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers,
      payload: { userId, tenantId: tenant },
    });
    const cookie = String(response.headers["set-cookie"]).split(";")[0];
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
  const company = (
    await cmd({
      action: "company.create",
      name: "Project client",
      customer: true,
      vendor: true,
      service_entity_id: null,
    })
  ).id;
  const contact = (
    await cmd({
      action: "contact.create",
      first_name: "Project",
      email: "",
      company_id: company,
      role: "Producer",
    })
  ).id;
  async function accepted(name: string) {
    const lead = (
      await cmd({
        action: "lead.create",
        company_id: company,
        contact_id: contact,
        entity_id: entity,
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
        option_name: "Agreed",
        currency: "USD",
        fx: "280",
        lines: [
          { description: "Production", quantity: "1", price: "100", tax: "18" },
          { description: "Exempt work", quantity: "1", price: "100", tax: "0" },
        ],
      })
    ).id;
    await cmd({
      action: "quote.accept",
      id: quote,
      reference: "Written agreement",
    });
    return { deal, quote };
  }
  const { deal, quote } = await accepted("Milestone film");
  const projectCommand = {
    action: "project.create",
    quote_id: quote,
    entity_id: entity,
    name: "Milestone film",
    code: "FILM-01",
    start_date: "2026-01-01",
    end_date: "2026-04-30",
    budget: "10000",
  };
  let project: string, advance: string, delivery: string, invoice: string;
  await t.test(
    "project keeps accepted quote and entity; existing expenses follow the deal",
    async () => {
      await cmd({ ...projectCommand, entity_id: other }, 409);
      await cmd({
        action: "expense.create",
        entity_id: entity,
        deal_id: deal,
        description: "Pre-production",
        amount: "2000",
        date: "2026-01-02",
        reference: "COST-1",
        request_key: uuid(),
      });
      project = (await cmd(projectCommand)).id;
      assert.equal((await cmd(projectCommand)).id, project);
      await cmd({ ...projectCommand, name: "Changed retry" }, 409);
      const p = (await data()).projects[0];
      assert.equal(p.quote_id, quote);
      assert.equal(p.contact_id, contact);
      assert.equal(p.cost, "200000");
      assert.equal(p.revenue, "0");
    },
  );
  await t.test(
    "milestones and drafts reserve the quote; retry cannot create duplicate invoices",
    async () => {
      const advancePlan = {
        action: "project.milestone",
        request_key: uuid(),
        project_id: project,
        name: "Advance 40%",
        due_date: "2026-01-10",
        amount: "80",
        billing_kind: "advance",
      };
      advance = (await cmd(advancePlan)).id;
      assert.equal((await cmd(advancePlan)).id, advance);
      await cmd({ ...advancePlan, amount: "81" }, 409);
      delivery = (
        await cmd({
          action: "project.milestone",
          project_id: project,
          name: "Delivery 60%",
          request_key: uuid(),
          due_date: "2026-03-01",
          amount: "120",
          billing_kind: "earned",
        })
      ).id;
      await cmd(
        {
          action: "project.milestone",
          project_id: project,
          name: "Over budget",
          request_key: uuid(),
          due_date: "2026-03-01",
          amount: "0.01",
          billing_kind: "earned",
        },
        409,
      );
      await cmd(
        {
          action: "invoice.create",
          quote_id: quote,
          amount: "1",
          issue_date: "2026-01-10",
          due_date: "2026-01-31",
          request_key: uuid(),
        },
        409,
      );
      const c = {
        action: "invoice.create",
        quote_id: quote,
        milestone_id: advance,
        issue_date: "2026-01-10",
        due_date: "2026-01-31",
        request_key: uuid(),
      };
      invoice = (await cmd(c)).id;
      assert.equal((await cmd(c)).id, invoice);
      await cmd({ ...c, due_date: "2026-02-01" }, 409);
      await cmd(
        {
          action: "project.cancel-milestone",
          id: advance,
          reason: "Not while billed",
        },
        409,
      );
      let i = (await data()).invoices.find((i: any) => i.id === invoice);
      assert.equal(i.net_minor, "8000");
      assert.equal(i.tax_minor, "720");
      assert.equal(i.total_minor, "8720");
      assert.equal(i.billing_kind, "advance");
      await cmd({ action: "invoice.issue", id: invoice });
      await cmd({
        action: "payment.create",
        invoice_id: invoice,
        date: "2026-01-15",
        amount: "80",
        wht: "7.20",
        fx: "285",
        reference: "ADVANCE",
        request_key: uuid(),
      });
      i = (await data()).invoices.find((i: any) => i.id === invoice);
      assert.equal(i.status, "Paid");
      const p = (await data()).projects[0];
      assert.equal(p.revenue, "0");
      assert.equal(p.deferred, "2240000");
      assert.equal(p.cash, "2280000");
      assert.equal(p.withholding, "205200");
      assert.equal(p.receivable, "0");
      assert.equal(p.fx_result, "43600");
    },
  );
  await t.test(
    "advance recognition is explicit, partial, immutable and historical",
    async () => {
      const c = {
        action: "invoice.recognise",
        id: invoice,
        date: "2026-02-01",
        amount: "40",
        reference: "First cut approved",
        request_key: uuid(),
      };
      const r = await cmd(c);
      assert.equal((await cmd(c)).id, r.id);
      await cmd({ ...c, amount: "41" }, 409);
      await cmd({ ...c, date: "2026-01-01", request_key: uuid() }, 400);
      await cmd({ ...c, amount: "41", request_key: uuid() }, 409);
      const p = (await data()).projects[0];
      assert.equal(p.revenue, "1120000");
      assert.equal(p.deferred, "1120000");
      const jan = await call(
        `/api/financial-reports?entityId=${entity}&from=2026-01-01&to=2026-01-31`,
      );
      assert.equal(jan.income, "43600");
      assert.equal(jan.cash.difference, "0");
      assert.deepEqual(jan.cash.unsupported, []);
      assert.equal(jan.balanceDifference, "0");
      assert.equal(jan.receivables.difference, "0");
      const feb = await call(
        `/api/financial-reports?entityId=${entity}&from=2026-02-01&to=2026-02-28`,
      );
      assert.equal(feb.income, "1120000");
      assert.equal(feb.cash.operating, "0");
      assert.equal(feb.cash.difference, "0");
      await assert.rejects(() =>
        inTenant(db, tenant, (tx) =>
          tx.query("UPDATE revenue_recognitions SET net_minor=1 WHERE id=$1", [
            r.id,
          ]),
        ),
      );
    },
  );
  await t.test(
    "delivery invoice clears exact mixed-rate tax and AR uses invoice amounts, not quote totals",
    async () => {
      const i = (
        await cmd({
          action: "invoice.create",
          quote_id: quote,
          milestone_id: delivery,
          issue_date: "2026-03-01",
          due_date: "2026-03-31",
          request_key: uuid(),
        })
      ).id;
      await cmd({ action: "invoice.issue", id: i });
      const d = await data(),
        invoices = d.invoices.filter((i: any) => i.deal_id === deal);
      assert.equal(
        invoices.reduce((s: bigint, i: any) => s + BigInt(i.net_minor), 0n),
        20000n,
      );
      assert.equal(
        invoices.reduce((s: bigint, i: any) => s + BigInt(i.tax_minor), 0n),
        1800n,
      );
      const march = await call(
        `/api/financial-reports?entityId=${entity}&from=2026-01-01&to=2026-03-31`,
      );
      assert.equal(march.receivables.documents[0].outstanding, "13080");
      assert.equal(march.receivables.difference, "0");
      assert.equal(march.balanceDifference, "0");
      await cmd(
        {
          action: "invoice.create",
          quote_id: quote,
          amount: "0.01",
          issue_date: "2026-03-01",
          due_date: "2026-03-31",
          request_key: uuid(),
        },
        409,
      );
    },
  );
  await t.test(
    "posted bills affect cost once; payment does not double-count and asset purchases stay outside expense",
    async () => {
      const bill = (
        await cmd({
          action: "bill.create",
          entity_id: entity,
          vendor_id: company,
          deal_id: deal,
          reference: "PROJECT-BILL",
          bill_date: "2026-02-01",
          due_date: "2026-03-01",
          currency: "PKR",
          fx: "1",
          tax_treatment: "recoverable",
          lines: [
            {
              description: "Labour",
              quantity: "1",
              price: "7000",
              tax: "18",
              account_code: "5200",
            },
            {
              description: "Equipment",
              quantity: "1",
              price: "5000",
              tax: "0",
              account_code: "1500",
            },
          ],
          request_key: uuid(),
        })
      ).id;
      assert.equal((await data()).projects[0].cost, "200000");
      await cmd({ action: "bill.submit", id: bill, version: 1 });
      await cmd({ action: "bill.approve", id: bill, version: 2 });
      assert.equal((await data()).projects[0].cost, "900000");
      const payment = (
        await cmd({
          action: "vendor-payment.create",
          bill_id: bill,
          date: "2026-02-02",
          amount: "1000",
          wht: "0",
          fee: "10",
          fx: "1",
          reference: "PARTIAL",
          request_key: uuid(),
        })
      ).id;
      assert.equal((await data()).projects[0].cost, "901000");
      await cmd({
        action: "vendor-payment.reverse",
        id: payment,
        date: "2026-02-03",
        reason: "Wrong receipt",
      });
      assert.equal((await data()).projects[0].cost, "900000");
      await cmd({
        action: "bill.void",
        id: bill,
        version: 5,
        date: "2026-02-04",
        reason: "Vendor cancelled",
      });
      assert.equal((await data()).projects[0].cost, "200000");
    },
  );
  await t.test(
    "draft cancellation and void release allocations without mutating historical documents",
    async () => {
      const second = await accepted("Rebilling");
      const c = {
        action: "invoice.create",
        quote_id: second.quote,
        amount: "70.01",
        issue_date: "2026-02-01",
        due_date: "2026-02-28",
        request_key: uuid(),
      };
      const one = (await cmd(c)).id;
      await cmd({
        action: "invoice.cancel",
        id: one,
        reason: "Revised schedule",
      });
      await cmd({ action: "invoice.issue", id: one }, 409);
      const two = (await cmd({ ...c, request_key: uuid() })).id;
      await cmd({ action: "invoice.issue", id: two });
      await cmd({
        action: "invoice.void",
        id: two,
        date: "2026-02-02",
        reason: "Replace schedule",
      });
      const final = (
        await cmd({
          ...c,
          amount: "200",
          issue_date: "2026-02-03",
          request_key: uuid(),
        })
      ).id;
      await cmd({ action: "invoice.issue", id: final });
      const d = await data();
      assert.equal(
        d.invoices.find((i: any) => i.id === final).total_minor,
        "21800",
      );
      assert.equal(
        d.invoices.find((i: any) => i.id === one).status,
        "Cancelled",
      );
      await assert.rejects(() =>
        inTenant(db, tenant, (tx) =>
          tx.query("UPDATE invoices SET net_minor=1 WHERE id=$1", [final]),
        ),
      );
    },
  );
  await t.test(
    "project updates use versions; role and tenant boundaries hold",
    async () => {
      const c = {
        action: "project.update",
        id: project,
        version: 1,
        name: "Milestone film",
        start_date: "2026-01-01",
        end_date: "2026-04-30",
        budget: "9000",
        status: "On hold",
      };
      await cmd(c);
      await cmd(c, 409);
      await cmd(
        {
          action: "project.milestone",
          project_id: project,
          name: "Paused",
          request_key: uuid(),
          due_date: "2026-05-01",
          amount: "1",
          billing_kind: "earned",
        },
        409,
      );
      await rep("/api/commands", { ...c, version: 2 }, 403);
      assert.deepEqual((await rep("/api/data")).projects, []);
      assert.deepEqual((await rep("/api/data")).recognitions, []);
      assert.equal(
        (
          await inTenant(db, uuid(), (tx) =>
            tx.query("SELECT * FROM projects WHERE id=$1", [project]),
          )
        ).rows.length,
        0,
      );
      await cmd({ ...c, id: uuid() }, 404);
    },
  );
  await t.test(
    "small partial invoices allocate cents exactly even after an earlier slice is removed",
    () => {
      for (let n = 1; n <= 100; n++) {
        const q = totals([
          { description: "Taxed", quantity: "1", price: `${n}.13`, tax: "18" },
          { description: "Other", quantity: "1", price: "1.03", tax: "5" },
        ]);
        const first = allocateInvoice(q, [], 17n),
          second = allocateInvoice(q, [first], 31n);
        const last = allocateInvoice(q, [second], BigInt(q.net) - 31n);
        assert.equal(BigInt(second.net) + BigInt(last.net), BigInt(q.net));
        assert.equal(BigInt(second.tax) + BigInt(last.tax), BigInt(q.tax));
        for (const line of last.lines) assert.ok(BigInt(line.taxMinor) >= 0n);
      }
    },
  );
}
