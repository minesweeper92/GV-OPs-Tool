import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import { createApp } from "../server/app.ts";
import { inTenant, type Database } from "../server/db.ts";
import { post, seedAccounts, type Context } from "../server/domain.ts";
import { monthDates } from "../server/periods.ts";

export async function verifyPeriodClose(t: TestContext, db: Database) {
  const tenant = uuid(),
    otherTenant = uuid(),
    entity = uuid();
  const admin = uuid(),
    finance = uuid(),
    sales = uuid();
  const otherEntity = uuid();
  await db.transaction(async (tx) => {
    for (const [id, name] of [
      [tenant, "Close tests"],
      [otherTenant, "Other close tests"],
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
      [entity, tenant, "CLOSE"],
      [otherEntity, otherTenant, "OTHER"],
    ]) {
      await tx.query(
        "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,$3,$3)",
        [id, owner, code],
      );
      await seedAccounts(tx, owner, id);
    }
  });
  const origin = "http://127.0.0.1:4320";
  const app = createApp(db, origin);
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
  const now = new Date();
  const priorMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  )
    .toISOString()
    .slice(0, 7);
  const { start, end } = monthDates(priorMonth);
  const previewPath = `/api/period-close?entityId=${entity}&month=${priorMonth}`;
  const transition = (
    preview: any,
    to: string,
    extras: Record<string, unknown> = {},
  ) => ({
    action: "period.transition",
    entity_id: entity,
    month: priorMonth,
    to,
    version: preview.version,
    preflight_hash: preview.preflightHash,
    acknowledge_warnings: false,
    reason: "Month-end review",
    request_key: uuid(),
    ...extras,
  });

  await t.test(
    "tenant and role boundaries protect close previews and transitions",
    async () => {
      await salesCall(previewPath, undefined, 403);
      await ownerCall(
        `/api/period-close?entityId=${otherEntity}&month=${priorMonth}`,
        undefined,
        404,
      );
      const preview = await financeCall(previewPath);
      assert.equal(preview.status, "Open");
      assert.equal(preview.version, 0);
      await salesCall("/api/commands", transition(preview, "Soft closed"), 403);
      await financeCall("/api/commands", transition(preview, "Closed"), 403);
      await ownerCall(
        "/api/commands",
        { ...transition(preview, "Soft closed"), entity_id: otherEntity },
        404,
      );
    },
  );

  await t.test(
    "preflight changes require a fresh review and explicit warning acknowledgement",
    async () => {
      const old = await ownerCall(previewPath);
      const bank = uuid(),
        bankCode = "10B9876";
      await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO accounts(tenant_id,entity_id,code,name,type,system) VALUES($1,$2,$3,'Close test bank','Asset',true)",
          [tenant, entity, bankCode],
        );
        await tx.query(
          `INSERT INTO bank_accounts(id,tenant_id,entity_id,account_code,name,reference,opening_on,opening_minor,last_reconciled_on,offset_code,request_key,request_payload)
         VALUES($1,$2,$3,$4,'Close test bank','TEST',$5,0,$5,'3900',$6,'{}')`,
          [bank, tenant, entity, bankCode, start, uuid()],
        );
      });
      await ownerCall("/api/commands", transition(old, "Soft closed"), 409);
      const current = await ownerCall(previewPath);
      assert.equal(current.checks.find((c: any) => c.key === "banks").count, 1);
      await financeCall(
        "/api/commands",
        transition(current, "Soft closed"),
        409,
      );
      const command = transition(current, "Soft closed", {
        acknowledge_warnings: true,
      });
      const result = await financeCall("/api/commands", command);
      assert.equal((await financeCall("/api/commands", command)).id, result.id);
      assert.equal((await ownerCall(previewPath)).status, "Soft closed");
      const history = (await ownerCall(previewPath)).history;
      assert.equal(history.length, 1);
      assert.equal(history[0].warnings.length, 1);
      await ownerCall(
        "/api/commands",
        { ...command, reason: "Different reason" },
        409,
      );
    },
  );

  await t.test(
    "soft close permits finance adjustments but final close blocks everyone",
    async () => {
      const entry = (userId: string, role: Context["role"], date: string) =>
        inTenant(db, tenant, (tx) =>
          post(
            tx,
            { tenantId: tenant, userId, role },
            entity,
            date,
            "close-test",
            uuid(),
            "Month-end adjustment",
            [
              { account: "1500", debit: 250n },
              { account: "5000", credit: 250n },
            ],
          ),
        );
      await assert.rejects(entry(sales, "sales", end), /soft-closed month/);
      await assert.rejects(
        inTenant(db, tenant, (tx) =>
          tx.query(
            `INSERT INTO journals(id,tenant_id,entity_id,source_type,source_id,posted_on,description,actor_id)
         VALUES($1,$2,$3,'bypass-test',$4,$5,'Bypass attempt',$6)`,
            [uuid(), tenant, entity, uuid(), end, sales],
          ),
        ),
        /Only finance can post in a soft-closed period/,
      );
      await entry(finance, "finance", end);
      const soft = await ownerCall(previewPath);
      await financeCall(
        "/api/commands",
        transition(soft, "Closed", { acknowledge_warnings: true }),
        403,
      );
      await ownerCall(
        "/api/commands",
        transition(soft, "Closed", { acknowledge_warnings: true }),
      );
      await assert.rejects(
        entry(admin, "admin", end),
        /accounting month is closed/,
      );
      await assert.rejects(
        inTenant(db, tenant, (tx) =>
          tx.query(
            `INSERT INTO journals(id,tenant_id,entity_id,source_type,source_id,posted_on,description,actor_id)
         VALUES($1,$2,$3,'bypass-test',$4,$5,'Bypass attempt',$6)`,
            [uuid(), tenant, entity, uuid(), end, admin],
          ),
        ),
        /closed accounting period/,
      );
      const closed = await ownerCall(previewPath);
      assert.equal(closed.status, "Closed");
      assert.equal(closed.history.length, 2);
      await ownerCall(
        "/api/commands",
        transition(closed, "Open", { reason: "Adjustment required" }),
      );
      await entry(sales, "sales", end);
      const reopened = await ownerCall(previewPath);
      assert.equal(reopened.status, "Open");
      assert.equal(reopened.history.length, 3);
      assert.equal(reopened.version, 3);
    },
  );

  await t.test(
    "period event history is append-only and the older date lock remains effective",
    async () => {
      const preview = await ownerCall(previewPath);
      await ownerCall(
        "/api/commands",
        {
          ...transition(preview, "Soft closed"),
          preflight_hash: "0".repeat(64),
        },
        409,
      );
      await assert.rejects(
        inTenant(db, tenant, (tx) =>
          tx.query("DELETE FROM accounting_period_events WHERE entity_id=$1", [
            entity,
          ]),
        ),
      );
      await ownerCall("/api/commands", {
        action: "period.close",
        entity_id: entity,
        date: start,
        reason: "Older lock",
      });
      await ownerCall(
        "/api/commands",
        transition(await ownerCall(previewPath), "Soft closed", {
          acknowledge_warnings: true,
        }),
        409,
      );
      const release = {
        action: "period.legacy-unlock",
        entity_id: entity,
        expected_lock_date: start,
        reason: "Move to monthly close workflow",
        request_key: uuid(),
      };
      await financeCall("/api/commands", release, 403);
      await ownerCall(
        "/api/commands",
        { ...release, expected_lock_date: end },
        409,
      );
      const unlocked = await ownerCall("/api/commands", release);
      assert.equal((await ownerCall("/api/commands", release)).id, unlocked.id);
      const after = await ownerCall(previewPath);
      assert.equal(after.legacyLock, null);
      assert.equal(after.legacyHistory.length, 1);
      assert.equal(after.legacyHistory[0].reason, release.reason);
    },
  );
}
