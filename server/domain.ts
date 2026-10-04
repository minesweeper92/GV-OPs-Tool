import { randomUUID as uuid } from "node:crypto";
import type { SQL, Row } from "./db.ts";
import { minor, scaled, baseAmount, round } from "../shared/money.ts";
import { documentTotals } from "../shared/documents.ts";
import { cashAccount } from "./bank-account.ts";
import { createProjectInvoice } from "./projects.ts";
import { detailsSnapshot } from "./documents.ts";
import { allocateNumber, createNumberSeries } from "./numbering.ts";
export type Context = {
  tenantId: string;
  userId: string;
  role: "admin" | "finance" | "sales" | "viewer";
  name?: string;
};
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const reject = (status: number, message: string): never => {
  throw new Problem(status, message);
};
const crm = (ctx: Context) => {
  if (!["admin", "sales"].includes(ctx.role))
    reject(403, "Your role cannot change CRM records.");
};
const finance = (ctx: Context) => {
  if (!["admin", "finance"].includes(ctx.role))
    reject(403, "Your role cannot post or view the books.");
};
export const chart = [
  ["1000", "Bank and cash", "Asset"],
  ["1100", "Accounts receivable", "Asset"],
  ["1200", "Withholding tax receivable", "Asset"],
  ["1300", "Input tax receivable", "Asset"],
  ["1400", "Prepayments", "Asset"],
  ["1500", "Equipment", "Asset"],
  ["2000", "Accounts payable", "Liability"],
  ["2100", "Output tax payable", "Liability"],
  ["2200", "Withholding tax payable", "Liability"],
  ["2300", "Deferred service revenue", "Liability"],
  ["2400", "Customer credits payable", "Liability"],
  ["3000", "Owner equity", "Equity"],
  ["3900", "Opening balance clearing", "Equity"],
  ["4000", "Service revenue", "Income"],
  ["4100", "Realised exchange gain", "Income"],
  ["5000", "Operating expenses", "Expense"],
  ["5100", "Realised exchange loss", "Expense"],
  ["5200", "Project production costs", "Expense"],
  ["5300", "Bank charges", "Expense"],
];
export async function seedAccounts(
  tx: SQL,
  tenantId: string,
  entityId: string,
) {
  for (const [code, name, type] of chart)
    await tx.query(
      "INSERT INTO accounts(tenant_id,entity_id,code,name,type,system) VALUES($1,$2,$3,$4,$5,true)",
      [tenantId, entityId, code, name, type],
    );
}
export async function audit(
  tx: SQL,
  ctx: Context,
  recordId: string,
  action: string,
  details: Row,
) {
  await tx.query(
    "INSERT INTO audit_events(id,tenant_id,actor_id,record_id,action,details) VALUES($1,$2,$3,$4,$5,$6)",
    [
      uuid(),
      ctx.tenantId,
      ctx.userId,
      recordId,
      action,
      JSON.stringify(details),
    ],
  );
}
async function record(
  tx: SQL,
  table: string,
  id: string,
  ctx: Context,
  owned = false,
): Promise<Row> {
  // Table names originate only from constants in this module.
  const r = (
    await tx.query(
      `SELECT * FROM ${table} WHERE id=$1 ${table === "quotes" ? "" : "FOR UPDATE"}`,
      [id],
    )
  ).rows[0];
  if (!r) reject(404, "Record not found in this organization.");
  if (owned && ctx.role === "sales" && r.owner_id !== ctx.userId)
    reject(403, "This record belongs to another team member.");
  return r;
}
async function entityDate(tx: SQL, id: string, date: string, ctx: Context) {
  const entity = await record(tx, "entities", id, ctx);
  if (entity.lock_date && date <= String(entity.lock_date).slice(0, 10))
    reject(409, "This accounting period is locked. Choose a later date.");
  return entity;
}
type PostingLine = {
  account: string;
  debit?: bigint;
  credit?: bigint;
  memo?: string;
};
type PostingMeta = {
  reference?: string;
  memo?: string;
  requestHash?: string;
  reversesJournalId?: string;
};
export async function post(
  tx: SQL,
  ctx: Context,
  entity: string,
  date: string,
  source: string,
  sourceId: string,
  description: string,
  lines: PostingLine[],
  meta: PostingMeta = {},
) {
  const period = (
    await tx.query(
      "SELECT status FROM accounting_periods WHERE entity_id=$1 AND month=date_trunc('month',$2::date)::date",
      [entity, date],
    )
  ).rows[0];
  if (period?.status === "Closed")
    throw new Problem(
      409,
      "This accounting month is closed. Reopen it before posting.",
    );
  if (
    period?.status === "Soft closed" &&
    !["admin", "finance"].includes(ctx.role)
  )
    throw new Problem(409, "Only finance can post in a soft-closed month.");
  const filtered = lines.filter((l) => (l.debit || 0n) + (l.credit || 0n) > 0n);
  if (source !== "bank-opening") {
    const closed = (
      await tx.query(
        "SELECT name FROM bank_accounts WHERE entity_id=$1 AND account_code=ANY($2::text[]) AND last_reconciled_on>=$3",
        [entity, filtered.map((l) => l.account), date],
      )
    ).rows;
    if (closed.length)
      throw new Problem(
        409,
        "This posting would change a reconciled bank period. Choose a later date.",
      );
  }
  const delta = filtered.reduce(
    (sum, l) => sum + (l.debit || 0n) - (l.credit || 0n),
    0n,
  );
  if (filtered.length < 2 || delta !== 0n)
    throw new Error("Posting is not balanced.");
  const id = uuid();
  await tx.query(
    "INSERT INTO journals(id,tenant_id,entity_id,source_type,source_id,posted_on,description,actor_id,external_reference,memo,request_hash,reverses_journal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      id,
      ctx.tenantId,
      entity,
      source,
      sourceId,
      date,
      description,
      ctx.userId,
      meta.reference || "",
      meta.memo || "",
      meta.requestHash || null,
      meta.reversesJournalId || null,
    ],
  );
  for (const [index, l] of filtered.entries())
    await tx.query(
      "INSERT INTO journal_lines(id,tenant_id,entity_id,journal_id,account_code,debit_minor,credit_minor,memo,line_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        uuid(),
        ctx.tenantId,
        entity,
        id,
        l.account,
        String(l.debit || 0n),
        String(l.credit || 0n),
        l.memo || "",
        index + 1,
      ],
    );
  return id;
}
export async function snapshot(tx: SQL, ctx: Context) {
  const own = ctx.role === "sales",
    allowedBooks = ["admin", "finance"].includes(ctx.role);
  const list = (table: string) =>
    tx
      .query(
        `SELECT * FROM ${table} ${own ? "WHERE owner_id=$1" : ""} ORDER BY created_at DESC`,
        own ? [ctx.userId] : [],
      )
      .then((r) => r.rows);
  const [entities, companies, contacts, leads, deals] = await Promise.all([
    tx.query("SELECT * FROM entities ORDER BY code").then((r) => r.rows),
    list("companies"),
    list("contacts"),
    list("leads"),
    list("deals"),
  ]);
  const dealIds = deals.map((d) => d.id),
    contactIds = contacts.map((c) => c.id);
  const quotes = (
    await tx.query(
      "SELECT * FROM quotes WHERE deal_id=ANY($1::uuid[]) ORDER BY created_at DESC",
      [dealIds],
    )
  ).rows;
  const invoices = (
    await tx.query(
      `SELECT i.*,d.name AS deal_name,e.code AS entity_code
    FROM invoices i LEFT JOIN deals d ON d.id=i.deal_id JOIN entities e ON e.id=i.entity_id
    WHERE (NOT $2::boolean OR i.deal_id=ANY($1::uuid[])) ORDER BY i.created_at DESC`,
      [dealIds, own],
    )
  ).rows;
  const affiliations = (
    await tx.query(
      "SELECT * FROM affiliations WHERE contact_id=ANY($1::uuid[]) ORDER BY started_on DESC",
      [contactIds],
    )
  ).rows;
  const quoteEvents = (
    await tx.query(
      "SELECT * FROM quote_events WHERE quote_id=ANY($1::uuid[]) ORDER BY created_at DESC",
      [quotes.map((q) => q.id)],
    )
  ).rows;
  const invoiceDeliveryEvents = (
    await tx.query(
      "SELECT * FROM invoice_delivery_events WHERE invoice_id=ANY($1::uuid[]) ORDER BY created_at DESC",
      [invoices.map((i) => i.id)],
    )
  ).rows;
  const documentAttachments = (
    await tx.query(
      `SELECT id,quote_id,invoice_id,filename,content_type,size_bytes,uploaded_by,created_at
       FROM document_attachments
       WHERE quote_id=ANY($1::uuid[]) OR invoice_id=ANY($2::uuid[])
       ORDER BY created_at DESC`,
      [quotes.map((q) => q.id), invoices.map((i) => i.id)],
    )
  ).rows;
  const storedSeries = (
    await tx.query(
      "SELECT * FROM number_series ORDER BY entity_id,kind,is_default DESC,name",
    )
  ).rows;
  const numberSeries = [...storedSeries];
  for (const e of entities)
    for (const kind of ["quote", "invoice"] as const)
      if (
        !storedSeries.some(
          (s) => s.entity_id === e.id && s.kind === kind && s.is_default,
        )
      )
        numberSeries.push({
          id: null,
          entity_id: e.id,
          kind,
          name: "Standard",
          prefix: kind === "quote" ? "QT-" : `${e.code}-INV-`,
          padding: kind === "quote" ? 6 : 5,
          next_number: kind === "quote" ? e.next_quote_number : e.next_invoice,
          is_default: true,
        });
  const payments = (
    await tx.query(
      "SELECT * FROM payments WHERE invoice_id=ANY($1::uuid[]) ORDER BY created_at DESC",
      [invoices.map((i) => i.id)],
    )
  ).rows;
  const auditIds = [
    ...dealIds,
    ...contactIds,
    ...companies.map((c) => c.id),
    ...leads.map((l) => l.id),
    ...quotes.map((q) => q.id),
    ...invoices.map((i) => i.id),
    ...payments.map((p) => p.id),
  ];
  const events = (
    await tx.query(
      `SELECT * FROM audit_events ${own ? "WHERE record_id=ANY($1::uuid[]) AND action NOT LIKE 'team.%' AND action NOT LIKE 'organization.%'" : ctx.role === "admin" ? "" : "WHERE action NOT LIKE 'team.%' AND action NOT LIKE 'organization.%'"} ORDER BY created_at DESC LIMIT 200`,
      own ? [auditIds] : [],
    )
  ).rows;
  const expenses = allowedBooks
    ? (await tx.query("SELECT * FROM expenses ORDER BY created_at DESC")).rows
    : [];
  return {
    entities,
    catalogItems: (
      await tx.query(
        "SELECT * FROM catalog_items WHERE active ORDER BY name,id",
      )
    ).rows,
    companies,
    contacts,
    affiliations,
    leads,
    deals,
    quotes,
    quoteEvents,
    invoiceDeliveryEvents,
    documentAttachments,
    numberSeries,
    invoices,
    payments,
    expenses,
    events: allowedBooks
      ? events
      : events.filter(
          (e) =>
            !e.action.startsWith("bill.") &&
            !e.action.startsWith("vendor-payment.") &&
            !e.action.startsWith("bank.") &&
            !e.action.startsWith("project.") &&
            e.action !== "invoice.recognise" &&
            !e.action.startsWith("credit.") &&
            !e.action.startsWith("recurring."),
        ),
  };
}
export async function reports(
  tx: SQL,
  ctx: Context,
  entityId: string,
  from: string,
  to: string,
) {
  finance(ctx);
  await record(tx, "entities", entityId, ctx);
  const trial = (
    await tx.query(
      `SELECT a.id,a.code,a.name,a.type,a.parent_code,a.description,a.active,a.system,a.version,
       coalesce(sum(l.debit_minor),0)::text AS debit,coalesce(sum(l.credit_minor),0)::text AS credit
    FROM accounts a LEFT JOIN journal_lines l ON l.entity_id=a.entity_id AND l.account_code=a.code AND l.journal_id IN
    (SELECT id FROM journals WHERE entity_id=$1 AND posted_on BETWEEN $2 AND $3)
    WHERE a.entity_id=$1 GROUP BY a.id,a.code,a.name,a.type,a.parent_code,a.description,a.active,a.system,a.version ORDER BY a.code`,
      [entityId, from, to],
    )
  ).rows;
  const journals = (
    await tx.query(
      `SELECT j.*,(SELECT r.id FROM journals r WHERE r.reverses_journal_id=j.id) AS reversal_id,
       json_agg(json_build_object('account',l.account_code,'debit',l.debit_minor::text,'credit',l.credit_minor::text,'memo',l.memo) ORDER BY l.line_number,l.id) AS lines
    FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.entity_id=$1 AND j.posted_on BETWEEN $2 AND $3 GROUP BY j.id ORDER BY j.posted_on DESC,j.created_at DESC`,
      [entityId, from, to],
    )
  ).rows;
  const periods = (
    await tx.query(
      "SELECT month,status FROM accounting_periods WHERE entity_id=$1 ORDER BY month DESC",
      [entityId],
    )
  ).rows;
  return { trial, journals, periods };
}
export async function execute(tx: SQL, ctx: Context, c: Row) {
  const t = ctx.tenantId,
    id = uuid();
  if (
    ctx.role === "finance" &&
    [
      "company.create",
      "contact.create",
      "contact.associate",
      "contact.end-association",
      "note.create",
    ].includes(c.action)
  ) {
    /* Shared customer and vendor maintenance. */
  } else if (
    [
      "company.create",
      "contact.create",
      "contact.associate",
      "contact.end-association",
      "lead.create",
      "lead.convert",
      "deal.follow-up",
      "deal.lose",
      "quote.create",
      "quote.share",
      "quote.accept",
      "note.create",
    ].includes(c.action)
  )
    crm(ctx);
  else finance(ctx);
  switch (c.action) {
    case "company.create": {
      if (c.service_entity_id)
        await record(tx, "entities", c.service_entity_id, ctx);
      const inserted = await tx.query(
        "INSERT INTO companies(id,tenant_id,name,domain,industry,tax_id,address,customer,vendor,service_entity_id,owner_id,creation_request_key,creation_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(tenant_id,creation_request_key) DO NOTHING RETURNING id",
        [
          id,
          t,
          c.name,
          c.domain,
          c.industry,
          c.tax_id,
          c.address,
          c.customer,
          c.vendor,
          c.service_entity_id,
          ctx.userId,
          c.request_key || null,
          c.request_key ? JSON.stringify(c) : null,
        ],
      );
      if (!inserted.rows.length) {
        const prior = (
          await tx.query(
            "SELECT id,owner_id,creation_payload=$2::jsonb AS same FROM companies WHERE creation_request_key=$1",
            [c.request_key, JSON.stringify(c)],
          )
        ).rows[0];
        if (
          !prior ||
          !prior.same ||
          (ctx.role === "sales" && prior.owner_id !== ctx.userId)
        )
          reject(
            409,
            "This retry key belongs to a different company creation. Refresh and try again.",
          );
        return { id: prior.id };
      }
      break;
    }
    case "contact.create": {
      if (c.company_id) await record(tx, "companies", c.company_id, ctx, true);
      await tx.query(
        "INSERT INTO contacts(id,tenant_id,first_name,last_name,email,phone,title,source,notes,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          t,
          c.first_name,
          c.last_name,
          c.email.toLowerCase(),
          c.phone,
          c.title,
          c.source,
          c.notes,
          ctx.userId,
        ],
      );
      if (c.company_id)
        await tx.query(
          "INSERT INTO affiliations(id,tenant_id,contact_id,company_id,role,started_on) VALUES($1,$2,$3,$4,$5,CURRENT_DATE)",
          [uuid(), t, id, c.company_id, c.role],
        );
      break;
    }
    case "contact.associate": {
      await record(tx, "contacts", c.contact_id, ctx, true);
      await record(tx, "companies", c.company_id, ctx, true);
      await tx.query(
        "INSERT INTO affiliations(id,tenant_id,contact_id,company_id,role,work_email,started_on) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, t, c.contact_id, c.company_id, c.role, c.work_email, c.started_on],
      );
      break;
    }
    case "contact.end-association": {
      const a = await record(tx, "affiliations", c.id, ctx);
      await record(tx, "contacts", a.contact_id, ctx, true);
      if (a.ended_on) reject(409, "This association has already ended.");
      await tx.query("UPDATE affiliations SET ended_on=$2 WHERE id=$1", [
        c.id,
        c.ended_on,
      ]);
      break;
    }
    case "lead.create": {
      await record(tx, "companies", c.company_id, ctx, true);
      await record(tx, "contacts", c.contact_id, ctx, true);
      await record(tx, "entities", c.entity_id, ctx);
      const link = (
        await tx.query(
          "SELECT id FROM affiliations WHERE contact_id=$1 AND company_id=$2 AND ended_on IS NULL",
          [c.contact_id, c.company_id],
        )
      ).rows[0];
      if (!link)
        reject(400, "Choose a contact currently associated with this company.");
      await tx.query(
        "INSERT INTO leads(id,tenant_id,company_id,contact_id,entity_id,title,source,next_action,due_date,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          t,
          c.company_id,
          c.contact_id,
          c.entity_id,
          c.title,
          c.source,
          c.next_action,
          c.due_date,
          ctx.userId,
        ],
      );
      break;
    }
    case "lead.convert": {
      const l = await record(tx, "leads", c.id, ctx, true);
      if (l.status === "Converted")
        return (await tx.query("SELECT id FROM deals WHERE lead_id=$1", [l.id]))
          .rows[0];
      if (l.status === "Disqualified")
        reject(409, "A disqualified lead cannot be converted.");
      await tx.query(
        "INSERT INTO deals(id,tenant_id,company_id,contact_id,entity_id,lead_id,name,next_action,due_date,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          t,
          l.company_id,
          l.contact_id,
          l.entity_id,
          l.id,
          l.title,
          l.next_action,
          l.due_date,
          l.owner_id,
        ],
      );
      await tx.query(
        "UPDATE leads SET status='Converted',next_action=NULL,due_date=NULL WHERE id=$1",
        [l.id],
      );
      await tx.query("UPDATE deals SET profile=$2 WHERE id=$1", [
        id,
        JSON.stringify(l.profile || {}),
      ]);
      break;
    }
    case "deal.follow-up":
    case "deal.lose": {
      const d = await record(tx, "deals", c.id, ctx, true);
      if (["Won", "Lost"].includes(d.stage))
        reject(
          409,
          "This deal is closed. Its commercial history is preserved.",
        );
      if (c.action === "deal.lose")
        await tx.query(
          "UPDATE deals SET stage='Lost',next_action=NULL,due_date=NULL WHERE id=$1",
          [d.id],
        );
      else
        await tx.query(
          "UPDATE deals SET next_action=$2,due_date=$3 WHERE id=$1",
          [d.id, c.next_action, c.due_date],
        );
      break;
    }
    case "quote.create": {
      const d = await record(tx, "deals", c.deal_id, ctx, true);
      if (["Won", "Lost"].includes(d.stage))
        reject(409, "Cannot revise a closed deal.");
      const e = await record(tx, "entities", d.entity_id, ctx),
        company = await record(tx, "companies", d.company_id, ctx, true);
      const fx = scaled(c.fx, 6);
      if (fx <= 0n || (c.currency === e.currency && fx !== 1_000_000n))
        reject(
          400,
          "Base-currency documents must use an exchange rate of 1. Foreign rates must be positive.",
        );
      const details = detailsSnapshot(company, c.details);
      let calculated;
      try {
        calculated = documentTotals(c.lines, details);
      } catch (error) {
        throw new Problem(400, (error as Error).message);
      }
      if (baseAmount(BigInt(calculated.total), fx) <= 0n)
        reject(400, "The converted quote total rounds to zero.");
      const revision = Number(
        (
          await tx.query(
            "SELECT coalesce(max(revision),0)+1 AS n FROM quotes WHERE deal_id=$1 AND option_name=$2",
            [d.id, c.option_name],
          )
        ).rows[0].n,
      );
      const number = await allocateNumber(
        tx,
        t,
        e.id,
        "quote",
        c.number_series_id,
      );
      await tx.query(
        `INSERT INTO quotes(id,tenant_id,deal_id,entity_id,option_name,revision,currency,fx_micros,lines,net_minor,tax_minor,total_minor,customer_name,issuer_name,issuer_address,issuer_tax_id,terms,created_by,details,number)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          id,
          t,
          d.id,
          d.entity_id,
          c.option_name,
          revision,
          c.currency,
          String(fx),
          JSON.stringify(calculated.lines),
          calculated.net,
          calculated.tax,
          calculated.total,
          company.name,
          e.name,
          e.address,
          e.tax_id,
          c.terms,
          ctx.userId,
          JSON.stringify(details),
          number,
        ],
      );
      await tx.query("UPDATE deals SET stage='Proposal' WHERE id=$1", [d.id]);
      break;
    }
    case "quote.share":
    case "quote.accept": {
      const q = await record(tx, "quotes", c.id, ctx),
        d = await record(tx, "deals", q.deal_id, ctx, true);
      if (
        ["Won", "Lost"].includes(d.stage) &&
        (c.action === "quote.accept" || d.accepted_quote_id !== q.id)
      )
        reject(409, "This deal is already closed.");
      if (c.action === "quote.accept") {
        await tx.query(
          "UPDATE deals SET stage='Won',accepted_quote_id=$2,next_action=NULL,due_date=NULL WHERE id=$1",
          [d.id, q.id],
        );
        await tx.query("UPDATE companies SET customer=true WHERE id=$1", [
          d.company_id,
        ]);
      } else if (d.stage !== "Won")
        await tx.query("UPDATE deals SET stage='Negotiation' WHERE id=$1", [
          d.id,
        ]);
      await tx.query(
        "INSERT INTO quote_events(id,tenant_id,quote_id,kind,reference,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          t,
          q.id,
          c.action === "quote.accept" ? "Accepted" : "Shared",
          c.reference,
          ctx.userId,
        ],
      );
      break;
    }
    case "invoice.create": {
      return createProjectInvoice(tx, ctx, c);
    }
    case "number-series.create": {
      return createNumberSeries(tx, ctx, c);
    }
    case "invoice.mark-sent": {
      const invoice = await record(tx, "invoices", c.id, ctx);
      if (!["Issued", "Paid", "Settled"].includes(invoice.status))
        reject(409, "Issue the invoice before marking it sent.");
      await tx.query(
        "INSERT INTO invoice_delivery_events(id,tenant_id,invoice_id,kind,reference,actor_id) VALUES($1,$2,$3,'Sent',$4,$5)",
        [id, t, invoice.id, c.reference, ctx.userId],
      );
      await audit(tx, ctx, invoice.id, c.action, { reference: c.reference });
      return { id: invoice.id };
    }
    case "invoice.issue": {
      const i = await record(tx, "invoices", c.id, ctx);
      if (i.status !== "Draft") {
        if (["Issued", "Paid", "Settled"].includes(i.status))
          return { id: i.id };
        reject(409, "This invoice cannot be issued.");
      }
      const e = await entityDate(
        tx,
        i.entity_id,
        String(i.issue_date).slice(0, 10),
        ctx,
      );
      // Older drafts may be unnumbered; new drafts receive a number on save.
      const number = i.number || (await allocateNumber(tx, t, e.id, "invoice"));
      const net = baseAmount(BigInt(i.net_minor), BigInt(i.fx_micros)),
        total = baseAmount(BigInt(i.total_minor), BigInt(i.fx_micros));
      if (total <= 0n) reject(400, "Base-currency total rounds to zero.");
      await post(
        tx,
        ctx,
        e.id,
        String(i.issue_date).slice(0, 10),
        "invoice",
        i.id,
        number,
        [
          { account: "1100", debit: total },
          {
            account: i.billing_kind === "advance" ? "2300" : "4000",
            credit: net,
          },
          { account: "2100", credit: total - net },
        ],
      );
      await tx.query(
        "UPDATE invoices SET status='Issued',number=$2 WHERE id=$1",
        [i.id, number],
      );
      break;
    }
    case "payment.create": {
      const i = await record(tx, "invoices", c.invoice_id, ctx);
      const prior = (
        await tx.query("SELECT * FROM payments WHERE request_key=$1", [
          c.request_key,
        ])
      ).rows[0];
      if (prior) {
        if (
          prior.invoice_id !== c.invoice_id ||
          BigInt(prior.amount_minor) !== minor(c.amount) ||
          BigInt(prior.wht_minor) !== minor(c.wht) ||
          BigInt(prior.fx_micros) !== scaled(c.fx, 6) ||
          String(prior.payment_date).slice(0, 10) !== c.date ||
          prior.reference !== c.reference ||
          (prior.bank_account_id || null) !== (c.bank_account_id || null)
        )
          reject(409, "This retry key was used for a different payment.");
        return { id: prior.id };
      }
      if (i.status !== "Issued")
        reject(
          409,
          "Only an issued invoice with a balance can receive payment.",
        );
      await entityDate(tx, i.entity_id, c.date, ctx);
      const bankCode = await cashAccount(
        tx,
        i.entity_id,
        c.bank_account_id,
        c.date,
      );
      if (c.date < String(i.issue_date).slice(0, 10))
        reject(400, "Payment date cannot precede invoice date.");
      const cash = minor(c.amount),
        wht = minor(c.wht),
        settled = cash + wht,
        fx = scaled(c.fx, 6),
        total = BigInt(i.total_minor),
        paid = BigInt(i.paid_minor),
        credited = BigInt(i.credited_minor);
      if (
        cash <= 0n ||
        fx <= 0n ||
        (i.currency === "PKR" && fx !== 1_000_000n) ||
        settled > total - paid - credited
      )
        reject(
          400,
          "Enter a positive payment within the balance and a valid exchange rate.",
        );
      const fullBase = baseAmount(total, BigInt(i.fx_micros)),
        ar = round(
          (fullBase -
            BigInt(i.paid_base_minor) -
            BigInt(i.credited_base_minor)) *
            settled,
          total - paid - credited,
        );
      const bank = baseAmount(cash, fx),
        tax = baseAmount(wht, fx),
        gain = bank + tax - ar;
      await tx.query(
        "INSERT INTO payments(id,tenant_id,entity_id,invoice_id,payment_date,amount_minor,wht_minor,fx_micros,reference,request_key,bank_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          id,
          t,
          i.entity_id,
          i.id,
          c.date,
          String(cash),
          String(wht),
          String(fx),
          c.reference,
          c.request_key,
          c.bank_account_id || null,
        ],
      );
      await post(
        tx,
        ctx,
        i.entity_id,
        c.date,
        "payment",
        id,
        `Payment for ${i.number}`,
        [
          { account: bankCode, debit: bank },
          { account: "1200", debit: tax },
          { account: "1100", credit: ar },
          gain >= 0n
            ? { account: "4100", credit: gain }
            : { account: "5100", debit: -gain },
        ],
      );
      await tx.query(
        "UPDATE invoices SET paid_minor=$2,paid_base_minor=paid_base_minor+$3,status=$4 WHERE id=$1",
        [
          i.id,
          String(paid + settled),
          String(ar),
          paid + settled + credited === total
            ? credited > 0n
              ? "Settled"
              : "Paid"
            : "Issued",
        ],
      );
      break;
    }
    case "invoice.void": {
      const i = await record(tx, "invoices", c.id, ctx);
      await entityDate(tx, i.entity_id, c.date, ctx);
      if (
        i.status !== "Issued" ||
        BigInt(i.paid_minor) !== 0n ||
        BigInt(i.credited_minor) !== 0n
      )
        reject(
          409,
          "Only unpaid issued invoices can be voided. Paid invoices require a credit note.",
        );
      if (c.date < String(i.issue_date).slice(0, 10))
        reject(400, "Reversal date cannot precede invoice date.");
      const lastCreditReversal = (
        await tx.query(
          `SELECT max(d)::text AS date FROM (
        SELECT r.reversal_date AS d FROM credit_reversals r JOIN credit_notes n ON n.id=r.credit_id WHERE n.invoice_id=$1
        UNION ALL SELECT r.reversal_date FROM application_reversals r JOIN credit_applications a ON a.id=r.application_id WHERE a.invoice_id=$1
      ) reversals`,
          [i.id],
        )
      ).rows[0].date;
      if (lastCreditReversal && c.date < lastCreditReversal)
        reject(409, "Void date cannot precede related credit reversals.");
      if (
        (
          await tx.query(
            "SELECT c.id FROM credit_notes c WHERE c.invoice_id=$1 AND NOT EXISTS(SELECT 1 FROM credit_reversals r WHERE r.credit_id=c.id)",
            [i.id],
          )
        ).rows.length
      )
        reject(
          409,
          "Reverse existing credit notes before voiding this invoice.",
        );
      if (
        (
          await tx.query(
            "SELECT id FROM revenue_recognitions WHERE invoice_id=$1 LIMIT 1",
            [i.id],
          )
        ).rows.length
      )
        reject(
          409,
          "An advance with recognised revenue cannot be voided. It requires a reviewed credit adjustment.",
        );
      const lines = (
        await tx.query(
          "SELECT l.* FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type='invoice' AND j.source_id=$1",
          [i.id],
        )
      ).rows;
      await post(
        tx,
        ctx,
        i.entity_id,
        c.date,
        "invoice_void",
        i.id,
        `Void ${i.number}: ${c.reason}`,
        lines.map((l) => ({
          account: l.account_code,
          debit: BigInt(l.credit_minor),
          credit: BigInt(l.debit_minor),
        })),
      );
      await tx.query("UPDATE invoices SET status='Voided' WHERE id=$1", [i.id]);
      break;
    }
    case "expense.create": {
      await entityDate(tx, c.entity_id, c.date, ctx);
      const prior = (
        await tx.query("SELECT * FROM expenses WHERE request_key=$1", [
          c.request_key,
        ])
      ).rows[0];
      if (prior) {
        if (
          prior.entity_id !== c.entity_id ||
          prior.deal_id !== c.deal_id ||
          BigInt(prior.amount_minor) !== minor(c.amount) ||
          prior.description !== c.description ||
          prior.reference !== c.reference ||
          String(prior.expense_date).slice(0, 10) !== c.date ||
          (prior.bank_account_id || null) !== (c.bank_account_id || null)
        )
          reject(409, "This retry key was used for another expense.");
        return { id: prior.id };
      }
      if (c.deal_id) {
        const d = await record(tx, "deals", c.deal_id, ctx);
        if (d.entity_id !== c.entity_id)
          reject(400, "Project and expense must use the same legal entity.");
      }
      const amount = minor(c.amount);
      const bankCode = await cashAccount(
        tx,
        c.entity_id,
        c.bank_account_id,
        c.date,
      );
      if (amount <= 0n) reject(400, "Expense must be greater than zero.");
      await tx.query(
        "INSERT INTO expenses(id,tenant_id,entity_id,deal_id,description,amount_minor,expense_date,reference,request_key,bank_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          t,
          c.entity_id,
          c.deal_id,
          c.description,
          String(amount),
          c.date,
          c.reference,
          c.request_key,
          c.bank_account_id || null,
        ],
      );
      await post(tx, ctx, c.entity_id, c.date, "expense", id, c.description, [
        { account: "5000", debit: amount },
        { account: bankCode, credit: amount },
      ]);
      break;
    }
    case "entity.create": {
      if (ctx.role !== "admin")
        reject(403, "Only an administrator can add a legal entity.");
      await tx.query(
        "INSERT INTO entities(id,tenant_id,name,code,tax_id,address) VALUES($1,$2,$3,$4,$5,$6)",
        [id, t, c.name, c.code, c.tax_id, c.address],
      );
      await seedAccounts(tx, t, id);
      break;
    }
    case "period.close": {
      if (ctx.role !== "admin")
        reject(403, "An administrator must lock accounting periods.");
      const e = await record(tx, "entities", c.entity_id, ctx);
      if (e.lock_date && c.date < String(e.lock_date).slice(0, 10))
        reject(409, "A period lock cannot be moved backwards.");
      await tx.query("UPDATE entities SET lock_date=$2 WHERE id=$1", [
        e.id,
        c.date,
      ]);
      break;
    }
    case "note.create": {
      const known = (
        await tx.query(
          `SELECT id,owner_id FROM companies WHERE id=$1 UNION ALL SELECT id,owner_id FROM contacts WHERE id=$1 UNION ALL SELECT id,owner_id FROM deals WHERE id=$1`,
          [c.record_id],
        )
      ).rows[0];
      if (!known) reject(404, "Record not found.");
      if (ctx.role === "sales" && known.owner_id !== ctx.userId)
        reject(403, "This is not your record.");
      break;
    }
    default:
      reject(400, "Unknown action.");
  }
  await audit(tx, ctx, c.id || c.record_id || id, c.action, c);
  return { id: c.action === "lead.convert" ? id : c.id || id };
}
