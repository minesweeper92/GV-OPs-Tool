import { randomUUID as uuid } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL, Row } from "./db.ts";
import { Problem, post, audit, type Context } from "./domain.ts";
import { minor, scaled, round, baseAmount } from "../shared/money.ts";
import { cashAccount } from "./bank-account.ts";
import { hasCapability } from "../shared/permissions.ts";
import { receiptProblem, receiptTotals } from "../shared/customer-receipts.ts";

const day = (v: unknown) => String(v).slice(0, 10);
const big = (v: unknown) => BigInt(v as string);

// Locks are always taken in the same order: invoices (sorted), then the
// receipt, then the legal entity. Competing receipts therefore queue instead
// of deadlocking, and each sees the balances the previous one left.
async function locked(tx: SQL, table: string, id: string, missing: string) {
  const r = (
    await tx.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id])
  ).rows[0];
  if (!r) throw new Problem(404, missing);
  return r;
}
const invoice = (tx: SQL, id: string) =>
  locked(tx, "invoices", id, "Invoice not found in this organization.");
const receiptRow = (tx: SQL, id: string) =>
  locked(
    tx,
    "customer_receipts",
    id,
    "Receipt not found in this organization.",
  );
async function entityOpen(tx: SQL, id: string, date: string) {
  const e = await locked(tx, "entities", id, "Legal entity not found.");
  if (e.lock_date && date <= day(e.lock_date))
    throw new Problem(
      409,
      "This accounting period is locked. Choose a later date.",
    );
  return e;
}
const remaining = (i: Row) =>
  big(i.total_minor) - big(i.paid_minor) - big(i.credited_minor);
const remainingBase = (i: Row) =>
  baseAmount(big(i.total_minor), big(i.fx_micros)) -
  big(i.paid_base_minor) -
  big(i.credited_base_minor);
async function settle(tx: SQL, i: Row, amount: bigint, base: bigint) {
  const paid = big(i.paid_minor) + amount,
    credited = big(i.credited_minor);
  await tx.query(
    "UPDATE invoices SET paid_minor=$2,paid_base_minor=$3,status=$4 WHERE id=$1",
    [
      i.id,
      String(paid),
      String(big(i.paid_base_minor) + base),
      paid + credited === big(i.total_minor)
        ? credited > 0n
          ? "Settled"
          : "Paid"
        : "Issued",
    ],
  );
}
async function reversed(tx: SQL, receiptId: string) {
  return (
    await tx.query(
      "SELECT * FROM customer_receipt_reversals WHERE receipt_id=$1",
      [receiptId],
    )
  ).rows[0];
}
// Unapplied cash already used by applications and refunds still in force.
async function usage(tx: SQL, receiptId: string) {
  const u = (
    await tx.query(
      `SELECT coalesce(sum(amount),0)::text AS amount,coalesce(sum(base),0)::text AS base FROM (
   SELECT a.amount_minor AS amount,a.liability_base_minor AS base FROM customer_receipt_applications a WHERE a.receipt_id=$1
    AND NOT EXISTS(SELECT 1 FROM customer_receipt_application_reversals r WHERE r.application_id=a.id)
   UNION ALL SELECT f.amount_minor,f.liability_base_minor FROM customer_receipt_refunds f WHERE f.receipt_id=$1
    AND NOT EXISTS(SELECT 1 FROM customer_receipt_refund_reversals r WHERE r.refund_id=f.id)) u`,
      [receiptId],
    )
  ).rows[0];
  return { amount: big(u.amount), base: big(u.base) };
}
// The PKR value an unapplied amount carries, taken from the receipt's own
// rate. Cumulative rounding means the last use clears the liability exactly.
function liabilityBase(
  r: Row,
  used: { amount: bigint; base: bigint },
  amount: bigint,
) {
  return (
    round(
      big(r.unapplied_base_minor) * (used.amount + amount),
      big(r.unapplied_minor),
    ) - used.base
  );
}
async function chronological(tx: SQL, receiptId: string, date: string) {
  const latest = (
    await tx.query(
      `SELECT max(d)::text AS date FROM (
    SELECT receipt_date AS d FROM customer_receipts WHERE id=$1
    UNION ALL SELECT application_date FROM customer_receipt_applications WHERE receipt_id=$1
    UNION ALL SELECT refund_date FROM customer_receipt_refunds WHERE receipt_id=$1
    UNION ALL SELECT r.reversal_date FROM customer_receipt_application_reversals r JOIN customer_receipt_applications a ON a.id=r.application_id WHERE a.receipt_id=$1
    UNION ALL SELECT r.reversal_date FROM customer_receipt_refund_reversals r JOIN customer_receipt_refunds f ON f.id=r.refund_id WHERE f.receipt_id=$1) h`,
      [receiptId],
    )
  ).rows[0].date;
  if (latest && date < day(latest))
    throw new Problem(
      409,
      "The date cannot precede the receipt or its latest application, refund or reversal.",
    );
}
async function reversePosting(
  tx: SQL,
  ctx: Context,
  entity: string,
  date: string,
  originalType: string,
  originalId: string,
  type: string,
  id: string,
  description: string,
) {
  const lines = (
    await tx.query(
      "SELECT l.* FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type=$1 AND j.source_id=$2",
      [originalType, originalId],
    )
  ).rows;
  await post(
    tx,
    ctx,
    entity,
    date,
    type,
    id,
    description,
    lines.map((l) => ({
      account: l.account_code,
      debit: big(l.credit_minor),
      credit: big(l.debit_minor),
    })),
  );
}
// A repeated reversal request with the same date and reason is the same
// reversal; anything else is refused rather than silently ignored.
function sameReversal(prior: Row | undefined, c: Row) {
  if (!prior) return null;
  if (day(prior.reversal_date) !== c.date || prior.reason !== c.reason)
    throw new Problem(
      409,
      "This record was already reversed with different details.",
    );
  return { id: prior.id as string };
}
const fxResult = (difference: bigint) =>
  difference >= 0n
    ? { account: "4100", credit: difference }
    : { account: "5100", debit: -difference };

