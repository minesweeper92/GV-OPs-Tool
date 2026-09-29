import { randomUUID as uuid } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL, Row } from "./db.ts";
import { Problem, audit, post, type Context } from "./domain.ts";
import { minor, round, baseAmount } from "../shared/money.ts";
import { invoiceCredits } from "./credits.ts";
import { allocateNumber } from "./numbering.ts";
const finance = (ctx: Context) => {
  if (!["admin", "finance"].includes(ctx.role))
    throw new Problem(
      403,
      "A finance role is required for project billing and profitability.",
    );
};
const date = (v: unknown) => String(v).slice(0, 10);
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
async function openDate(tx: SQL, entity: string, day: string) {
  const e = await get(tx, "entities", entity);
  if (e.lock_date && day <= date(e.lock_date))
    throw new Problem(
      409,
      "This accounting period is locked. Choose a later date.",
    );
  return e;
}
function samePayload(a: Row, b: Row) {
  // jsonb normalizes object-key order, including nested document details.
  return isDeepStrictEqual(a, JSON.parse(JSON.stringify(b)));
}
async function activeInvoices(tx: SQL, deal: string) {
  return (
    await tx.query(
      "SELECT * FROM invoices WHERE deal_id=$1 AND status NOT IN ('Voided','Cancelled')",
      [deal],
    )
  ).rows;
}

