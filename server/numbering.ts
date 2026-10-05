import { randomUUID } from "node:crypto";
import type { SQL, Row } from "./db.ts";
import { Problem } from "./domain.ts";

export async function allocateNumber(
  tx: SQL,
  tenantId: string,
  entityId: string,
  kind: "quote" | "invoice" | "purchase-order",
  seriesId?: string | null,
) {
  // The entity row serializes lazy default-series creation and allocations.
  const entity = (
    await tx.query("SELECT * FROM entities WHERE id=$1 FOR UPDATE", [entityId])
  ).rows[0];
  if (!entity || entity.tenant_id !== tenantId)
    throw new Problem(404, "Legal entity unavailable.");
  const prefix =
    kind === "quote"
      ? "QT-"
      : `${entity.code}-${kind === "purchase-order" ? "PO" : "INV"}-`;
  const padding = kind === "quote" ? 6 : 5;
  const legacyNext =
    kind === "quote"
      ? entity.next_quote_number
      : kind === "purchase-order"
        ? entity.next_purchase_order
        : entity.next_invoice;
  await tx.query(
    `INSERT INTO number_series(id,tenant_id,entity_id,kind,name,prefix,padding,next_number,is_default)
     VALUES($1,$2,$3,$4,'Standard',$5,$6,$7,true)
     ON CONFLICT(tenant_id,entity_id,kind,prefix) DO NOTHING`,
    [randomUUID(), tenantId, entityId, kind, prefix, padding, legacyNext],
  );
  const row = (
    await tx.query(
      `UPDATE number_series SET next_number=next_number+1
       WHERE id=(SELECT id FROM number_series WHERE tenant_id=$1 AND entity_id=$2 AND kind=$3
         AND ($4::uuid IS NOT NULL AND id=$4 OR $4::uuid IS NULL AND is_default))
       RETURNING prefix,padding,next_number-1 AS allocated,is_default`,
      [tenantId, entityId, kind, seriesId || null],
    )
  ).rows[0];
  if (!row)
    throw new Problem(
      400,
      "Choose a valid number series for this legal entity.",
    );
  if (row.is_default) {
    const counter =
      kind === "quote"
        ? "next_quote_number"
        : kind === "purchase-order"
          ? "next_purchase_order"
          : "next_invoice";
    await tx.query(`UPDATE entities SET ${counter}=$2 WHERE id=$1`, [
      entityId,
      String(BigInt(row.allocated) + 1n),
    ]);
  }
  return `${row.prefix}${String(row.allocated).padStart(row.padding, "0")}`;
}

export async function createNumberSeries(
  tx: SQL,
  ctx: { tenantId: string; role: string },
  c: Row,
) {
  if (!["admin", "finance"].includes(ctx.role))
    throw new Problem(
      403,
      "A finance role is required to configure numbering.",
    );
  const entity = (
    await tx.query("SELECT id,code FROM entities WHERE id=$1", [c.entity_id])
  ).rows[0];
  if (!entity) throw new Problem(404, "Legal entity unavailable.");
  const standardPrefix =
    c.kind === "quote"
      ? "QT-"
      : `${entity.code}-${c.kind === "purchase-order" ? "PO" : "INV"}-`;
  if (c.prefix === standardPrefix)
    throw new Problem(
      409,
      "That prefix belongs to the standard series. Select Standard instead.",
    );
  const candidate = `${c.prefix}${String(c.next_number).padStart(c.padding, "0")}`;
  const table =
    c.kind === "quote"
      ? "quotes"
      : c.kind === "purchase-order"
        ? "purchase_orders"
        : "invoices";
  const collision = (
    await tx.query(`SELECT id FROM ${table} WHERE entity_id=$1 AND number=$2`, [
      c.entity_id,
      candidate,
    ])
  ).rows[0];
  if (collision)
    throw new Problem(409, "That next document number already exists.");
  const id = randomUUID();
  try {
    await tx.query(
      `INSERT INTO number_series(id,tenant_id,entity_id,kind,name,prefix,padding,next_number)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        ctx.tenantId,
        c.entity_id,
        c.kind,
        c.name,
        c.prefix,
        c.padding,
        c.next_number,
      ],
    );
  } catch (error) {
    if (String(error).includes("unique"))
      throw new Problem(
        409,
        "That name or prefix already exists for this legal entity and document type.",
      );
    throw error;
  }
  return { id };
}