export async function executeCustomerReceipt(tx: SQL, ctx: Context, c: Row) {
  if (!hasCapability(ctx, "books.post"))
    throw new Problem(
      403,
      "Permission to record financial transactions is required for customer receipts.",
    );
  const id = uuid(),
    t = ctx.tenantId;
  if (c.action === "customer-receipt.create") return create(tx, ctx, c, id);
  if (c.action === "customer-receipt.apply") {
    const i = await invoice(tx, c.invoice_id),
      r = await receiptRow(tx, c.receipt_id);
    await entityOpen(tx, r.entity_id, c.date);
    const prior = (
      await tx.query(
        "SELECT id,request_payload FROM customer_receipt_applications WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (!isDeepStrictEqual(prior.request_payload, c))
        throw new Problem(
          409,
          "This retry key was used for a different application.",
        );
      return { id: prior.id };
    }
    if (await reversed(tx, r.id))
      throw new Problem(409, "This receipt has been reversed.");
    if (
      i.entity_id !== r.entity_id ||
      i.company_id !== r.company_id ||
      i.currency !== r.currency
    )
      throw new Problem(
        400,
        "Unapplied cash can only settle an invoice for the same customer, legal entity and currency.",
      );
    if (i.status !== "Issued")
      throw new Problem(
        409,
        "Only an issued invoice with a balance can be settled.",
      );
    if (c.date < day(i.issue_date))
      throw new Problem(
        400,
        "The application date cannot precede the invoice date.",
      );
    await chronological(tx, r.id, c.date);
    const amount = minor(c.amount),
      used = await usage(tx, r.id),
      left = remaining(i);
    if (
      amount <= 0n ||
      amount > big(r.unapplied_minor) - used.amount ||
      amount > left
    )
      throw new Problem(
        400,
        "Enter an amount within both the unapplied cash and the invoice balance.",
      );
    const liability = liabilityBase(r, used, amount),
      ar = round(remainingBase(i) * amount, left);
    await tx.query(
      "INSERT INTO customer_receipt_applications(id,tenant_id,receipt_id,invoice_id,application_date,amount_minor,liability_base_minor,ar_base_minor,created_by,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
        t,
        r.id,
        i.id,
        c.date,
        String(amount),
        String(liability),
        String(ar),
        ctx.userId,
        c.request_key,
        JSON.stringify(c),
      ],
    );
    await settle(tx, i, amount, ar);
    await post(
      tx,
      ctx,
      r.entity_id,
      c.date,
      "customer-receipt-application",
      id,
      `Unapplied cash ${r.reference} applied to ${i.number}`,
      [
        { account: "2410", debit: liability },
        { account: "1100", credit: ar },
        fxResult(liability - ar),
      ],
    );
    await audit(tx, ctx, i.id, c.action, {
      receiptId: r.id,
      actorName: ctx.name || null,
      text: `Applied ${c.amount} ${r.currency} of unapplied cash from receipt ${r.reference} to ${i.number}.`,
    });
    return { id };
  }
  if (c.action === "customer-receipt.refund") {
    const r = await receiptRow(tx, c.receipt_id);
    await entityOpen(tx, r.entity_id, c.date);
    const prior = (
      await tx.query(
        "SELECT id,request_payload FROM customer_receipt_refunds WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (!isDeepStrictEqual(prior.request_payload, c))
        throw new Problem(
          409,
          "This retry key was used for a different refund.",
        );
      return { id: prior.id };
    }
    if (await reversed(tx, r.id))
      throw new Problem(409, "This receipt has been reversed.");
    await chronological(tx, r.id, c.date);
    const amount = minor(c.amount),
      fx = scaled(c.fx, 6),
      used = await usage(tx, r.id);
    if (fx <= 0n || (r.currency === "PKR" && fx !== 1_000_000n))
      throw new Problem(400, "Enter a valid exchange rate; PKR must use 1.");
    if (amount <= 0n || amount > big(r.unapplied_minor) - used.amount)
      throw new Problem(
        400,
        "Enter a refund within the unapplied cash still available.",
      );
    const bankCode = await cashAccount(
        tx,
        r.entity_id,
        c.bank_account_id,
        c.date,
      ),
      liability = liabilityBase(r, used, amount),
      paid = baseAmount(amount, fx);
    await tx.query(
      "INSERT INTO customer_receipt_refunds(id,tenant_id,receipt_id,refund_date,amount_minor,liability_base_minor,fx_micros,bank_account_id,reference,created_by,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        id,
        t,
        r.id,
        c.date,
        String(amount),
        String(liability),
        String(fx),
        c.bank_account_id || null,
        c.reference,
        ctx.userId,
        c.request_key,
        JSON.stringify(c),
      ],
    );
    await post(
      tx,
      ctx,
      r.entity_id,
      c.date,
      "customer-receipt-refund",
      id,
      `Refund of unapplied cash ${r.reference} · ${r.customer_name}`,
      [
        { account: "2410", debit: liability },
        { account: bankCode, credit: paid },
        fxResult(liability - paid),
      ],
    );
    await audit(tx, ctx, r.id, c.action, {
      actorName: ctx.name || null,
      text: `Recorded a refund of ${c.amount} ${r.currency} of unapplied cash to ${r.customer_name} (${c.reference}). No bank transfer was initiated.`,
    });
    return { id };
  }
  if (c.action === "customer-receipt.reverse-application") {
    const a = (
      await tx.query(
        "SELECT * FROM customer_receipt_applications WHERE id=$1",
        [c.id],
      )
    ).rows[0];
    if (!a)
      throw new Problem(404, "Application not found in this organization.");
    const i = await invoice(tx, a.invoice_id),
      r = await receiptRow(tx, a.receipt_id);
    await entityOpen(tx, r.entity_id, c.date);
    const same = sameReversal(
      (
        await tx.query(
          "SELECT * FROM customer_receipt_application_reversals WHERE application_id=$1",
          [a.id],
        )
      ).rows[0],
      c,
    );
    if (same) return same;
    await chronological(tx, r.id, c.date);
    await reversePosting(
      tx,
      ctx,
      r.entity_id,
      c.date,
      "customer-receipt-application",
      a.id,
      "customer-receipt-application-reversal",
      id,
      `Reverse application of ${r.reference} to ${i.number}: ${c.reason}`,
    );
    await tx.query(
      "INSERT INTO customer_receipt_application_reversals(id,tenant_id,application_id,reversal_date,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [id, t, a.id, c.date, c.reason, ctx.userId],
    );
    await settle(tx, i, -big(a.amount_minor), -big(a.ar_base_minor));
    await audit(tx, ctx, i.id, c.action, {
      receiptId: r.id,
      actorName: ctx.name || null,
      text: `Reversed the application of receipt ${r.reference} to ${i.number}: ${c.reason}. The cash is unapplied again.`,
    });
    return { id };
  }
  if (c.action === "customer-receipt.reverse-refund") {
    const f = (
      await tx.query("SELECT * FROM customer_receipt_refunds WHERE id=$1", [
        c.id,
      ])
    ).rows[0];
    if (!f) throw new Problem(404, "Refund not found in this organization.");
    const r = await receiptRow(tx, f.receipt_id);
    await entityOpen(tx, r.entity_id, c.date);
    const same = sameReversal(
      (
        await tx.query(
          "SELECT * FROM customer_receipt_refund_reversals WHERE refund_id=$1",
          [f.id],
        )
      ).rows[0],
      c,
    );
    if (same) return same;
    await chronological(tx, r.id, c.date);
    await cashAccount(tx, r.entity_id, f.bank_account_id, c.date);
    await reversePosting(
      tx,
      ctx,
      r.entity_id,
      c.date,
      "customer-receipt-refund",
      f.id,
      "customer-receipt-refund-reversal",
      id,
      `Reverse refund ${f.reference}: ${c.reason}`,
    );
    await tx.query(
      "INSERT INTO customer_receipt_refund_reversals(id,tenant_id,refund_id,reversal_date,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [id, t, f.id, c.date, c.reason, ctx.userId],
    );
    await audit(tx, ctx, r.id, c.action, {
      actorName: ctx.name || null,
      text: `Reversed refund ${f.reference}: ${c.reason}. The cash is unapplied again.`,
    });
    return { id };
  }
  if (c.action === "customer-receipt.reverse") {
    const allocations = (
      await tx.query(
        "SELECT * FROM customer_receipt_allocations WHERE receipt_id=$1 ORDER BY invoice_id",
        [c.id],
      )
    ).rows;
    const invoices: Row[] = [];
    for (const a of allocations) invoices.push(await invoice(tx, a.invoice_id));
    const r = await receiptRow(tx, c.id);
    await entityOpen(tx, r.entity_id, c.date);
    const same = sameReversal(await reversed(tx, r.id), c);
    if (same) return same;
    if ((await usage(tx, r.id)).amount > 0n)
      throw new Problem(
        409,
        "Reverse this receipt's applications and refunds before reversing the receipt.",
      );
    await chronological(tx, r.id, c.date);
    await cashAccount(tx, r.entity_id, r.bank_account_id, c.date);
    await reversePosting(
      tx,
      ctx,
      r.entity_id,
      c.date,
      "customer-receipt",
      r.id,
      "customer-receipt-reversal",
      id,
      `Reverse receipt ${r.reference} · ${r.customer_name}: ${c.reason}`,
    );
    await tx.query(
      "INSERT INTO customer_receipt_reversals(id,tenant_id,receipt_id,reversal_date,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [id, t, r.id, c.date, c.reason, ctx.userId],
    );
    for (const [n, a] of allocations.entries()) {
      await settle(
        tx,
        invoices[n],
        -(
          big(a.amount_minor) +
          big(a.wht_minor) +
          big(a.sales_tax_withheld_minor)
        ),
        -big(a.carrying_minor),
      );
      await audit(tx, ctx, a.invoice_id, c.action, {
        receiptId: r.id,
        actorName: ctx.name || null,
        text: `Reversed receipt ${r.reference}: ${c.reason}. ${invoices[n].number} is open again.`,
      });
    }
    await audit(tx, ctx, r.id, c.action, {
      actorName: ctx.name || null,
      text: `Reversed receipt ${r.reference} from ${r.customer_name}: ${c.reason}.`,
    });
    return { id };
  }
  throw new Problem(400, "Unknown customer receipt action.");
}

