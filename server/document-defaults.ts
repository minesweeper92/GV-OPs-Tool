import { randomUUID as uuid } from "node:crypto";
import type { SQL, Row } from "./db.ts";
import { audit, Problem, type Context } from "./domain.ts";

export async function defaultsSnapshot(tx: SQL, ctx: Context) {
  return {
    documentDefaults: (
      await tx.query(
        "SELECT entity_id,version,settings FROM document_defaults ORDER BY entity_id",
      )
    ).rows,
    documentDefaultsHistory:
      ctx.role === "admin"
        ? (
            await tx.query(
              "SELECT entity_id,version,actor_name,created_at FROM document_defaults_history ORDER BY created_at DESC,id DESC LIMIT 100",
            )
          ).rows
        : [],
  };
}
export async function saveDocumentDefaults(tx: SQL, ctx: Context, c: Row) {
  if (ctx.role !== "admin")
    throw new Problem(403, "Only administrators can change document defaults.");
  const entity = (
    await tx.query("SELECT id FROM entities WHERE id=$1 FOR UPDATE", [
      c.entity_id,
    ])
  ).rows[0];
  if (!entity) throw new Problem(404, "Legal entity unavailable.");
  const prior = (
    await tx.query(
      "SELECT * FROM document_defaults_history WHERE request_key=$1",
      [c.request_key],
    )
  ).rows[0];
  if (prior) {
    // PostgreSQL jsonb reorders object keys; compare its canonical representation in SQL.
    const same = (
      await tx.query(
        "SELECT payload=$2::jsonb AS same FROM document_defaults_history WHERE request_key=$1",
        [c.request_key, JSON.stringify(c)],
      )
    ).rows[0]?.same;
    if (!same)
      throw new Problem(409, "This retry key was used for different defaults.");
    return { id: entity.id };
  }
  const old = (
    await tx.query("SELECT * FROM document_defaults WHERE entity_id=$1", [
      c.entity_id,
    ])
  ).rows[0];
  if ((old?.version || 0) !== c.version)
    throw new Problem(
      409,
      "Defaults changed in another session. Keep your draft, then discard and reopen to load the latest version.",
    );
  const id = old?.id || uuid();
  await tx.query(
    `INSERT INTO document_defaults(id,tenant_id,entity_id,version,settings) VALUES($1,$2,$3,1,$4)
    ON CONFLICT(tenant_id,entity_id) DO UPDATE SET version=document_defaults.version+1,settings=excluded.settings`,
    [id, ctx.tenantId, c.entity_id, JSON.stringify(c.settings)],
  );
  await tx.query(
    "INSERT INTO document_defaults_history(id,tenant_id,entity_id,version,request_key,payload,actor_id,actor_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      uuid(),
      ctx.tenantId,
      c.entity_id,
      c.version + 1,
      c.request_key,
      JSON.stringify(c),
      ctx.userId,
      ctx.name || ctx.userId,
    ],
  );
  await audit(tx, ctx, id, c.action, {
    before: old?.settings || null,
    after: c.settings,
    entity_id: c.entity_id,
    text: "Updated document defaults. Existing documents are unchanged.",
  });
  return { id };
}
