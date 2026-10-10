import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import {
  openDatabase,
  migrate,
  bindEnvironment,
  inTenant,
} from "../server/db.ts";
import { seed } from "../server/seed.ts";
import { createApp } from "../server/app.ts";
import {
  initialSalesDefaults,
  salesDefaults,
  termDueDate,
  resolvedDefaults,
  defaultDetails,
  updateDefaultDetails,
  replaceDefault,
} from "../shared/document-defaults.ts";
import { documentDetails } from "../shared/documents.ts";

test("payment term library validates rules, resolves legacy/customer precedence and calendar boundaries", () => {
  const settings = initialSalesDefaults();
  settings.default_term_id = "month-end";
  settings.quote_valid_days = 15;
  settings.quote_notes = "Entity quote note";
  settings.payment_instructions = "Entity instructions";
  assert.equal(
    termDueDate("2028-02-03", { kind: "end-month", days: 0 }),
    "2028-02-29",
  );
  assert.equal(
    termDueDate("2026-02-28", { kind: "end-month", days: 0 }),
    "2026-02-28",
  );
  assert.equal(
    termDueDate("2026-12-20", { kind: "days", days: 15 }),
    "2027-01-04",
  );
  assert.equal(
    termDueDate("2026-12-20", { kind: "days", days: 0 }),
    "2026-12-20",
  );
  assert.equal(termDueDate("", { kind: "days", days: 15 }), "");
  const defaults = resolvedDefaults(settings, "quote", "2026-12-20");
  assert.equal(defaults.term.kind, "end-month");
  assert.equal(defaults.valid_until, "2027-01-04");
  const legacy = resolvedDefaults(settings, "invoice", "2026-12-20", {
    payment_days: 7,
  });
  assert.equal(legacy.term.days, 7);
  const inherit = resolvedDefaults(settings, "quote", "2026-12-20", {
    payment_days: 7,
    payment_terms_mode: "entity",
    document_notes: "Customer note",
    payment_instructions: "Customer bank details",
  });
  assert.equal(inherit.term.kind, "end-month");
  assert.equal(inherit.customer_notes, "Customer note");
  assert.equal(inherit.payment_instructions, "Customer bank details");
  assert.equal(
    resolvedDefaults(settings, "invoice", "2026-12-20", {
      payment_terms_mode: "days",
      payment_days: 0,
    }).term.name,
    "Due on receipt",
  );
  assert.equal(
    salesDefaults.safeParse({
      ...settings,
      terms: [...settings.terms, settings.terms[0]],
    }).success,
    false,
  );
  assert.equal(
    salesDefaults.safeParse({ ...settings, default_term_id: "missing" })
      .success,
    false,
  );
  assert.equal(
    salesDefaults.safeParse({
      ...settings,
      terms: [{ id: "eom", name: "Bad", kind: "end-month", days: 1 }],
    }).success,
    false,
  );
});

test("default updates preserve custom wording/clearing, saved rules and reordered JSON keys", () => {
  const before = resolvedDefaults(
    initialSalesDefaults(),
    "quote",
    "2026-10-10",
  );
  const settings = {
    ...initialSalesDefaults(),
    quote_notes: "New note",
    quote_terms: "New terms",
    default_term_id: "net60",
    quote_valid_days: 10,
  };
  const after = resolvedDefaults(settings, "quote", "2026-10-10");
  const current = documentDetails.parse(defaultDetails(before));
  assert.equal(
    updateDefaultDetails(current, before, after).payment_term?.days,
    60,
  );
  current.customer_notes = "My note";
  current.valid_until = "2026-11-01";
  assert.equal(
    updateDefaultDetails(current, before, after).customer_notes,
    "My note",
  );
  assert.equal(
    updateDefaultDetails(current, before, after).valid_until,
    "2026-11-01",
  );
  assert.equal(replaceDefault("", "Default note", "New default"), "");
  assert.equal(
    replaceDefault(
      { days: 30, kind: "days", id: "net30", name: "Net 30" },
      before.term,
      after.term,
    ).days,
    60,
  );
  assert.equal(documentDetails.parse({}).payment_term, null);
});

