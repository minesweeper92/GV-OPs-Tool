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
import {
  executeCustomerReceipt,
  customerReceiptSnapshot,
} from "../server/customer-receipts.ts";
import {
  receiptProblem,
  suggestAllocations,
} from "../shared/customer-receipts.ts";

const status = (code: number) => (e: unknown) =>
  e instanceof Problem && e.status === code;

test("suggestions settle the oldest invoices first and totals explain the bank", () => {
  const invoices = [
    { id: "b", due_date: "2026-03-01", number: "INV-2", balance: 500n },
    { id: "a", due_date: "2026-02-01", number: "INV-1", balance: 300n },
    { id: "c", due_date: "2026-03-01", number: "INV-3", balance: 900n },
  ];
  assert.deepEqual(suggestAllocations(1000n, invoices), [
    { invoice_id: "a", amount: 300n },
    { invoice_id: "b", amount: 500n },
    { invoice_id: "c", amount: 200n },
  ]);
  assert.deepEqual(suggestAllocations(200n, invoices), [
    { invoice_id: "a", amount: 200n },
  ]);
  const line = (amount: string, wht = "0", sales_tax_withheld = "0") => ({
    amount,
    wht,
    sales_tax_withheld,
  });
  assert.equal(
    receiptProblem({ amount: "100", fee: "0", allocations: [] }),
    null,
  );
  assert.match(
    receiptProblem({ amount: "0", fee: "0", allocations: [] })!,
    /cash received/,
  );
  assert.match(
    receiptProblem({ amount: "100", fee: "101", allocations: [] })!,
    /fee/,
  );
  assert.match(
    receiptProblem({ amount: "100", fee: "0", allocations: [line("101")] })!,
    /more cash/,
  );
  assert.match(
    receiptProblem({ amount: "100", fee: "0", allocations: [line("0")] })!,
    /nothing allocated/,
  );
  // Fully withheld by the customer: nothing reaches the bank.
  assert.equal(
    receiptProblem({
      amount: "0",
      fee: "0",
      allocations: [line("0", "50", "88")],
    }),
    null,
  );
});

