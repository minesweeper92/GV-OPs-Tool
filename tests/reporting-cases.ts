import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import { inTenant, type Database } from "../server/db.ts";
import { seedAccounts, post, type Context } from "../server/domain.ts";
import { createApp } from "../server/app.ts";
import { ageBucket } from "../shared/reporting.ts";

export async function verifyReporting(t: TestContext, db: Database) {
  const tenant = uuid(),
    entity = uuid(),
    second = uuid(),
    user = uuid(),
    sales = uuid();
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO tenants VALUES($1,'Reporting tests')", [
      tenant,
    ]);
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
      [entity, "RPT"],
      [second, "RPT2"],
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
  async function login(id: string) {
    const headers = { host: "127.0.0.1:4320", origin: "http://127.0.0.1:4320" };
    const response = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers,
      payload: { userId: id, tenantId: tenant },
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
    rep = await login(sales);
  const cmd = (payload: Record<string, unknown>) =>
    call("/api/commands", payload);
  const report = (from: string, to: string, entityId: string = entity) =>
    call(`/api/financial-reports?entityId=${entityId}&from=${from}&to=${to}`);
  const company = (
    await cmd({
      action: "company.create",
      name: `Reports ${uuid()}`,
      domain: "",
      industry: "",
      tax_id: "",
      address: "",
      customer: true,
      vendor: true,
      service_entity_id: null,
    })
  ).id;
  const contact = (
    await cmd({
      action: "contact.create",
      first_name: "Reports",
      last_name: "Test",
      email: "",
      phone: "",
      title: "",
      source: "",
      notes: "",
      company_id: company,
      role: "Billing",
    })
  ).id;
  const lead = (
    await cmd({
      action: "lead.create",
      company_id: company,
      contact_id: contact,
      entity_id: entity,
      title: "Reporting project",
      source: "",
      next_action: "Quote",
      due_date: "2026-01-01",
    })
  ).id;
  const deal = (await cmd({ action: "lead.convert", id: lead })).id;
  const quote = (
    await cmd({
      action: "quote.create",
      deal_id: deal,
      option_name: "Reporting",
      currency: "USD",
      fx: "280",
      lines: [{ description: "Work", quantity: "1", price: "100", tax: "0" }],
      terms: "",
    })
  ).id;
  await cmd({ action: "quote.accept", id: quote, reference: "Agreed" });
  const invoice = (
    await cmd({
      action: "invoice.create",
      quote_id: quote,
      issue_date: "2026-01-01",
      due_date: "2026-01-31",
    })
  ).id;
  await cmd({ action: "invoice.issue", id: invoice });
  const bill = (
    await cmd({
      action: "bill.create",
      entity_id: entity,
      vendor_id: company,
      deal_id: deal,
      reference: "REPORT-BILL",
      bill_date: "2026-01-01",
      due_date: "2026-01-31",
      currency: "USD",
      fx: "280",
      lines: [
        {
          description: "Equipment",
          quantity: "1",
          price: "50",
          tax: "0",
          account_code: "1500",
        },
        {
          description: "Production",
          quantity: "1",
          price: "30",
          tax: "0",
          account_code: "5200",
        },
      ],
      tax_treatment: "expense",
      notes: "",
      request_key: uuid(),
    })
  ).id;
  await cmd({ action: "bill.submit", id: bill, version: 1 });
  await cmd({ action: "bill.approve", id: bill, version: 2 });
  await t.test(
    "accrual statements tie; an unpaid capital purchase is not a cash outflow",
    async () => {
      const r = await report("2026-01-01", "2026-01-31");
      assert.equal(r.profit, "1960000");
      assert.equal(r.assets, "4200000");
      assert.equal(r.liabilities, "2240000");
      assert.equal(r.earnings, r.profit);
      assert.equal(r.balanceDifference, "0");
      assert.equal(r.cash.opening, "0");
      assert.equal(r.cash.closing, "0");
      assert.equal(r.cash.operating, "0");
      assert.equal(r.cash.investing, "0");
      assert.equal(r.cash.difference, "0");
      assert.deepEqual(r.cash.unsupported, []);
      assert.equal(r.receivables.total, "2800000");
      assert.equal(r.payables.total, "2240000");
      assert.equal(r.receivables.documents[0].bucket, 0);
      const empty = await report("2025-01-01", "2025-12-31");
      assert.equal(empty.profit, "0");
      assert.equal(empty.assets, "0");
      assert.equal(empty.receivables.documents.length, 0);
    },
  );
  await cmd({
    action: "payment.create",
    invoice_id: invoice,
    date: "2026-02-15",
    amount: "30",
    wht: "10",
    fx: "300",
    reference: "Receipt",
    request_key: uuid(),
  });
  const payment = (
    await cmd({
      action: "vendor-payment.create",
      bill_id: bill,
      date: "2026-02-15",
      amount: "30",
      wht: "10",
      fee: "2",
      fx: "300",
      reference: "Payment",
      request_key: uuid(),
    })
  ).id;
  await t.test(
    "historical ageing ignores later payments; FX carrying balances reconcile",
    async () => {
      const jan = await report("2026-01-01", "2026-01-31");
      assert.equal(jan.receivables.total, "2800000");
      assert.equal(jan.payables.total, "2240000");
      const feb = await report("2026-02-01", "2026-02-28");
      assert.equal(feb.receivables.documents[0].outstanding, "6000");
      assert.equal(feb.receivables.total, "1680000");
      assert.equal(feb.receivables.difference, "0");
      assert.equal(feb.payables.documents[0].outstanding, "4000");
      assert.equal(feb.payables.total, "1120000");
      assert.equal(feb.payables.difference, "0");
      assert.equal(feb.profit, "-60000");
      assert.equal(feb.cash.investing, "-562500");
      assert.equal(feb.cash.operating, "502500");
      assert.equal(feb.cash.closing, "-60000");
      assert.equal(feb.cash.difference, "0");
      assert.equal(feb.balanceDifference, "0");
      assert.deepEqual(
        [0, 1, 30, 31, 60, 61, 90, 91].map(
          (n) =>
            ageBucket(
              new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10),
              "2026-01-01",
            ).bucket,
        ),
        [0, 1, 1, 2, 2, 3, 3, 4],
      );
      const detail = await call(
        `/api/account-detail?entityId=${entity}&code=1100&from=2026-02-01&to=2026-02-28`,
      );
      assert.equal(detail.opening, "2800000");
      assert.equal(detail.closing, "1680000");
      assert.equal(detail.lines[0].balance, detail.closing);
    },
  );
  await cmd({
    action: "vendor-payment.reverse",
    id: payment,
    date: "2026-03-01",
    reason: "Wrong bank reference",
  });
  await cmd({
    action: "bill.void",
    id: bill,
    version: 5,
    date: "2026-03-02",
    reason: "Supplier cancelled",
  });
  await t.test(
    "later reversals and voids preserve historical balances and cash classifications",
    async () => {
      assert.equal(
        (await report("2026-02-01", "2026-02-28")).payables.total,
        "1120000",
      );
      const march = await report("2026-03-01", "2026-03-01");
      assert.equal(march.payables.total, "2240000");
      assert.equal(march.cash.investing, "562500");
      assert.equal(march.cash.difference, "0");
      const after = await report("2026-01-01", "2026-03-31");
      assert.equal(after.payables.total, "0");
      assert.equal(after.payables.documents.length, 0);
      assert.equal(after.cash.investing, "0");
      assert.equal(after.cash.closing, "900000");
      assert.equal(after.balanceDifference, "0");
      const onlyOther = await report("2026-01-01", "2026-03-31", second);
      assert.equal(onlyOther.assets, "0");
      assert.equal(
        (await report("2026-01-01", "2026-03-31", "all")).assets,
        after.assets,
      );
    },
  );
  await t.test(
    "reports reject unauthorized roles, foreign entities and malformed dates",
    async () => {
      await rep(
        `/api/financial-reports?entityId=${entity}&from=2026-01-01&to=2026-03-31`,
        undefined,
        403,
      );
      await call(
        `/api/financial-reports?entityId=${uuid()}&from=2026-01-01&to=2026-03-31`,
        undefined,
        404,
      );
      await call(
        `/api/financial-reports?entityId=${entity}&from=2026-03-01&to=2026-02-30`,
        undefined,
        400,
      );
      await call(
        `/api/financial-reports?entityId=${entity}&from=2026-03-01&to=2026-01-01`,
        undefined,
        400,
      );
      await rep(
        `/api/account-detail?entityId=${entity}&code=1100&from=2026-01-01&to=2026-03-31`,
        undefined,
        403,
      );
      const ctx: Context = { tenantId: tenant, userId: user, role: "admin" };
      await inTenant(db, tenant, (tx) =>
        post(
          tx,
          ctx,
          second,
          "2026-01-01",
          "unclassified-test",
          uuid(),
          "Unsupported classification",
          [
            { account: "1000", debit: 100n },
            { account: "3000", credit: 100n },
          ],
        ),
      );
      const flagged = await report("2026-01-01", "2026-01-31", second);
      assert.deepEqual(flagged.cash.unsupported, ["unclassified-test"]);
    },
  );
}
