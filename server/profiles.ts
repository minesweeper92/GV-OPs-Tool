import type { SQL, Row } from "./db.ts";
import { execute, audit, Problem, type Context } from "./domain.ts";
import { executeCrm } from "./crm.ts";
import { commandSchema } from "../shared/commands.ts";
import { requireCommandPermission } from "./permission-checks.ts";

const tables: Record<string, string> = {
  contact: "contacts",
  company: "companies",
  lead: "leads",
  deal: "deals",
};
async function linked(tx: SQL, ctx: Context, table: string, id: string) {
  const r = (await tx.query(`SELECT * FROM ${table} WHERE id=$1`, [id]))
    .rows[0];
  if (!r || (ctx.role === "sales" && r.owner_id !== ctx.userId))
    throw new Problem(404, "Linked record is unavailable in your workspace.");
  return r;
}
export async function executeProfile(tx: SQL, ctx: Context, c: Row) {
  requireCommandPermission(ctx, c);
  if (ctx.role === "viewer")
    throw new Problem(403, "Read-only users cannot edit profiles.");
  const kind = c.action.split(".")[1],
    table = tables[kind];
  if (!table) throw new Problem(400, "Unsupported profile.");
  if (["lead", "deal"].includes(kind) && ctx.role === "finance")
    throw new Problem(403, "A sales role is required.");
  let existing: Row | undefined;
  if (c.id) {
    existing = (
      await tx.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [c.id])
    ).rows[0];
    if (!existing || (ctx.role === "sales" && existing.owner_id !== ctx.userId))
      throw new Problem(404, "Record unavailable.");
    if (existing.version !== c.version)
      throw new Problem(409, "This record changed. Refresh before editing.");
    if (
      kind === "lead" &&
      ["company_id", "contact_id", "entity_id"].some(
        (k) => c[k] !== existing![k],
      )
    )
      throw new Problem(
        409,
        "Lead relationships cannot be replaced through a profile edit.",
      );
  }
  const member = (
    await tx.query("SELECT role FROM memberships WHERE user_id=$1 AND active", [
      c.owner_id,
    ])
  ).rows[0];
  if (
    !member ||
    member.role === "viewer" ||
    (["lead", "deal"].includes(kind) && member.role === "finance")
  )
    throw new Problem(400, "Choose an active owner with the appropriate role.");
  if (ctx.role !== "admin" && c.owner_id !== (existing?.owner_id || ctx.userId))
    throw new Problem(403, "Only an administrator can reassign ownership.");
  if (c.company_id) await linked(tx, ctx, "companies", c.company_id);
  if (c.contact_id) await linked(tx, ctx, "contacts", c.contact_id);
  if (c.profile.end_client_id)
    await linked(tx, ctx, "companies", c.profile.end_client_id);
  const stakeholderIds = new Set<string>();
  for (const stakeholder of c.profile.stakeholders || []) {
    if (stakeholderIds.has(stakeholder.contact_id))
      throw new Problem(400, "List each stakeholder once.");
    stakeholderIds.add(stakeholder.contact_id);
    await linked(tx, ctx, "contacts", stakeholder.contact_id);
  }
  if (c.profile.parent_company_id) {
    const visited = new Set([c.id]);
    let parent: string | null = c.profile.parent_company_id;
    while (parent) {
      if (visited.has(parent))
        throw new Problem(400, "A company hierarchy cannot contain a cycle.");
      visited.add(parent);
      const p = await linked(tx, ctx, "companies", parent);
      parent = p.profile?.parent_company_id || null;
    }
  }
  const registrations = new Set();
  for (const r of c.profile.registrations || []) {
    if (registrations.has(r.entity_id))
      throw new Problem(400, "Use one registration per legal entity.");
    registrations.add(r.entity_id);
    if (
      !(await tx.query("SELECT id FROM entities WHERE id=$1", [r.entity_id]))
        .rows.length
    )
      throw new Problem(404, "Registration entity unavailable.");
  }
  let id = c.id;
  if (!id) {
    const action = `${kind}.create`;
    const base: Row =
      kind === "contact"
        ? {
            action,
            first_name: c.first_name,
            last_name: c.last_name,
            email: c.email,
            phone: c.phone,
            title: c.title,
            source: c.source,
            notes: c.notes,
            company_id: c.company_id,
            role: c.role || "Contact",
          }
        : kind === "company"
          ? {
              action,
              name: c.name,
              domain: c.domain,
              industry: c.industry,
              tax_id: c.tax_id,
              address: c.address,
              customer: c.customer,
              vendor: c.vendor,
              service_entity_id: c.service_entity_id,
            }
          : {
              action,
              title: c.title,
              source: c.source,
              company_id: c.company_id,
              contact_id: c.contact_id,
              entity_id: c.entity_id,
              next_action: c.next_action || "Review enquiry",
              due_date: c.due_date || new Date().toISOString().slice(0, 10),
            };
    id = (await execute(tx, ctx, commandSchema.parse(base))).id;
  }
  if (kind === "deal") {
    await tx.query("UPDATE deals SET name=$2 WHERE id=$1", [id, c.name]);
  } else {
    const base: Row = {
      ...c,
      action: `crm.${kind}-edit`,
      id,
      version: existing?.version || 1,
    };
    delete base.profile;
    delete base.owner_id;
    delete base.company_id;
    delete base.contact_id;
    delete base.entity_id;
    if (kind === "contact") delete base.role;
    await executeCrm(tx, ctx, commandSchema.parse(base));
  }
  await tx.query(`UPDATE ${table} SET profile=$2,owner_id=$3 WHERE id=$1`, [
    id,
    JSON.stringify(c.profile),
    c.owner_id,
  ]);
  await audit(tx, ctx, id, c.action, {
    profile: c.profile,
    owner_id: c.owner_id,
  });
  return { id };
}
