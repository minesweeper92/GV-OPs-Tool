import { randomUUID as uuid } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL, Row } from "./db.ts";
import { Problem, post, audit, type Context } from "./domain.ts";
import { minor, scaled, totals, baseAmount, round } from "../shared/money.ts";
import { cashAccount } from "./bank-account.ts";

function requireFinance(ctx: Context) {
  if (!["admin", "finance"].includes(ctx.role))
    throw new Problem(
      403,
      "A finance role is required for purchases and payables.",
    );
}
async function get(
  tx: SQL,
  table: "bills" | "entities" | "companies" | "deals" | "vendor_payments",
  id: string,
) {
  const r = (
    await tx.query(
      `SELECT * FROM ${table} WHERE id=$1 ${table === "bills" || table === "entities" ? "FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  if (!r) throw new Problem(404, "Record not found in this organization.");
  return r;
}
async function openDate(tx: SQL, b: Row, date: string) {
  const entity = await get(tx, "entities", b.entity_id);
  if (entity.lock_date && date <= String(entity.lock_date).slice(0, 10))
    throw new Problem(
      409,
      "This accounting period is locked. Choose a later date.",
    );
  if (date < String(b.last_activity_on).slice(0, 10))
    throw new Problem(
      400,
      "Use a date on or after the latest posting for this bill.",
    );
  return entity;
}
async function reverseJournal(
  tx: SQL,
  ctx: Context,
  entity: string,
  source: string,
  sourceId: string,
  date: string,
  newSource: string,
  newId: string,
  description: string,
) {
  const rows = (
    await tx.query(
      "SELECT l.account_code,l.debit_minor,l.credit_minor FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type=$1 AND j.source_id=$2",
      [source, sourceId],
    )
  ).rows;
  if (!rows.length)
    throw new Problem(
      409,
      "Original journal is missing. No reversal was recorded.",
    );
  await post(
    tx,
    ctx,
    entity,
    date,
    newSource,
    newId,
    description,
    rows.map((l) => ({
      account: l.account_code,
      debit: BigInt(l.credit_minor),
      credit: BigInt(l.debit_minor),
    })),
  );
}
export async function payableSnapshot(tx: SQL, ctx: Context) {
  if (!["admin", "finance"].includes(ctx.role))
    return { bills: [], vendorPayments: [] };
  const bills = (
    await tx.query(
      "SELECT * FROM bills ORDER BY bill_date DESC,created_at DESC",
    )
  ).rows;
  const vendorPayments = (
    await tx.query(
      "SELECT p.*,r.reversal_date,r.reason AS reversal_reason FROM vendor_payments p LEFT JOIN vendor_payment_reversals r ON r.payment_id=p.id ORDER BY p.payment_date DESC,p.created_at DESC",
    )
  ).rows;
  // Original request bodies are internal retry metadata, not presentation data.
  return {
    bills: bills.map(({ request_payload, ...b }) => b),
    vendorPayments: vendorPayments.map(({ request_payload, ...p }) => p),
  };
}
export async function executePayable(tx: SQL, ctx: Context, c: Row) {
  requireFinance(ctx);
  const t = ctx.tenantId,
    id = uuid();
  if (c.action === "bill.create" || c.action === "bill.edit") {
    const old = c.action === "bill.edit" ? await get(tx, "bills", c.id) : null;
    if (old?.purchase_order_id)
      throw new Problem(
        409,
        "Purchase-order bill quantities are fixed. Void the draft and convert again to change them.",
      );
    if (old && (old.status !== "Draft" || old.version !== c.version))
      throw new Problem(
        409,
        "Only the current draft can be edited. Refresh to see its latest status.",
      );
    const entity = await get(tx, "entities", old?.entity_id || c.entity_id);
    if (!old) {
      const prior = (
        await tx.query(
          "SELECT id,request_payload FROM bills WHERE request_key=$1",
          [c.request_key],
        )
      ).rows[0];
      if (prior) {
        if (!isDeepStrictEqual(prior.request_payload, c))
          throw new Problem(409, "This retry key was used for another bill.");
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
      throw new Problem(
        400,
        "The project belongs to a different legal entity.",
      );
    if (c.due_date < c.bill_date)
      throw new Problem(400, "Due date cannot precede bill date.");
    const fx = scaled(c.fx, 6);
    if (fx <= 0n || (c.currency === "PKR" && fx !== 1_000_000n))
      throw new Problem(400, "Enter a positive FX rate; PKR must use 1.");
    let sum;
    try {
      sum = totals(c.lines);
    } catch (error) {
      throw new Problem(400, (error as Error).message);
    }
    const base = baseAmount(BigInt(sum.total), fx);
    if (base === 0n)
      throw new Problem(
        400,
        "Bill must convert to at least one PKR minor unit.",
      );
    if (
      (
        await tx.query(
          "SELECT id FROM bills WHERE entity_id=$1 AND vendor_id=$2 AND lower(trim(reference))=lower(trim($3)) AND status<>'Voided' AND id<>$4",
          [entity.id, vendor.id, c.reference, old?.id || id],
        )
      ).rows.length
    )
      throw new Problem(
        409,
        "This vendor bill number already exists for this legal entity. Open the existing bill instead.",
      );
    const duplicate = (
      await tx.query(
        "SELECT reference FROM bills WHERE entity_id=$1 AND vendor_id=$2 AND bill_date=$3 AND currency=$4 AND total_minor=$5 AND status<>'Voided' AND id<>$6",
        [
          entity.id,
          vendor.id,
          c.bill_date,
          c.currency,
          sum.total,
          old?.id || id,
        ],
      )
    ).rows[0];
    if (duplicate && !c.acknowledge_duplicate)
      throw new Problem(
        409,
        `Possible duplicate: ${duplicate.reference} has this vendor, date, currency and total. Review it, then confirm that this is a separate bill.`,
      );
    const values = [
      vendor.id,
      vendor.name,
      entity.name,
      c.deal_id,
      c.reference,
      c.bill_date,
      c.due_date,
      c.currency,
      String(fx),
      JSON.stringify(
        sum.lines.map((l, i) => ({
          ...l,
          account_code: c.lines[i].account_code,
        })),
      ),
      c.tax_treatment,
      sum.net,
      sum.tax,
      sum.total,
      String(base),
      c.notes,
    ];
    if (old) {
      await tx.query(
        "UPDATE bills SET vendor_id=$2,vendor_name=$3,entity_name=$4,deal_id=$5,reference=$6,bill_date=$7,due_date=$8,currency=$9,fx_micros=$10,lines=$11,tax_treatment=$12,net_minor=$13,tax_minor=$14,total_minor=$15,base_minor=$16,notes=$17,last_activity_on=$7,version=version+1 WHERE id=$1",
        [old.id, ...values],
      );
    } else
      await tx.query(
        "INSERT INTO bills(id,tenant_id,entity_id,vendor_id,vendor_name,entity_name,deal_id,reference,bill_date,due_date,currency,fx_micros,lines,tax_treatment,net_minor,tax_minor,total_minor,base_minor,notes,last_activity_on,created_by,request_key,request_payload,purchase_order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$9,$20,$21,$22,$23)",
        [
          id,
          t,
          entity.id,
          ...values,
          ctx.userId,
          c.request_key,
          JSON.stringify(c),
          c.purchase_order_id || null,
        ],
      );
    await audit(tx, ctx, old?.id || id, c.action, {
      text: `${old ? "Updated" : "Created"} draft bill ${c.reference} from ${vendor.name}.`,
      duplicateAcknowledged: !!duplicate && c.acknowledge_duplicate,
    });
    return { id: old?.id || id };
  }
  if (c.action.startsWith("bill.")) {
    const b = await get(tx, "bills", c.id);
    if (b.version !== c.version)
      throw new Problem(
        409,
        "This bill changed. Refresh before taking this action.",
      );
    if (c.action === "bill.submit") {
      if (b.status !== "Draft")
        throw new Problem(409, "Only a draft can be submitted.");
      await tx.query(
        "UPDATE bills SET status='Pending approval',version=version+1 WHERE id=$1",
        [b.id],
      );
    } else if (c.action === "bill.return") {
      if (ctx.role !== "admin")
        throw new Problem(403, "An administrator must review the bill.");
      if (b.status !== "Pending approval")
        throw new Problem(409, "Only a submitted bill can be returned.");
      await tx.query(
        "UPDATE bills SET status='Draft',version=version+1 WHERE id=$1",
        [b.id],
      );
    } else if (c.action === "bill.approve") {
      if (ctx.role !== "admin")
        throw new Problem(
          403,
          "An administrator must approve and post the bill.",
        );
      if (b.status !== "Pending approval")
        throw new Problem(409, "Submit the draft for approval first.");
      await openDate(tx, b, String(b.bill_date).slice(0, 10));
      const total = BigInt(b.total_minor),
        net = BigInt(b.net_minor),
        base = BigInt(b.base_minor),
        netBase = baseAmount(net, BigInt(b.fx_micros));
      const recoverable = b.tax_treatment === "recoverable",
        allocatedBase = recoverable ? netBase : base,
        denominator = recoverable ? net : total;
      let cumulative = 0n,
        allocated = 0n;
      const posting = b.lines.map((l: Row) => {
        cumulative +=
          BigInt(l.subtotal) + (recoverable ? 0n : BigInt(l.taxMinor));
        const target = round(allocatedBase * cumulative, denominator),
          debit = target - allocated;
        allocated = target;
        return { account: l.account_code, debit };
      });
      if (recoverable) posting.push({ account: "1300", debit: base - netBase });
      await post(
        tx,
        ctx,
        b.entity_id,
        b.bill_date,
        "bill",
        b.id,
        `Bill ${b.reference} · ${b.vendor_name}`,
        [...posting, { account: "2000", credit: base }],
      );
      await tx.query(
        "UPDATE bills SET status='Open',approved_by=$2,approved_at=now(),version=version+1 WHERE id=$1",
        [b.id, ctx.userId],
      );
    } else if (c.action === "bill.void") {
      if (
        b.status === "Voided" ||
        BigInt(b.paid_minor) !== 0n ||
        BigInt(b.credited_minor) !== 0n ||
        (
          await tx.query(
            "SELECT id FROM vendor_credits v WHERE bill_id=$1 AND NOT EXISTS(SELECT 1 FROM vendor_credit_reversals r WHERE r.credit_id=v.id)",
            [b.id],
          )
        ).rows.length
      )
        throw new Problem(
          409,
          "Reverse active payments, credit applications and source vendor credits before voiding this bill.",
        );
      if (b.status === "Open") {
        if (ctx.role !== "admin")
          throw new Problem(403, "An administrator must void a posted bill.");
        await openDate(tx, b, c.date);
        await reverseJournal(
          tx,
          ctx,
          b.entity_id,
          "bill",
          b.id,
          c.date,
          "bill-void",
          b.id,
          `Void bill ${b.reference}: ${c.reason}`,
        );
      }
      await tx.query(
        "UPDATE bills SET status='Voided',last_activity_on=greatest(last_activity_on,$2::date),version=version+1 WHERE id=$1",
        [b.id, c.date],
      );
    } else throw new Problem(400, "Unknown bill action.");
    await audit(tx, ctx, b.id, c.action, {
      text: `Bill ${b.reference}: ${c.action.split(".")[1]}${c.reason ? ` — ${c.reason}` : ""}.`,
    });
    return { id: b.id };
  }
  if (c.action === "vendor-payment.create") {
    const b = await get(tx, "bills", c.bill_id);
    const prior = (
      await tx.query(
        "SELECT id,request_payload FROM vendor_payments WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (!isDeepStrictEqual(prior.request_payload, c))
        throw new Problem(409, "This retry key was used for another payment.");
      return { id: prior.id };
    }
    if (b.status !== "Open")
      throw new Problem(409, "Only an approved, open bill can be paid.");
    await openDate(tx, b, c.date);
    const bankCode = await cashAccount(
      tx,
      b.entity_id,
      c.bank_account_id,
      c.date,
    );
    const amount = minor(c.amount),
      wht = minor(c.wht),
      fee = minor(c.fee),
      fx = scaled(c.fx, 6),
      settled = amount + wht,
      remaining =
        BigInt(b.total_minor) - BigInt(b.paid_minor) - BigInt(b.credited_minor),
      remainingBase =
        BigInt(b.base_minor) -
        BigInt(b.paid_base_minor) -
        BigInt(b.credited_base_minor);
    if (
      amount <= 0n ||
      settled > remaining ||
      fx <= 0n ||
      (b.currency === "PKR" && fx !== 1_000_000n)
    )
      throw new Problem(
        400,
        "Enter a positive payment within the remaining balance and a valid exchange rate.",
      );
    const carrying = round(remainingBase * settled, remaining),
      cash = baseAmount(amount, fx),
      withheld = baseAmount(wht, fx),
      fees = baseAmount(fee, fx),
      difference = cash + withheld - carrying;
    if (cash === 0n)
      throw new Problem(
        400,
        "Payment must convert to at least one PKR minor unit.",
      );
    await tx.query(
      "INSERT INTO vendor_payments(id,tenant_id,entity_id,bill_id,payment_date,amount_minor,wht_minor,fee_minor,fx_micros,carrying_minor,reference,request_key,request_payload,bank_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
      [
        id,
        t,
        b.entity_id,
        b.id,
        c.date,
        String(amount),
        String(wht),
        String(fee),
        String(fx),
        String(carrying),
        c.reference,
        c.request_key,
        JSON.stringify(c),
        c.bank_account_id || null,
      ],
    );
    await post(
      tx,
      ctx,
      b.entity_id,
      c.date,
      "vendor-payment",
      id,
      `Vendor payment for ${b.reference}`,
      [
        { account: "2000", debit: carrying },
        { account: bankCode, credit: cash + fees },
        { account: "2200", credit: withheld },
        { account: "5300", debit: fees },
        difference >= 0n
          ? { account: "5100", debit: difference }
          : { account: "4100", credit: -difference },
      ],
    );
    await tx.query(
      "UPDATE bills SET paid_minor=paid_minor+$2,paid_base_minor=paid_base_minor+$3,status=$4,last_activity_on=$5,version=version+1 WHERE id=$1",
      [
        b.id,
        String(settled),
        String(carrying),
        settled === remaining ? "Paid" : "Open",
        c.date,
      ],
    );
    await audit(tx, ctx, b.id, c.action, {
      paymentId: id,
      text: `Recorded payment ${c.reference} for ${b.reference}. No bank transfer was initiated.`,
    });
    return { id };
  }
  if (c.action === "vendor-payment.reverse") {
    const p = (
      await tx.query("SELECT * FROM vendor_payments WHERE id=$1", [c.id])
    ).rows[0];
    if (!p) throw new Problem(404, "Payment not found.");
    const b = await get(tx, "bills", p.bill_id);
    const prior = (
      await tx.query(
        "SELECT * FROM vendor_payment_reversals WHERE payment_id=$1",
        [p.id],
      )
    ).rows[0];
    if (prior) {
      if (
        String(prior.reversal_date).slice(0, 10) !== c.date ||
        prior.reason !== c.reason
      )
        throw new Problem(
          409,
          "This payment already has a different reversal.",
        );
      return { id: prior.id };
    }
    await openDate(tx, b, c.date);
    await reverseJournal(
      tx,
      ctx,
      b.entity_id,
      "vendor-payment",
      p.id,
      c.date,
      "vendor-payment-reversal",
      id,
      `Reverse payment ${p.reference}: ${c.reason}`,
    );
    await tx.query(
      "INSERT INTO vendor_payment_reversals(id,tenant_id,payment_id,reversal_date,reason) VALUES($1,$2,$3,$4,$5)",
      [id, t, p.id, c.date, c.reason],
    );
    await tx.query(
      "UPDATE bills SET paid_minor=paid_minor-$2,paid_base_minor=paid_base_minor-$3,status='Open',last_activity_on=$4,version=version+1 WHERE id=$1",
      [
        b.id,
        String(BigInt(p.amount_minor) + BigInt(p.wht_minor)),
        p.carrying_minor,
        c.date,
      ],
    );
    await audit(tx, ctx, b.id, c.action, {
      paymentId: p.id,
      text: `Reversed payment ${p.reference}: ${c.reason}.`,
    });
    return { id };
  }
  throw new Problem(400, "Unknown payable action.");
}
