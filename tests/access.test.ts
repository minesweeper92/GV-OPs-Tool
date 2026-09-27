import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  migrate,
  verifyMigrations,
  bindEnvironment,
  inTenant,
} from "../server/db.ts";
import { Access } from "../server/access.ts";
import { seed } from "../server/seed.ts";
import { createApp } from "../server/app.ts";

test("organization and team access boundaries", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  await bindEnvironment(db, "sample");
  const access = new Access(db, "sample");
  const accounts = (
    await db.query(
      "SELECT m.*,u.email,t.name AS organization FROM memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id",
    )
  ).rows;
  const owner = accounts.find(
    (a) => a.role === "admin" && a.organization.startsWith("Grid"),
  )!;
  const sales = accounts.find((a) => a.role === "sales")!;
  const second = accounts.find((a) => a.organization.startsWith("Separate"))!;
  async function session(userId: string, tenantId: string | null) {
    const issued = await access.issue(userId, tenantId);
    return { ...issued, s: await access.read(issued.raw) };
  }
  const admin = await session(owner.user_id, owner.tenant_id),
    rep = await session(sales.user_id, sales.tenant_id);
  await t.test(
    "only admins manage teams; no cross-tenant escalation; last admin preserved",
    async () => {
      await assert.rejects(() => access.team(rep.s), /administrator/);
      await assert.rejects(
        () =>
          access.invite(rep.s, { email: "new@example.test", role: "admin" }),
        /administrator/,
      );
      await assert.rejects(
        () =>
          access.updateMember(admin.s, {
            userId: owner.user_id,
            role: "viewer",
            active: true,
            version: 1,
          }),
        /at least one/,
      );
      await assert.rejects(
        () =>
          access.updateMember(admin.s, {
            userId: owner.user_id,
            role: "admin",
            active: false,
            version: 1,
          }),
        /at least one/,
      );
      await assert.rejects(
        () => access.switchOrganization(rep.s, second.tenant_id),
        /do not have access/,
      );
      await assert.rejects(
        () =>
          access.updateMember(admin.s, {
            userId: uuid(),
            role: "admin",
            active: true,
            version: 1,
          }),
        /not found/,
      );
      const invite = await access.invite(admin.s, {
        email: "unrelated@example.test",
        role: "viewer",
      });
      assert.equal(
        (
          await inTenant(db, second.tenant_id, (tx) =>
            tx.query("SELECT id FROM invitations WHERE id=$1", [invite.id]),
          )
        ).rows.length,
        0,
      );
    },
  );
  await t.test(
    "revocation ends sessions; stale writes conflict; restoration requires fresh login",
    async () => {
      await access.updateMember(admin.s, {
        userId: sales.user_id,
        role: "sales",
        active: false,
        version: 1,
      });
      await assert.rejects(() => access.read(rep.raw), /session ended/);
      await assert.rejects(
        () => access.issue(sales.user_id, sales.tenant_id),
        /do not have access/,
      );
      await assert.rejects(
        () =>
          access.updateMember(admin.s, {
            userId: sales.user_id,
            role: "admin",
            active: true,
            version: 1,
          }),
        /changed since/,
      );
      await access.updateMember(admin.s, {
        userId: sales.user_id,
        role: "sales",
        active: true,
        version: 2,
      });
      await assert.rejects(() => access.read(rep.raw), /session ended/);
    },
  );
  await t.test(
    "invitation is email-bound, one-time, revocable and expiring",
    async () => {
      const userId = uuid();
      await db.query("INSERT INTO users VALUES($1,$2,$3)", [
        userId,
        "New teammate",
        "teammate@example.test",
      ]);
      const newcomer = await session(userId, null);
      const invite = await access.invite(admin.s, {
        email: "Teammate@example.test",
        role: "finance",
      });
      await assert.rejects(
        () => access.accept(admin.s, invite.id),
        /another verified email/,
      );
      assert.equal(
        (await access.organizations(newcomer.s)).invitations[0].id,
        invite.id,
      );
      await access.revokeInvite(admin.s, invite.id);
      await assert.rejects(
        () => access.accept(newcomer.s, invite.id),
        /revoked/,
      );
      const expired = await access.invite(admin.s, {
        email: "teammate@example.test",
        role: "finance",
      });
      await db.query(
        "UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1",
        [expired.id],
      );
      await assert.rejects(
        () => access.accept(newcomer.s, expired.id),
        /expired/,
      );
      const replacement = await access.invite(admin.s, {
        email: "teammate@example.test",
        role: "finance",
      });
      assert.equal(
        (await access.accept(newcomer.s, replacement.id)).id,
        owner.tenant_id,
      );
      await assert.rejects(
        () => access.accept(newcomer.s, replacement.id),
        /already used/,
      );
      const joined = await access.switchOrganization(
        newcomer.s,
        owner.tenant_id,
      );
      assert.equal((await access.read(joined.raw)).role, "finance");
    },
  );
  await t.test(
    "switch rotates session and CSRF; onboarding creation is idempotent",
    async () => {
      const body = {
        name: "New organization",
        entityName: "New legal entity",
        entityCode: "NEW",
        requestKey: uuid(),
      };
      const created = await access.createOrganization(admin.s, body);
      assert.deepEqual(await access.createOrganization(admin.s, body), created);
      await assert.rejects(
        () =>
          access.createOrganization(admin.s, { ...body, name: "Different" }),
        /retry key/,
      );
      assert.equal(
        (
          await db.query("SELECT id FROM entities WHERE tenant_id=$1", [
            created.id,
          ])
        ).rows.length,
        1,
      );
      assert.ok(
        (
          await db.query("SELECT code FROM accounts WHERE tenant_id=$1", [
            created.id,
          ])
        ).rows.length > 0,
      );
      const switched = await access.switchOrganization(admin.s, created.id);
      assert.notEqual(switched.csrf, admin.csrf);
      await assert.rejects(() => access.read(admin.raw), /session ended/);
      assert.equal((await access.read(switched.raw)).tenantId, created.id);
      const app = createApp(db, "http://127.0.0.1:4320");
      await app.ready();
      try {
        const headers = {
          host: "127.0.0.1:4320",
          origin: "http://127.0.0.1:4320",
          cookie: `gv_workspace_session=${switched.raw}`,
          "x-csrf-token": admin.csrf,
        };
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/api/organizations/switch",
              headers,
              payload: { id: owner.tenant_id },
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/api/team/member",
              headers: { ...headers, "x-csrf-token": "é".repeat(43) },
              payload: {},
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              url: "/api/demo-accounts/unsafe",
              headers: { host: "127.0.0.1:4320" },
            })
          ).statusCode,
          401,
        );
      } finally {
        await app.close();
      }
    },
  );
  await assert.rejects(() => bindEnvironment(db, "oidc"), /separate/);
});

test("persistent database restarts with migrations and environment intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gv-workspace-test-")),
    path = join(directory, "nested", "database");
  let db = await openDatabase(path);
  try {
    await migrate(db);
    await bindEnvironment(db, "sample");
    await seed(db);
  } finally {
    await db.close();
  }
  db = await openDatabase(path);
  try {
    await migrate(db);
    await verifyMigrations(db);
    await bindEnvironment(db, "sample");
    assert.equal((await db.query("SELECT * FROM tenants")).rows.length, 2);
    await assert.rejects(() => bindEnvironment(db, "oidc"), /separate/);
  } finally {
    await db.close();
  }
});
