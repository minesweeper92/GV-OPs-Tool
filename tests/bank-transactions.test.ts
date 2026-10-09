import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import {
  openDatabase,
  migrate,
  bindEnvironment,
  inTenant,
  type Row,
} from "../server/db.ts";
import { seed } from "../server/seed.ts";
import { Problem, execute, type Context } from "../server/domain.ts";
import { executeBank } from "../server/banking.ts";
import { executeDocument } from "../server/documents.ts";
import { executeManualJournal } from "../server/manual-journals.ts";
import { executeAccount } from "../server/accounts.ts";
import { bankTransactionProblem } from "../shared/banking.ts";
import { financialReports } from "../server/financial-reports.ts";

const status = (code: number) => (e: unknown) =>
  e instanceof Problem && e.status === code;

test("allocations must explain the whole bank movement", () => {
  const line = (debit: string, credit: string) => ({ debit, credit });
  assert.equal(
    bankTransactionProblem({
      direction: "out",
      amount: "144000",
      lines: [line("150000", "0"), line("0", "6000")],
    }),
    null,
  );
  assert.equal(
    bankTransactionProblem({
      direction: "in",
      amount: "757.52",
      lines: [line("0", "757.52")],
    }),
    null,
  );
  assert.match(
    bankTransactionProblem({
      direction: "out",
      amount: "100",
      lines: [line("0", "100")],
    })!,
    /went/,
  );
  assert.match(
    bankTransactionProblem({
      direction: "in",
      amount: "100",
      lines: [line("100", "100")],
    })!,
    /not both/,
  );
  assert.match(
    bankTransactionProblem({
      direction: "in",
      amount: "0",
      lines: [line("0", "0")],
    })!,
    /greater than zero/,
  );
});

