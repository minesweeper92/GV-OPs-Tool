import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import type { Database } from "../server/db.ts";
import { inTenant } from "../server/db.ts";
import { seedAccounts } from "../server/domain.ts";
import { createApp } from "../server/app.ts";
import { partyStatement } from "../server/statements.ts";

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
