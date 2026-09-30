import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import type { Database } from "../server/db.ts";
import { inTenant } from "../server/db.ts";
import { seedAccounts } from "../server/domain.ts";
import { createApp } from "../server/app.ts";
import { parseCsv, tableCsv } from "../shared/cutover.ts";

export async function verifyCutover(t: TestContext, db: Database) {
  const tenant = uuid(),
    otherTenant = uuid(),
    entity = uuid(),
    otherEntity = uuid();
  const admin = uuid(),
    finance = uuid(),
    sales = uuid();
  const customer = uuid(),
    vendor = uuid();
  await db.transaction(async (tx) => {
    for (const [id, name] of [
      [tenant, "Cutover sample"],
      [otherTenant, "Other cutover sample"],
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
      [entity, tenant, "CUT"],
      [otherEntity, otherTenant, "OTH"],
    ]) {
      await tx.query(
        "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,$3,$3)",
        [id, owner, code],
      );
      await seedAccounts(tx, owner, id);
    }
    for (const [id, name, isCustomer, isVendor] of [
      [customer, "Cutover Customer", true, false],
      [vendor, "Cutover Vendor", false, true],
    ] as const)
      await tx.query(
        "INSERT INTO companies(id,tenant_id,name,owner_id,customer,vendor) VALUES($1,$2,$3,$4,$5,$6)",
        [id, tenant, name, admin, isCustomer, isVendor],
      );
  });
  const origin = "http://127.0.0.1:4320";
  const app = createApp(db, origin);
  await app.ready();
  t.after(() => app.close());
  const login = async (userId: string) => {
    const signed = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers: { host: "127.0.0.1:4320", origin },
      payload: { userId, tenantId: tenant },
    });
    assert.equal(signed.statusCode, 200, signed.body);
    const cookie = String(signed.headers["set-cookie"]).split(";")[0];
    const me = (
      await app.inject({
        url: "/api/me",
        headers: { host: "127.0.0.1:4320", cookie },
      })
    ).json();
    return async (
      url: string,
      payload?: Record<string, unknown>,
      expected = 200,
    ) => {
      const response = await app.inject({
        method: payload ? "POST" : "GET",
        url,
        headers: {
          host: "127.0.0.1:4320",
          origin,
          cookie,
          "x-csrf-token": me.csrf,
        },
        payload,
      });
      assert.equal(response.statusCode, expected, response.body);
      return response.json();
    };
  };
  const owner = await login(admin),
    bookkeeper = await login(finance),
    rep = await login(sales);
  const date = "2026-09-01";
  const accountRows = [
    {
      code: "10B0001",
      name: "Opening bank",
      type: "Asset",
      debit: "1000.00",
      credit: "0",
    },
    {
      code: "1100",
      name: "Accounts receivable",
      type: "Asset",
      debit: "500.00",
      credit: "0",
    },
    {
      code: "2000",
      name: "Accounts payable",
      type: "Liability",
      debit: "0",
      credit: "200.00",
    },
    {
      code: "3000",
      name: "Owner equity",
      type: "Equity",
      debit: "0",
      credit: "1300.00",
    },
    {
      code: "5400",
      name: "Cutover adjustment",
      type: "Expense",
      debit: "0",
      credit: "0",
    },
  ];
  const input = {
    entity_id: entity,
    cutover_date: date,
    accounts: accountRows,
    receivables: [
      {
        company: "Cutover Customer",
        number: "OLD-INV-17",
        issue_date: "2026-08-15",
        due_date: "2026-10-01",
        amount: "500.00",
      },
    ],
    payables: [
      {
        company: "Cutover Vendor",
        number: "OLD-BILL-9",
        bill_date: "2026-08-20",
        due_date: "2026-10-10",
        amount: "200.00",
      },
    ],
  };
  await t.test(
    "CSV parser handles quoted headers and rejects malformed rows",
    () => {
      assert.deepEqual(parseCsv('name,amount\n"A, B",10\n'), [
        ["name", "amount"],
        ["A, B", "10"],
      ]);
      assert.deepEqual(tableCsv("Code, Name\n5400,Tools\n", ["code", "name"]), [
        { code: "5400", name: "Tools" },
      ]);
      assert.throws(() => parseCsv('name\n"broken'), /unclosed/);
    },
  );
  await t.test(
    "preview blocks missing bank and unbalanced AR without posting",
    async () => {
      const pre = await owner("/api/cutover/preview", input);
      assert.equal(pre.canCommit, false);
      assert.ok(
        pre.checks.some((c: any) => c.label === "Bank 10B0001" && !c.ok),
      );
      const changed = {
        ...input,
        receivables: [{ ...input.receivables[0], amount: "400.00" }],
      };
      const ar = await owner("/api/cutover/preview", changed);
      assert.ok(
        ar.checks.some(
          (c: any) => c.label === "Receivables reconcile" && !c.ok,
        ),
      );
      assert.equal(
        (
          await inTenant(db, tenant, (tx) =>
            tx.query("SELECT count(*)::int AS n FROM cutover_batches"),
          )
        ).rows[0].n,
        0,
      );
      await rep("/api/cutover/preview", input, 403);
      await owner(
        "/api/cutover/preview",
        { ...input, entity_id: otherEntity },
        404,
      );
    },
  );
  await t.test(
    "cutover posts AR/AP detail and balanced opening ledger atomically",
    async () => {
      await owner("/api/commands", {
        action: "bank.create",
        entity_id: entity,
        name: "Opening bank",
        reference: "TEST",
        opening_on: date,
        opening: "1000.00",
        offset_code: "3900",
        request_key: uuid(),
      });
      const pre = await bookkeeper("/api/cutover/preview", input);
      assert.equal(pre.canCommit, true, JSON.stringify(pre.checks));
      const key = uuid();
      await bookkeeper(
        "/api/cutover/commit",
        {
          input,
          preflightHash: pre.preflightHash,
          requestKey: key,
          confirmation: "CUT",
        },
        403,
      );
      await owner(
        "/api/cutover/commit",
        {
          input,
          preflightHash: pre.preflightHash,
          requestKey: key,
          confirmation: "WRONG",
        },
        400,
      );
      await owner(
        "/api/cutover/commit",
        {
          input,
          preflightHash: "0".repeat(64),
          requestKey: key,
          confirmation: "CUT",
        },
        409,
      );
      const result = await owner("/api/cutover/commit", {
        input,
        preflightHash: pre.preflightHash,
        requestKey: key,
        confirmation: "CUT",
      });
      assert.equal(
        (
          await owner("/api/cutover/commit", {
            input,
            preflightHash: pre.preflightHash,
            requestKey: key,
            confirmation: "CUT",
          })
        ).id,
        result.id,
      );
      const history = await owner(`/api/cutover?entityId=${entity}`);
      assert.equal(history.length, 1);
      assert.deepEqual(history[0].source_data, input);
      const ledger = await inTenant(db, tenant, async (tx) => {
        const balances = (
          await tx.query(
            "SELECT account_code,sum(debit_minor-credit_minor)::text AS amount FROM journal_lines WHERE entity_id=$1 GROUP BY account_code",
            [entity],
          )
        ).rows;
        const invoices = (
          await tx.query(
            "SELECT id,number,status,opening_batch_id FROM invoices WHERE entity_id=$1",
            [entity],
          )
        ).rows;
        const bills = (
          await tx.query(
            "SELECT id,reference,status,opening_batch_id FROM bills WHERE entity_id=$1",
            [entity],
          )
        ).rows;
        return { balances, invoices, bills };
      });
      const balance = (code: string) =>
        ledger.balances.find((r) => r.account_code === code)?.amount;
      assert.equal(balance("3900"), "0");
      assert.equal(balance("1100"), "50000");
      assert.equal(balance("2000"), "-20000");
      assert.equal(balance("3000"), "-130000");
      assert.equal(ledger.invoices[0].number, "OLD-INV-17");
      assert.equal(ledger.invoices[0].opening_batch_id, result.id);
      assert.equal(ledger.bills[0].reference, "OLD-BILL-9");
      const report = await owner(
        `/api/financial-reports?entityId=${entity}&from=2026-09-01&to=2026-09-30`,
      );
      assert.equal(report.receivables.total, "50000");
      assert.equal(report.payables.total, "20000");
      assert.equal(report.receivables.difference, "0");
      assert.equal(report.payables.difference, "0");
      await owner("/api/commands", {
        action: "payment.create",
        invoice_id: ledger.invoices[0].id,
        date: "2026-09-10",
        amount: "100.00",
        wht: "0",
        fx: "1",
        reference: "CUT-PAY",
        request_key: uuid(),
      });
      const after = await owner(
        `/api/financial-reports?entityId=${entity}&from=2026-09-01&to=2026-09-30`,
      );
      assert.equal(after.receivables.total, "40000");
      await owner("/api/cutover/preview", input).then((p) =>
        assert.equal(p.canCommit, false),
      );
    },
  );
}
