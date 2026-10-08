import type { SQL } from "./db.ts";
import { Problem, type Context } from "./domain.ts";
import { ageing } from "./financial-reports.ts";
import type {
  PartyStatement,
  StatementFilter,
  StatementGroup,
} from "../shared/statements.ts";
import { hasCapability } from "../shared/permissions.ts";

// Link each immutable posting to its party and transaction currency. Applications
// move AR into credits payable, so they have zero net statement movement.
const customerEffects = `
 SELECT j.source_type AS type,i.id,i.company_id AS party_id,i.currency,i.number,
 CASE WHEN j.source_type='invoice' THEN i.total_minor ELSE -i.total_minor END AS amount,
 0::bigint AS credit_delta,'invoice' AS link_type,i.id AS link_id
 FROM invoices i JOIN journals j ON j.source_id=i.id AND j.source_type IN ('invoice','invoice_void')
 UNION ALL SELECT 'payment',p.id,i.company_id,i.currency,coalesce(nullif(p.reference,''),i.number),-(p.amount_minor+p.wht_minor),0,'invoice',i.id
 FROM payments p JOIN invoices i ON i.id=p.invoice_id
 UNION ALL SELECT 'credit',c.id,i.company_id,i.currency,c.number,-c.total_minor,c.total_minor,'credit',c.id
 FROM credit_notes c JOIN invoices i ON i.id=c.invoice_id
 UNION ALL SELECT 'credit-reversal',r.id,i.company_id,i.currency,c.number,c.total_minor,-c.total_minor,'credit',c.id
 FROM credit_reversals r JOIN credit_notes c ON c.id=r.credit_id JOIN invoices i ON i.id=c.invoice_id
 UNION ALL SELECT 'credit-application',a.id,i.company_id,i.currency,c.number,0,-a.amount_minor,'invoice',i.id
 FROM credit_applications a JOIN invoices i ON i.id=a.invoice_id JOIN credit_notes c ON c.id=a.credit_id
 UNION ALL SELECT 'credit-application-reversal',r.id,i.company_id,i.currency,c.number,0,a.amount_minor,'invoice',i.id
 FROM application_reversals r JOIN credit_applications a ON a.id=r.application_id JOIN invoices i ON i.id=a.invoice_id JOIN credit_notes c ON c.id=a.credit_id
 UNION ALL SELECT 'customer-refund',r.id,i.company_id,i.currency,coalesce(nullif(r.reference,''),c.number),r.amount_minor,-r.amount_minor,'credit',c.id
 FROM customer_refunds r JOIN credit_notes c ON c.id=r.credit_id JOIN invoices i ON i.id=c.invoice_id
 UNION ALL SELECT 'customer-refund-reversal',v.id,i.company_id,i.currency,c.number,-r.amount_minor,r.amount_minor,'credit',c.id
 FROM refund_reversals v JOIN customer_refunds r ON r.id=v.refund_id JOIN credit_notes c ON c.id=r.credit_id JOIN invoices i ON i.id=c.invoice_id`;
