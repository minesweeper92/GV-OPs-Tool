import { randomUUID as uuid } from "node:crypto";
import { Problem, post, audit, type Context } from "./domain.ts";
import type { SQL, Row } from "./db.ts";
import { minor, scaled, round, baseAmount } from "../shared/money.ts";
import { cashAccount } from "./bank-account.ts";
import { signedMinor } from "../shared/banking.ts";
import { hasCapability } from "../shared/permissions.ts";
const day = (v: unknown) => String(v).slice(0, 10);
const sum = (rows: Row[], key: string) =>
  rows.reduce((s, r) => s + BigInt(r[key]), 0n);
async function get(tx: SQL, table: string, id: string, lock = true) {
  const r = (
    await tx.query(
      `SELECT * FROM ${table} WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  if (!r) throw new Problem(404, "Record not found in this organization.");
  return r;
}
async function entityDate(tx: SQL, entity: string, date: string) {
  const e = await get(tx, "entities", entity);
  if (e.lock_date && date <= day(e.lock_date))
    throw new Problem(409, "This accounting period is locked.");
  return e;
}
async function retry(tx: SQL, table: string, c: Row) {
  const p = (
    await tx.query(
      `SELECT id,request_payload FROM ${table} WHERE request_key=$1`,
      [c.request_key],
    )
  ).rows[0];
  if (
    p &&
    JSON.stringify(Object.entries(p.request_payload).sort()) !==
      JSON.stringify(Object.entries(c).sort())
  )
    throw new Problem(
      409,
      "This retry key was used for a different transaction.",
    );
  return p;
}
export async function invoiceCredits(tx: SQL, id: string) {
  return (
    await tx.query(
      "SELECT c.* FROM credit_notes c WHERE invoice_id=$1 AND NOT EXISTS(SELECT 1 FROM credit_reversals r WHERE r.credit_id=c.id)",
      [id],
    )
  ).rows;
}
async function invoice(tx: SQL, id: string): Promise<Row> {
  return get(tx, "invoices", id);
}
async function activeCredit(tx: SQL, id: string) {
  const c = await get(tx, "credit_notes", id);
  if (
    (await tx.query("SELECT id FROM credit_reversals WHERE credit_id=$1", [id]))
      .rows.length
  )
    throw new Problem(409, "This credit note has been reversed.");
  return c;
}
async function usage(tx: SQL, id: string) {
  return (
    await tx.query(
      `SELECT coalesce(sum(amount),0)::text AS amount,coalesce(sum(base),0)::text AS base FROM (
 SELECT amount_minor AS amount,credit_base_minor AS base FROM credit_applications a WHERE credit_id=$1 AND NOT EXISTS(SELECT 1 FROM application_reversals r WHERE r.application_id=a.id)
 UNION ALL SELECT amount_minor,credit_base_minor FROM customer_refunds f WHERE credit_id=$1 AND NOT EXISTS(SELECT 1 FROM refund_reversals r WHERE r.refund_id=f.id)) u`,
      [id],
    )
  ).rows[0];
}
async function chronological(tx: SQL, creditId: string, date: string) {
  const latest = (
    await tx.query(
      `SELECT max(d)::text AS date FROM (
    SELECT credit_date AS d FROM credit_notes WHERE id=$1
    UNION ALL SELECT application_date FROM credit_applications WHERE credit_id=$1
    UNION ALL SELECT refund_date FROM customer_refunds WHERE credit_id=$1
    UNION ALL SELECT r.reversal_date FROM application_reversals r JOIN credit_applications a ON a.id=r.application_id WHERE a.credit_id=$1
    UNION ALL SELECT r.reversal_date FROM refund_reversals r JOIN customer_refunds f ON f.id=r.refund_id WHERE f.credit_id=$1
  ) history`,
      [creditId],
    )
  ).rows[0].date;
  if (latest && date < latest)
    throw new Problem(
      409,
      "Date cannot precede the latest application, refund or reversal on this credit note.",
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
  reason: string,
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
    reason,
    lines.map((l) => ({
      account: l.account_code,
      debit: BigInt(l.credit_minor),
      credit: BigInt(l.debit_minor),
    })),
  );
}
async function updateCredits(tx: SQL, i: Row, amount: bigint, base: bigint) {
  const credited = BigInt(i.credited_minor) + amount,
    creditedBase = BigInt(i.credited_base_minor) + base;
  await tx.query(
    "UPDATE invoices SET credited_minor=$2,credited_base_minor=$3,status=$4 WHERE id=$1",
    [
      i.id,
      String(credited),
      String(creditedBase),
      BigInt(i.paid_minor) + credited === BigInt(i.total_minor)
        ? "Settled"
        : "Issued",
    ],
  );
}
export async function executeCredit(tx: SQL, ctx: Context, c: Row) {
  if (!hasCapability(ctx, "books.post"))
    throw new Problem(
      403,
      "A finance role is required for credits and refunds.",
    );
  let id = uuid();
  if (c.action === "credit.create") {
    const i = await invoice(tx, c.invoice_id),
      prior = await retry(tx, "credit_notes", c);
    if (prior) return { id: prior.id };
    if (i.opening_batch_id)
      throw new Problem(
        409,
        "Opening receivables cannot use a revenue credit note. Record a reviewed opening-balance adjustment instead.",
      );
    if (!["Issued", "Paid", "Settled"].includes(i.status))
      throw new Problem(409, "Choose an issued invoice.");
    if (c.date < day(i.issue_date))
      throw new Problem(400, "Credit date cannot precede the invoice.");
    const e = await entityDate(tx, i.entity_id, c.date),
      existing = await invoiceCredits(tx, i.id);
    const latest = (
      await tx.query(
        "SELECT max(recognition_date)::text AS date FROM revenue_recognitions WHERE invoice_id=$1",
        [i.id],
      )
    ).rows[0].date;
    if (latest && c.date < latest)
      throw new Problem(
        409,
        "Credit date cannot precede recorded revenue recognition.",
      );
    if (existing.some((x) => day(x.credit_date) > c.date))
      throw new Problem(409, "Credit date cannot precede an existing credit.");
    const reversed = (
      await tx.query(
        "SELECT max(r.reversal_date)::text AS date FROM credit_reversals r JOIN credit_notes n ON n.id=r.credit_id WHERE n.invoice_id=$1",
        [i.id],
      )
    ).rows[0].date;
    if (reversed && c.date < reversed)
      throw new Problem(
        409,
        "Credit date cannot precede an earlier credit reversal.",
      );
    let net = 0n,
      tax = 0n;
    const lines: Row[] = [],
      seen = new Set<number>();
    for (const selection of c.lines) {
      if (seen.has(selection.index) || !i.lines[selection.index])
        throw new Problem(400, "Select each valid invoice line once.");
      seen.add(selection.index);
      const source = i.lines[selection.index],
        used = existing
          .flatMap((x) => x.lines)
          .filter((x) => x.invoiceLine === selection.index),
        available = BigInt(source.subtotal) - sum(used, "subtotal"),
        amount = minor(selection.amount);
      if (amount <= 0n || amount > available)
        throw new Problem(
          409,
          "Credit exceeds an invoice line’s remaining subtotal.",
        );
      const taxPart = round(
        (BigInt(source.taxMinor) - sum(used, "taxMinor")) * amount,
        available,
      );
      lines.push({
        invoiceLine: selection.index,
        description: source.description,
        subtotal: String(amount),
        taxMinor: String(taxPart),
        tax: source.tax,
      });
      net += amount;
      tax += taxPart;
    }
    const recognized = (
      await tx.query(
        "SELECT coalesce(sum(net_minor),0)::text AS net,coalesce(sum(base_minor),0)::text AS base FROM revenue_recognitions WHERE invoice_id=$1",
        [i.id],
      )
    ).rows[0];
    const adjustment = signedMinor(c.adjustment_amount || "0"),
      originalAdjustment = BigInt(i.adjustment_minor || 0),
      remainingAdjustment =
        originalAdjustment - sum(existing, "adjustment_minor"),
      total = net + tax + adjustment;
    if (
      adjustment !== 0n &&
      (originalAdjustment === 0n ||
        adjustment > 0n !== originalAdjustment > 0n ||
        (adjustment < 0n ? -adjustment : adjustment) >
          (remainingAdjustment < 0n
            ? -remainingAdjustment
            : remainingAdjustment))
    )
      throw new Problem(
        409,
        "Adjustment exceeds the invoice’s remaining adjustment or has the wrong sign.",
      );
    if (total <= 0n)
      throw new Problem(
        400,
        "Credit total must be positive after its adjustment.",
      );
    if (total + sum(existing, "total_minor") > BigInt(i.total_minor))
      throw new Problem(
        409,
        "The selected item credit exceeds the invoice total after its post-tax adjustment.",
      );
    if (i.billing_kind === "earned" && c.treatment !== "earned")
      throw new Problem(
        400,
        "This invoice contains earned revenue, not an advance.",
      );
    const bucket = existing.filter((x) => x.treatment === c.treatment);
    const posted = (
      await tx.query(
        `SELECT l.account_code, sum(l.credit_minor-l.debit_minor)::text AS amount
       FROM journal_lines l JOIN journals j ON j.id=l.journal_id
       WHERE j.source_type='invoice' AND j.source_id=$1 GROUP BY l.account_code`,
        [i.id],
      )
    ).rows;
    const postedAmount = (account: string) =>
      BigInt(posted.find((l) => l.account_code === account)?.amount || 0);
    const fullNetBase = postedAmount(
        i.billing_kind === "advance" ? "2300" : "4000",
      ),
      fullTaxBase = postedAmount("2100"),
      fullAdjustmentBase = postedAmount("4020");
    const bucketNet =
      i.billing_kind === "earned"
        ? BigInt(i.net_minor)
        : c.treatment === "earned"
          ? BigInt(recognized.net)
          : BigInt(i.net_minor) - BigInt(recognized.net);
    const bucketBase =
      i.billing_kind === "earned"
        ? fullNetBase
        : c.treatment === "earned"
          ? BigInt(recognized.base)
          : fullNetBase - BigInt(recognized.base);
    if (net > bucketNet - sum(bucket, "net_minor"))
      throw new Problem(
        409,
        "Credit exceeds the selected earned/deferred revenue balance.",
      );
    const netBase =
      net === 0n
        ? 0n
        : round(
            (bucketBase - sum(bucket, "net_base_minor")) * net,
            bucketNet - sum(bucket, "net_minor"),
          );
    const remainingTax = BigInt(i.tax_minor) - sum(existing, "tax_minor"),
      taxBase =
        tax === 0n
          ? BigInt(i.tax_minor) === 0n && net > 0n
            ? round(
                (fullTaxBase - sum(existing, "tax_base_minor")) * net,
                BigInt(i.net_minor) - sum(existing, "net_minor"),
              )
            : 0n
          : round(
              (fullTaxBase - sum(existing, "tax_base_minor")) * tax,
              remainingTax,
            ),
      remainingAdjustmentBase =
        fullAdjustmentBase - sum(existing, "adjustment_base_minor"),
      adjustmentBase =
        adjustment === 0n
          ? 0n
          : (remainingAdjustmentBase < 0n ? -1n : 1n) *
            round(
              (remainingAdjustmentBase < 0n
                ? -remainingAdjustmentBase
                : remainingAdjustmentBase) *
                (adjustment < 0n ? -adjustment : adjustment),
              remainingAdjustment < 0n
                ? -remainingAdjustment
                : remainingAdjustment,
            ),
      base = netBase + taxBase + adjustmentBase;
    if (base <= 0n) throw new Problem(400, "Credit rounds to zero in PKR.");
    const number = `${e.code}-CN-${String(e.next_credit).padStart(5, "0")}`;
    await tx.query(
      "UPDATE entities SET next_credit=next_credit+1 WHERE id=$1",
      [e.id],
    );
    await tx.query(
      `INSERT INTO credit_notes(id,tenant_id,entity_id,invoice_id,number,credit_date,lines,net_minor,tax_minor,total_minor,net_base_minor,tax_base_minor,base_minor,treatment,reason,request_key,request_payload,adjustment_minor,adjustment_base_minor)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        id,
        ctx.tenantId,
        i.entity_id,
        i.id,
        number,
        c.date,
        JSON.stringify(lines),
        String(net),
        String(tax),
        String(total),
        String(netBase),
        String(taxBase),
        String(base),
        c.treatment,
        c.reason,
        c.request_key,
        JSON.stringify(c),
        String(adjustment),
        String(adjustmentBase),
      ],
    );
    await post(
      tx,
      ctx,
      i.entity_id,
      c.date,
      "credit",
      id,
      `${number}: ${c.reason}`,
      [
        {
          account: c.treatment === "deferred" ? "2300" : "4000",
          debit: netBase,
        },
        { account: "2100", debit: taxBase },
        {
          account: "4020",
          ...(adjustmentBase >= 0n
            ? { debit: adjustmentBase }
            : { credit: -adjustmentBase }),
        },
        { account: "2400", credit: base },
      ],
    );
  } else if (c.action === "credit.apply" || c.action === "credit.refund") {
    const credit = await activeCredit(tx, c.credit_id),
      source = await invoice(tx, credit.invoice_id),
      table =
        c.action === "credit.apply"
          ? "credit_applications"
          : "customer_refunds";
    const prior = await retry(tx, table, c);
    if (prior) return { id: prior.id };
    await entityDate(tx, credit.entity_id, c.date);
    await chronological(tx, credit.id, c.date);
    if (c.date < day(credit.credit_date))
      throw new Problem(
        400,
        "Transaction date cannot precede the credit note.",
      );
    const used = await usage(tx, credit.id),
      amount = minor(c.amount),
      remaining = BigInt(credit.total_minor) - BigInt(used.amount);
    if (amount <= 0n || amount > remaining)
      throw new Problem(409, "Amount exceeds the available customer credit.");
    const carrying = round(
      (BigInt(credit.base_minor) - BigInt(used.base)) * amount,
      remaining,
    );
    if (c.action === "credit.apply") {
      const i =
        c.invoice_id === source.id ? source : await invoice(tx, c.invoice_id);
      if (
        i.entity_id !== credit.entity_id ||
        i.company_id !== source.company_id ||
        i.currency !== source.currency
      )
        throw new Problem(
          409,
          "Credits require the same customer, currency and issuing entity.",
        );
      if (
        i.status !== "Issued" ||
        c.date < day(i.issue_date) ||
        amount >
          BigInt(i.total_minor) -
            BigInt(i.paid_minor) -
            BigInt(i.credited_minor)
      )
        throw new Problem(
          409,
          "Choose an open invoice and an amount within its balance.",
        );
      const settled = BigInt(i.paid_minor) + BigInt(i.credited_minor),
        base = round(
          (baseAmount(BigInt(i.total_minor), BigInt(i.fx_micros)) -
            BigInt(i.paid_base_minor) -
            BigInt(i.credited_base_minor)) *
            amount,
          BigInt(i.total_minor) - settled,
        ),
        gain = carrying - base;
      if (carrying === 0n && base === 0n)
        throw new Problem(
          400,
          "Application rounds to zero in PKR; use a larger amount.",
        );
      await tx.query(
        "INSERT INTO credit_applications(id,tenant_id,credit_id,invoice_id,application_date,amount_minor,credit_base_minor,ar_base_minor,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          ctx.tenantId,
          credit.id,
          i.id,
          c.date,
          String(amount),
          String(carrying),
          String(base),
          c.request_key,
          JSON.stringify(c),
        ],
      );
      await post(
        tx,
        ctx,
        i.entity_id,
        c.date,
        "credit-application",
        id,
        `Apply ${credit.number} to ${i.number}`,
        [
          { account: "2400", debit: carrying },
          { account: "1100", credit: base },
          gain >= 0n
            ? { account: "4100", credit: gain }
            : { account: "5100", debit: -gain },
        ],
      );
      await updateCredits(tx, i, amount, base);
    } else {
      const fx = scaled(c.fx, 6);
      if (fx <= 0n || (source.currency === "PKR" && fx !== 1000000n))
        throw new Problem(400, "Use a valid refund exchange rate.");
      const bank = await cashAccount(
          tx,
          credit.entity_id,
          c.bank_account_id,
          c.date,
        ),
        cash = baseAmount(amount, fx),
        gain = carrying - cash;
      if (cash <= 0n) throw new Problem(400, "Refund rounds to zero in PKR.");
      await tx.query(
        "INSERT INTO customer_refunds(id,tenant_id,credit_id,refund_date,amount_minor,credit_base_minor,fx_micros,bank_account_id,reference,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          id,
          ctx.tenantId,
          credit.id,
          c.date,
          String(amount),
          String(carrying),
          String(fx),
          c.bank_account_id,
          c.reference,
          c.request_key,
          JSON.stringify(c),
        ],
      );
      await post(
        tx,
        ctx,
        credit.entity_id,
        c.date,
        "customer-refund",
        id,
        `Refund ${credit.number}: ${c.reference}`,
        [
          { account: "2400", debit: carrying },
          { account: bank, credit: cash },
          gain >= 0n
            ? { account: "4100", credit: gain }
            : { account: "5100", debit: -gain },
        ],
      );
    }
  } else {
    const isCredit = c.action === "credit.reverse",
      isApply = c.action === "credit.unapply";
    const original = await get(
        tx,
        isCredit
          ? "credit_notes"
          : isApply
            ? "credit_applications"
            : "customer_refunds",
        c.id,
        false,
      ),
      credit = await get(
        tx,
        "credit_notes",
        isCredit ? c.id : original.credit_id,
      ),
      i = await invoice(tx, isApply ? original.invoice_id : credit.invoice_id);
    const table = isCredit
        ? "credit_reversals"
        : isApply
          ? "application_reversals"
          : "refund_reversals",
      key = isCredit ? "credit_id" : isApply ? "application_id" : "refund_id";
    const prior = (
      await tx.query(`SELECT id FROM ${table} WHERE ${key}=$1`, [c.id])
    ).rows[0];
    if (prior) return { id: prior.id };
    await entityDate(tx, credit.entity_id, c.date);
    await chronological(tx, credit.id, c.date);
    const originalDate = isCredit
      ? credit.credit_date
      : isApply
        ? original.application_date
        : original.refund_date;
    if (c.date < day(originalDate))
      throw new Problem(
        400,
        "Reversal cannot precede the original transaction.",
      );
    if (isCredit) {
      if (BigInt((await usage(tx, credit.id)).amount) > 0n)
        throw new Problem(
          409,
          "Reverse all applications and refunds before reversing this credit.",
        );
      const latest = (
        await tx.query(
          `SELECT max(d)::text AS date FROM (SELECT r.reversal_date AS d FROM application_reversals r JOIN credit_applications a ON a.id=r.application_id WHERE a.credit_id=$1 UNION ALL SELECT r.reversal_date FROM refund_reversals r JOIN customer_refunds f ON f.id=r.refund_id WHERE f.credit_id=$1) x`,
          [credit.id],
        )
      ).rows[0].date;
      if (latest && c.date < latest)
        throw new Problem(
          409,
          "Credit reversal cannot precede its application/refund reversals.",
        );
    }
    await tx.query(
      `INSERT INTO ${table}(id,tenant_id,${key},reversal_date,reason) VALUES($1,$2,$3,$4,$5)`,
      [id, ctx.tenantId, c.id, c.date, c.reason],
    );
    await reversePosting(
      tx,
      ctx,
      credit.entity_id,
      c.date,
      isCredit ? "credit" : isApply ? "credit-application" : "customer-refund",
      c.id,
      isCredit
        ? "credit-reversal"
        : isApply
          ? "credit-application-reversal"
          : "customer-refund-reversal",
      id,
      c.reason,
    );
    if (isApply)
      await updateCredits(
        tx,
        i,
        -BigInt(original.amount_minor),
        -BigInt(original.ar_base_minor),
      );
  }
  await audit(tx, ctx, id, c.action, c);
  return { id };
}
export async function creditSnapshot(tx: SQL, ctx: Context) {
  if (!hasCapability(ctx, "books.view"))
    return { credits: [], creditApplications: [], customerRefunds: [] };
  const credits = (
    await tx.query(`SELECT c.*,i.currency,i.fx_micros,i.customer_name,i.company_id,i.number AS invoice_number,r.reversal_date,
 (CASE WHEN r.id IS NOT NULL THEN 0 ELSE c.total_minor-(SELECT coalesce(sum(a.amount_minor),0) FROM credit_applications a WHERE a.credit_id=c.id AND NOT EXISTS(SELECT 1 FROM application_reversals x WHERE x.application_id=a.id))-(SELECT coalesce(sum(f.amount_minor),0) FROM customer_refunds f WHERE f.credit_id=c.id AND NOT EXISTS(SELECT 1 FROM refund_reversals x WHERE x.refund_id=f.id)) END)::text AS available
 FROM credit_notes c JOIN invoices i ON i.id=c.invoice_id LEFT JOIN credit_reversals r ON r.credit_id=c.id ORDER BY c.created_at DESC`)
  ).rows;
  const creditApplications = (
    await tx.query(
      "SELECT a.*,r.reversal_date FROM credit_applications a LEFT JOIN application_reversals r ON r.application_id=a.id ORDER BY a.created_at DESC",
    )
  ).rows;
  const customerRefunds = (
    await tx.query(
      "SELECT f.*,r.reversal_date FROM customer_refunds f LEFT JOIN refund_reversals r ON r.refund_id=f.id ORDER BY f.created_at DESC",
    )
  ).rows;
  return { credits, creditApplications, customerRefunds };
}