async function create(tx: SQL, ctx: Context, c: Row, id: string) {
  const problem = receiptProblem(c as never);
  if (problem) throw new Problem(400, problem);
  const allocations: Row[] = [...c.allocations].sort((a, b) =>
    a.invoice_id.localeCompare(b.invoice_id),
  );
  if (new Set(allocations.map((a) => a.invoice_id)).size !== allocations.length)
    throw new Problem(400, "Select each invoice only once.");
  const invoices: Row[] = [];
  for (const a of allocations) invoices.push(await invoice(tx, a.invoice_id));
  const entity = await entityOpen(tx, c.entity_id, c.date);
  const prior = (
    await tx.query(
      "SELECT id,request_payload FROM customer_receipts WHERE request_key=$1",
      [c.request_key],
    )
  ).rows[0];
  if (prior) {
    if (!isDeepStrictEqual(prior.request_payload, c))
      throw new Problem(
        409,
        "This retry key was used for a different receipt.",
      );
    return { id: prior.id };
  }
  const company = (
    await tx.query("SELECT id,name,customer FROM companies WHERE id=$1", [
      c.company_id,
    ])
  ).rows[0];
  if (!company)
    throw new Problem(404, "Customer not found in this organization.");
  if (!company.customer)
    throw new Problem(
      400,
      "Mark this company as a customer before recording a receipt.",
    );
  const fx = scaled(c.fx, 6);
  if (fx <= 0n || (c.currency === "PKR" && fx !== 1_000_000n))
    throw new Problem(400, "Enter a valid exchange rate; PKR must use 1.");
  const totals = receiptTotals(c as never);
  const prepared = allocations.map((a, n) => {
    const i = invoices[n],
      amount = minor(a.amount),
      wht = minor(a.wht),
      salesTax = minor(a.sales_tax_withheld),
      settled = amount + wht + salesTax,
      left = remaining(i);
    if (
      i.entity_id !== entity.id ||
      i.company_id !== company.id ||
      i.currency !== c.currency
    )
      throw new Problem(
        400,
        "Every invoice must belong to this customer, legal entity and currency.",
      );
    if (i.status !== "Issued" || left <= 0n)
      throw new Problem(
        409,
        `${i.number || "An invoice"} is not open for payment. Refresh and review the allocation.`,
      );
    if (c.date < day(i.issue_date))
      throw new Problem(
        400,
        `The receipt date cannot precede invoice ${i.number}.`,
      );
    if (settled > left)
      throw new Problem(
        400,
        `The allocation to ${i.number} exceeds its outstanding balance. Refresh and review.`,
      );
    return {
      i,
      amount,
      wht,
      salesTax,
      settled,
      carrying: round(remainingBase(i) * settled, left),
    };
  });
  const bankCode = await cashAccount(tx, entity.id, c.bank_account_id, c.date);
  const cashBase = baseAmount(totals.cash, fx),
    feeBase = baseAmount(totals.fee, fx),
    whtBase = baseAmount(totals.wht, fx),
    salesTaxBase = baseAmount(totals.salesTax, fx),
    allocatedBase =
      totals.cash > 0n
        ? round(cashBase * totals.allocatedCash, totals.cash)
        : 0n,
    unappliedBase = cashBase - allocatedBase,
    carrying = prepared.reduce((s, a) => s + a.carrying, 0n);
  if (totals.unapplied > 0n && unappliedBase <= 0n)
    throw new Problem(
      400,
      "Unapplied cash must convert to at least one PKR minor unit.",
    );
  await tx.query(
    "INSERT INTO customer_receipts(id,tenant_id,entity_id,company_id,customer_name,currency,receipt_date,amount_minor,wht_minor,sales_tax_withheld_minor,fee_minor,unapplied_minor,fx_micros,cash_base_minor,unapplied_base_minor,bank_account_id,reference,notes,created_by,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)",
    [
      id,
      ctx.tenantId,
      entity.id,
      company.id,
      company.name,
      c.currency,
      c.date,
      String(totals.cash),
      String(totals.wht),
      String(totals.salesTax),
      String(totals.fee),
      String(totals.unapplied),
      String(fx),
      String(cashBase),
      String(unappliedBase),
      c.bank_account_id || null,
      c.reference,
      c.notes || "",
      ctx.userId,
      c.request_key,
      JSON.stringify(c),
    ],
  );
  // Cumulative rounding: each invoice's PKR share is the running total less
  // what earlier invoices took, so the shares always add up exactly.
  let cash = 0n,
    wht = 0n,
    salesTax = 0n,
    cashTo = 0n,
    whtTo = 0n,
    salesTaxTo = 0n,
    feeTo = 0n;
  for (const a of prepared) {
    cash += a.amount;
    wht += a.wht;
    salesTax += a.salesTax;
    const nextCash = totals.allocatedCash
        ? round(allocatedBase * cash, totals.allocatedCash)
        : 0n,
      nextWht = totals.wht ? round(whtBase * wht, totals.wht) : 0n,
      nextSalesTax = totals.salesTax
        ? round(salesTaxBase * salesTax, totals.salesTax)
        : 0n,
      nextFee = totals.cash ? round(feeBase * cash, totals.cash) : 0n;
    await tx.query(
      "INSERT INTO customer_receipt_allocations(id,tenant_id,receipt_id,invoice_id,amount_minor,wht_minor,sales_tax_withheld_minor,carrying_minor,cash_base_minor,wht_base_minor,sales_tax_base_minor,fee_base_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        uuid(),
        ctx.tenantId,
        id,
        a.i.id,
        String(a.amount),
        String(a.wht),
        String(a.salesTax),
        String(a.carrying),
        String(nextCash - cashTo),
        String(nextWht - whtTo),
        String(nextSalesTax - salesTaxTo),
        String(nextFee - feeTo),
      ],
    );
    cashTo = nextCash;
    whtTo = nextWht;
    salesTaxTo = nextSalesTax;
    feeTo = nextFee;
    await settle(tx, a.i, a.settled, a.carrying);
    await audit(tx, ctx, a.i.id, c.action, {
      receiptId: id,
      actorName: ctx.name || null,
      text: `Receipt ${c.reference} settled ${a.i.number}. No bank transfer was initiated.`,
    });
  }
  await post(
    tx,
    ctx,
    entity.id,
    c.date,
    "customer-receipt",
    id,
    `Receipt ${c.reference} · ${company.name}${prepared.length ? ` (${prepared.length} invoice${prepared.length === 1 ? "" : "s"})` : " (unapplied)"}`,
    [
      { account: bankCode, debit: cashBase - feeBase },
      { account: "5300", debit: feeBase },
      { account: "1200", debit: whtBase },
      { account: "1210", debit: salesTaxBase },
      { account: "1100", credit: carrying },
      { account: "2410", credit: unappliedBase },
      fxResult(allocatedBase + whtBase + salesTaxBase - carrying),
    ],
  );
  await audit(tx, ctx, id, c.action, {
    actorName: ctx.name || null,
    text: `Recorded receipt ${c.reference} from ${company.name}: ${c.amount} ${c.currency} cash across ${prepared.length} invoice${prepared.length === 1 ? "" : "s"}${totals.unapplied > 0n ? ", with unapplied cash held for the customer" : ""}.`,
  });
  return { id };
}

