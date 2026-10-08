import { createHash, randomBytes, randomUUID as uuid } from "node:crypto";
import type { Database, SQL } from "./db.ts";
import { Problem, audit, seedAccounts, type Context } from "./domain.ts";
import {
  grantedCapabilities,
  hasCapability,
  type Capability,
  type BuiltInRole,
} from "../shared/permissions.ts";
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
  capabilities?: Capability[];
  roleProfileId?: string | null;
  roleName?: string | null;
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
        `SELECT s.*,u.name,u.email,t.name AS organization,m.role,m.active,m.role_profile_id,p.name AS role_name,p.base_role,p.capabilities AS selected_capabilities FROM sessions s
   JOIN users u ON u.id=s.user_id LEFT JOIN tenants t ON t.id=s.tenant_id
   LEFT JOIN memberships m ON m.user_id=s.user_id AND m.tenant_id=s.tenant_id
   LEFT JOIN role_profiles p ON p.id=m.role_profile_id AND p.tenant_id=m.tenant_id
   WHERE s.hash=$1 AND s.auth_kind=$2 AND s.expires_at>now()`,
        [hash(raw), this.mode],
      )
    ).rows[0];
    if (
      !r ||
      (r.tenant_id &&
        (!r.active || (r.role_profile_id && r.base_role !== r.role)))
    )
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
      capabilities: grantedCapabilities({
        role: r.role,
        capabilities: r.role_profile_id ? r.selected_capabilities : undefined,
      }),
      roleProfileId: r.role_profile_id,
      roleName: r.role_name,
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
      capabilities: s.capabilities,
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
          "SELECT u.id,u.name,u.email,m.role,m.active,m.version,m.role_profile_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.name",
          [ctx.tenantId],
        )
      ).rows;
      const invitations = (
        await tx.query(
          "SELECT id,email,role,role_profile_id,expires_at,accepted_by,revoked_at FROM invitations WHERE tenant_id=$1 ORDER BY created_at DESC",
          [ctx.tenantId],
        )
      ).rows;
      const profiles = (
        await tx.query(
          "SELECT id,name,base_role,capabilities,version FROM role_profiles WHERE tenant_id=$1 ORDER BY name",
          [ctx.tenantId],
        )
      ).rows;
      return { members, invitations, profiles };
    });
  }
  async invite(
    s: Session,
    b: { email: string; role: Context["role"]; roleProfileId?: string | null },
  ) {
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
      await this.validateProfile(tx, ctx.tenantId, b.role, b.roleProfileId);
      await tx.query(
        "INSERT INTO invitations(id,tenant_id,email,role,created_by,expires_at,role_profile_id) VALUES($1,$2,$3,$4,$5,now()+interval '7 days',$6)",
        [id, ctx.tenantId, email, b.role, ctx.userId, b.roleProfileId || null],
      );
      await audit(tx, ctx, id, "team.invited", {
        email,
        role: b.role,
        roleProfileId: b.roleProfileId || null,
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
        "INSERT INTO memberships(tenant_id,user_id,role,role_profile_id) VALUES($1,$2,$3,$4)",
        [invite.tenant_id, s.userId, invite.role, invite.role_profile_id],
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
      roleProfileId?: string | null;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const ctx = await admin(tx, s);
      const before = (
        await tx.query(
          "SELECT role,active,version,role_profile_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
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
      // Older clients must not silently remove a profile on an unrelated edit.
      const profileId =
        b.roleProfileId === undefined
          ? before.role_profile_id
          : b.roleProfileId;
      await this.validateProfile(tx, ctx.tenantId, b.role, profileId);
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
        "UPDATE memberships SET role=$3,active=$4,version=version+1,role_profile_id=$5 WHERE tenant_id=$1 AND user_id=$2",
        [ctx.tenantId, b.userId, b.role, b.active, profileId],
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
        after: { role: b.role, active: b.active, role_profile_id: profileId },
        text: `${s.name} changed ${person.name}: ${before.role} (${before.active ? "active" : "removed"}) → ${b.role} (${b.active ? "active" : "removed"}).`,
      });
      return { ok: true, self: b.userId === s.userId };
    });
  }
  private async validateProfile(
    tx: SQL,
    tenantId: string,
    role: string,
    id?: string | null,
  ) {
    if (!id) return;
    const profile = (
      await tx.query(
        "SELECT base_role FROM role_profiles WHERE tenant_id=$1 AND id=$2 FOR SHARE",
        [tenantId, id],
      )
    ).rows[0];
    if (!profile || profile.base_role !== role || role === "admin")
      throw new Problem(
        400,
        "Choose a custom role from this organization with the matching template.",
      );
  }
  async saveProfile(
    s: Session,
    b: {
      id?: string;
      name: string;
      baseRole: Exclude<BuiltInRole, "admin">;
      capabilities: Capability[];
      version?: number;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const ctx = await admin(tx, s);
      const selected = [...new Set(b.capabilities)];
      if (selected.some((cap) => !hasCapability(b.baseRole, cap)))
        throw new Problem(
          400,
          "Custom permissions cannot exceed their role template.",
        );
      if (selected.includes("books.post") && !selected.includes("books.view"))
        throw new Problem(
          400,
          "Recording transactions also requires viewing accounting.",
        );
      if (
        selected.includes("crm.sales") &&
        !selected.includes("contacts.manage")
      )
        throw new Problem(
          400,
          "Managing sales also requires maintaining contacts.",
        );
      const id = b.id || uuid();
      const before = b.id
        ? (
            await tx.query(
              "SELECT * FROM role_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [ctx.tenantId, id],
            )
          ).rows[0]
        : null;
      if (b.id && !before)
        throw new Problem(404, "Custom role not found in this organization.");
      if (before && before.version !== b.version)
        throw new Problem(409, "This role changed. Refresh before saving.");
      if (before && before.base_role !== b.baseRole)
        throw new Problem(
          400,
          "The template cannot change after a role is created. Create another role instead.",
        );
      const duplicate = (
        await tx.query(
          "SELECT id FROM role_profiles WHERE tenant_id=$1 AND lower(name)=lower($2) AND id<>$3",
          [ctx.tenantId, b.name.trim(), id],
        )
      ).rows.length;
      if (duplicate)
        throw new Problem(409, "A custom role with this name already exists.");
      if (before) {
        await tx.query(
          "UPDATE role_profiles SET name=$3,capabilities=$4,version=version+1 WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, id, b.name.trim(), JSON.stringify(selected)],
        );
        await tx.query(
          "UPDATE memberships SET version=version+1 WHERE tenant_id=$1 AND role_profile_id=$2",
          [ctx.tenantId, id],
        );
        await tx.query(
          "DELETE FROM sessions WHERE tenant_id=$1 AND user_id IN (SELECT user_id FROM memberships WHERE tenant_id=$1 AND role_profile_id=$2)",
          [ctx.tenantId, id],
        );
      } else {
        await tx.query(
          "INSERT INTO role_profiles(id,tenant_id,name,base_role,capabilities) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            ctx.tenantId,
            b.name.trim(),
            b.baseRole,
            JSON.stringify(selected),
          ],
        );
      }
      await audit(
        tx,
        ctx,
        id,
        before ? "team.role-updated" : "team.role-created",
        {
          before,
          after: {
            name: b.name.trim(),
            baseRole: b.baseRole,
            capabilities: selected,
          },
        },
      );
      return { id };
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
