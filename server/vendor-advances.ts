import { randomUUID as uuid } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL, Row } from "./db.ts";
import { Problem, audit, post, type Context } from "./domain.ts";
import { minor, scaled, baseAmount, round } from "../shared/money.ts";
import {
  releasePrepayment,
  prepaymentCostAdjustment,
} from "../shared/prepayment.ts";
import { cashAccount } from "./bank-account.ts";
import { hasCapability } from "../shared/permissions.ts";
const day = (v: unknown) => String(v).slice(0, 10);
async function get(tx: SQL, table: string, id: string, lock = false) {
  const row = (
    await tx.query(
      `SELECT * FROM ${table} WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  if (!row) throw new Problem(404, "Record not found in this organization.");
  return row;
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
async function period(tx: SQL, entity: string, date: string) {
  const e = await get(tx, "entities", entity, true);
  if (e.lock_date && date <= day(e.lock_date))
    throw new Problem(409, "This accounting period is locked.");
}
function rate(currency: string, value: string) {
  const fx = scaled(value, 6);
  if (fx <= 0n || (currency === "PKR" && fx !== 1000000n))
    throw new Problem(400, "Enter a positive exchange rate; PKR must use 1.");
  return fx;
}
async function usage(tx: SQL, id: string) {
  return (
    await tx.query(
      `SELECT coalesce(sum(amount),0)::text AS amount,coalesce(sum(base),0)::text AS base FROM (
    SELECT amount_minor AS amount,carrying_minor AS base FROM vendor_advance_applications a WHERE advance_id=$1 AND NOT EXISTS(SELECT 1 FROM vendor_advance_application_reversals r WHERE r.application_id=a.id)
    UNION ALL SELECT amount_minor,carrying_minor FROM vendor_advance_refunds f WHERE advance_id=$1 AND NOT EXISTS(SELECT 1 FROM vendor_advance_refund_reversals r WHERE r.refund_id=f.id)) u`,
      [id],
    )
  ).rows[0];
}
async function chronology(tx: SQL, id: string, date: string) {
  const latest = (
    await tx.query(
      `SELECT max(d)::text AS date FROM (
    SELECT advance_date AS d FROM vendor_advances WHERE id=$1
    UNION ALL SELECT application_date FROM vendor_advance_applications WHERE advance_id=$1
    UNION ALL SELECT refund_date FROM vendor_advance_refunds WHERE advance_id=$1
    UNION ALL SELECT r.reversal_date FROM vendor_advance_application_reversals r JOIN vendor_advance_applications a ON a.id=r.application_id WHERE a.advance_id=$1
    UNION ALL SELECT r.reversal_date FROM vendor_advance_refund_reversals r JOIN vendor_advance_refunds f ON f.id=r.refund_id WHERE f.advance_id=$1) dates`,
      [id],
    )
  ).rows[0].date;
  if (latest && date < latest)
    throw new Problem(
      409,
      "Date cannot precede this advance's latest transaction or reversal.",
    );
}
async function inverse(
  tx: SQL,
  ctx: Context,
  entity: string,
  source: string,
  sourceId: string,
  date: string,
  newSource: string,
  id: string,
  reason: string,
) {
  const journal = (
    await tx.query(
      "SELECT id FROM journals WHERE source_type=$1 AND source_id=$2 AND entity_id=$3",
      [source, sourceId, entity],
    )
  ).rows[0];
  if (!journal)
    throw new Problem(409, "The original posted journal is unavailable.");
  const lines = (
    await tx.query("SELECT * FROM journal_lines WHERE journal_id=$1", [
      journal.id,
    ])
  ).rows;
  await post(
    tx,
    ctx,
    entity,
    date,
    newSource,
    id,
    reason,
    lines.map((l) => ({
      account: l.account_code,
      debit: BigInt(l.credit_minor),
      credit: BigInt(l.debit_minor),
    })),
  );
}
async function changeBill(
  tx: SQL,
  b: Row,
  amount: bigint,
  base: bigint,
  date: string,
) {
  const paid = BigInt(b.paid_minor) + amount;
  await tx.query(
    "UPDATE bills SET paid_minor=$2,paid_base_minor=$3,last_activity_on=$4,status=$5,version=version+1 WHERE id=$1",
    [
      b.id,
      String(paid),
      String(BigInt(b.paid_base_minor) + base),
      date,
      paid + BigInt(b.credited_minor) === BigInt(b.total_minor)
        ? "Paid"
        : "Open",
    ],
  );
}
export async function executeVendorAdvance(tx: SQL, ctx: Context, c: Row) {
  if (!hasCapability(ctx, "books.post"))
    throw new Problem(403, "Finance access is required for vendor advances.");
  const id = uuid();
  if (c.action === "vendor-advance.create") {
    await get(tx, "entities", c.entity_id, true);
    const prior = await retry(tx, "vendor_advances", c);
    if (prior) return { id: prior.id };
    await period(tx, c.entity_id, c.date);
    const vendor = await get(tx, "companies", c.vendor_id);
    if (!vendor.vendor)
      throw new Problem(400, "Choose a company marked as a vendor.");
    if (
      c.deal_id &&
      (await get(tx, "deals", c.deal_id)).entity_id !== c.entity_id
    )
      throw new Problem(400, "The project must belong to this legal entity.");
    const fx = rate(c.currency, c.fx),
      amount = minor(c.amount),
      wht = minor(c.wht),
      fee = minor(c.fee),
      total = amount + wht,
      base = baseAmount(total, fx),
      cashBase = baseAmount(amount, fx),
      feeBase = baseAmount(fee, fx),
      bank = await cashAccount(tx, c.entity_id, c.bank_account_id, c.date);
    if (amount <= 0n || cashBase <= 0n || base <= 0n)
      throw new Problem(
        400,
        "Enter a positive cash advance that converts to at least one PKR minor unit.",
      );
    await tx.query(
      `INSERT INTO vendor_advances(id,tenant_id,entity_id,vendor_id,deal_id,vendor_name,currency,advance_date,amount_minor,wht_minor,fee_minor,total_minor,base_minor,fx_micros,bank_account_id,purpose,reference,notes,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        id,
        ctx.tenantId,
        c.entity_id,
        c.vendor_id,
        c.deal_id,
        vendor.name,
        c.currency,
        c.date,
        String(amount),
        String(wht),
        String(fee),
        String(total),
        String(base),
        String(fx),
        c.bank_account_id,
        c.purpose,
        c.reference,
        c.notes,
        c.request_key,
        JSON.stringify(c),
      ],
    );
    await post(
      tx,
      ctx,
      c.entity_id,
      c.date,
      "vendor-advance",
      id,
      `Vendor advance ${c.reference}`,
      [
        { account: "1400", debit: base },
        { account: bank, credit: cashBase + feeBase },
        ...(base > cashBase
          ? [{ account: "2200", credit: base - cashBase }]
          : []),
        ...(feeBase ? [{ account: "5300", debit: feeBase }] : []),
      ],
    );
    await audit(tx, ctx, id, c.action, c);
    return { id };
  }
  const reverseApplication = c.action === "vendor-advance.reverse-application",
    reverseRefund = c.action === "vendor-advance.reverse-refund",
    apply = c.action === "vendor-advance.apply",
    refund = c.action === "vendor-advance.refund";
  const original = reverseApplication
    ? await get(tx, "vendor_advance_applications", c.id)
    : reverseRefund
      ? await get(tx, "vendor_advance_refunds", c.id)
      : null;
  // Bill locks always precede advance/entity locks, matching all other payable commands.
  const bill = apply
    ? await get(tx, "bills", c.bill_id, true)
    : reverseApplication
      ? await get(tx, "bills", original!.bill_id, true)
      : null;
  const advance = await get(
    tx,
    "vendor_advances",
    original?.advance_id || c.id,
    true,
  );
  const table = apply
    ? "vendor_advance_applications"
    : refund
      ? "vendor_advance_refunds"
      : null;
  if (table) {
    const prior = await retry(tx, table, c);
    if (prior) return { id: prior.id };
  }
  const reversalTable = reverseApplication
    ? "vendor_advance_application_reversals"
    : reverseRefund
      ? "vendor_advance_refund_reversals"
      : c.action === "vendor-advance.reverse"
        ? "vendor_advance_reversals"
        : null;
  if (reversalTable) {
    const column = reverseApplication
      ? "application_id"
      : reverseRefund
        ? "refund_id"
        : "advance_id";
    const prior = (
      await tx.query(`SELECT * FROM ${reversalTable} WHERE ${column}=$1`, [
        c.id,
      ])
    ).rows[0];
    if (prior) {
      if (day(prior.reversal_date) !== c.date || prior.reason !== c.reason)
        throw new Problem(
          409,
          "This transaction was already reversed with different details.",
        );
      return { id: prior.id };
    }
  }
  if (
    (
      await tx.query(
        "SELECT id FROM vendor_advance_reversals WHERE advance_id=$1",
        [advance.id],
      )
    ).rows.length
  )
    throw new Problem(409, "This advance has been reversed.");
  await period(tx, advance.entity_id, c.date);
  await chronology(tx, advance.id, c.date);
  if (bill && c.date < day(bill.last_activity_on))
    throw new Problem(409, "Date cannot precede the bill's latest posting.");
  const used = await usage(tx, advance.id),
    available = BigInt(advance.total_minor) - BigInt(used.amount),
    remainingBase = BigInt(advance.base_minor) - BigInt(used.base);
  if (apply) {
    if (
      bill!.entity_id !== advance.entity_id ||
      bill!.vendor_id !== advance.vendor_id ||
      bill!.currency !== advance.currency ||
      (advance.deal_id && bill!.deal_id !== advance.deal_id)
    )
      throw new Problem(
        400,
        "Choose a bill for this vendor, legal entity, currency and project.",
      );
    const accountCodes = new Set(bill!.lines.map((l: Row) => l.account_code));
    if (
      advance.purpose === "investing"
        ? [...accountCodes].some((code) => code !== "1500")
        : accountCodes.has("1500")
    )
      throw new Problem(
        409,
        "The advance's cash-flow purpose does not match this bill. Split capital and operating purchases into separate bills and advances.",
      );
    const amount = minor(c.amount),
      due =
        BigInt(bill!.total_minor) -
        BigInt(bill!.paid_minor) -
        BigInt(bill!.credited_minor);
    if (bill!.status !== "Open" || amount <= 0n || amount > due)
      throw new Problem(
        400,
        "Apply a positive amount within this approved bill's outstanding balance.",
      );
    let carrying;
    try {
      carrying = releasePrepayment(amount, available, remainingBase);
    } catch (e) {
      throw new Problem(400, (e as Error).message);
    }
    const billCarrying = round(
      (BigInt(bill!.base_minor) -
        BigInt(bill!.paid_base_minor) -
        BigInt(bill!.credited_base_minor)) *
        amount,
      due,
    );
    if (billCarrying === 0n && carrying === 0n)
      throw new Problem(
        400,
        "Increase the application amount; this slice rounds to zero PKR.",
      );
    const credits = (
      await tx.query(
        "SELECT v.* FROM vendor_credits v WHERE v.bill_id=$1 AND NOT EXISTS(SELECT 1 FROM vendor_credit_reversals r WHERE r.credit_id=v.id)",
        [bill!.id],
      )
    ).rows;
    const unapplied = (
      await tx.query(
        `SELECT v.id FROM vendor_credits v WHERE v.bill_id=$1 AND NOT EXISTS(SELECT 1 FROM vendor_credit_reversals r WHERE r.credit_id=v.id) AND v.total_minor>(SELECT coalesce(sum(a.amount_minor),0) FROM vendor_credit_applications a WHERE a.credit_id=v.id AND a.bill_id=$1 AND NOT EXISTS(SELECT 1 FROM vendor_application_reversals r WHERE r.application_id=a.id))`,
        [bill!.id],
      )
    ).rows;
    if (unapplied.length)
      throw new Problem(
        409,
        "Apply this bill's vendor credits to the bill before applying an advance.",
      );
    // Cost weights exclude lines already credited by the vendor. Input tax is
    // never used as the offset account for a historical prepayment adjustment.
    let weight = 0n,
      assigned = 0n;
    const costTotal = BigInt(
      bill!.tax_treatment === "expense" ? bill!.total_minor : bill!.net_minor,
    );
    const costBase = baseAmount(costTotal, BigInt(bill!.fx_micros));
    const costLines = bill!.lines.map((l: Row, index: number) => {
      weight +=
        BigInt(l.subtotal) +
        (bill!.tax_treatment === "expense" ? BigInt(l.taxMinor) : 0n);
      const cumulative = round(costBase * weight, costTotal),
        part = cumulative - assigned;
      assigned = cumulative;
      const credited = credits
        .flatMap((v) => v.lines)
        .filter((v: Row) => v.billLine === index)
        .reduce((n: bigint, v: Row) => n + BigInt(v.cost_base), 0n);
      return {
        account_code: l.account_code,
        subtotal: String(part - credited),
        taxMinor: "0",
      };
    });
    let adjustments;
    try {
      adjustments = prepaymentCostAdjustment(
        costLines,
        "recoverable",
        billCarrying - carrying,
      );
    } catch (e) {
      throw new Problem(409, (e as Error).message);
    }
    await tx.query(
      "INSERT INTO vendor_advance_applications(id,tenant_id,advance_id,bill_id,application_date,amount_minor,carrying_minor,bill_carrying_minor,cost_adjustments,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
        ctx.tenantId,
        advance.id,
        bill!.id,
        c.date,
        String(amount),
        String(carrying),
        String(billCarrying),
        JSON.stringify(adjustments),
        c.request_key,
        JSON.stringify(c),
      ],
    );
    await post(
      tx,
      ctx,
      advance.entity_id,
      c.date,
      "vendor-advance-application",
      id,
      `Apply advance ${advance.reference} to ${bill!.reference}`,
      [
        { account: "2000", debit: billCarrying },
        { account: "1400", credit: carrying },
        ...adjustments.map((a) => ({
          account: a.account,
          ...(BigInt(a.amount_minor) > 0n
            ? { credit: BigInt(a.amount_minor) }
            : { debit: -BigInt(a.amount_minor) }),
        })),
      ],
    );
    await changeBill(tx, bill!, amount, billCarrying, c.date);
    await audit(tx, ctx, bill!.id, c.action, {
      advance_id: advance.id,
      application_id: id,
      text: `Applied vendor advance ${advance.reference}.`,
    });
  } else if (refund) {
    const amount = minor(c.amount),
      fee = minor(c.fee),
      fx = rate(advance.currency, c.fx),
      cash = baseAmount(amount, fx),
      feeBase = baseAmount(fee, fx),
      bank = await cashAccount(
        tx,
        advance.entity_id,
        c.bank_account_id,
        c.date,
      );
    if (cash <= feeBase)
      throw new Problem(400, "Refund cash must exceed the bank charge.");
    let carrying;
    try {
      carrying = releasePrepayment(amount, available, remainingBase);
    } catch (e) {
      throw new Problem(400, (e as Error).message);
    }
    await tx.query(
      "INSERT INTO vendor_advance_refunds(id,tenant_id,advance_id,refund_date,amount_minor,carrying_minor,fx_micros,fee_minor,bank_account_id,reference,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        id,
        ctx.tenantId,
        advance.id,
        c.date,
        String(amount),
        String(carrying),
        String(fx),
        String(fee),
        c.bank_account_id,
        c.reference,
        c.request_key,
        JSON.stringify(c),
      ],
    );
    const delta = cash - carrying;
    await post(
      tx,
      ctx,
      advance.entity_id,
      c.date,
      "vendor-advance-refund",
      id,
      `Refund of advance ${advance.reference}: ${c.reference}`,
      [
        { account: bank, debit: cash - feeBase },
        { account: "1400", credit: carrying },
        ...(feeBase ? [{ account: "5300", debit: feeBase }] : []),
        ...(delta > 0n
          ? [{ account: "4100", credit: delta }]
          : delta < 0n
            ? [{ account: "5100", debit: -delta }]
            : []),
      ],
    );
  } else if (reverseApplication) {
    await inverse(
      tx,
      ctx,
      advance.entity_id,
      "vendor-advance-application",
      original!.id,
      c.date,
      "vendor-advance-application-reversal",
      id,
      c.reason,
    );
    await tx.query(
      "INSERT INTO vendor_advance_application_reversals(id,tenant_id,application_id,reversal_date,reason) VALUES($1,$2,$3,$4,$5)",
      [id, ctx.tenantId, original!.id, c.date, c.reason],
    );
    await changeBill(
      tx,
      bill!,
      -BigInt(original!.amount_minor),
      -BigInt(original!.bill_carrying_minor),
      c.date,
    );
    await audit(tx, ctx, bill!.id, c.action, {
      advance_id: advance.id,
      application_id: original!.id,
      text: `Reversed application of vendor advance ${advance.reference}: ${c.reason}`,
    });
  } else if (reverseRefund) {
    await cashAccount(tx, advance.entity_id, original!.bank_account_id, c.date);
    await inverse(
      tx,
      ctx,
      advance.entity_id,
      "vendor-advance-refund",
      original!.id,
      c.date,
      "vendor-advance-refund-reversal",
      id,
      c.reason,
    );
    await tx.query(
      "INSERT INTO vendor_advance_refund_reversals(id,tenant_id,refund_id,reversal_date,reason) VALUES($1,$2,$3,$4,$5)",
      [id, ctx.tenantId, original!.id, c.date, c.reason],
    );
  } else if (c.action === "vendor-advance.reverse") {
    if (BigInt(used.amount) !== 0n)
      throw new Problem(
        409,
        "Reverse all active applications and refunds before reversing this advance.",
      );
    await cashAccount(tx, advance.entity_id, advance.bank_account_id, c.date);
    await inverse(
      tx,
      ctx,
      advance.entity_id,
      "vendor-advance",
      advance.id,
      c.date,
      "vendor-advance-reversal",
      id,
      c.reason,
    );
    await tx.query(
      "INSERT INTO vendor_advance_reversals(id,tenant_id,advance_id,reversal_date,reason) VALUES($1,$2,$3,$4,$5)",
      [id, ctx.tenantId, advance.id, c.date, c.reason],
    );
  } else throw new Problem(400, "Unknown vendor advance action.");
  await audit(tx, ctx, advance.id, c.action, { ...c, transaction_id: id });
  return { id };
}
export async function vendorAdvanceSnapshot(tx: SQL, ctx: Context) {
  if (!hasCapability(ctx, "books.view"))
    return {
      vendorAdvances: [],
      vendorAdvanceApplications: [],
      vendorAdvanceRefunds: [],
    };
  const advances = (
    await tx.query(`SELECT v.*,r.reversal_date,r.reason AS reversal_reason,
    coalesce(a.amount,0)::text AS applied_minor,coalesce(a.base,0)::text AS applied_base_minor,coalesce(f.amount,0)::text AS refunded_minor,coalesce(f.base,0)::text AS refunded_base_minor
    FROM vendor_advances v LEFT JOIN vendor_advance_reversals r ON r.advance_id=v.id
    LEFT JOIN LATERAL (SELECT sum(a.amount_minor) AS amount,sum(a.carrying_minor) AS base FROM vendor_advance_applications a WHERE a.advance_id=v.id AND NOT EXISTS(SELECT 1 FROM vendor_advance_application_reversals x WHERE x.application_id=a.id)) a ON true
    LEFT JOIN LATERAL (SELECT sum(f.amount_minor) AS amount,sum(f.carrying_minor) AS base FROM vendor_advance_refunds f WHERE f.advance_id=v.id AND NOT EXISTS(SELECT 1 FROM vendor_advance_refund_reversals x WHERE x.refund_id=f.id)) f ON true ORDER BY v.created_at DESC`)
  ).rows.map(({ request_payload, ...v }) => v);
  const applications = (
    await tx.query(
      "SELECT a.*,r.reversal_date,r.reason AS reversal_reason FROM vendor_advance_applications a LEFT JOIN vendor_advance_application_reversals r ON r.application_id=a.id ORDER BY a.created_at DESC",
    )
  ).rows.map(({ request_payload, ...a }) => a);
  const refunds = (
    await tx.query(
      "SELECT f.*,r.reversal_date,r.reason AS reversal_reason FROM vendor_advance_refunds f LEFT JOIN vendor_advance_refund_reversals r ON r.refund_id=f.id ORDER BY f.created_at DESC",
    )
  ).rows.map(({ request_payload, ...f }) => f);
  return {
    vendorAdvances: advances,
    vendorAdvanceApplications: applications,
    vendorAdvanceRefunds: refunds,
  };
}
