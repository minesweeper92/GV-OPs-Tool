import { randomUUID as uuid } from "node:crypto";
import type { SQL, Row } from "./db.ts";
import { Problem, audit, type Context } from "./domain.ts";
import { totals, scaled, baseAmount } from "../shared/money.ts";
import { documentDetails } from "../shared/documents.ts";
import { allocateNumber } from "./numbering.ts";

export function detailsSnapshot(company: Row, details?: Row) {
  const p = company.profile || {};
  const result = documentDetails.parse(
    details || {
      billing_address: company.address,
      shipping_address: company.shipping_address,
      customer_tax_id: company.tax_id,
      recipients: p.billing_recipients || [],
      payment_terms: `Net ${p.payment_days ?? 30} days`,
      customer_notes: p.document_notes || "",
    },
  );
  if (
    result.valid_until &&
    result.quote_date &&
    result.valid_until < result.quote_date
  )
    throw new Problem(400, "Quote expiry cannot precede its date.");
  return result;
}
export async function executeDocument(tx: SQL, ctx: Context, c: Row) {
  if (c.action.startsWith("document.item-")) {
    if (ctx.role === "viewer")
      throw new Problem(403, "Read-only users cannot manage saved items.");
    if (c.action === "document.item-save") {
      // Validating via totals also checks discount and tax bounds.
      try {
        totals([c.line]);
      } catch (error) {
        throw new Problem(400, (error as Error).message);
      }
      const id = uuid();
      const saved = (
        await tx.query(
          "INSERT INTO catalog_items(id,tenant_id,name,currency,line,created_by,request_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,request_key) DO NOTHING RETURNING id",
          [
            id,
            ctx.tenantId,
            c.name,
            c.currency,
            JSON.stringify(c.line),
            ctx.userId,
            c.request_key,
          ],
        )
      ).rows[0];
      if (!saved) {
        const prior = (
          await tx.query(
            "SELECT *,line=$2::jsonb AS same_line FROM catalog_items WHERE request_key=$1",
            [c.request_key, JSON.stringify(c.line)],
          )
        ).rows[0];
        if (
          !prior ||
          prior.name !== c.name ||
          prior.currency !== c.currency ||
          !prior.same_line
        )
          throw new Problem(409, "This retry key was used for another item.");
        return { id: prior.id };
      }
      await audit(tx, ctx, id, c.action, c);
      return { id };
    }
    const item = (
      await tx.query("SELECT * FROM catalog_items WHERE id=$1 FOR UPDATE", [
        c.id,
      ])
    ).rows[0];
    if (!item) throw new Problem(404, "Saved item unavailable.");
    if (ctx.role !== "admin" && item.created_by !== ctx.userId)
      throw new Problem(
        403,
        "Only the creator or an administrator can archive this saved item.",
      );
    await tx.query("UPDATE catalog_items SET active=false WHERE id=$1", [c.id]);
    await audit(tx, ctx, c.id, c.action, {});
    return { id: c.id };
  }
  if (!["admin", "finance"].includes(ctx.role))
    throw new Problem(403, "A finance role is required.");
  let id = c.id || uuid();
  let invoice: Row | undefined;
  if (c.action === "document.invoice-edit") {
    invoice = (
      await tx.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!invoice) throw new Problem(404, "Invoice unavailable.");
    if (invoice.status !== "Draft" || invoice.version !== c.version)
      throw new Problem(
        409,
        "Only the current draft can be edited. Refresh this invoice.",
      );
  }
  const e = (
    await tx.query("SELECT * FROM entities WHERE id=$1 FOR UPDATE", [
      invoice?.entity_id || c.entity_id,
    ])
  ).rows[0];
  if (!e) throw new Problem(404, "Legal entity unavailable.");
  // Entity lock serializes repeated creates before checking the retry key.
  if (!invoice) {
    const prior = (
      await tx.query(
        "SELECT id,request_payload FROM invoices WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      const same = (
        await tx.query("SELECT $1::jsonb=$2::jsonb AS same", [
          JSON.stringify(prior.request_payload),
          JSON.stringify(c),
        ])
      ).rows[0].same;
      if (!same)
        throw new Problem(
          409,
          "This retry key was used for a different invoice.",
        );
      return { id: prior.id };
    }
  }
  if (e.lock_date && c.issue_date <= String(e.lock_date).slice(0, 10))
    throw new Problem(409, "This accounting period is locked.");
  if (c.due_date < c.issue_date)
    throw new Problem(400, "Due date cannot precede invoice date.");
  if (invoice?.deal_id) {
    const last = (
      await tx.query(
        "SELECT max(j.posted_on)::text AS date FROM journals j JOIN invoices i ON i.id=j.source_id WHERE i.deal_id=$1 AND j.source_type='invoice_void'",
        [invoice.deal_id],
      )
    ).rows[0].date;
    if (last && c.issue_date < last)
      throw new Problem(
        409,
        "Replacement invoices cannot precede the latest invoice reversal date.",
      );
  }
  if (invoice) {
    await tx.query(
      "UPDATE invoices SET issue_date=$2,due_date=$3,terms=$4,details=$5 WHERE id=$1",
      [
        id,
        c.issue_date,
        c.due_date,
        c.terms,
        JSON.stringify(detailsSnapshot({}, c.details)),
      ],
    );
  } else {
    const company = (
      await tx.query("SELECT * FROM companies WHERE id=$1 FOR UPDATE", [
        c.company_id,
      ])
    ).rows[0];
    if (!company) throw new Problem(404, "Customer unavailable.");
    const fx = scaled(c.fx, 6);
    if (fx <= 0n || (c.currency === e.currency && fx !== 1000000n))
      throw new Problem(400, "Enter a positive exchange rate; PKR uses 1.");
    let calculated;
    try {
      calculated = totals(c.lines);
    } catch (error) {
      throw new Problem(400, (error as Error).message);
    }
    if (baseAmount(BigInt(calculated.net), fx) <= 0n)
      throw new Problem(400, "The subtotal rounds to zero in PKR.");
    const number = await allocateNumber(
      tx,
      ctx.tenantId,
      e.id,
      "invoice",
      c.number_series_id,
    );
    await tx.query(
      `INSERT INTO invoices(id,tenant_id,entity_id,company_id,customer_name,issuer_name,issuer_address,issuer_tax_id,terms,issue_date,due_date,lines,net_minor,tax_minor,total_minor,currency,fx_micros,billing_kind,label,request_key,request_payload,details,number)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        id,
        ctx.tenantId,
        e.id,
        company.id,
        company.name,
        e.name,
        e.address,
        e.tax_id,
        c.terms,
        c.issue_date,
        c.due_date,
        JSON.stringify(calculated.lines),
        calculated.net,
        calculated.tax,
        calculated.total,
        c.currency,
        String(fx),
        c.billing_kind,
        c.label || "Direct invoice",
        c.request_key,
        JSON.stringify(c),
        JSON.stringify(detailsSnapshot(company, c.details)),
        number,
      ],
    );
    await tx.query("UPDATE companies SET customer=true WHERE id=$1", [
      company.id,
    ]);
  }
  await audit(tx, ctx, id, c.action, c);
  return { id };
}