const vendorEffects = `
 SELECT j.source_type AS type,b.id,b.vendor_id AS party_id,b.currency,b.reference AS number,
 CASE WHEN j.source_type='bill' THEN b.total_minor ELSE -b.total_minor END AS amount,
 0::bigint AS credit_delta,'bill' AS link_type,b.id AS link_id
 FROM bills b JOIN journals j ON j.source_id=b.id AND j.source_type IN ('bill','bill-void')
 UNION ALL SELECT 'vendor-payment',p.id,b.vendor_id,b.currency,coalesce(nullif(p.reference,''),b.reference),-(p.amount_minor+p.wht_minor),0,'bill',b.id
 FROM vendor_payments p JOIN bills b ON b.id=p.bill_id
 UNION ALL SELECT 'vendor-payment-reversal',r.id,b.vendor_id,b.currency,b.reference,p.amount_minor+p.wht_minor,0,'bill',b.id
 FROM vendor_payment_reversals r JOIN vendor_payments p ON p.id=r.payment_id JOIN bills b ON b.id=p.bill_id
 UNION ALL SELECT 'vendor-payment-batch',p.id,p.vendor_id,p.currency,p.reference,-(p.amount_minor+p.wht_minor),0,'vendor-payments',p.id FROM vendor_payment_batches p
 UNION ALL SELECT 'vendor-payment-batch-reversal',r.id,p.vendor_id,p.currency,p.reference,p.amount_minor+p.wht_minor,0,'vendor-payments',p.id FROM vendor_payment_batch_reversals r JOIN vendor_payment_batches p ON p.id=r.payment_id
 UNION ALL SELECT 'vendor-credit',v.id,b.vendor_id,b.currency,v.number,-v.total_minor,v.total_minor,'vendor-credits',v.id FROM vendor_credits v JOIN bills b ON b.id=v.bill_id
 UNION ALL SELECT 'vendor-credit-reversal',r.id,b.vendor_id,b.currency,v.number,v.total_minor,-v.total_minor,'vendor-credits',v.id FROM vendor_credit_reversals r JOIN vendor_credits v ON v.id=r.credit_id JOIN bills b ON b.id=v.bill_id
 UNION ALL SELECT 'vendor-credit-application',a.id,b.vendor_id,b.currency,v.number,0,-a.amount_minor,'bill',b.id FROM vendor_credit_applications a JOIN vendor_credits v ON v.id=a.credit_id JOIN bills b ON b.id=a.bill_id
 UNION ALL SELECT 'vendor-credit-application-reversal',r.id,b.vendor_id,b.currency,v.number,0,a.amount_minor,'bill',b.id FROM vendor_application_reversals r JOIN vendor_credit_applications a ON a.id=r.application_id JOIN vendor_credits v ON v.id=a.credit_id JOIN bills b ON b.id=a.bill_id
 UNION ALL SELECT 'vendor-refund',f.id,b.vendor_id,b.currency,f.reference,f.amount_minor,-f.amount_minor,'vendor-credits',v.id FROM vendor_refunds f JOIN vendor_credits v ON v.id=f.credit_id JOIN bills b ON b.id=v.bill_id
 UNION ALL SELECT 'vendor-refund-reversal',r.id,b.vendor_id,b.currency,v.number,-f.amount_minor,f.amount_minor,'vendor-credits',v.id FROM vendor_refund_reversals r JOIN vendor_refunds f ON f.id=r.refund_id JOIN vendor_credits v ON v.id=f.credit_id JOIN bills b ON b.id=v.bill_id`;

const vendorAdvanceEffects = `
 SELECT 'vendor-advance',v.id,v.vendor_id,v.currency,v.reference,-v.total_minor,0::bigint,'vendor-advances',v.id,v.total_minor,-v.base_minor FROM vendor_advances v
 UNION ALL SELECT 'vendor-advance-reversal',r.id,v.vendor_id,v.currency,v.reference,v.total_minor,0,'vendor-advances',v.id,-v.total_minor,v.base_minor FROM vendor_advance_reversals r JOIN vendor_advances v ON v.id=r.advance_id
 UNION ALL SELECT 'vendor-advance-application',a.id,v.vendor_id,v.currency,v.reference,0,0,'vendor-advances',v.id,-a.amount_minor,a.carrying_minor-a.bill_carrying_minor FROM vendor_advance_applications a JOIN vendor_advances v ON v.id=a.advance_id
 UNION ALL SELECT 'vendor-advance-application-reversal',r.id,v.vendor_id,v.currency,v.reference,0,0,'vendor-advances',v.id,a.amount_minor,a.bill_carrying_minor-a.carrying_minor FROM vendor_advance_application_reversals r JOIN vendor_advance_applications a ON a.id=r.application_id JOIN vendor_advances v ON v.id=a.advance_id
 UNION ALL SELECT 'vendor-advance-refund',f.id,v.vendor_id,v.currency,f.reference,f.amount_minor,0,'vendor-advances',v.id,-f.amount_minor,f.carrying_minor FROM vendor_advance_refunds f JOIN vendor_advances v ON v.id=f.advance_id
 UNION ALL SELECT 'vendor-advance-refund-reversal',r.id,v.vendor_id,v.currency,f.reference,-f.amount_minor,0,'vendor-advances',v.id,f.amount_minor,-f.carrying_minor FROM vendor_advance_refund_reversals r JOIN vendor_advance_refunds f ON f.id=r.refund_id JOIN vendor_advances v ON v.id=f.advance_id`;

