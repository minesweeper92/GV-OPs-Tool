import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import type { Database } from "../server/db.ts";
import { seedAccounts } from "../server/domain.ts";
import { createApp } from "../server/app.ts";

export async function verifyManualJournals(t: TestContext, db: Database) {
  const tenant = uuid(),
    otherTenant = uuid(),
    entity = uuid(),
    otherEntity = uuid(),
    admin = uuid(),
    finance = uuid(),
    sales = uuid();
  await db.transaction(async (tx) => {
    for (const [id, name] of [
      [tenant, "Manual journals"],
      [otherTenant, "Separate journals"],
    ])
      await tx.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [id, name]);
    for (const [id, role, tenantId] of [
      [admin, "admin", tenant],
      [finance, "finance", tenant],
      [sales, "sales", tenant],
    ]) {
      await tx.query("INSERT INTO users(id,name,email) VALUES($1,$2,$3)", [
        id,
        role,
        `${id}@example.test`,
      ]);
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [tenantId, id, role],
      );
    }
    for (const [id, owner, code] of [
      [entity, tenant, "MAN"],
      [otherEntity, otherTenant, "OTH"],
    ]) {
      await tx.query(
        "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,$3,$3)",
        [id, owner, code],
      );
      await seedAccounts(tx, owner, id);
    }
  });
  const origin = "http://127.0.0.1:4320",
    app = createApp(db, origin);
  await app.ready();
  t.after(() => app.close());
  async function login(userId: string) {
    const headers = { host: "127.0.0.1:4320", origin };
    const signed = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers,
      payload: { userId, tenantId: tenant },
    });
    assert.equal(signed.statusCode, 200, signed.body);
    const cookie = String(signed.headers["set-cookie"]).split(";")[0];
    const me = (
      await app.inject({ url: "/api/me", headers: { ...headers, cookie } })
    ).json();
    return async (
      url: string,
      payload?: Record<string, unknown>,
      expected = 200,
    ) => {
      const response = await app.inject({
        method: payload ? "POST" : "GET",
        url,
        headers: { ...headers, cookie, "x-csrf-token": me.csrf },
        payload,
      });
      assert.equal(response.statusCode, expected, response.body);
      return response.json();
    };
  }
  const ownerCall = await login(admin),
    financeCall = await login(finance),
    salesCall = await login(sales);
  const create = {
    action: "manual-journal.create",
    entity_id: entity,
    date: "2026-09-15",
    reference: "ADJ-001",
    memo: "Approved equipment reclassification",
    lines: [
      { account_code: "1500", debit: "125.25", credit: "0", memo: "Equipment" },
      {
        account_code: "5000",
        debit: "0",
        credit: "125.25",
        memo: "Reclass expense",
      },
    ],
    request_key: uuid(),
  };
  await t.test(
    "finance posts exact balanced lines, retries safely and reports the reference",
    async () => {
      const made = await financeCall("/api/commands", create);
      assert.equal((await financeCall("/api/commands", create)).id, made.id);
      await financeCall(
        "/api/commands",
        { ...create, memo: "Different transaction" },
        409,
      );
      const report = await financeCall(
        `/api/reports?entityId=${entity}&from=2026-09-01&to=2026-09-30`,
      );
      const journal = report.journals.find(
        (j: { id: string }) => j.id === made.id,
      );
      assert.equal(journal.external_reference, "ADJ-001");
      assert.equal(journal.memo, create.memo);
      assert.deepEqual(
        journal.lines
          .map((l: { account: string; debit: string; credit: string }) => [
            l.account,
            l.debit,
            l.credit,
          ])
          .sort(),
        [
          ["1500", "12525", "0"],
          ["5000", "0", "12525"],
        ],
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM journals WHERE source_type='manual' AND source_id=$1",
            [create.request_key],
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(
        db.query("UPDATE journals SET memo='tampered' WHERE id=$1", [made.id]),
        /immutable/i,
      );
      await assert.rejects(
        db.query("DELETE FROM journal_lines WHERE journal_id=$1", [made.id]),
        /immutable/i,
      );
    },
  );
  await t.test(
    "invalid, controlled, foreign-entity and unauthorised postings fail",
    async () => {
      await salesCall("/api/commands", { ...create, request_key: uuid() }, 403);
      await ownerCall(
        "/api/commands",
        {
          ...create,
          request_key: uuid(),
          lines: [{ ...create.lines[0], debit: "100" }, create.lines[1]],
        },
        400,
      );
      await ownerCall(
        "/api/commands",
        {
          ...create,
          request_key: uuid(),
          lines: [{ ...create.lines[0], credit: "1" }, create.lines[1]],
        },
        400,
      );
      await ownerCall(
        "/api/commands",
        {
          ...create,
          request_key: uuid(),
          lines: [
            { ...create.lines[0], account_code: "1100" },
            create.lines[1],
          ],
        },
        400,
      );
      await ownerCall(
        "/api/commands",
        { ...create, entity_id: otherEntity, request_key: uuid() },
        404,
      );
    },
  );
  await t.test(
    "locked originals remain; a dated reversal restores balances once",
    async () => {
      const made = (
        await financeCall(
          "/api/reports?entityId=" + entity + "&from=2026-09-01&to=2026-09-30",
        )
      ).journals.find(
        (j: { source_type: string }) => j.source_type === "manual",
      );
      await ownerCall("/api/commands", {
        action: "period.close",
        entity_id: entity,
        date: "2026-09-15",
        reason: "Reviewed",
      });
      await financeCall(
        "/api/commands",
        { ...create, request_key: uuid() },
        409,
      );
      await financeCall(
        "/api/commands",
        {
          action: "manual-journal.reverse",
          id: made.id,
          date: "2026-09-15",
          reason: "Wrong classification",
          request_key: uuid(),
        },
        409,
      );
      const reversal = {
        action: "manual-journal.reverse",
        id: made.id,
        date: "2026-09-16",
        reason: "Wrong classification",
        request_key: uuid(),
      };
      const reversed = await financeCall("/api/commands", reversal);
      assert.equal(
        (await financeCall("/api/commands", reversal)).id,
        reversed.id,
      );
      await financeCall(
        "/api/commands",
        { ...reversal, request_key: uuid() },
        409,
      );
      const report = await financeCall(
        `/api/reports?entityId=${entity}&from=2026-09-01&to=2026-09-30`,
      );
      assert.equal(
        report.journals.find((j: { id: string }) => j.id === reversed.id)
          .reverses_journal_id,
        made.id,
      );
      for (const code of ["1500", "5000"]) {
        const row = report.trial.find((a: { code: string }) => a.code === code);
        assert.equal(row.debit, row.credit);
      }
    },
  );
}