export async function customerReceiptSnapshot(tx: SQL, ctx: Context) {
  if (!hasCapability(ctx, "books.view"))
    return {
      customerReceipts: [],
      customerReceiptAllocations: [],
      customerReceiptApplications: [],
      customerReceiptRefunds: [],
    };
  const q = async (sql: string) => (await tx.query(sql)).rows;
  return {
    customerReceipts:
      await q(`SELECT r.id,r.entity_id,r.company_id,r.customer_name,r.currency,r.receipt_date,r.amount_minor::text,r.wht_minor::text,
      r.sales_tax_withheld_minor::text,r.fee_minor::text,r.unapplied_minor::text,r.fx_micros::text,r.bank_account_id,r.reference,r.notes,
      v.reversal_date,v.reason AS reversal_reason,
      (CASE WHEN v.id IS NOT NULL THEN 0 ELSE r.unapplied_minor
        -coalesce((SELECT sum(a.amount_minor) FROM customer_receipt_applications a WHERE a.receipt_id=r.id AND NOT EXISTS(SELECT 1 FROM customer_receipt_application_reversals x WHERE x.application_id=a.id)),0)
        -coalesce((SELECT sum(f.amount_minor) FROM customer_receipt_refunds f WHERE f.receipt_id=r.id AND NOT EXISTS(SELECT 1 FROM customer_receipt_refund_reversals x WHERE x.refund_id=f.id)),0) END)::text AS available_minor
      FROM customer_receipts r LEFT JOIN customer_receipt_reversals v ON v.receipt_id=r.id ORDER BY r.receipt_date DESC,r.created_at DESC`),
    customerReceiptAllocations: await q(
      "SELECT id,receipt_id,invoice_id,amount_minor::text,wht_minor::text,sales_tax_withheld_minor::text FROM customer_receipt_allocations",
    ),
    customerReceiptApplications:
      await q(`SELECT a.id,a.receipt_id,a.invoice_id,a.application_date,a.amount_minor::text,v.reversal_date,v.reason AS reversal_reason
      FROM customer_receipt_applications a LEFT JOIN customer_receipt_application_reversals v ON v.application_id=a.id ORDER BY a.application_date,a.created_at`),
    customerReceiptRefunds:
      await q(`SELECT f.id,f.receipt_id,f.refund_date,f.amount_minor::text,f.fx_micros::text,f.bank_account_id,f.reference,v.reversal_date,v.reason AS reversal_reason
      FROM customer_receipt_refunds f LEFT JOIN customer_receipt_refund_reversals v ON v.refund_id=f.id ORDER BY f.refund_date,f.created_at`),
  };
}
