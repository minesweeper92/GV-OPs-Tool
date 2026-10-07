import { randomUUID as uuid } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Problem, post, audit, type Context } from "./domain.ts";
import type { SQL, Row } from "./db.ts";
import { minor, scaled, round, baseAmount } from "../shared/money.ts";
import { cashAccount } from "./bank-account.ts";
const sum = (rows: Row[], key: string) =>
  rows.reduce((n, r) => n + BigInt(r[key]), 0n);
async function get(tx: SQL, table: string, id: string, lock = false) {
  const r = (
    await tx.query(
      `SELECT * FROM ${table} WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  if (!r) throw new Problem(404, "Record not found in this organization.");
  return r;
}
async function retry(tx: SQL, table: string, c: Row) {
  const p = (
    await tx.query(
      `SELECT id,request_payload FROM ${table} WHERE request_key=$1`,
      [c.request_key],
    )
  ).rows[0];
  if (p && !isDeepStrictEqual(p.request_payload, c))
    throw new Problem(409, "This retry key was used for another transaction.");
  return p;
}
async function usage(tx: SQL, id: string) {
  return (
    await tx.query(
      `SELECT coalesce(sum(amount),0)::text AS amount,coalesce(sum(base),0)::text AS base FROM (
 SELECT amount_minor AS amount,credit_base_minor AS base FROM vendor_credit_applications a WHERE credit_id=$1 AND NOT EXISTS(SELECT 1 FROM vendor_application_reversals r WHERE r.application_id=a.id)
 UNION ALL SELECT amount_minor,credit_base_minor FROM vendor_refunds f WHERE credit_id=$1 AND NOT EXISTS(SELECT 1 FROM vendor_refund_reversals r WHERE r.refund_id=f.id)) u`,
      [id],
    )
  ).rows[0];
}
async function chronology(tx: SQL, id: string, date: string) {
  const latest = (
    await tx.query(
      `SELECT max(d)::text AS date FROM (
 SELECT credit_date AS d FROM vendor_credits WHERE id=$1 UNION ALL SELECT application_date FROM vendor_credit_applications WHERE credit_id=$1 UNION ALL SELECT refund_date FROM vendor_refunds WHERE credit_id=$1
 UNION ALL SELECT r.reversal_date FROM vendor_application_reversals r JOIN vendor_credit_applications a ON a.id=r.application_id WHERE a.credit_id=$1 UNION ALL SELECT r.reversal_date FROM vendor_refund_reversals r JOIN vendor_refunds f ON f.id=r.refund_id WHERE f.credit_id=$1) h`,
      [id],
    )
  ).rows[0].date;
  if (latest && date < latest)
    throw new Problem(
      409,
      "Date cannot precede this credit's latest transaction or reversal.",
    );
}
async function period(tx: SQL, entity: string, date: string) {
  const e = await get(tx, "entities", entity, true);
  if (e.lock_date && date <= String(e.lock_date).slice(0, 10))
    throw new Problem(409, "This accounting period is locked.");
  return e;
}
async function updateBill(
  tx: SQL,
  b: Row,
  amount: bigint,
  base: bigint,
  date: string,
) {
  const credited = BigInt(b.credited_minor) + amount;
  await tx.query(
    "UPDATE bills SET credited_minor=$2,credited_base_minor=$3,status=$4,last_activity_on=greatest(last_activity_on,$5::date),version=version+1 WHERE id=$1",
    [
      b.id,
      String(credited),
      String(BigInt(b.credited_base_minor) + base),
      credited + BigInt(b.paid_minor) === BigInt(b.total_minor)
        ? "Paid"
        : "Open",
      date,
    ],
  );
}
export async function executeVendorCredit(tx: SQL, ctx: Context, c: Row) {
  if (!["admin", "finance"].includes(ctx.role))
    throw new Problem(
      403,
      "A finance role is required for vendor credits and refunds.",
    );
  const id = uuid();
  const originalTable =
    c.action === "vendor-credit.create"
      ? "bills"
      : c.action === "vendor-credit.apply" ||
          c.action === "vendor-credit.refund" ||
          c.action === "vendor-credit.reverse"
        ? "vendor_credits"
        : c.action === "vendor-credit.unapply"
          ? "vendor_credit_applications"
          : "vendor_refunds";
  const original = await get(
    tx,
    originalTable,
    c.bill_id && c.action === "vendor-credit.create"
      ? c.bill_id
      : c.credit_id || c.id,
  );
  const credit =
    c.action === "vendor-credit.create"
      ? null
      : originalTable === "vendor_credits"
        ? original
        : await get(tx, "vendor_credits", original.credit_id);
  const source = credit ? await get(tx, "bills", credit.bill_id) : original;
  // Lock all participating bills in UUID order before the entity, matching
  // payables' bill-before-entity ordering without cross-bill credit deadlocks.
  const targetId =
    c.action === "vendor-credit.apply"
      ? c.bill_id
      : c.action === "vendor-credit.unapply"
        ? original.bill_id
        : source.id;
  await tx.query(
    "SELECT id FROM bills WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [[source.id, targetId]],
  );
  const b = await get(tx, "bills", source.id, true);
  const e = await get(tx, "entities", b.entity_id, true);
  if (credit) await get(tx, "vendor_credits", credit.id, true);
  if (c.action === "vendor-credit.create") {
    const prior = await retry(tx, "vendor_credits", c);
    if (prior) return { id: prior.id };
    if (
      (
        await tx.query(
          "SELECT a.id FROM vendor_advance_applications a WHERE a.bill_id=$1 AND NOT EXISTS(SELECT 1 FROM vendor_advance_application_reversals r WHERE r.application_id=a.id)",
          [b.id],
        )
      ).rows.length
    )
      throw new Problem(
        409,
        "Reverse this bill's advance applications before recording a vendor credit, so historical prepayment costs remain correct.",
      );
    if (!["Open", "Paid"].includes(b.status) || b.opening_batch_id)
      throw new Problem(
        409,
        "Choose an approved bill, not an opening balance.",
      );
    if (c.date < b.bill_date)
      throw new Problem(400, "Credit date cannot precede the bill.");
    await period(tx, e.id, c.date);
    const history = (
      await tx.query(
        "SELECT max(d)::text AS date FROM (SELECT credit_date AS d FROM vendor_credits WHERE bill_id=$1 UNION ALL SELECT r.reversal_date FROM vendor_credit_reversals r JOIN vendor_credits v ON v.id=r.credit_id WHERE v.bill_id=$1) h",
        [b.id],
      )
    ).rows[0].date;
    if (history && c.date < history)
      throw new Problem(
        409,
        "Credit date cannot precede an earlier credit or reversal.",
      );
    const existing = (
      await tx.query(
        "SELECT * FROM vendor_credits v WHERE bill_id=$1 AND NOT EXISTS(SELECT 1 FROM vendor_credit_reversals r WHERE r.credit_id=v.id)",
        [b.id],
      )
    ).rows;
    const duplicate = (
      await tx.query(
        "SELECT v.id FROM vendor_credits v JOIN bills x ON x.id=v.bill_id WHERE v.entity_id=$1 AND x.vendor_id=$2 AND lower(trim(v.reference))=lower(trim($3)) AND NOT EXISTS(SELECT 1 FROM vendor_credit_reversals r WHERE r.credit_id=v.id)",
        [b.entity_id, b.vendor_id, c.reference],
      )
    ).rows[0];
    if (duplicate)
      throw new Problem(
        409,
        "This vendor credit reference already exists for this legal entity.",
      );
    const recover = b.tax_treatment === "recoverable",
      full = BigInt(b.base_minor),
      netBase = baseAmount(BigInt(b.net_minor), BigInt(b.fx_micros));
    let cumulative = 0n,
      allocated = 0n;
    const fullCosts = b.lines.map((l: Row) => {
      cumulative += BigInt(l.subtotal) + (recover ? 0n : BigInt(l.taxMinor));
      const target = round(
        (recover ? netBase : full) * cumulative,
        BigInt(recover ? b.net_minor : b.total_minor),
      );
      const part = target - allocated;
      allocated = target;
      return part;
    });
    let net = 0n,
      tax = 0n,
      costBase = 0n;
    const lines: Row[] = [],
      seen = new Set<number>();
    for (const s of c.lines) {
      if (seen.has(s.index) || !b.lines[s.index])
        throw new Problem(400, "Select each valid bill line once.");
      seen.add(s.index);
      const l = b.lines[s.index],
        used = existing
          .flatMap((v) => v.lines)
          .filter((v) => v.billLine === s.index),
        remaining = BigInt(l.subtotal) - sum(used, "subtotal"),
        amount = minor(s.amount);
      if (amount <= 0n || amount > remaining)
        throw new Problem(
          409,
          "Credit exceeds the bill line's remaining subtotal.",
        );
      const taxPart = round(
          (BigInt(l.taxMinor) - sum(used, "taxMinor")) * amount,
          remaining,
        ),
        remainingCost = fullCosts[s.index] - sum(used, "cost_base"),
        cost = round(
          remainingCost * (amount + (recover ? 0n : taxPart)),
          remaining +
            (recover ? 0n : BigInt(l.taxMinor) - sum(used, "taxMinor")),
        );
      lines.push({
        billLine: s.index,
        description: l.description,
        account_code: l.account_code,
        subtotal: String(amount),
        taxMinor: String(taxPart),
        cost_base: String(cost),
      });
      net += amount;
      tax += taxPart;
      costBase += cost;
    }
    const taxBase =
        recover && tax > 0n
          ? round(
              (full - netBase - sum(existing, "tax_base_minor")) * tax,
              BigInt(b.tax_minor) - sum(existing, "tax_minor"),
            )
          : 0n,
      base = costBase + taxBase;
    if (base <= 0n) throw new Problem(400, "Credit rounds to zero in PKR.");
    const number = `${e.code}-VC-${String(e.next_vendor_credit).padStart(5, "0")}`;
    await tx.query(
      "UPDATE entities SET next_vendor_credit=next_vendor_credit+1 WHERE id=$1",
      [e.id],
    );
    await tx.query(
      "INSERT INTO vendor_credits(id,tenant_id,entity_id,bill_id,number,reference,credit_date,reason,lines,net_minor,tax_minor,total_minor,base_minor,tax_base_minor,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
      [
        id,
        ctx.tenantId,
        e.id,
        b.id,
        number,
        c.reference,
        c.date,
        c.reason,
        JSON.stringify(lines),
        String(net),
        String(tax),
        String(net + tax),
        String(base),
        String(taxBase),
        c.request_key,
        JSON.stringify(c),
      ],
    );
    await post(
      tx,
      ctx,
      e.id,
      c.date,
      "vendor-credit",
      id,
      `${number}: ${c.reason}`,
      [
        { account: "1350", debit: base },
        ...lines.map((l) => ({
          account: l.account_code,
          credit: BigInt(l.cost_base),
        })),
        { account: "1300", credit: taxBase },
      ],
    );
  } else if (
    c.action === "vendor-credit.apply" ||
    c.action === "vendor-credit.refund"
  ) {
    const v = credit!,
      table =
        c.action === "vendor-credit.apply"
          ? "vendor_credit_applications"
          : "vendor_refunds",
      prior = await retry(tx, table, c);
    if (prior) return { id: prior.id };
    if (
      (
        await tx.query(
          "SELECT id FROM vendor_credit_reversals WHERE credit_id=$1",
          [v.id],
        )
      ).rows.length
    )
      throw new Problem(409, "This vendor credit is reversed.");
    await period(tx, e.id, c.date);
    await chronology(tx, v.id, c.date);
    const used = await usage(tx, v.id),
      remaining = BigInt(v.total_minor) - BigInt(used.amount),
      amount = minor(c.amount);
    if (amount <= 0n || amount > remaining)
      throw new Problem(409, "Amount exceeds available vendor credit.");
    const carrying = round(
      (BigInt(v.base_minor) - BigInt(used.base)) * amount,
      remaining,
    );
    if (c.action === "vendor-credit.apply") {
      const target =
        c.bill_id === b.id ? b : await get(tx, "bills", c.bill_id, true);
      if (
        target.entity_id !== b.entity_id ||
        target.vendor_id !== b.vendor_id ||
        target.currency !== b.currency
      )
        throw new Problem(
          409,
          "Choose a bill for the same vendor, legal entity and currency.",
        );
      const owing =
        BigInt(target.total_minor) -
        BigInt(target.paid_minor) -
        BigInt(target.credited_minor);
      if (
        target.status !== "Open" ||
        c.date < target.last_activity_on ||
        c.date < target.bill_date ||
        amount > owing
      )
        throw new Problem(
          409,
          "Choose an open bill, a current transaction date and an amount within its balance.",
        );
      const apBase = round(
          (BigInt(target.base_minor) -
            BigInt(target.paid_base_minor) -
            BigInt(target.credited_base_minor)) *
            amount,
          owing,
        ),
        gain = apBase - carrying;
      if (apBase === 0n && carrying === 0n)
        throw new Problem(400, "Application rounds to zero in PKR.");
      await tx.query(
        "INSERT INTO vendor_credit_applications(id,tenant_id,credit_id,bill_id,application_date,amount_minor,credit_base_minor,ap_base_minor,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          ctx.tenantId,
          v.id,
          target.id,
          c.date,
          String(amount),
          String(carrying),
          String(apBase),
          c.request_key,
          JSON.stringify(c),
        ],
      );
      await post(
        tx,
        ctx,
        e.id,
        c.date,
        "vendor-credit-application",
        id,
        `Apply ${v.number} to ${target.reference}`,
        [
          { account: "2000", debit: apBase },
          { account: "1350", credit: carrying },
          gain >= 0n
            ? { account: "4100", credit: gain }
            : { account: "5100", debit: -gain },
        ],
      );
      await updateBill(tx, target, amount, apBase, c.date);
    } else {
      const fx = scaled(c.fx, 6);
      if (fx <= 0n || (b.currency === "PKR" && fx !== 1000000n))
        throw new Problem(
          400,
          "Use a positive refund exchange rate; PKR must use 1.",
        );
      const bank = await cashAccount(tx, e.id, c.bank_account_id, c.date),
        cash = baseAmount(amount, fx),
        gain = cash - carrying;
      if (cash <= 0n) throw new Problem(400, "Refund rounds to zero in PKR.");
      await tx.query(
        "INSERT INTO vendor_refunds(id,tenant_id,credit_id,refund_date,amount_minor,credit_base_minor,fx_micros,bank_account_id,reference,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          id,
          ctx.tenantId,
          v.id,
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
        e.id,
        c.date,
        "vendor-refund",
        id,
        `Refund received for ${v.number}: ${c.reference}`,
        [
          { account: bank, debit: cash },
          { account: "1350", credit: carrying },
          gain >= 0n
            ? { account: "4100", credit: gain }
            : { account: "5100", debit: -gain },
        ],
      );
    }
  } else {
    const v = credit!,
      isCredit = c.action === "vendor-credit.reverse",
      isApply = c.action === "vendor-credit.unapply",
      table = isCredit
        ? "vendor_credit_reversals"
        : isApply
          ? "vendor_application_reversals"
          : "vendor_refund_reversals",
      key = isCredit ? "credit_id" : isApply ? "application_id" : "refund_id";
    const prior = (
      await tx.query(`SELECT * FROM ${table} WHERE ${key}=$1`, [c.id])
    ).rows[0];
    if (prior) {
      if (prior.reversal_date !== c.date || prior.reason !== c.reason)
        throw new Problem(
          409,
          "This reversal already exists with different details.",
        );
      return { id: prior.id };
    }
    await period(tx, e.id, c.date);
    await chronology(tx, v.id, c.date);
    if (isCredit && BigInt((await usage(tx, v.id)).amount) > 0n)
      throw new Problem(
        409,
        "Reverse applications and refunds before reversing this credit.",
      );
    const target = isApply
      ? original.bill_id === b.id
        ? b
        : await get(tx, "bills", original.bill_id, true)
      : null;
    if (target && c.date < target.last_activity_on)
      throw new Problem(
        409,
        "Reversal cannot precede the bill's latest transaction.",
      );
    await tx.query(
      `INSERT INTO ${table}(id,tenant_id,${key},reversal_date,reason) VALUES($1,$2,$3,$4,$5)`,
      [id, ctx.tenantId, c.id, c.date, c.reason],
    );
    const type = isCredit
        ? "vendor-credit"
        : isApply
          ? "vendor-credit-application"
          : "vendor-refund",
      reversal = isCredit
        ? "vendor-credit-reversal"
        : isApply
          ? "vendor-credit-application-reversal"
          : "vendor-refund-reversal";
    const lines = (
      await tx.query(
        "SELECT l.* FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type=$1 AND j.source_id=$2",
        [type, c.id],
      )
    ).rows;
    await post(
      tx,
      ctx,
      e.id,
      c.date,
      reversal,
      id,
      c.reason,
      lines.map((l) => ({
        account: l.account_code,
        debit: BigInt(l.credit_minor),
        credit: BigInt(l.debit_minor),
      })),
    );
    if (target)
      await updateBill(
        tx,
        target,
        -BigInt(original.amount_minor),
        -BigInt(original.ap_base_minor),
        c.date,
      );
  }
  await audit(tx, ctx, id, c.action, c);
  return { id };
}
export async function vendorCreditSnapshot(tx: SQL, ctx: Context) {
  if (!["admin", "finance"].includes(ctx.role))
    return {
      vendorCredits: [],
      vendorCreditApplications: [],
      vendorRefunds: [],
    };
  const vendorCredits = (
    await tx.query(`SELECT v.*,b.vendor_id,b.vendor_name,b.currency,b.fx_micros,b.entity_name,r.reversal_date,
 (CASE WHEN r.id IS NOT NULL THEN 0 ELSE v.total_minor-(SELECT coalesce(sum(a.amount_minor),0) FROM vendor_credit_applications a WHERE a.credit_id=v.id AND NOT EXISTS(SELECT 1 FROM vendor_application_reversals x WHERE x.application_id=a.id))-(SELECT coalesce(sum(f.amount_minor),0) FROM vendor_refunds f WHERE f.credit_id=v.id AND NOT EXISTS(SELECT 1 FROM vendor_refund_reversals x WHERE x.refund_id=f.id)) END)::text AS available
 FROM vendor_credits v JOIN bills b ON b.id=v.bill_id LEFT JOIN vendor_credit_reversals r ON r.credit_id=v.id ORDER BY v.created_at DESC`)
  ).rows.map(({ request_payload, ...v }) => v);
  const vendorCreditApplications = (
    await tx.query(
      "SELECT a.*,r.reversal_date FROM vendor_credit_applications a LEFT JOIN vendor_application_reversals r ON r.application_id=a.id ORDER BY a.created_at DESC",
    )
  ).rows.map(({ request_payload, ...a }) => a);
  const vendorRefunds = (
    await tx.query(
      "SELECT f.*,r.reversal_date FROM vendor_refunds f LEFT JOIN vendor_refund_reversals r ON r.refund_id=f.id ORDER BY f.created_at DESC",
    )
  ).rows.map(({ request_payload, ...f }) => f);
  return { vendorCredits, vendorCreditApplications, vendorRefunds };
}