test("bank transactions post drawings, net salaries and openings through the bank", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  await bindEnvironment(db, "sample");
  const rows = (
    await db.query(
      "SELECT m.*,u.name,t.name AS organization FROM memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id",
    )
  ).rows;
  const owner = rows.find(
    (r) => r.role === "admin" && r.organization.startsWith("Grid"),
  )!;
  const tenant = owner.tenant_id;
  const sales = rows.find((r) => r.role === "sales" && r.tenant_id === tenant)!;
  const admin: Context = {
    tenantId: tenant,
    userId: owner.user_id,
    role: "admin",
    name: "Owner",
  };
  const rep: Context = {
    tenantId: tenant,
    userId: sales.user_id,
    role: "sales",
    name: "Rep",
  };
  const run = (who: Context, c: Row) =>
    inTenant(db, who.tenantId, (tx) =>
      c.action.startsWith("bank.")
        ? executeBank(tx, who, c)
        : c.action.startsWith("manual-journal.")
          ? executeManualJournal(tx, who, c as never)
          : c.action.startsWith("account.")
            ? executeAccount(tx, who, c as never)
            : execute(tx, who, c),
    );
  const read = (sql: string, params: unknown[] = []) =>
    inTenant(db, tenant, async (tx) => (await tx.query(sql, params)).rows);
  const entity = (
    await read("SELECT id FROM entities ORDER BY code LIMIT 1")
  )[0].id;
  for (const [code, name, type] of [
    ["2250", "Salary tax payable", "Liability"],
    ["3100", "Drawings", "Equity"],
    ["5030", "Salaries", "Expense"],
  ])
    await run(admin, {
      action: "account.create",
      entity_id: entity,
      code,
      name,
      type,
      parent_code: null,
      description: "",
      request_key: uuid(),
    });
  const { id: bankId } = await run(admin, {
    action: "bank.create",
    entity_id: entity,
    name: "Test current account",
    reference: "TST",
    opening_on: "2026-01-01",
    opening: "0",
    offset_code: "3900",
    request_key: uuid(),
  });
  const bank = (
    await read("SELECT * FROM bank_accounts WHERE id=$1", [bankId])
  )[0];
  const balance = async (code: string) => {
    const r = (
      await read(
        "SELECT coalesce(sum(debit_minor-credit_minor),0)::bigint AS b FROM journal_lines WHERE entity_id=$1 AND account_code=$2",
        [entity, code],
      )
    )[0];
    return Number(r.b) / 100;
  };
  const tx = (over: Row = {}) => ({
    action: "bank.transaction",
    bank_id: bankId,
    date: "2026-07-31",
    direction: "in",
    amount: "500000",
    description: "Owner capital introduced",
    reference: "CAP-1",
    lines: [
      { account_code: "3000", debit: "0", credit: "500000", memo: "Capital" },
    ],
    request_key: uuid(),
    ...over,
  });

  await t.test(
    "money in and out lands on the bank and the allocated accounts",
    async () => {
      const capital = tx();
      await run(admin, capital);
      // A retry with the same key does not post twice; a changed retry is refused.
      await run(admin, capital);
      await assert.rejects(
        run(admin, {
          ...capital,
          amount: "1",
          lines: [{ ...capital.lines[0], credit: "1" }],
        }),
        status(409),
      );
      await run(
        admin,
        tx({
          direction: "out",
          amount: "144000",
          description: "June salary, net",
          reference: "SAL-JUN",
          lines: [
            {
              account_code: "5030",
              debit: "150000",
              credit: "0",
              memo: "Gross salary",
            },
            {
              account_code: "2250",
              debit: "0",
              credit: "6000",
              memo: "s.149 tax withheld",
            },
          ],
        }),
      );
      await run(
        admin,
        tx({
          direction: "out",
          amount: "181000",
          description: "Drawing",
          reference: "DRAW",
          lines: [
            { account_code: "3100", debit: "181000", credit: "0", memo: "" },
          ],
        }),
      );
      assert.equal(await balance(bank.account_code), 500000 - 144000 - 181000);
      assert.equal(await balance("5030"), 150000);
      assert.equal(await balance("2250"), -6000);
      assert.equal(await balance("3100"), 181000);
      const audit = await read(
        "SELECT count(*)::int AS n FROM audit_events WHERE action='bank.transaction'",
      );
      assert.equal(audit[0].n, 3);
      // The cash-flow statement classifies them: capital in and drawings out are
      // financing; the net salary is operating; nothing is left unexplained.
      const report = await inTenant(db, tenant, (q) =>
        financialReports(q, admin, {
          entityId: entity,
          from: "2026-07-01",
          to: "2026-07-31",
        } as never),
      );
      assert.deepEqual(report.cash.unsupported, []);
      assert.equal(report.cash.difference, "0");
      assert.equal(report.cash.financing, String((500000 - 181000) * 100));
      assert.equal(report.cash.operating, String(-144000 * 100));
      // The transaction appears in the bank's book lines for reconciliation.
      const lines = await read(
        "SELECT j.source_type FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.account_code=$1",
        [bank.account_code],
      );
      assert.equal(
        lines.filter((l) => l.source_type === "bank-transaction").length,
        3,
      );
    },
  );

  await t.test(
    "control accounts, other banks, foreign charts and locked periods are refused",
    async () => {
      for (const code of ["1100", "2000", "1200", bank.account_code])
        await assert.rejects(
          run(
            admin,
            tx({
              lines: [
                { account_code: code, debit: "0", credit: "500000", memo: "" },
              ],
            }),
          ),
          status(400),
        );
      await assert.rejects(
        run(
          admin,
          tx({
            lines: [
              { account_code: "9999", debit: "0", credit: "500000", memo: "" },
            ],
          }),
        ),
        /chart/,
      );
      await assert.rejects(
        run(admin, tx({ date: "2025-12-31" })),
        /opening date/,
      );
      await run(admin, {
        action: "period.close",
        entity_id: entity,
        date: "2026-07-31",
        reason: "Test lock",
      });
      await assert.rejects(run(admin, tx({ date: "2026-07-15" })), status(409));
      // Manual journals now point people at this workflow for bank accounts.
      await assert.rejects(
        run(admin, {
          action: "manual-journal.create",
          entity_id: entity,
          date: "2026-08-15",
          reference: "X",
          memo: "X",
          auto_reverse_on: null,
          lines: [
            {
              account_code: bank.account_code,
              debit: "1",
              credit: "0",
              memo: "",
            },
            { account_code: "3000", debit: "0", credit: "1", memo: "" },
          ],
          request_key: uuid(),
        }),
        /banking workflow/,
      );
    },
  );

  await t.test(
    "only people who can record transactions may use it",
    async () => {
      await assert.rejects(run(rep, tx({ date: "2026-09-01" })), status(403));
    },
  );

  await t.test("history is append-only", async () => {
    await assert.rejects(
      inTenant(db, tenant, (q) =>
        q.query("UPDATE bank_transactions SET description='edited'"),
      ),
    );
  });
});

