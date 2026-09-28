import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import { inTenant, type Database } from "../server/db.ts";
import { post, seedAccounts, type Context } from "../server/domain.ts";
import { createApp } from "../server/app.ts";
import { parseStatementCsv } from "../shared/banking.ts";

export async function verifyBanking(t: TestContext, db: Database) {
  const tenant = uuid(),
    other = uuid(),
    entity = uuid(),
    second = uuid(),
    user = uuid(),
    sales = uuid();
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO tenants VALUES($1,'Banking tests'),($2,'Banking outsider')",
      [tenant, other],
    );
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
      [entity, "BNK"],
      [second, "BNK2"],
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
    const h = { host: "127.0.0.1:4320", origin: "http://127.0.0.1:4320" };
    const r = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers: h,
      payload: { userId: id, tenantId: tenant },
    });
    const cookie = String(r.headers["set-cookie"]).split(";")[0];
    const me = (
      await app.inject({ url: "/api/me", headers: { ...h, cookie } })
    ).json();
    return async (
      url: string,
      payload?: Record<string, unknown>,
      expected = 200,
    ) => {
      const response = await app.inject({
        method: payload ? "POST" : "GET",
        url,
        headers: { ...h, cookie, "x-csrf-token": me.csrf },
        payload,
      });
      assert.equal(response.statusCode, expected, response.body);
      return response.json();
    };
  }
  const call = await login(user),
    rep = await login(sales),
    cmd = (c: Record<string, unknown>, expected = 200) =>
      call("/api/commands", c, expected);
  const create = {
    action: "bank.create",
    entity_id: entity,
    name: "Test Current",
    reference: "1234",
    opening_on: "2025-12-31",
    opening: "1000",
    offset_code: "3900",
    request_key: uuid(),
  };
  const b = (await cmd(create)).id;
  const otherBank = (
    await cmd({ ...create, entity_id: second, request_key: uuid() })
  ).id;
  const detail = (id = b, statementId = "") =>
    call(
      `/api/banking?bankId=${id}${statementId ? "&statementId=" + statementId : ""}`,
    );
  const expense = (amount: string, date = "2026-01-10", bank = b) => ({
    action: "expense.create",
    entity_id: entity,
    bank_account_id: bank,
    deal_id: null,
    amount,
    date,
    description: `Test cost ${amount}`,
    reference: "Paid",
    request_key: uuid(),
  });
  const hundred = await cmd(expense("100"));
  await cmd(expense("20", "2026-01-20"));
  let statementId: string, matchId: string;
  await t.test(
    "CSV parsing, account opening, import validation and retry protection",
    async () => {
      assert.equal((await cmd(create)).id, b);
      await cmd({ ...create, opening: "2000" }, 409);
      const parsed = parseStatementCsv(
        'Date,Description,Reference,Amount\r\n2026-01-10,"Studio, hire","Ref ""A""",-40\r\n2026-01-10,Fees,FEE,-60.00',
      );
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].description, "Studio, hire");
      assert.equal(parsed[0].reference, 'Ref "A"');
      assert.throws(() =>
        parseStatementCsv(
          "Date,Description,Reference,Amount\n01/02/2026,Test,A,-1",
        ),
      );
      assert.throws(() =>
        parseStatementCsv(
          'Date,Description,Reference,Amount\n2026-01-01,"unclosed,A,1',
        ),
      );
      const c = {
        action: "bank.import",
        bank_id: b,
        from: "2026-01-01",
        to: "2026-01-31",
        opening: "1000",
        closing: "900",
        reference: "Jan",
        lines: parsed,
        request_key: uuid(),
      };
      await cmd({ ...c, closing: "901" }, 400);
      await cmd({ ...c, opening: "900" }, 409);
      await cmd({ ...c, from: "2026-01-02" }, 400);
      statementId = (await cmd(c)).id;
      assert.equal((await cmd(c)).id, statementId);
      await cmd({ ...c, request_key: uuid() }, 409);
      const d = await detail();
      assert.equal(d.bookBalance, "88000");
      assert.equal(d.unmatchedBookBalance, "-12000");
      assert.equal(d.difference, "10000");
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::integer AS n FROM journals WHERE tenant_id=$1",
            [tenant],
          )
        ).rows[0].n,
        4,
      ); // two openings, two expenses; imports post nothing
    },
  );
  await t.test(
    "grouped matches, duplicate prevention, undo and completion with uncleared items",
    async () => {
      let d = await detail();
      const book = d.books.find((l: any) => l.description === "Test cost 100");
      const c = {
        action: "bank.match",
        statement_id: statementId,
        statement_line_ids: d.lines.map((l: any) => l.id),
        journal_line_ids: [book.id],
      };
      await cmd({ ...c, statement_line_ids: [d.lines[0].id] }, 400);
      await cmd({ ...c, journal_line_ids: [book.id, book.id] }, 400);
      await cmd({ action: "bank.close", id: statementId }, 409);
      matchId = (await cmd(c)).id;
      assert.equal((await cmd(c)).id, matchId);
      await cmd({ ...c, statement_line_ids: [d.lines[0].id] }, 409);
      await cmd({
        action: "bank.unmatch",
        id: matchId,
        reason: "Review grouping",
      });
      d = await detail();
      assert.equal(d.matches.length, 0);
      matchId = (await cmd(c)).id;
      d = await detail();
      assert.equal(d.difference, "0");
      assert.equal(d.unmatchedBookBalance, "-2000");
      await cmd({ action: "bank.close", id: statementId });
      await cmd({ action: "bank.close", id: statementId });
      assert.equal((await detail()).statement.status, "Reconciled");
      await cmd(
        { action: "bank.unmatch", id: matchId, reason: "After close" },
        409,
      );
      await cmd(expense("1", "2026-01-25"), 400);
      await assert.rejects(
        inTenant(db, tenant, (tx) =>
          post(
            tx,
            { tenantId: tenant, userId: user, role: "admin" },
            entity,
            "2026-01-25",
            "test-backdate",
            uuid(),
            "Backdate",
            [
              { account: d.account.account_code, credit: 100n },
              { account: "5000", debit: 100n },
            ],
          ),
        ),
      );
    },
  );
  await t.test(
    "uncleared items carry forward; historical reconciliations remain stable",
    async () => {
      const c = {
        action: "bank.import",
        bank_id: b,
        from: "2026-02-01",
        to: "2026-02-28",
        opening: "900",
        closing: "880",
        reference: "Feb",
        lines: [
          {
            date: "2026-02-01",
            description: "Cleared old withdrawal",
            reference: "B",
            amount: "-20",
          },
        ],
        request_key: uuid(),
      };
      const feb = (await cmd(c)).id;
      let d = await detail(b, feb);
      assert.equal(d.books.length, 1);
      assert.equal(d.books[0].posted_on, "2026-01-20");
      await cmd({
        action: "bank.match",
        statement_id: feb,
        statement_line_ids: [d.lines[0].id],
        journal_line_ids: [d.books[0].id],
      });
      await cmd({ action: "bank.close", id: feb });
      d = await detail(b, statementId);
      assert.equal(d.unmatchedBookBalance, "-2000");
      assert.equal(d.difference, "0");
      const march = (
        await cmd({
          ...c,
          from: "2026-03-01",
          to: "2026-03-31",
          opening: "880",
          closing: "880",
          reference: "March",
          lines: [],
          request_key: uuid(),
        })
      ).id;
      await cmd({
        action: "bank.cancel",
        id: march,
        reason: "Uploaded wrong period",
      });
      assert.equal((await detail(b, march)).statement.status, "Cancelled");
      const replacement = (
        await cmd({
          ...c,
          from: "2026-03-01",
          to: "2026-03-31",
          opening: "880",
          closing: "880",
          reference: "March correct",
          lines: [],
          request_key: uuid(),
        })
      ).id;
      await cmd({ action: "bank.close", id: replacement });
    },
  );
  await t.test(
    "banking enforces entity, tenant and role boundaries and immutable statement evidence",
    async () => {
      await cmd(expense("5", "2026-04-01", otherBank), 400);
      await rep(`/api/banking?bankId=${b}`, undefined, 403);
      await rep(
        "/api/commands",
        { ...create, name: "Forbidden", request_key: uuid() },
        403,
      );
      assert.equal((await rep("/api/data")).bankAccounts.length, 0);
      await call(
        `/api/banking?bankId=${otherBank}&statementId=${statementId}`,
        undefined,
        404,
      );
      assert.equal(
        (
          await inTenant(db, other, (tx) =>
            tx.query("SELECT * FROM bank_statements"),
          )
        ).rows.length,
        0,
      );
      await assert.rejects(
        db.query("UPDATE bank_statements SET reference='Changed' WHERE id=$1", [
          statementId,
        ]),
      );
      await assert.rejects(
        db.query(
          "UPDATE bank_statement_lines SET description='Changed' WHERE statement_id=$1",
          [statementId],
        ),
      );
      const unchanged = await detail(b, statementId);
      assert.equal(unchanged.statement.reference, "Jan");
      const recorded = (
        await db.query("SELECT bank_account_id FROM expenses WHERE id=$1", [
          hundred.id,
        ])
      ).rows[0];
      assert.equal(recorded.bank_account_id, b);
    },
  );
}