export async function partyStatement(
  tx: SQL,
  ctx: Context,
  filter: StatementFilter,
): Promise<PartyStatement> {
  if (!hasCapability(ctx, "books.view"))
    throw new Problem(403, "A finance role is required for statements.");
  const company = (
    await tx.query("SELECT id,name,address,tax_id FROM companies WHERE id=$1", [
      filter.companyId,
    ])
  ).rows[0];
  if (!company)
    throw new Problem(404, "Company not found in this organization.");
  const entities = (
    await tx.query(
      "SELECT id,code,name FROM entities WHERE ($1::uuid IS NULL OR id=$1) ORDER BY code",
      [filter.entityId === "all" ? null : filter.entityId],
    )
  ).rows;
  if (filter.entityId !== "all" && !entities.length)
    throw new Problem(404, "Entity not found in this organization.");
  const ids = entities.map((e) => e.id);
  const customer = filter.kind === "customer";
  const rows = (
    await tx.query(
      `WITH original_effects AS (${customer ? customerEffects : vendorEffects}), effects AS (SELECT original_effects.*,0::bigint AS advance_delta,NULL::bigint AS base_override FROM original_effects ${customer ? "" : `UNION ALL ${vendorAdvanceEffects}`})
    SELECT j.id,j.posted_on AS date,j.description,ef.type,ef.number,ef.amount::text,ef.credit_delta::text,ef.advance_delta::text,
      ef.currency,ef.link_type,ef.link_id,j.entity_id,e.code AS entity_code,e.name AS entity_name,
      coalesce(ef.base_override,${customer ? "" : "-"}coalesce(l.delta,0))::text AS base
    FROM effects ef JOIN journals j ON j.source_type=ef.type AND j.source_id=ef.id
    JOIN entities e ON e.id=j.entity_id
    LEFT JOIN (SELECT journal_id,sum(debit_minor-credit_minor) AS delta FROM journal_lines
      WHERE account_code ${customer ? "IN ('1100','2400')" : "IN ('2000','1350')"} GROUP BY journal_id) l ON l.journal_id=j.id
    WHERE ef.party_id=$1 AND j.entity_id=ANY($2::uuid[]) AND j.posted_on<=$3
    ORDER BY j.posted_on,j.created_at,j.id`,
      [filter.companyId, ids, filter.to],
    )
  ).rows;
  const aged = await ageing(
    tx,
    ids,
    filter.to,
    customer ? "ar" : "ap",
    0n,
    filter.companyId,
  );
  const groups = new Map<string, StatementGroup>();
  const groupFor = (entityId: string, currency: string) => {
    const key = `${entityId}/${currency}`;
    let g = groups.get(key);
    if (!g) {
      const e = entities.find((e) => e.id === entityId)!;
      g = {
        entity_id: e.id,
        entity_code: e.code,
        entity_name: e.name,
        currency,
        opening: "0",
        closing: "0",
        openingBase: "0",
        closingBase: "0",
        increases: "0",
        decreases: "0",
        outstanding: "0",
        availableCredit: "0",
        availableAdvance: "0",
        entries: [],
        documents: [],
      };
      groups.set(key, g);
    }
    return g;
  };
  for (const r of rows) {
    const g = groupFor(r.entity_id, r.currency);
    g.closing = String(BigInt(g.closing) + BigInt(r.amount));
    g.closingBase = String(BigInt(g.closingBase) + BigInt(r.base));
    g.availableCredit = String(
      BigInt(g.availableCredit) + BigInt(r.credit_delta),
    );
    g.availableAdvance = String(
      BigInt(g.availableAdvance) + BigInt(r.advance_delta),
    );
    if (r.date < filter.from) {
      g.opening = g.closing;
      g.openingBase = g.closingBase;
    } else {
      if (BigInt(r.amount) >= 0n)
        g.increases = String(BigInt(g.increases) + BigInt(r.amount));
      else g.decreases = String(BigInt(g.decreases) - BigInt(r.amount));
      g.entries.push({
        id: r.id,
        date: r.date,
        type: r.type,
        number: r.number,
        description: r.description,
        amount: r.amount,
        base: r.base,
        balance: g.closing,
        baseBalance: g.closingBase,
        link_type: r.link_type,
        link_id: r.link_id,
      });
    }
  }
  for (const d of aged.documents) {
    const g = groupFor(d.entity_id, d.currency);
    g.documents.push(d);
    g.outstanding = String(BigInt(g.outstanding) + BigInt(d.outstanding));
  }
  return {
    filter,
    generatedAt: new Date().toISOString(),
    company: company as PartyStatement["company"],
    groups: [...groups.values()].sort(
      (a, b) =>
        a.entity_code.localeCompare(b.entity_code) ||
        a.currency.localeCompare(b.currency),
    ),
  };
}
