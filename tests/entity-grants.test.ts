import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import { openDatabase, migrate, bindEnvironment } from "../server/db.ts";
import { seed } from "../server/seed.ts";
import { createApp } from "../server/app.ts";

test("entity grants limit a member to chosen legal entities", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  await bindEnvironment(db, "sample");
  const origin = "http://127.0.0.1:4320",
    host = "127.0.0.1:4320",
    app = createApp(db, origin);
  await app.ready();
  t.after(() => app.close());
  const accounts = (
    await app.inject({ url: "/api/demo-accounts", headers: { host } })
  ).json();
  async function login(name: string) {
    const a = accounts.find(
      (a: { name: string; organization: string }) =>
        a.name === name && a.organization.startsWith("Grid"),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers: { host, origin },
      payload: { userId: a.user_id, tenantId: a.tenant_id },
    });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.headers["set-cookie"]!.toString().split(";")[0];
    const me = (
      await app.inject({ url: "/api/me", headers: { host, cookie } })
    ).json();
    const call = (url: string, payload?: unknown) =>
      app.inject({
        method: payload ? "POST" : "GET",
        url,
        headers: { host, origin, cookie, "x-csrf-token": me.csrf },
        payload: payload as Record<string, unknown> | undefined,
      });
    return { me, call, userId: a.user_id as string };
  }
  const ok = async (r: Promise<{ statusCode: number; body: string }>) => {
    const res = await r;
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body);
  };

  const owner = await login("Owner");
  const data = await ok(owner.call("/api/data"));
  const pvt = data.entities.find((e: { code: string }) => e.code === "PVT"),
    aop = data.entities.find((e: { code: string }) => e.code === "AOP");
  const vendor = await ok(
    owner.call("/api/commands", {
      action: "company.create",
      name: `Grant vendor ${uuid()}`,
      vendor: true,
      customer: false,
      service_entity_id: null,
    }),
  );
  const bill = (entity: string, reference: string) =>
    ok(
      owner.call("/api/commands", {
        action: "bill.create",
        entity_id: entity,
        vendor_id: vendor.id,
        deal_id: null,
        reference,
        bill_date: "2030-03-01",
        due_date: "2030-03-31",
        currency: "PKR",
        fx: "1",
        lines: [
          {
            description: "Granted work",
            quantity: "1",
            price: "100",
            tax: "0",
            account_code: "5000",
          },
        ],
        tax_treatment: "expense",
        request_key: uuid(),
        notes: "",
      }),
    );
  const pvtBill = await bill(pvt.id, `PVT-${uuid()}`),
    aopBill = await bill(aop.id, `AOP-${uuid()}`);

  const team = await ok(owner.call("/api/team"));
  assert.deepEqual(
    team.entities.map((e: { code: string }) => e.code),
    ["AOP", "PVT"],
  );
  const accountant = team.members.find(
    (m: { name: string }) => m.name === "Accountant",
  );
  const ownerMember = team.members.find(
    (m: { name: string }) => m.name === "Owner",
  );
  const grant = (
    member: { id: string; role: string; version: number },
    entityIds: unknown,
  ) =>
    owner.call("/api/team/member", {
      userId: member.id,
      role: member.role,
      active: true,
      version: member.version,
      entityIds,
    });
  // Administrators always keep every entity; grants must name real entities.
  assert.equal((await grant(ownerMember, [pvt.id])).statusCode, 400);
  assert.equal((await grant(accountant, [])).statusCode, 400);
  assert.match((await grant(accountant, [uuid()])).body, /this organization/);
  await ok(grant(accountant, [pvt.id]));

  const limited = await login("Accountant");
  assert.deepEqual(limited.me.user.entityIds, [pvt.id]);
  const seen = await ok(limited.call("/api/data"));
  assert.deepEqual(
    seen.entities.map((e: { code: string }) => e.code),
    ["PVT"],
  );
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  assert.ok(ids(seen.bills).includes(pvtBill.id));
  assert.ok(!ids(seen.bills).includes(aopBill.id));
  for (const key of [
    "bills",
    "invoices",
    "payments",
    "expenses",
    "leads",
    "deals",
    "quotes",
    "bankAccounts",
    "purchaseOrders",
    "vendorCredits",
    "vendorAdvances",
  ])
    for (const row of seen[key] || [])
      if (row.entity_id)
        assert.equal(row.entity_id, pvt.id, `${key} leaked ${row.entity_id}`);
  // Contacts and companies stay organization-wide.
  assert.ok(seen.companies.some((c: { id: string }) => c.id === vendor.id));

  // Hidden records behave as missing; writes into other entities fail.
  const submit = await limited.call("/api/commands", {
    action: "bill.submit",
    id: aopBill.id,
    version: 1,
  });
  assert.notEqual(submit.statusCode, 200);
  await ok(
    limited.call("/api/commands", {
      action: "bill.submit",
      id: pvtBill.id,
      version: 1,
    }),
  );
  const create = await limited.call("/api/commands", {
    action: "bill.create",
    entity_id: aop.id,
    vendor_id: vendor.id,
    deal_id: null,
    reference: `Blocked-${uuid()}`,
    bill_date: "2030-03-01",
    due_date: "2030-03-31",
    currency: "PKR",
    fx: "1",
    lines: [
      {
        description: "Blocked",
        quantity: "1",
        price: "1",
        tax: "0",
        account_code: "5000",
      },
    ],
    tax_treatment: "expense",
    request_key: uuid(),
    notes: "",
  });
  assert.notEqual(create.statusCode, 200);
  const report = await limited.call(
    `/api/reports?entityId=${aop.id}&from=2030-01-01&to=2030-12-31`,
  );
  assert.ok(
    report.statusCode !== 200 || !report.body.includes(aopBill.id),
    report.body,
  );

  // An unrelated edit from an older client keeps the grant.
  const kept = (await ok(owner.call("/api/team"))).members.find(
    (m: { id: string }) => m.id === accountant.id,
  );
  assert.deepEqual(kept.entity_ids, [pvt.id]);
  await ok(
    owner.call("/api/team/member", {
      userId: kept.id,
      role: kept.role,
      active: true,
      version: kept.version,
    }),
  );
  const after = (await ok(owner.call("/api/team"))).members.find(
    (m: { id: string }) => m.id === accountant.id,
  );
  assert.deepEqual(after.entity_ids, [pvt.id]);

  // Restoring every entity shows the hidden bill again.
  await ok(grant(after, null));
  const full = await login("Accountant");
  assert.ok(ids((await ok(full.call("/api/data"))).bills).includes(aopBill.id));

  // Invitations carry the grant into the accepted membership.
  const invite = await ok(
    owner.call("/api/team/invite", {
      email: `grant-${uuid()}@example.test`,
      role: "viewer",
      entityIds: [aop.id],
    }),
  );
  const pending = (await ok(owner.call("/api/team"))).invitations.find(
    (i: { id: string }) => i.id === invite.id,
  );
  assert.deepEqual(pending.entity_ids, [aop.id]);
});

test("every entity-tagged table and its children carry the entity policy", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  const missing = (
    await db.query(`
      WITH scoped AS (
        SELECT c.oid,c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=current_schema()
        WHERE c.relkind='r' AND EXISTS(
          SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='entity_id' AND NOT a.attisdropped)
      ), children AS (
        SELECT DISTINCT c.relname FROM pg_constraint k
        JOIN pg_class c ON c.oid=k.conrelid
        WHERE k.contype='f' AND k.confrelid IN (SELECT oid FROM scoped)
      )
      SELECT relname FROM (SELECT relname FROM scoped UNION SELECT relname FROM children) t
      WHERE relname NOT IN ('audit_events','companies')
        AND NOT EXISTS(SELECT 1 FROM pg_policies p WHERE p.tablename=t.relname AND p.policyname='entity_scope')
      ORDER BY relname`)
  ).rows.map((r) => r.relname);
  // Shared by decision: the audit feed and companies (their service entity is
  // a preference, not ownership). Anything else must be scoped.
  assert.deepEqual(missing, []);
});
