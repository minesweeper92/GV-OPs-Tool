import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, bindEnvironment } from "../server/db.ts";
import { Access } from "../server/access.ts";
import { seed } from "../server/seed.ts";
import { Problem, type Context } from "../server/domain.ts";
import { requireCommandPermission } from "../server/permission-checks.ts";
import { hasCapability, grantedCapabilities } from "../shared/permissions.ts";
import { executePurchaseOrder } from "../server/purchase-orders.ts";
import type { SQL } from "../server/db.ts";

const forbidden = (e: unknown) => e instanceof Problem && e.status === 403;

test("custom profiles narrow but never broaden their template", () => {
  const narrowed = { role: "finance", capabilities: ["books.view"] };
  assert.equal(hasCapability(narrowed, "books.view"), true);
  assert.equal(hasCapability(narrowed, "books.post"), false);
  // A stored grant outside the template is ignored rather than trusted.
  assert.equal(
    hasCapability(
      { role: "viewer", capabilities: ["books.post"] },
      "books.post",
    ),
    false,
  );
  assert.deepEqual(
    grantedCapabilities({ role: "sales", capabilities: [] }),
    [],
  );
  assert.deepEqual(grantedCapabilities("finance"), [
    "books.view",
    "books.post",
    "contacts.manage",
  ]);
});

test("command gate fails closed for narrowed profiles", async () => {
  const ctx = (capabilities: string[]): Context =>
    ({ tenantId: "t", userId: "u", role: "finance", capabilities }) as Context;
  const viewOnly = ctx(["books.view", "contacts.manage"]);
  for (const action of ["bill.create", "bank.match", "unknown.action", ""])
    assert.throws(
      () => requireCommandPermission(viewOnly, { action }),
      forbidden,
    );
  requireCommandPermission(viewOnly, { action: "contact.create" });
  // Finance can already follow up tasks on deals; only sales edits are gated.
  requireCommandPermission(viewOnly, {
    action: "crm.task",
    record_type: "deal",
  });
  for (const action of ["crm.lead-edit", "profile.deal", "quote.create"])
    assert.throws(
      () => requireCommandPermission(viewOnly, { action }),
      forbidden,
    );
  const noContacts = ctx(["books.view", "books.post"]);
  assert.throws(
    () => requireCommandPermission(noContacts, { action: "crm.task" }),
    forbidden,
  );
  requireCommandPermission(noContacts, { action: "document.item-save" });
  // Built-in roles without a profile are left to the module guards.
  requireCommandPermission(
    { tenantId: "t", userId: "u", role: "viewer" },
    { action: "bill.create" },
  );
  // Module guards see the narrowed profile before touching the database.
  let queries = 0;
  const tx = { query: async () => (queries++, { rows: [] }) } as unknown as SQL;
  await assert.rejects(
    executePurchaseOrder(tx, viewOnly, { action: "purchase-order.create" }),
    forbidden,
  );
  assert.equal(queries, 0);
});