test("customers can withhold sales tax separately from income tax", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  await bindEnvironment(db, "sample");
  const owner = (
    await db.query(
      "SELECT m.* FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.role='admin' AND t.name LIKE 'Grid%'",
    )
  ).rows[0];
  const admin: Context = {
    tenantId: owner.tenant_id,
    userId: owner.user_id,
    role: "admin",
    name: "Owner",
  };
  const run = (c: Row) =>
    inTenant(db, admin.tenantId, (tx) => execute(tx, admin, c));
  const read = (sql: string, params: unknown[] = []) =>
    inTenant(
      db,
      admin.tenantId,
      async (tx) => (await tx.query(sql, params)).rows,
    );
  // An issued PKR invoice of 550,000 + 16% GST = 638,000, as Nestlé was billed.
  const entity = (
    await read("SELECT id FROM entities ORDER BY code LIMIT 1")
  )[0].id;
  const company = (
    await read("SELECT id FROM companies ORDER BY name LIMIT 1")
  )[0].id;
  const created = await inTenant(db, admin.tenantId, (tx) =>
    executeDocument(tx, admin, {
      action: "document.invoice-create",
      entity_id: entity,
      company_id: company,
      issue_date: "2026-04-10",
      due_date: "2026-07-09",
      currency: "PKR",
      fx: "1",
      lines: [
        {
          description: "TVC changes and releases",
          quantity: "1",
          price: "550000",
          tax: "16",
          unit: "",
          section: "",
        },
      ],
      billing_kind: "earned",
      label: "Campaign edit",
      terms: "",
      request_key: uuid(),
      details: {
        subject: "",
        reference: "",
        purchase_order: "",
        billing_address: "",
        shipping_address: "",
        customer_tax_id: "",
        attention: "",
        payment_terms: "",
        customer_notes: "",
        inclusions: "",
        exclusions: "",
        delivery_schedule: "",
        payment_schedule: "",
        payment_instructions: "",
        custom_fields: [],
      },
    }),
  );
  await run({ action: "invoice.issue", id: created.id });
  const invoice = (
    await read("SELECT * FROM invoices WHERE id=$1", [created.id])
  )[0];
  assert.equal(invoice.total_minor, "63800000");
  const total = BigInt(invoice.total_minor);
  const salesTax =
    BigInt(invoice.tax_minor) > 0n ? BigInt(invoice.tax_minor) : total / 10n;
  const fmt = (m: bigint) => `${m / 100n}.${String(m % 100n).padStart(2, "0")}`;
  const pay = (over: Row) => ({
    action: "payment.create",
    invoice_id: invoice.id,
    date: String(invoice.issue_date).slice(0, 10),
    amount: "0",
    wht: "0",
    fx: "1",
    reference: "Customer remittance",
    request_key: uuid(),
    ...over,
  });
  await assert.rejects(run(pay({})), status(400));
  await assert.rejects(
    run(pay({ sales_tax_withheld: fmt(total + 1n) })),
    status(400),
  );
  // Withholding-only settlement: no cash, sales tax lands in its own account.
  await run(pay({ sales_tax_withheld: fmt(salesTax) }));
  await run(pay({ amount: fmt(total - salesTax - 1000n), wht: "10" }));
  const after = (
    await read("SELECT * FROM invoices WHERE id=$1", [invoice.id])
  )[0];
  assert.equal(after.status, "Paid");
  const balance = async (code: string) =>
    BigInt(
      (
        await read(
          "SELECT coalesce(sum(debit_minor-credit_minor),0)::bigint AS b FROM journal_lines WHERE entity_id=$1 AND account_code=$2",
          [invoice.entity_id, code],
        )
      )[0].b,
    );
  assert.equal(await balance("1210"), salesTax);
  // The customer statement settles the invoice in full.
  const settled = await read(
    "SELECT sum(amount_minor+wht_minor+sales_tax_withheld_minor)::bigint AS s FROM payments WHERE invoice_id=$1",
    [invoice.id],
  );
  assert.equal(BigInt(settled[0].s), total);
});