// Per-line allocation preserves each original tax rate and clears
// rounding residuals on the final invoice. Drafts reserve amounts too.
export function allocateInvoice(q: Row, existing: Row[], amount: bigint) {
  const used = q.lines.map((_: Row, index: number) =>
    existing.reduce(
      (sum: { net: bigint; tax: bigint }, i: Row) => {
        for (const [n, l] of (i.lines as Row[]).entries())
          if ((l.quoteLine ?? n) === index) {
            sum.net += BigInt(l.subtotal);
            sum.tax += BigInt(l.taxMinor);
          }
        return sum;
      },
      { net: 0n, tax: 0n },
    ),
  );
  const remaining = q.lines.reduce(
    (s: bigint, l: Row, n: number) => s + BigInt(l.subtotal) - used[n].net,
    0n,
  );
  if (amount <= 0n || amount > remaining)
    throw new Problem(
      409,
      "The amount exceeds the unbilled quote balance, including reserved drafts.",
    );
  let weight = 0n,
    assigned = 0n,
    net = 0n,
    tax = 0n;
  const lines: Row[] = [];
  for (const [n, l] of (q.lines as Row[]).entries()) {
    const lineNet = BigInt(l.subtotal),
      available = lineNet - used[n].net;
    if (available <= 0n) continue;
    weight += available;
    const cumulative = round(amount * weight, remaining),
      part = cumulative - assigned;
    assigned = cumulative;
    if (part === 0n) continue;
    const partTax = round((BigInt(l.taxMinor) - used[n].tax) * part, available);
    if (partTax < 0n)
      throw new Problem(409, "The remaining tax allocation needs review.");
    const price = `${part / 100n}.${String(part % 100n).padStart(2, "0")}`;
    lines.push({
      unit: l.unit || "",
      section: l.section || "",
      discount_type:
        part === lineNet && used[n].net === 0n ? l.discount_type : "percent",
      discount: part === lineNet && used[n].net === 0n ? l.discount : "0",
      discountMinor:
        part === lineNet && used[n].net === 0n ? l.discountMinor : "0",
      quoteLine: n,
      description: l.description,
      quantity: part === lineNet && used[n].net === 0n ? l.quantity : "1",
      price: part === lineNet && used[n].net === 0n ? l.price : price,
      tax: l.tax,
      subtotal: String(part),
      taxMinor: String(partTax),
    });
    net += part;
    tax += partTax;
  }
  return {
    lines,
    net: String(net),
    tax: String(tax),
    total: String(net + tax),
  };
}
export async function createProjectInvoice(tx: SQL, ctx: Context, c: Row) {
  finance(ctx);
  const q = await get(tx, "quotes", c.quote_id, false),
    d = await get(tx, "deals", q.deal_id);
  if (d.accepted_quote_id !== q.id)
    throw new Problem(409, "Select the explicitly accepted quote version.");
  if (c.request_key) {
    const prior = (
      await tx.query(
        "SELECT id,request_payload FROM invoices WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (!samePayload(prior.request_payload, c))
        throw new Problem(409, "This retry key was used for another invoice.");
      return { id: prior.id };
    }
  }
  const invoices = await activeInvoices(tx, d.id);
  if (
    (
      await tx.query(
        "SELECT id FROM recurring_profiles WHERE deal_id=$1 AND kind='invoice'",
        [d.id],
      )
    ).rows.length
  )
    throw new Problem(
      409,
      "This deal uses recurring billing. Generate invoices from its schedule.",
    );
  // Retain the old one-click full-quote API's retry behaviour for existing callers.
  if (
    c.amount === undefined &&
    !c.milestone_id &&
    !c.request_key &&
    invoices.length
  )
    return { id: invoices[0].id };
  const project = (
    await tx.query("SELECT * FROM projects WHERE deal_id=$1", [d.id])
  ).rows[0];
  if (project && project.status !== "Active")
    throw new Problem(409, "Resume the project before creating new invoices.");
  let amount =
    c.amount === undefined
      ? BigInt(q.net_minor) -
        invoices.reduce((s, i) => s + BigInt(i.net_minor), 0n)
      : minor(c.amount);
  let label = c.label,
    kind = c.billing_kind;
  const milestones = project
    ? (
        await tx.query(
          "SELECT m.* FROM project_milestones m WHERE m.project_id=$1 AND m.status='Planned'",
          [project.id],
        )
      ).rows
    : [];
  if (c.milestone_id) {
    const m = milestones.find((m) => m.id === c.milestone_id);
    if (!m)
      throw new Problem(
        409,
        "Choose an active milestone belonging to this project.",
      );
    const prior = invoices.find((i) => i.milestone_id === m.id);
    if (prior) return { id: prior.id };
    if (c.amount !== undefined && amount !== BigInt(m.net_minor))
      throw new Problem(409, "Invoice the exact milestone amount.");
    amount = BigInt(m.net_minor);
    label = m.name;
    kind = m.billing_kind;
  }
  const unbilledPlan = milestones
    .filter(
      (m) =>
        m.id !== c.milestone_id &&
        !invoices.some((i) => i.milestone_id === m.id),
    )
    .reduce((s, m) => s + BigInt(m.net_minor), 0n);
  if (
    invoices.reduce((s, i) => s + BigInt(i.net_minor), 0n) +
      unbilledPlan +
      amount >
    BigInt(q.net_minor)
  )
    throw new Problem(
      409,
      "This amount is reserved by another draft or planned milestone.",
    );
  await openDate(tx, d.entity_id, c.issue_date);
  const lastVoid = (
    await tx.query(
      "SELECT max(j.posted_on)::text AS date FROM journals j JOIN invoices i ON i.id=j.source_id WHERE i.deal_id=$1 AND j.source_type='invoice_void'",
      [d.id],
    )
  ).rows[0].date;
  if (lastVoid && c.issue_date < lastVoid)
    throw new Problem(
      409,
      "Replacement invoices cannot precede the latest invoice reversal date.",
    );
  if (c.due_date < c.issue_date)
    throw new Problem(400, "Due date cannot precede invoice date.");
  const calculated = allocateInvoice(q, invoices, amount),
    id = uuid();
  if (baseAmount(BigInt(calculated.net), BigInt(q.fx_micros)) <= 0n)
    throw new Problem(400, "The invoice subtotal rounds to zero in PKR.");
  const number = await allocateNumber(
    tx,
    ctx.tenantId,
    d.entity_id,
    "invoice",
    c.number_series_id,
  );
  await tx.query(
    `INSERT INTO invoices(id,tenant_id,entity_id,deal_id,quote_id,issue_date,due_date,lines,net_minor,tax_minor,total_minor,billing_kind,label,milestone_id,request_key,request_payload,currency,fx_micros,details,number)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      id,
      ctx.tenantId,
      d.entity_id,
      d.id,
      q.id,
      c.issue_date,
      c.due_date,
      JSON.stringify(calculated.lines),
      calculated.net,
      calculated.tax,
      calculated.total,
      kind,
      label,
      c.milestone_id || null,
      c.request_key || null,
      JSON.stringify(c),
      q.currency,
      q.fx_micros,
      JSON.stringify(c.details || q.details || {}),
      number,
    ],
  );
  await audit(tx, ctx, id, "invoice.create", { ...c, deal_id: d.id });
  return { id };
}
export async function executeProject(tx: SQL, ctx: Context, c: Row) {
  finance(ctx);
  let id = c.id || uuid();
  if (c.action === "project.create") {
    const q = await get(tx, "quotes", c.quote_id, false),
      d = await get(tx, "deals", q.deal_id);
    if (
      (
        await tx.query(
          "SELECT id FROM recurring_profiles WHERE deal_id=$1 AND kind='invoice'",
          [d.id],
        )
      ).rows.length
    )
      throw new Problem(
        409,
        "Recurring contracts are separate from fixed-budget projects.",
      );
    if (d.accepted_quote_id !== q.id || c.entity_id !== d.entity_id)
      throw new Problem(
        409,
        "Confirm the issuing entity and accepted quote for this deal.",
      );
    const existing = (
      await tx.query("SELECT * FROM projects WHERE deal_id=$1", [d.id])
    ).rows[0];
    if (existing) {
      if (
        existing.name !== c.name ||
        existing.code !== c.code ||
        existing.budget_minor !== String(minor(c.budget)) ||
        date(existing.start_date) !== c.start_date ||
        (existing.end_date ? date(existing.end_date) : null) !== c.end_date
      )
        throw new Problem(
          409,
          "This deal already has a project. Open it to make changes.",
        );
      return { id: existing.id };
    }
    if (c.end_date && c.end_date < c.start_date)
      throw new Problem(400, "End date cannot precede start date.");
    await tx.query(
      "INSERT INTO projects(id,tenant_id,entity_id,deal_id,quote_id,name,code,start_date,end_date,budget_minor,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
        ctx.tenantId,
        d.entity_id,
        d.id,
        q.id,
        c.name,
        c.code,
        c.start_date,
        c.end_date,
        String(minor(c.budget)),
        ctx.userId,
      ],
    );
  } else if (c.action === "project.update") {
    const p = await get(tx, "projects", id);
    if (p.version !== c.version)
      throw new Problem(409, "Project changed. Reload before editing.");
    if (c.end_date && c.end_date < c.start_date)
      throw new Problem(400, "End date cannot precede start date.");
    await tx.query(
      "UPDATE projects SET name=$2,start_date=$3,end_date=$4,budget_minor=$5,status=$6,version=version+1 WHERE id=$1",
      [id, c.name, c.start_date, c.end_date, String(minor(c.budget)), c.status],
    );
  } else if (c.action === "project.milestone") {
    const p = await get(tx, "projects", c.project_id),
      d = await get(tx, "deals", p.deal_id),
      q = await get(tx, "quotes", p.quote_id, false);
    const prior = (
      await tx.query(
        "SELECT id,request_payload FROM project_milestones WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (!samePayload(prior.request_payload, c))
        throw new Problem(
          409,
          "This retry key was used for another milestone.",
        );
      return { id: prior.id };
    }
    if (p.status !== "Active")
      throw new Problem(409, "Resume the project before adding milestones.");
    const invoices = await activeInvoices(tx, d.id);
    const planned = (
      await tx.query(
        "SELECT m.* FROM project_milestones m WHERE project_id=$1 AND status='Planned'",
        [p.id],
      )
    ).rows
      .filter((m) => !invoices.some((i) => i.milestone_id === m.id))
      .reduce((s, m) => s + BigInt(m.net_minor), 0n);
    const amount = minor(c.amount);
    if (
      amount <= 0n ||
      amount +
        planned +
        invoices.reduce((s, i) => s + BigInt(i.net_minor), 0n) >
        BigInt(q.net_minor)
    )
      throw new Problem(
        409,
        "Milestones and invoices cannot exceed the accepted quote subtotal.",
      );
    await tx.query(
      "INSERT INTO project_milestones(id,tenant_id,project_id,name,due_date,net_minor,billing_kind,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        ctx.tenantId,
        p.id,
        c.name,
        c.due_date,
        String(amount),
        c.billing_kind,
        c.request_key,
        JSON.stringify(c),
      ],
    );
  } else if (c.action === "project.cancel-milestone") {
    const m = await get(tx, "project_milestones", id, false),
      p = await get(tx, "projects", m.project_id);
    await get(tx, "deals", p.deal_id);
    if (
      (await activeInvoices(tx, p.deal_id)).some((i) => i.milestone_id === id)
    )
      throw new Problem(
        409,
        "Cancel or void the linked invoice before cancelling this milestone.",
      );
    if (m.status === "Cancelled") return { id };
    await tx.query(
      "UPDATE project_milestones SET status='Cancelled' WHERE id=$1",
      [id],
    );
  } else if (c.action === "invoice.cancel") {
    const i = await get(tx, "invoices", id);
    if (i.status === "Cancelled") return { id };
    if (i.status !== "Draft")
      throw new Problem(409, "Only an unissued draft can be cancelled.");
    await tx.query("UPDATE invoices SET status='Cancelled' WHERE id=$1", [id]);
  } else if (c.action === "invoice.recognise") {
    const i = await get(tx, "invoices", id);
    const prior = (
      await tx.query(
        "SELECT id,request_payload FROM revenue_recognitions WHERE request_key=$1",
        [c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (!samePayload(prior.request_payload, c))
        throw new Problem(
          409,
          "This retry key was used for another recognition.",
        );
      return { id: prior.id };
    }
    if (
      i.billing_kind !== "advance" ||
      !["Issued", "Paid", "Settled"].includes(i.status)
    )
      throw new Problem(
        409,
        "Only an issued advance invoice can have revenue recognised.",
      );
    await openDate(tx, i.entity_id, c.date);
    if (c.date < date(i.issue_date))
      throw new Problem(400, "Recognition cannot precede the invoice date.");
    const used = (
      await tx.query(
        "SELECT coalesce(sum(net_minor),0)::text AS net,coalesce(sum(base_minor),0)::text AS base FROM revenue_recognitions WHERE invoice_id=$1",
        [id],
      )
    ).rows[0];
    const amount = minor(c.amount),
      net = BigInt(i.net_minor);
    const credits = (await invoiceCredits(tx, i.id)).filter(
      (c) => c.treatment === "deferred",
    );
    if (credits.some((x) => c.date < date(x.credit_date)))
      throw new Problem(
        409,
        "Recognition cannot precede existing deferred credits.",
      );
    const remainingNet =
        net -
        BigInt(used.net) -
        credits.reduce((s, x) => s + BigInt(x.net_minor), 0n),
      remainingBase =
        baseAmount(net, BigInt(i.fx_micros)) -
        BigInt(used.base) -
        credits.reduce((s, x) => s + BigInt(x.net_base_minor), 0n);
    if (amount <= 0n || amount > remainingNet)
      throw new Problem(
        409,
        "Recognition exceeds the deferred invoice subtotal.",
      );
    const base = round(remainingBase * amount, remainingNet);
    if (base <= 0n)
      throw new Problem(400, "Recognition amount rounds to zero in PKR.");
    id = uuid();
    await tx.query(
      "INSERT INTO revenue_recognitions(id,tenant_id,invoice_id,recognition_date,net_minor,base_minor,reference,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        ctx.tenantId,
        i.id,
        c.date,
        String(amount),
        String(base),
        c.reference,
        c.request_key,
        JSON.stringify(c),
      ],
    );
    await post(
      tx,
      ctx,
      i.entity_id,
      c.date,
      "invoice-recognition",
      id,
      `Delivered work: ${i.number} · ${c.reference}`,
      [
        { account: "2300", debit: base },
        { account: "4000", credit: base },
      ],
    );
  } else throw new Problem(400, "Unknown project action.");
  await audit(tx, ctx, id, c.action, c);
  return { id };
}

export async function projectSnapshot(tx: SQL, ctx: Context) {
  if (!["admin", "finance"].includes(ctx.role))
    return { projects: [], milestones: [], recognitions: [] };
  const projects = (
    await tx.query(`WITH sources AS (
 SELECT i.deal_id,j.id FROM invoices i JOIN journals j ON j.source_id=i.id AND j.source_type IN ('invoice','invoice_void')
 UNION ALL SELECT i.deal_id,j.id FROM credit_notes c JOIN invoices i ON i.id=c.invoice_id JOIN journals j ON j.source_id=c.id AND j.source_type='credit'
 UNION ALL SELECT i.deal_id,j.id FROM credit_reversals r JOIN credit_notes c ON c.id=r.credit_id JOIN invoices i ON i.id=c.invoice_id JOIN journals j ON j.source_id=r.id AND j.source_type='credit-reversal'
 UNION ALL SELECT i.deal_id,j.id FROM credit_applications a JOIN invoices i ON i.id=a.invoice_id JOIN journals j ON j.source_id=a.id AND j.source_type='credit-application'
 UNION ALL SELECT i.deal_id,j.id FROM application_reversals r JOIN credit_applications a ON a.id=r.application_id JOIN invoices i ON i.id=a.invoice_id JOIN journals j ON j.source_id=r.id AND j.source_type='credit-application-reversal'
 UNION ALL SELECT i.deal_id,j.id FROM customer_refunds f JOIN credit_notes c ON c.id=f.credit_id JOIN invoices i ON i.id=c.invoice_id JOIN journals j ON j.source_id=f.id AND j.source_type='customer-refund'
 UNION ALL SELECT i.deal_id,j.id FROM refund_reversals r JOIN customer_refunds f ON f.id=r.refund_id JOIN credit_notes c ON c.id=f.credit_id JOIN invoices i ON i.id=c.invoice_id JOIN journals j ON j.source_id=r.id AND j.source_type='customer-refund-reversal'
 UNION ALL SELECT i.deal_id,j.id FROM revenue_recognitions r JOIN invoices i ON i.id=r.invoice_id JOIN journals j ON j.source_id=r.id AND j.source_type='invoice-recognition'
 UNION ALL SELECT i.deal_id,j.id FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN journals j ON j.source_id=p.id AND j.source_type='payment'
 UNION ALL SELECT x.deal_id,j.id FROM expenses x JOIN journals j ON j.source_id=x.id AND j.source_type='expense'
 UNION ALL SELECT b.deal_id,j.id FROM bills b JOIN journals j ON j.source_id=b.id AND j.source_type IN ('bill','bill-void')
 UNION ALL SELECT b.deal_id,j.id FROM vendor_payments p JOIN bills b ON b.id=p.bill_id JOIN journals j ON j.source_id=p.id AND j.source_type='vendor-payment'
 UNION ALL SELECT b.deal_id,j.id FROM vendor_payment_reversals r JOIN vendor_payments p ON p.id=r.payment_id JOIN bills b ON b.id=p.bill_id JOIN journals j ON j.source_id=r.id AND j.source_type='vendor-payment-reversal'
 ), amounts AS (
 SELECT s.deal_id,
 coalesce(sum(l.credit_minor-l.debit_minor) FILTER(WHERE l.account_code='4000'),0)::text AS revenue,
 coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE l.account_code IN ('5000','5200','5300')),0)::text AS cost,
 coalesce(sum(l.credit_minor-l.debit_minor) FILTER(WHERE l.account_code IN ('4100','5100')),0)::text AS fx_result,
 coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE j.source_type='payment' AND (l.account_code='1000' OR l.account_code LIKE '10B%')),0)::text AS cash,
 coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE l.account_code='1200'),0)::text AS withholding,
 coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE l.account_code='1100'),0)::text AS receivable,
 coalesce(sum(l.credit_minor-l.debit_minor) FILTER(WHERE l.account_code='2300'),0)::text AS deferred,
 coalesce(sum(l.credit_minor-l.debit_minor) FILTER(WHERE j.source_type IN ('customer-refund','customer-refund-reversal') AND (l.account_code='1000' OR l.account_code LIKE '10B%')),0)::text AS refunded
 FROM sources s JOIN journals j ON j.id=s.id JOIN journal_lines l ON l.journal_id=s.id GROUP BY s.deal_id)
 SELECT p.*,q.customer_name,d.contact_id,q.currency,q.fx_micros,q.net_minor::text AS quote_net,q.total_minor::text AS quote_total,
 coalesce(a.revenue,'0') AS revenue,coalesce(a.cost,'0') AS cost,coalesce(a.cash,'0') AS cash,coalesce(a.withholding,'0') AS withholding,coalesce(a.receivable,'0') AS receivable,coalesce(a.deferred,'0') AS deferred,coalesce(a.fx_result,'0') AS fx_result,
 coalesce(a.refunded,'0') AS refunded,
 (SELECT coalesce(sum(i.net_minor),0)::text FROM invoices i WHERE i.deal_id=p.deal_id AND i.status IN ('Issued','Paid','Settled')) AS billed_net,
 (SELECT coalesce(sum(i.net_minor),0)::text FROM invoices i WHERE i.deal_id=p.deal_id AND i.status='Draft') AS reserved_net,
 (SELECT coalesce(sum(m.net_minor),0)::text FROM project_milestones m WHERE m.project_id=p.id AND m.status='Planned' AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.milestone_id=m.id AND i.status NOT IN ('Cancelled','Voided'))) AS planned_net
 FROM projects p JOIN quotes q ON q.id=p.quote_id JOIN deals d ON d.id=p.deal_id LEFT JOIN amounts a ON a.deal_id=p.deal_id ORDER BY p.created_at DESC`)
  ).rows;
  const milestones = (
    await tx.query(
      "SELECT * FROM project_milestones ORDER BY due_date,created_at",
    )
  ).rows;
  const recognitions = (
    await tx.query(
      "SELECT id,invoice_id,recognition_date,net_minor,base_minor,reference FROM revenue_recognitions ORDER BY recognition_date",
    )
  ).rows;
  return { projects, milestones, recognitions };
}
