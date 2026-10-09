import { randomUUID as uuid } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL, Row } from "./db.ts";
import { Problem, audit, type Context } from "./domain.ts";
import { totals, scaled, baseAmount } from "../shared/money.ts";
import {
  pendingApproval,
  startApproval,
  actApproval,
} from "./approval-workflows.ts";
import { allocateNumber } from "./numbering.ts";
import { executePayable } from "./payables.ts";
import { hasCapability } from "../shared/permissions.ts";

const requireFinance = (ctx: Context) => {
  if (!hasCapability(ctx, "books.post"))
    throw new Problem(403, "A finance role is required for purchase orders.");
};
async function get(
  tx: SQL,
  table: "purchase_orders" | "companies" | "entities" | "deals",
  id: string,
  lock = false,
) {
  const r = (
    await tx.query(
      `SELECT * FROM ${table} WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  if (!r) throw new Problem(404, "Record not found in this organization.");
  return r;
}
export async function purchaseOrderSnapshot(tx: SQL, ctx: Context) {
  if (!hasCapability(ctx, "books.view")) return { purchaseOrders: [] };
  const orders = (
    await tx.query(
      "SELECT * FROM purchase_orders ORDER BY order_date DESC,created_at DESC",
    )
  ).rows;
  const allocations = (
    await tx.query(
      "SELECT a.purchase_order_id,a.bill_id,a.line_index,a.quantity_millis,b.status FROM purchase_order_bill_lines a JOIN bills b ON b.id=a.bill_id",
    )
  ).rows;
  return {
    purchaseOrders: orders.map(({ request_payload, ...o }) => ({
      ...o,
      allocations: allocations.filter((a) => a.purchase_order_id === o.id),
    })),
  };
}
export async function executePurchaseOrder(tx: SQL, ctx: Context, c: Row) {
  requireFinance(ctx);
  if (
    c.action === "purchase-order.create" ||
    c.action === "purchase-order.edit"
  ) {
    const old =
      c.action === "purchase-order.edit"
        ? await get(tx, "purchase_orders", c.id, true)
        : null;
    if (old && (old.status !== "Draft" || old.version !== c.version))
      throw new Problem(
        409,
        "Only the current draft purchase order can be edited.",
      );
    const entity = await get(
      tx,
      "entities",
      old?.entity_id || c.entity_id,
      true,
    );
    if (!old) {
      const prior = (
        await tx.query(
          "SELECT id,request_payload FROM purchase_orders WHERE request_key=$1",
          [c.request_key],
        )
      ).rows[0];
      if (prior) {
        if (!isDeepStrictEqual(prior.request_payload, c))
          throw new Problem(
            409,
            "This retry key was used for another purchase order.",
          );
        return { id: prior.id };
      }
    }
    const vendor = await get(tx, "companies", c.vendor_id);
    if (!vendor.vendor)
      throw new Problem(400, "Choose a company marked as a vendor.");
    if (
      c.deal_id &&
      (await get(tx, "deals", c.deal_id)).entity_id !== entity.id
    )
      throw new Problem(400, "The project belongs to another legal entity.");
    if (c.delivery_date && c.delivery_date < c.order_date)
      throw new Problem(
        400,
        "Expected delivery cannot precede the order date.",
      );
    const fx = scaled(c.fx, 6);
    if (fx <= 0n || (c.currency === "PKR" && fx !== 1000000n))
      throw new Problem(400, "Use a positive exchange rate; PKR must use 1.");
    let sum;
    try {
      sum = totals(c.lines);
      if (BigInt(sum.total) <= 0n)
        throw new Error("Purchase order total must be positive.");
    } catch (e) {
      throw new Problem(400, (e as Error).message);
    }
    const values = [
      vendor.id,
      vendor.name,
      entity.name,
      c.deal_id,
      c.order_date,
      c.delivery_date,
      c.currency,
      String(fx),
      JSON.stringify(
        sum.lines.map((l, i) => ({
          ...l,
          account_code: c.lines[i].account_code,
        })),
      ),
      sum.net,
      sum.tax,
      sum.total,
      c.tax_treatment,
      c.reference,
      c.notes,
      c.terms,
      c.delivery_address,
    ];
    const id = old?.id || uuid();
    if (old)
      await tx.query(
        "UPDATE purchase_orders SET vendor_id=$2,vendor_name=$3,entity_name=$4,deal_id=$5,order_date=$6,delivery_date=$7,currency=$8,fx_micros=$9,lines=$10,net_minor=$11,tax_minor=$12,total_minor=$13,tax_treatment=$14,reference=$15,notes=$16,terms=$17,delivery_address=$18,version=version+1 WHERE id=$1",
        [id, ...values],
      );
    else {
      const number = await allocateNumber(
        tx,
        ctx.tenantId,
        entity.id,
        "purchase-order",
        c.number_series_id,
      );
      await tx.query(
        "INSERT INTO purchase_orders(id,tenant_id,entity_id,number,vendor_id,vendor_name,entity_name,deal_id,order_date,delivery_date,currency,fx_micros,lines,net_minor,tax_minor,total_minor,tax_treatment,reference,notes,terms,delivery_address,created_by,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)",
        [
          id,
          ctx.tenantId,
          entity.id,
          number,
          ...values,
          ctx.userId,
          c.request_key,
          JSON.stringify(c),
        ],
      );
    }
    await audit(tx, ctx, id, c.action, {
      text: `${old ? "Updated" : "Created"} purchase order draft for ${vendor.name}. No ledger posting.`,
    });
    return { id };
  }
  const po = await get(tx, "purchase_orders", c.id, true);
  if (c.action === "purchase-order.bill") {
    const prior = (
      await tx.query(
        "SELECT id,purchase_order_id,request_payload FROM bills WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.purchase_order_id !== po.id ||
        !isDeepStrictEqual(prior.request_payload.purchase_order_command, c)
      )
        throw new Problem(
          409,
          "This retry key was used for another conversion.",
        );
      return { id: prior.id };
    }
  }
  if (po.version !== c.version)
    throw new Problem(
      409,
      "This purchase order changed. Refresh before continuing.",
    );
  if (c.action === "purchase-order.submit") {
    if (po.status !== "Draft")
      throw new Problem(409, "Only a draft can be submitted.");
    const run = await startApproval(
      tx,
      ctx,
      "purchase-order",
      po,
      String(baseAmount(BigInt(po.total_minor), BigInt(po.fx_micros))),
    );
    if (!run)
      throw new Problem(409, "Configure purchase-order approval rules first.");
    await tx.query(
      "UPDATE purchase_orders SET status='Pending approval',version=version+1 WHERE id=$1",
      [po.id],
    );
    return { id: po.id };
  }
  if (
    c.action === "purchase-order.review" ||
    c.action === "purchase-order.return"
  ) {
    const run = await pendingApproval(tx, po.id);
    if (po.status !== "Pending approval" || !run)
      throw new Problem(409, "No pending approval for this order.");
    const returned = c.action === "purchase-order.return";
    const final = await actApproval(tx, ctx, run, c.comment, returned);
    await tx.query(
      "UPDATE purchase_orders SET status=$2,version=version+1 WHERE id=$1",
      [po.id, returned ? "Draft" : final ? "Issued" : "Pending approval"],
    );
    return { id: po.id };
  }
  const active = (
    await tx.query(
      "SELECT a.* FROM purchase_order_bill_lines a JOIN bills b ON b.id=a.bill_id WHERE a.purchase_order_id=$1 AND b.status<>'Voided'",
      [po.id],
    )
  ).rows;
  if (c.action === "purchase-order.status") {
    // Pending reviews may only be returned through the audited workflow action.
    if (po.status === "Pending approval")
      throw new Problem(
        409,
        "Return this order through its approval workflow first.",
      );
    if (
      c.status === "Issued" &&
      po.status === "Draft" &&
      (
        await tx.query(
          "SELECT id FROM approval_rules WHERE entity_id=$1 AND kind='purchase-order'",
          [po.entity_id],
        )
      ).rows.length
    )
      throw new Problem(
        409,
        "Submit this order and complete its approvals before issuing.",
      );
    const allowed =
      c.status === "Issued"
        ? ["Draft", "Closed"].includes(po.status)
        : c.status === "Closed"
          ? po.status === "Issued"
          : ["Draft", "Issued"].includes(po.status) && active.length === 0;
    if (!allowed)
      throw new Problem(
        409,
        "This transition is unavailable. Void linked bills before cancelling, or close the remaining order instead.",
      );
    await tx.query(
      "UPDATE purchase_orders SET status=$2,version=version+1 WHERE id=$1",
      [po.id, c.status],
    );
    await audit(tx, ctx, po.id, c.action, {
      text: `${po.number}: ${c.status} — ${c.reason}. No ledger posting.`,
    });
    return { id: po.id };
  }
  if (c.action !== "purchase-order.bill")
    throw new Problem(400, "Unknown purchase order action.");
  if (po.status !== "Issued")
    throw new Problem(
      409,
      "Issue or reopen this purchase order before converting it to a bill.",
    );
  if (c.bill_date < po.order_date)
    throw new Problem(400, "Bill date cannot precede the purchase order date.");
  const seen = new Set<number>();
  const lines = c.allocations.map((a: Row) => {
    const source = po.lines[a.index],
      qty = scaled(a.quantity, 3);
    if (!source || seen.has(a.index) || qty <= 0n)
      throw new Problem(
        400,
        "Select each valid order line once with a positive quantity.",
      );
    seen.add(a.index);
    const used = active
      .filter((r) => r.line_index === a.index)
      .reduce((n, r) => n + BigInt(r.quantity_millis), 0n);
    if (qty + used > scaled(source.quantity, 3))
      throw new Problem(
        409,
        "The selected quantity exceeds the remaining order quantity. Refresh the order.",
      );
    return {
      description: source.description,
      quantity: a.quantity,
      price: source.price,
      tax: source.tax,
      account_code: source.account_code,
    };
  });
  const result = await executePayable(tx, ctx, {
    action: "bill.create",
    entity_id: po.entity_id,
    vendor_id: po.vendor_id,
    deal_id: po.deal_id,
    reference: c.reference,
    bill_date: c.bill_date,
    due_date: c.due_date,
    currency: po.currency,
    fx: c.fx,
    lines,
    tax_treatment: po.tax_treatment,
    notes: `From ${po.number}${po.notes ? "\n" + po.notes : ""}`,
    acknowledge_duplicate: c.acknowledge_duplicate,
    request_key: c.request_key,
    purchase_order_id: po.id,
    purchase_order_command: c,
  });
  for (const a of c.allocations)
    await tx.query(
      "INSERT INTO purchase_order_bill_lines(id,tenant_id,purchase_order_id,bill_id,line_index,quantity_millis) VALUES($1,$2,$3,$4,$5,$6)",
      [
        uuid(),
        ctx.tenantId,
        po.id,
        result.id,
        a.index,
        String(scaled(a.quantity, 3)),
      ],
    );
  await audit(tx, ctx, po.id, c.action, {
    text: `${po.number}: converted selected quantities to a draft bill ${c.reference}. No ledger posting.`,
    billId: result.id,
  });
  return result;
}
