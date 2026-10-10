import {
  grantedCapabilities,
  hasCapability,
  type Capability,
} from "../shared/permissions.ts";
import { Problem, type Context } from "./domain.ts";
import type { Row, SQL } from "./db.ts";

export async function currentMemberContext(
  tx: SQL,
  ctx: Context,
  entityId?: string,
): Promise<Context> {
  const m = (
    await tx.query(
      `SELECT m.role,m.role_profile_id,m.entity_ids,p.base_role,p.capabilities FROM memberships m
    LEFT JOIN role_profiles p ON p.tenant_id=m.tenant_id AND p.id=m.role_profile_id
    WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.active`,
      [ctx.tenantId, ctx.userId],
    )
  ).rows[0];
  if (!m || (m.role_profile_id && m.base_role !== m.role))
    throw new Problem(
      403,
      "Active finance access is required to generate drafts.",
    );
  if (entityId && m.entity_ids && !m.entity_ids.includes(entityId))
    throw new Problem(
      403,
      "The schedule creator no longer has access to this legal entity.",
    );
  return {
    ...ctx,
    role: m.role,
    entityIds: m.entity_ids ?? null,
    capabilities: grantedCapabilities({
      role: m.role,
      capabilities: m.role_profile_id ? m.capabilities : undefined,
    }),
  };
}

// Template checks and ownership checks remain in domain services. This second
// gate ensures every command, including future financial commands, respects a
// narrowed profile. Each action requires a capability that every built-in role
// able to perform it already holds, so a full-template profile behaves exactly
// like its built-in role. Unknown actions fail closed to finance permission.
const sales = /^(lead|deal|quote)\.|^profile\.(lead|deal)$|^crm\.lead-edit$/;
const contacts = /^(company|contact|note|crm|profile)\./;
export function commandCapability(action: string): Capability | Capability[] {
  if (action === "settings.sales-defaults") return "team.manage";
  if (sales.test(action)) return "crm.sales";
  if (contacts.test(action)) return "contacts.manage";
  if (action.startsWith("document.item-")) return ["crm.sales", "books.post"];
  return "books.post";
}
export function requireCommandPermission(ctx: Context, c: Row) {
  if (ctx.capabilities === undefined) return;
  const needed = commandCapability(
    typeof c.action === "string" ? c.action : "",
  );
  if (![needed].flat().some((cap) => hasCapability(ctx, cap)))
    throw new Problem(
      403,
      "Your role does not allow this action. Ask an administrator to review your access.",
    );
}