test("customer receipts allocate, hold unapplied cash and reverse without rewriting history", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  await bindEnvironment(db, "sample");
  const rows = (
    await db.query(
      "SELECT m.*,t.name AS organization FROM memberships m JOIN tenants t ON t.id=m.tenant_id",
    )
  ).rows;
  const owner = rows.find(
    (r) => r.role === "admin" && r.organization.startsWith("Grid"),
  )!;
  const tenant = owner.tenant_id;
  const salesRow = rows.find(
    (r) => r.role === "sales" && r.tenant_id === tenant,
  )!;
  const admin: Context = {
    tenantId: tenant,
    userId: owner.user_id,
    role: "admin",
    name: "Owner",
  };
  const rep: Context = {
    tenantId: tenant,
    userId: salesRow.user_id,
    role: "sales",
    name: "Rep",
  };
  const run = (who: Context, c: Row) =>
    inTenant(db, who, (tx) =>
      c.action.startsWith("customer-receipt.")
        ? executeCustomerReceipt(tx, who, c)
        : c.action.startsWith("bank.")
          ? executeBank(tx, who, c)
          : c.action.startsWith("document.")
            ? executeDocument(tx, who, c)
            : execute(tx, who, c),
    );
  const read = (sql: string, params: unknown[] = []) =>
    inTenant(db, tenant, async (tx) => (await tx.query(sql, params)).rows);
  const entities = await read("SELECT id,code FROM entities ORDER BY code");
  const entity = entities[0].id,
    otherEntity = entities[1].id;
  const company = (name: string, customer = true) =>
    run(admin, {
      action: "company.create",
      domain: "",
      industry: "",
      tax_id: "",
      address: "",
      name: `${name} ${uuid().slice(0, 8)}`,
      customer,
      vendor: !customer,
      service_entity_id: null,
    }).then((r) => r.id as string);
  const customer = await company("Receipt customer"),
    stranger = await company("Other customer"),
    vendorOnly = await company("Vendor only", false);
  const bank = (
    await run(admin, {
      action: "bank.create",
      entity_id: entity,
      name: `Receipts bank ${uuid().slice(0, 6)}`,
      reference: "RCPT",
      opening_on: "2026-01-01",
      opening: "0",
      offset_code: "3900",
      request_key: uuid(),
    })
  ).id as string;
  const bankCode = (
    await read("SELECT account_code FROM bank_accounts WHERE id=$1", [bank])
  )[0].account_code;
  const details = {
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
  };
  async function issued(over: Row = {}) {
    const c = {
      action: "document.invoice-create",
      entity_id: entity,
      company_id: customer,
      issue_date: "2026-01-10",
      due_date: "2026-02-01",
      currency: "PKR",
      fx: "1",
      lines: [
        {
          description: "Work",
          quantity: "1",
          price: "100000",
          tax: "0",
          unit: "",
          section: "",
        },
      ],
      billing_kind: "earned",
      label: "Work",
      terms: "",
      details,
      request_key: uuid(),
      ...over,
    };
    const { id } = await run(admin, c);
    await run(admin, { action: "invoice.issue", id });
    return id as string;
  }
  const inv = async (id: string) =>
    (await read("SELECT * FROM invoices WHERE id=$1", [id]))[0];
  const balance = async (code: string, e = entity) =>
    Number(
      (
        await read(
          "SELECT coalesce(sum(debit_minor-credit_minor),0)::bigint AS b FROM journal_lines WHERE entity_id=$1 AND account_code=$2",
          [e, code],
        )
      )[0].b,
    ) / 100;
  const receipt = (over: Row = {}) => ({
    action: "customer-receipt.create",
    entity_id: entity,
    company_id: customer,
    currency: "PKR",
    bank_account_id: bank,
    date: "2026-02-15",
    amount: "600000",
    fee: "500",
    fx: "1",
    reference: "RCPT-1",
    notes: "",
    allocations: [] as Row[],
    request_key: uuid(),
    ...over,
  });
  let arBefore = await balance("1100");
  const a = await issued(),
    b = await issued({
      due_date: "2026-03-01",
      lines: [
        {
          description: "Campaign",
          quantity: "1",
          price: "550000",
          tax: "16",
          unit: "",
          section: "",
        },
      ],
    });
  let receiptId = "";

  await t.test(
    "one bank movement settles several invoices; withholding never reaches the bank",
    async () => {
      const c = receipt({
        allocations: [
          {
            invoice_id: b,
            amount: "400000",
            wht: "60000",
            sales_tax_withheld: "88000",
          },
          {
            invoice_id: a,
            amount: "100000",
            wht: "0",
            sales_tax_withheld: "0",
          },
        ],
      });
      receiptId = (await run(admin, c)).id;
      // A lost response is retried with the same key: same receipt, nothing doubled.
      assert.equal((await run(admin, c)).id, receiptId);
      await assert.rejects(run(admin, { ...c, amount: "700000" }), status(409));
      assert.equal(await balance(bankCode), 599500);
      assert.equal(await balance("5300"), 500);
      assert.equal(await balance("1200"), 60000);
      assert.equal(await balance("1210"), 88000);
      assert.equal(await balance("2410"), -100000);
      assert.equal((await balance("1100")) - arBefore, 90000);
      assert.equal((await inv(a)).status, "Paid");
      const second = await inv(b);
      assert.equal(second.status, "Issued");
      assert.equal(second.paid_minor, "54800000");
      const journal = await read(
        "SELECT count(*)::int AS n FROM journals WHERE source_type='customer-receipt' AND source_id=$1",
        [receiptId],
      );
      assert.equal(journal[0].n, 1);
    },
  );

  await t.test(
    "allocations stay within one customer, entity, currency and balance",
    async () => {
      const foreign = await issued({ company_id: stranger });
      // That invoice is another customer's receivable from here on.
      arBefore += 100000;
      await assert.rejects(
        run(
          admin,
          receipt({
            allocations: [
              {
                invoice_id: foreign,
                amount: "1",
                wht: "0",
                sales_tax_withheld: "0",
              },
            ],
          }),
        ),
        /this customer, legal entity and currency/,
      );
      await assert.rejects(
        run(
          admin,
          receipt({
            allocations: [
              {
                invoice_id: b,
                amount: "90001",
                wht: "0",
                sales_tax_withheld: "0",
              },
            ],
          }),
        ),
        /exceeds its outstanding balance/,
      );
      await assert.rejects(
        run(
          admin,
          receipt({
            allocations: [
              { invoice_id: a, amount: "1", wht: "0", sales_tax_withheld: "0" },
            ],
          }),
        ),
        status(409),
      );
      await assert.rejects(
        run(
          admin,
          receipt({
            date: "2026-01-09",
            allocations: [
              { invoice_id: b, amount: "1", wht: "0", sales_tax_withheld: "0" },
            ],
          }),
        ),
        /cannot precede invoice/,
      );
      await assert.rejects(
        run(
          admin,
          receipt({
            allocations: [
              { invoice_id: b, amount: "1", wht: "0", sales_tax_withheld: "0" },
              { invoice_id: b, amount: "1", wht: "0", sales_tax_withheld: "0" },
            ],
          }),
        ),
        /only once/,
      );
      await assert.rejects(
        run(
          admin,
          receipt({
            entity_id: otherEntity,
            allocations: [
              { invoice_id: b, amount: "1", wht: "0", sales_tax_withheld: "0" },
            ],
          }),
        ),
        status(400),
      );
      await assert.rejects(
        run(admin, receipt({ company_id: vendorOnly })),
        /as a customer/,
      );
      await assert.rejects(run(admin, receipt({ fx: "2" })), /PKR must use 1/);
      await assert.rejects(run(rep, receipt()), status(403));
      // Two people settling the same balance: the second sees the first's result.
      const [x, y] = await Promise.allSettled([
        run(
          admin,
          receipt({
            reference: "RACE-1",
            amount: "90000",
            fee: "0",
            allocations: [
              {
                invoice_id: b,
                amount: "90000",
                wht: "0",
                sales_tax_withheld: "0",
              },
            ],
          }),
        ),
        run(
          admin,
          receipt({
            reference: "RACE-2",
            amount: "90000",
            fee: "0",
            allocations: [
              {
                invoice_id: b,
                amount: "90000",
                wht: "0",
                sales_tax_withheld: "0",
              },
            ],
          }),
        ),
      ]);
      assert.deepEqual([x.status, y.status].sort(), ["fulfilled", "rejected"]);
      const winner = (
        x.status === "fulfilled"
          ? x.value
          : (y as PromiseFulfilledResult<Row>).value
      ).id;
      await run(admin, {
        action: "customer-receipt.reverse",
        id: winner,
        date: "2026-02-15",
        reason: "Race test cleanup",
      });
      assert.equal((await inv(b)).paid_minor, "54800000");
    },
  );

  let applicationId = "",
    refundId = "";
  await t.test(
    "unapplied cash is applied and refunded later, each within what is left",
    async () => {
      await assert.rejects(
        run(admin, {
          action: "customer-receipt.apply",
          receipt_id: receiptId,
          invoice_id: b,
          date: "2026-02-20",
          amount: "90001",
          request_key: uuid(),
        }),
        status(400),
      );
      await assert.rejects(
        run(admin, {
          action: "customer-receipt.apply",
          receipt_id: receiptId,
          invoice_id: b,
          date: "2026-02-14",
          amount: "90000",
          request_key: uuid(),
        }),
        status(409),
      );
      const apply = {
        action: "customer-receipt.apply",
        receipt_id: receiptId,
        invoice_id: b,
        date: "2026-02-20",
        amount: "90000",
        request_key: uuid(),
      };
      applicationId = (await run(admin, apply)).id;
      assert.equal((await run(admin, apply)).id, applicationId);
      assert.equal((await inv(b)).status, "Paid");
      assert.equal(await balance("2410"), -10000);
      assert.equal((await balance("1100")) - arBefore, 0);
      await assert.rejects(
        run(admin, {
          action: "customer-receipt.refund",
          receipt_id: receiptId,
          bank_account_id: bank,
          date: "2026-02-25",
          amount: "10001",
          fx: "1",
          reference: "REF-1",
          request_key: uuid(),
        }),
        status(400),
      );
      refundId = (
        await run(admin, {
          action: "customer-receipt.refund",
          receipt_id: receiptId,
          bank_account_id: bank,
          date: "2026-02-25",
          amount: "10000",
          fx: "1",
          reference: "REF-1",
          request_key: uuid(),
        })
      ).id;
      assert.equal(await balance("2410"), 0);
      assert.equal(await balance(bankCode), 589500);
      const snapshot = await inTenant(db, admin, (tx) =>
        customerReceiptSnapshot(tx, admin),
      );
      assert.equal(
        snapshot.customerReceipts.find((r) => r.id === receiptId)!
          .available_minor,
        "0",
      );
    },
  );

  await t.test(
    "reversals are dated, ordered and restore exactly what they undo",
    async () => {
      await assert.rejects(
        run(admin, {
          action: "customer-receipt.reverse",
          id: receiptId,
          date: "2026-02-26",
          reason: "Wrong customer",
        }),
        /applications and refunds/,
      );
      await assert.rejects(
        run(admin, {
          action: "customer-receipt.reverse-refund",
          id: refundId,
          date: "2026-02-24",
          reason: "Too early",
        }),
        status(409),
      );
      const undoRefund = {
        action: "customer-receipt.reverse-refund",
        id: refundId,
        date: "2026-02-26",
        reason: "Refund bounced",
      };
      const first = (await run(admin, undoRefund)).id;
      assert.equal((await run(admin, undoRefund)).id, first);
      await assert.rejects(
        run(admin, { ...undoRefund, reason: "Different" }),
        status(409),
      );
      assert.equal(await balance(bankCode), 599500);
      await run(admin, {
        action: "customer-receipt.reverse-application",
        id: applicationId,
        date: "2026-02-27",
        reason: "Applied to wrong invoice",
      });
      const reopened = await inv(b);
      assert.equal(reopened.status, "Issued");
      assert.equal(reopened.paid_minor, "54800000");
      assert.equal(await balance("2410"), -100000);
      await run(admin, {
        action: "customer-receipt.reverse",
        id: receiptId,
        date: "2026-02-28",
        reason: "Wrong customer",
      });
      for (const id of [a, b]) {
        const i = await inv(id);
        assert.equal(i.status, "Issued");
        assert.equal(i.paid_minor, "0");
        assert.equal(i.paid_base_minor, "0");
      }
      for (const code of [
        bankCode,
        "5300",
        "1200",
        "1210",
        "2410",
        "4100",
        "5100",
      ])
        assert.equal(await balance(code), 0, code);
      assert.equal((await balance("1100")) - arBefore, 738000);
      // The originals are still there; nothing was edited or deleted.
      assert.equal(
        (
          await read(
            "SELECT count(*)::int AS n FROM customer_receipt_allocations WHERE receipt_id=$1",
            [receiptId],
          )
        )[0].n,
        2,
      );
      await assert.rejects(
        inTenant(db, tenant, (tx) =>
          tx.query("UPDATE customer_receipts SET reference='edited'"),
        ),
      );
      await assert.rejects(
        run(admin, {
          action: "customer-receipt.apply",
          receipt_id: receiptId,
          invoice_id: b,
          date: "2026-03-01",
          amount: "1",
          request_key: uuid(),
        }),
        /has been reversed/,
      );
    },
  );

  await t.test(
    "foreign-currency receipts carry each amount at the right rate",
    async () => {
      const usd = await issued({
        currency: "USD",
        fx: "280",
        issue_date: "2026-03-01",
        due_date: "2026-03-31",
        lines: [
          {
            description: "Export work",
            quantity: "1",
            price: "1000",
            tax: "0",
            unit: "",
            section: "",
          },
        ],
      });
      const gainBefore = await balance("4100"),
        lossBefore = await balance("5100"),
        bankBefore = await balance(bankCode);
      const r = (
        await run(
          admin,
          receipt({
            currency: "USD",
            fx: "290",
            date: "2026-03-10",
            amount: "1500",
            fee: "0",
            reference: "USD-1",
            allocations: [
              {
                invoice_id: usd,
                amount: "1000",
                wht: "0",
                sales_tax_withheld: "0",
              },
            ],
          }),
        )
      ).id;
      // 1,000 settles AR carried at 280; 500 is unapplied at the receipt's 290.
      assert.equal((await balance(bankCode)) - bankBefore, 435000);
      assert.equal((await balance("4100")) - gainBefore, -10000);
      assert.equal(await balance("2410"), -145000);
      assert.equal((await inv(usd)).status, "Paid");
      await run(admin, {
        action: "customer-receipt.refund",
        receipt_id: r,
        bank_account_id: bank,
        date: "2026-03-20",
        amount: "500",
        fx: "300",
        reference: "USD-REF",
        request_key: uuid(),
      });
      assert.equal(await balance("2410"), 0);
      assert.equal((await balance("5100")) - lossBefore, 5000);
      assert.equal((await balance(bankCode)) - bankBefore, 285000);
    },
  );

  await t.test(
    "locked periods and legal-entity grants are respected",
    async () => {
      const open = await issued({
        issue_date: "2026-04-05",
        due_date: "2026-04-30",
      });
      await run(admin, {
        action: "period.close",
        entity_id: entity,
        date: "2026-04-30",
        reason: "Month closed",
      });
      await assert.rejects(
        run(
          admin,
          receipt({
            date: "2026-04-20",
            reference: "LOCKED",
            amount: "100",
            fee: "0",
            allocations: [
              {
                invoice_id: open,
                amount: "100",
                wht: "0",
                sales_tax_withheld: "0",
              },
            ],
          }),
        ),
        status(409),
      );
      // Someone limited to another legal entity cannot see or settle this one.
      const limited: Context = {
        ...admin,
        role: "finance",
        entityIds: [otherEntity],
      };
      await assert.rejects(
        run(
          limited,
          receipt({
            date: "2026-05-02",
            reference: "HIDDEN",
            amount: "100",
            fee: "0",
            allocations: [
              {
                invoice_id: open,
                amount: "100",
                wht: "0",
                sales_tax_withheld: "0",
              },
            ],
          }),
        ),
        status(404),
      );
      const visible = await inTenant(db, limited, (tx) =>
        customerReceiptSnapshot(tx, limited),
      );
      assert.equal(visible.customerReceipts.length, 0);
      assert.equal(visible.customerReceiptAllocations.length, 0);
    },
  );
});