test("administrators manage tenant-scoped custom roles", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  await bindEnvironment(db, "sample");
  const access = new Access(db, "sample");
  const accounts = (
    await db.query(
      "SELECT m.*,t.name AS organization FROM memberships m JOIN tenants t ON t.id=m.tenant_id",
    )
  ).rows;
  const owner = accounts.find(
    (a) => a.role === "admin" && a.organization.startsWith("Grid"),
  )!;
  const finance = accounts.find(
    (a) => a.role === "finance" && a.tenant_id === owner.tenant_id,
  )!;
  const sales = accounts.find(
    (a) => a.role === "sales" && a.tenant_id === owner.tenant_id,
  )!;
  const other = accounts.find(
    (a) => a.role === "admin" && !a.organization.startsWith("Grid"),
  )!;
  const session = async (userId: string, tenantId: string) => {
    const issued = await access.issue(userId, tenantId);
    return { raw: issued.raw, s: await access.read(issued.raw) };
  };
  const admin = await session(owner.user_id, owner.tenant_id);

  await assert.rejects(
    access.saveProfile((await session(sales.user_id, sales.tenant_id)).s, {
      name: "Rep",
      baseRole: "sales",
      capabilities: [],
    }),
    /administrator/,
  );
  await assert.rejects(
    access.saveProfile(admin.s, {
      name: "Escalate",
      baseRole: "viewer",
      capabilities: ["books.post"],
    }),
    /cannot exceed/,
  );
  await assert.rejects(
    access.saveProfile(admin.s, {
      name: "Poster",
      baseRole: "finance",
      capabilities: ["books.post"],
    }),
    /viewing accounting/,
  );
  const { id } = await access.saveProfile(admin.s, {
    name: "Auditor",
    baseRole: "finance",
    capabilities: ["books.view", "contacts.manage"],
  });
  await assert.rejects(
    access.saveProfile(admin.s, {
      name: "auditor",
      baseRole: "finance",
      capabilities: [],
    }),
    /already exists/,
  );

  // Profiles must match the template and belong to the same organization.
  await assert.rejects(
    access.updateMember(admin.s, {
      userId: sales.user_id,
      role: "sales",
      active: true,
      version: sales.version,
      roleProfileId: id,
    }),
    /matching template/,
  );
  const otherAdmin = await session(other.user_id, other.tenant_id);
  await assert.rejects(
    access.invite(otherAdmin.s, {
      email: "x@example.test",
      role: "finance",
      roleProfileId: id,
    }),
    /matching template/,
  );

  const before = await session(finance.user_id, finance.tenant_id);
  await access.updateMember(admin.s, {
    userId: finance.user_id,
    role: "finance",
    active: true,
    version: finance.version,
    roleProfileId: id,
  });
  await assert.rejects(access.read(before.raw), /Sign in again/);
  const narrowed = await session(finance.user_id, finance.tenant_id);
  assert.deepEqual(narrowed.s.capabilities, ["books.view", "contacts.manage"]);
  assert.equal(narrowed.s.roleName, "Auditor");
  assert.throws(
    () =>
      requireCommandPermission(access.context(narrowed.s), {
        action: "bill.create",
      }),
    forbidden,
  );

  // An unrelated edit from an older client keeps the profile.
  const version = (await access.team(admin.s)).members.find(
    (m) => m.id === finance.user_id,
  )!.version;
  await access.updateMember(admin.s, {
    userId: finance.user_id,
    role: "finance",
    active: true,
    version,
  });
  const kept = (await access.team(admin.s)).members.find(
    (m) => m.id === finance.user_id,
  )!;
  assert.equal(kept.role_profile_id, id);

  // Editing the role signs out its members and applies on next sign-in.
  const current = await session(finance.user_id, finance.tenant_id);
  await assert.rejects(
    access.saveProfile(admin.s, {
      id,
      version: 9,
      name: "Auditor",
      baseRole: "finance",
      capabilities: [],
    }),
    /changed/,
  );
  await assert.rejects(
    access.saveProfile(admin.s, {
      id,
      version: 1,
      name: "Auditor",
      baseRole: "sales",
      capabilities: [],
    }),
    /template cannot change/,
  );
  await access.saveProfile(admin.s, {
    id,
    version: 1,
    name: "Auditor",
    baseRole: "finance",
    capabilities: ["books.view"],
  });
  await assert.rejects(access.read(current.raw), /Sign in again/);
  assert.deepEqual(
    (await session(finance.user_id, finance.tenant_id)).s.capabilities,
    ["books.view"],
  );

  const events = (
    await db.query(
      "SELECT action FROM audit_events WHERE tenant_id=$1 AND action LIKE 'team.role-%' ORDER BY created_at",
      [owner.tenant_id],
    )
  ).rows.map((r) => r.action);
  assert.deepEqual(events, ["team.role-created", "team.role-updated"]);
});