test("document defaults are audited, retry-safe, versioned, scoped and cannot rewrite saved documents", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  await bindEnvironment(db, "sample");
  const host = "127.0.0.1:4348",
    origin = `http://${host}`,
    app = createApp(db, origin);
  await app.ready();
  t.after(() => app.close());
  const accounts = (
    await app.inject({ url: "/api/demo-accounts", headers: { host } })
  ).json();
  async function login(name: string, organization = "Grid") {
    const a = accounts.find(
      (a: any) => a.name === name && a.organization.startsWith(organization),
    );
    const r = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers: { host, origin },
      payload: { userId: a.user_id, tenantId: a.tenant_id },
    });
    assert.equal(r.statusCode, 200, r.body);
    const cookie = r.headers["set-cookie"]!.toString().split(";")[0];
    const me = (
      await app.inject({ url: "/api/me", headers: { host, cookie } })
    ).json();
    return {
      me,
      call: (url: string, payload?: any) =>
        app.inject({
          method: payload ? "POST" : "GET",
          url,
          headers: { host, origin, cookie, "x-csrf-token": me.csrf },
          payload,
        }),
    };
  }
  async function ok(p: any) {
    const r = await p;
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  }
  const owner = await login("Owner"),
    finance = await login("Accountant"),
    sales = await login("Sales rep");
  const initial = await ok(owner.call("/api/data")),
    entity = initial.entities[0].id;
  const before = JSON.stringify({
    quotes: initial.quotes,
    invoices: initial.invoices,
  });
  const c = {
    action: "settings.sales-defaults",
    entity_id: entity,
    version: 0,
    request_key: uuid(),
    settings: {
      ...initialSalesDefaults(),
      quote_notes: "Shared reusable wording",
      default_term_id: "net45",
    },
  };
  await ok(owner.call("/api/commands", c));
  await ok(owner.call("/api/commands", JSON.parse(JSON.stringify(c))));
  assert.equal(
    (
      await owner.call("/api/commands", {
        ...c,
        settings: { ...c.settings, quote_notes: "Different retry" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await owner.call("/api/commands", { ...c, request_key: uuid() }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await finance.call("/api/commands", {
        ...c,
        version: 1,
        request_key: uuid(),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await sales.call("/api/commands", {
        ...c,
        version: 1,
        request_key: uuid(),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await owner.call("/api/commands", {
        ...c,
        entity_id: uuid(),
        request_key: uuid(),
      })
    ).statusCode,
    404,
  );
  const foreign = (
    await db.query("SELECT id FROM entities WHERE tenant_id<>$1 LIMIT 1", [
      owner.me.organization.id,
    ])
  ).rows[0].id;
  assert.equal(
    (
      await owner.call("/api/commands", {
        ...c,
        entity_id: foreign,
        request_key: uuid(),
      })
    ).statusCode,
    404,
  );
  const updated = await ok(owner.call("/api/data"));
  assert.equal(
    updated.documentDefaults.find((d: any) => d.entity_id === entity).version,
    1,
  );
  assert.equal(
    updated.documentDefaultsHistory.filter((d: any) => d.entity_id === entity)
      .length,
    1,
  );
  assert.equal(
    JSON.stringify({ quotes: updated.quotes, invoices: updated.invoices }),
    before,
  );
  assert.equal(
    (await ok(finance.call("/api/data"))).documentDefaultsHistory.length,
    0,
  );
  const company = await ok(
    owner.call("/api/commands", {
      action: "company.create",
      name: `Default customer ${uuid()}`,
      customer: true,
      vendor: false,
      service_entity_id: null,
    }),
  );
  assert.equal(
    (await ok(owner.call("/api/data"))).companies.find(
      (r: any) => r.id === company.id,
    ).profile.payment_terms_mode,
    "entity",
  );
  // Restrictive entity RLS also applies to the two new settings tables.
  const tenant = owner.me.organization.id;
  const ctx = {
    tenantId: tenant,
    userId: finance.me.user.id,
    role: "finance",
    entityIds: [initial.entities[1].id],
  };
  await inTenant(db, ctx, async (tx) => {
    assert.equal(
      (
        await tx.query("SELECT * FROM document_defaults WHERE entity_id=$1", [
          entity,
        ])
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await tx.query(
          "SELECT * FROM document_defaults_history WHERE entity_id=$1",
          [entity],
        )
      ).rows.length,
      0,
    );
  });
  await assert.rejects(
    db.query(
      "UPDATE document_defaults_history SET actor_name='Changed' WHERE entity_id=$1",
      [entity],
    ),
    /immutable/i,
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM audit_events WHERE action='settings.sales-defaults'",
        )
      ).rows[0].count,
    ),
    1,
  );
  const role = uuid();
  await db.query(
    "INSERT INTO role_profiles(id,tenant_id,name,base_role,capabilities) VALUES($1,$2,'Defaults view only','finance','[\"books.view\"]')",
    [role, tenant],
  );
  await db.query(
    "UPDATE memberships SET role_profile_id=$1 WHERE tenant_id=$2 AND user_id=$3",
    [role, tenant, finance.me.user.id],
  );
  assert.equal(
    (
      await finance.call("/api/commands", {
        ...c,
        version: 1,
        request_key: uuid(),
      })
    ).statusCode,
    403,
  );
});
