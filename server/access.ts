import { createHash, randomBytes, randomUUID as uuid } from "node:crypto";
import type { Database, SQL } from "./db.ts";
import { Problem, audit, seedAccounts, type Context } from "./domain.ts";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export type Mode = "sample" | "oidc";
export interface Session {
  hash: string;
  userId: string;
  tenantId: string | null;
  role: Context["role"] | null;
  name: string;
  email: string;
  organization: string | null;
  csrf: string;
}
async function admin(tx: SQL, s: Session) {
  if (!s.tenantId)
    throw new Problem(403, "Create or join an organization first.");
  // Serialize administrator changes per organization to protect its last admin.
  await tx.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [s.tenantId]);
  const m = (
    await tx.query(
      "SELECT role,active FROM memberships WHERE tenant_id=$1 AND user_id=$2",
      [s.tenantId, s.userId],
    )
  ).rows[0];
  if (!m?.active || m.role !== "admin")
    throw new Problem(
      403,
      "Only an active organization administrator can manage team access.",
    );
  return { tenantId: s.tenantId, userId: s.userId, role: "admin" } as Context;
}
export class Access {
  constructor(
    readonly db: Database,
    readonly mode: Mode,
  ) {}
  async read(raw: string | undefined): Promise<Session> {
    if (!raw || raw.length > 128)
      throw new Problem(401, "Sign in to continue.");
    const r = (
      await this.db.query(
        `SELECT s.*,u.name,u.email,t.name AS organization,m.role,m.active FROM sessions s
   JOIN users u ON u.id=s.user_id LEFT JOIN tenants t ON t.id=s.tenant_id
   LEFT JOIN memberships m ON m.user_id=s.user_id AND m.tenant_id=s.tenant_id
   WHERE s.hash=$1 AND s.auth_kind=$2 AND s.expires_at>now()`,
        [hash(raw), this.mode],
      )
    ).rows[0];
    if (!r || (r.tenant_id && !r.active))
      throw new Problem(
        401,
        "Your session ended or access changed. Sign in again.",
      );
    return {
      hash: r.hash,
      userId: r.user_id,
      tenantId: r.tenant_id,
      role: r.role,
      name: r.name,
      email: r.email,
      organization: r.organization,
      csrf: r.csrf,
    };
  }
  async issue(userId: string, tenantId: string | null, previousHash?: string) {
    return this.db.transaction((tx) =>
      this.issueIn(tx, userId, tenantId, previousHash),
    );
  }
  private async issueIn(
    tx: SQL,
    userId: string,
    tenantId: string | null,
    previousHash?: string,
  ) {
    if (
      tenantId &&
      !(
        await tx.query(
          "SELECT user_id FROM memberships WHERE user_id=$1 AND tenant_id=$2 AND active=true",
          [userId, tenantId],
        )
      ).rows.length
    )
      throw new Problem(403, "You do not have access to that organization.");
    const raw = token(),
      csrf = token();
    if (previousHash)
      await tx.query("DELETE FROM sessions WHERE hash=$1", [previousHash]);
    await tx.query("DELETE FROM sessions WHERE expires_at<now()");
    await tx.query(
      "INSERT INTO sessions(hash,user_id,tenant_id,csrf,auth_kind,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '8 hours')",
      [hash(raw), userId, tenantId, csrf, this.mode],
    );
    return { raw, csrf };
  }
  context(s: Session): Context {
    if (!s.tenantId || !s.role)
      throw new Problem(403, "Create or join an organization first.");
    return {
      tenantId: s.tenantId,
      userId: s.userId,
      role: s.role,
      name: s.name,
    };
  }
  async organizations(s: Session) {
    const organizations = (
      await this.db.query(
        "SELECT t.id,t.name,m.role FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=$1 AND m.active=true ORDER BY t.name",
        [s.userId],
      )
    ).rows;
    const invitations = (
      await this.db.query(
        `SELECT i.id,t.name AS organization,i.role,i.expires_at FROM invitations i JOIN tenants t ON t.id=i.tenant_id
    WHERE lower(i.email)=lower($1) AND i.accepted_by IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()`,
        [s.email],
      )
    ).rows;
    return { organizations, invitations };
  }
  async createOrganization(
    s: Session,
    b: {
      name: string;
      entityName: string;
      entityCode: string;
      requestKey: string;
    },
  ) {
    return this.db.transaction(async (tx) => {
      // Per-user lock serializes duplicate onboarding retries.
      await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [s.userId]);
      const old = (
        await tx.query(
          "SELECT tenant_id,payload FROM organization_requests WHERE user_id=$1 AND request_key=$2",
          [s.userId, b.requestKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.payload.name !== b.name ||
          old.payload.entityName !== b.entityName ||
          old.payload.entityCode !== b.entityCode
        )
          throw new Problem(
            409,
            "This retry key already created a different organization.",
          );
        return { id: old.tenant_id };
      }
      const tenantId = uuid(),
        entityId = uuid(),
        ctx: Context = { tenantId, userId: s.userId, role: "admin" };
      await tx.query("INSERT INTO tenants(id,name) VALUES($1,$2)", [
        tenantId,
        b.name,
      ]);
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",
        [tenantId, s.userId],
      );
      await tx.query(
        "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,$3,$4)",
        [entityId, tenantId, b.entityName, b.entityCode],
      );
      await seedAccounts(tx, tenantId, entityId);
      await audit(tx, ctx, tenantId, "organization.created", {
        name: b.name,
        entityName: b.entityName,
        baseCurrency: "PKR",
      });
      await tx.query(
        "INSERT INTO organization_requests(user_id,request_key,tenant_id,payload) VALUES($1,$2,$3,$4)",
        [s.userId, b.requestKey, tenantId, JSON.stringify(b)],
      );
      return { id: tenantId };
    });
  }
  async switchOrganization(s: Session, id: string) {
    return this.db.transaction(async (tx) => {
      const issued = await this.issueIn(tx, s.userId, id, s.hash);
      await audit(
        tx,
        { tenantId: id, userId: s.userId, role: s.role || "viewer" },
        id,
        "organization.switched",
        {},
      );
      return issued;
    });
  }
  async team(s: Session) {
    return this.db.transaction(async (tx) => {
      const ctx = await admin(tx, s);
      const members = (
        await tx.query(
          "SELECT u.id,u.name,u.email,m.role,m.active,m.version FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.name",
          [ctx.tenantId],
        )
      ).rows;
      const invitations = (
        await tx.query(
          "SELECT id,email,role,expires_at,accepted_by,revoked_at FROM invitations WHERE tenant_id=$1 ORDER BY created_at DESC",
          [ctx.tenantId],
        )
      ).rows;
      return { members, invitations };
    });
  }
  async invite(s: Session, b: { email: string; role: Context["role"] }) {
    return this.db.transaction(async (tx) => {
      const ctx = await admin(tx, s),
        email = b.email.toLowerCase();
      if (
        (
          await tx.query(
            "SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND lower(u.email)=$2",
            [ctx.tenantId, email],
          )
        ).rows.length
      )
        throw new Problem(
          409,
          "This person already has a membership. Update their access instead.",
        );
      await tx.query(
        "UPDATE invitations SET revoked_at=now() WHERE tenant_id=$1 AND lower(email)=$2 AND accepted_by IS NULL AND revoked_at IS NULL",
        [ctx.tenantId, email],
      );
      const id = uuid();
      await tx.query(
        "INSERT INTO invitations(id,tenant_id,email,role,created_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')",
        [id, ctx.tenantId, email, b.role, ctx.userId],
      );
      await audit(tx, ctx, id, "team.invited", {
        email,
        role: b.role,
        text: `${s.name} invited ${email} as ${b.role}.`,
      });
      return { id };
    });
  }
  async revokeInvite(s: Session, id: string) {
    return this.db.transaction(async (tx) => {
      const ctx = await admin(tx, s);
      const row = (
        await tx.query(
          "UPDATE invitations SET revoked_at=now() WHERE tenant_id=$1 AND id=$2 AND accepted_by IS NULL AND revoked_at IS NULL RETURNING id",
          [ctx.tenantId, id],
        )
      ).rows[0];
      if (!row) throw new Problem(404, "Pending invitation not found.");
      await audit(tx, ctx, id, "team.invitation-revoked", {});
      return { ok: true };
    });
  }
  async accept(s: Session, id: string) {
    return this.db.transaction(async (tx) => {
      const invite = (
        await tx.query(
          "SELECT * FROM invitations WHERE id=$1 AND lower(email)=lower($2) AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
          [id, s.email],
        )
      ).rows[0];
      if (!invite)
        throw new Problem(
          403,
          "This invitation is expired, revoked, already used, or addressed to another verified email.",
        );
      if (
        (
          await tx.query(
            "SELECT user_id FROM memberships WHERE tenant_id=$1 AND user_id=$2",
            [invite.tenant_id, s.userId],
          )
        ).rows.length
      )
        throw new Problem(
          409,
          "Membership already exists. Ask an administrator to change your access.",
        );
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [invite.tenant_id, s.userId, invite.role],
      );
      await tx.query("UPDATE invitations SET accepted_by=$2 WHERE id=$1", [
        id,
        s.userId,
      ]);
      await audit(
        tx,
        { tenantId: invite.tenant_id, userId: s.userId, role: invite.role },
        id,
        "team.invitation-accepted",
        {},
      );
      return { id: invite.tenant_id };
    });
  }
  async updateMember(
    s: Session,
    b: {
      userId: string;
      role: Context["role"];
      active: boolean;
      version: number;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const ctx = await admin(tx, s);
      const before = (
        await tx.query(
          "SELECT role,active,version FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
          [ctx.tenantId, b.userId],
        )
      ).rows[0];
      if (!before)
        throw new Problem(404, "Member not found in this organization.");
      if (before.version !== b.version)
        throw new Problem(
          409,
          "Access changed since you opened this page. Refresh and try again.",
        );
      if (
        before.role === "admin" &&
        before.active &&
        (b.role !== "admin" || !b.active)
      ) {
        const count = (
          await tx.query(
            "SELECT count(*)::int AS n FROM memberships WHERE tenant_id=$1 AND role='admin' AND active=true",
            [ctx.tenantId],
          )
        ).rows[0].n;
        if (count <= 1)
          throw new Problem(
            409,
            "Keep at least one active administrator. Add another administrator first.",
          );
      }
      await tx.query(
        "UPDATE memberships SET role=$3,active=$4,version=version+1 WHERE tenant_id=$1 AND user_id=$2",
        [ctx.tenantId, b.userId, b.role, b.active],
      );
      await tx.query("DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2", [
        ctx.tenantId,
        b.userId,
      ]);
      const person = (
        await tx.query("SELECT name FROM users WHERE id=$1", [b.userId])
      ).rows[0];
      await audit(tx, ctx, b.userId, "team.access-changed", {
        before,
        after: { role: b.role, active: b.active },
        text: `${s.name} changed ${person.name}: ${before.role} (${before.active ? "active" : "removed"}) → ${b.role} (${b.active ? "active" : "removed"}).`,
      });
      return { ok: true, self: b.userId === s.userId };
    });
  }
  async identity(
    issuer: string,
    claims: { sub: string; email: string; name: string },
  ) {
    return this.db.transaction(async (tx) => {
      const prior = (
        await tx.query(
          "SELECT user_id FROM identities WHERE issuer=$1 AND subject=$2",
          [issuer, claims.sub],
        )
      ).rows[0];
      const userId = prior?.user_id || uuid();
      if (prior) {
        const old = (
          await tx.query("SELECT email FROM users WHERE id=$1 FOR UPDATE", [
            userId,
          ])
        ).rows[0];
        if (old.email.toLowerCase() !== claims.email.toLowerCase())
          await tx.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
        await tx.query("UPDATE users SET name=$2,email=$3 WHERE id=$1", [
          userId,
          claims.name,
          claims.email.toLowerCase(),
        ]);
      } else {
        if (
          (
            await tx.query(
              "SELECT id FROM users WHERE lower(email)=lower($1)",
              [claims.email],
            )
          ).rows.length
        )
          throw new Problem(
            409,
            "This email belongs to an existing identity. Automatic account linking is disabled.",
          );
        await tx.query("INSERT INTO users(id,name,email) VALUES($1,$2,$3)", [
          userId,
          claims.name,
          claims.email.toLowerCase(),
        ]);
        await tx.query(
          "INSERT INTO identities(issuer,subject,user_id) VALUES($1,$2,$3)",
          [issuer, claims.sub, userId],
        );
      }
      const member = (
        await tx.query(
          "SELECT tenant_id FROM memberships WHERE user_id=$1 AND active=true ORDER BY tenant_id LIMIT 1",
          [userId],
        )
      ).rows[0];
      return { userId, tenantId: member?.tenant_id || null };
    });
  }
}
