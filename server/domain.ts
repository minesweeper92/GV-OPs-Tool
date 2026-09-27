import { randomUUID as uuid } from "node:crypto";
import type { SQL, Row } from "./db.ts";
import { minor, scaled, totals, baseAmount, round } from "../shared/money.ts";
export type Context = {
  tenantId: string;
  userId: string;
  role: "admin" | "finance" | "sales" | "viewer";
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
  ["2100", "Output tax payable", "Liability"],
  ["3000", "Owner equity", "Equity"],
  ["4000", "Service revenue", "Income"],
  ["4100", "Realised exchange gain", "Income"],
  ["5000", "Operating expenses", "Expense"],
  ["5100", "Realised exchange loss", "Expense"],
];
export async function seedAccounts(
  tx: SQL,
  tenantId: string,
  entityId: string,
) {
  for (const [code, name, type] of chart)
    await tx.query(
      "INSERT INTO accounts(tenant_id,entity_id,code,name,type) VALUES($1,$2,$3,$4,$5)",
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
type PostingLine = { account: string; debit?: bigint; credit?: bigint };
export async function post(
  tx: SQL,
  ctx: Context,
  entity: string,
  date: string,
  source: string,
  sourceId: string,
  description: string,
  lines: PostingLine[],
) {
  const filtered = lines.filter((l) => (l.debit || 0n) + (l.credit || 0n) > 0n);
  const delta = filtered.reduce(
    (sum, l) => sum + (l.debit || 0n) - (l.credit || 0n),
    0n,
  );
  if (filtered.length < 2 || delta !== 0n)
    throw new Error("Posting is not balanced.");
  const id = uuid();
  await tx.query(
    "INSERT INTO journals(id,tenant_id,entity_id,source_type,source_id,posted_on,description,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, ctx.tenantId, entity, source, sourceId, date, description, ctx.userId],
  );
  for (const l of filtered)
    await tx.query(
      "INSERT INTO journal_lines(id,tenant_id,entity_id,journal_id,account_code,debit_minor,credit_minor) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        uuid(),
        ctx.tenantId,
        entity,
        id,
        l.account,
        String(l.debit || 0n),
        String(l.credit || 0n),
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
      `SELECT i.*,q.currency,q.fx_micros,q.total_minor,q.net_minor,q.tax_minor,q.lines,q.customer_name,q.issuer_name,
    q.issuer_address,q.issuer_tax_id,q.terms,d.name AS deal_name,e.code AS entity_code
    FROM invoices i JOIN quotes q ON q.id=i.quote_id JOIN deals d ON d.id=i.deal_id JOIN entities e ON e.id=i.entity_id
    WHERE i.deal_id=ANY($1::uuid[]) ORDER BY i.created_at DESC`,
      [dealIds],
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
      `SELECT * FROM audit_events ${own ? "WHERE record_id=ANY($1::uuid[])" : ""} ORDER BY created_at DESC LIMIT 200`,
      own ? [auditIds] : [],
    )
  ).rows;
  const expenses = allowedBooks
    ? (await tx.query("SELECT * FROM expenses ORDER BY created_at DESC")).rows
    : [];
  return {
    entities,
    companies,
    contacts,
    affiliations,
    leads,
    deals,
    quotes,
    quoteEvents,
    invoices,
    payments,
    expenses,
    events,
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
      `SELECT a.code,a.name,a.type,coalesce(sum(l.debit_minor),0)::text AS debit,coalesce(sum(l.credit_minor),0)::text AS credit
    FROM accounts a LEFT JOIN journal_lines l ON l.entity_id=a.entity_id AND l.account_code=a.code AND l.journal_id IN
    (SELECT id FROM journals WHERE entity_id=$1 AND posted_on BETWEEN $2 AND $3)
    WHERE a.entity_id=$1 GROUP BY a.code,a.name,a.type ORDER BY a.code`,
      [entityId, from, to],
    )
  ).rows;
  const journals = (
    await tx.query(
      `SELECT j.*,json_agg(json_build_object('account',l.account_code,'debit',l.debit_minor::text,'credit',l.credit_minor::text)) AS lines
    FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.entity_id=$1 AND j.posted_on BETWEEN $2 AND $3 GROUP BY j.id ORDER BY j.posted_on DESC,j.created_at DESC`,
      [entityId, from, to],
    )
  ).rows;
  return { trial, journals };
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
      await tx.query(
        "INSERT INTO companies(id,tenant_id,name,domain,industry,tax_id,address,customer,vendor,service_entity_id,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
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
        ],
      );
      break;
    }
    case "contact.create": {
      await record(tx, "companies", c.company_id, ctx, true);
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
      await tx.query("UPDATE leads SET status='Converted' WHERE id=$1", [l.id]);
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
      let calculated;
      try {
        calculated = totals(c.lines);
      } catch (error) {
        throw new Problem(400, (error as Error).message);
      }
      if(baseAmount(BigInt(calculated.total),fx)<=0n) reject(400,'The converted quote total rounds to zero.');
      const revision = Number(
        (
          await tx.query(
            "SELECT coalesce(max(revision),0)+1 AS n FROM quotes WHERE deal_id=$1 AND option_name=$2",
            [d.id, c.option_name],
          )
        ).rows[0].n,
      );
      await tx.query(
        `INSERT INTO quotes(id,tenant_id,deal_id,entity_id,option_name,revision,currency,fx_micros,lines,net_minor,tax_minor,total_minor,customer_name,issuer_name,issuer_address,issuer_tax_id,terms,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
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
        ],
      );
      await tx.query("UPDATE deals SET stage='Proposal' WHERE id=$1", [d.id]);
      break;
    }
    case "quote.share":
    case "quote.accept": {
      const q = await record(tx, "quotes", c.id, ctx),
        d = await record(tx, "deals", q.deal_id, ctx, true);
      if (["Won", "Lost"].includes(d.stage))
        reject(409, "This deal is already closed.");
      if (c.action === "quote.accept") {
        await tx.query(
          "UPDATE deals SET stage='Won',accepted_quote_id=$2,next_action=NULL,due_date=NULL WHERE id=$1",
          [d.id, q.id],
        );
        await tx.query("UPDATE companies SET customer=true WHERE id=$1", [
          d.company_id,
        ]);
      } else
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
      const q = await record(tx, "quotes", c.quote_id, ctx),
        d = await record(tx, "deals", q.deal_id, ctx);
      if (d.accepted_quote_id !== q.id)
        reject(409, "Select the explicitly accepted quote version.");
      const existing = (
        await tx.query("SELECT id FROM invoices WHERE deal_id=$1", [d.id])
      ).rows[0];
      if (existing) return existing;
      await entityDate(tx, d.entity_id, c.issue_date, ctx);
      if (c.due_date < c.issue_date)
        reject(400, "Due date cannot precede invoice date.");
      await tx.query(
        "INSERT INTO invoices(id,tenant_id,entity_id,deal_id,quote_id,issue_date,due_date) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, t, d.entity_id, d.id, q.id, c.issue_date, c.due_date],
      );
      break;
    }
    case "invoice.issue": {
      const i = await record(tx, "invoices", c.id, ctx);
      if (i.status !== "Draft") {
        if (["Issued", "Paid"].includes(i.status)) return { id: i.id };
        reject(409, "This invoice cannot be issued.");
      }
      const q = await record(tx, "quotes", i.quote_id, ctx),
        e = await entityDate(
          tx,
          i.entity_id,
          String(i.issue_date).slice(0, 10),
          ctx,
        );
      const number = `${e.code}-INV-${String(e.next_invoice).padStart(5, "0")}`;
      await tx.query(
        "UPDATE entities SET next_invoice=next_invoice+1 WHERE id=$1",
        [e.id],
      );
      const net = baseAmount(BigInt(q.net_minor), BigInt(q.fx_micros)),
        total = baseAmount(BigInt(q.total_minor), BigInt(q.fx_micros));
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
          { account: "4000", credit: net },
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
          prior.reference !== c.reference
        )
          reject(409, "This retry key was used for a different payment.");
        return { id: prior.id };
      }
      if (i.status !== "Issued")
        reject(
          409,
          "Only an issued invoice with a balance can receive payment.",
        );
      const q = await record(tx, "quotes", i.quote_id, ctx);
      await entityDate(tx, i.entity_id, c.date, ctx);
      if (c.date < String(i.issue_date).slice(0, 10))
        reject(400, "Payment date cannot precede invoice date.");
      const cash = minor(c.amount),
        wht = minor(c.wht),
        settled = cash + wht,
        fx = scaled(c.fx, 6),
        total = BigInt(q.total_minor),
        paid = BigInt(i.paid_minor);
      if (
        cash <= 0n ||
        fx <= 0n ||
        (q.currency === "PKR" && fx !== 1_000_000n) ||
        settled > total - paid
      )
        reject(
          400,
          "Enter a positive payment within the balance and a valid exchange rate.",
        );
      const fullBase = baseAmount(total, BigInt(q.fx_micros)),
        ar =
          round(fullBase * (paid + settled), total) - BigInt(i.paid_base_minor);
      const bank = baseAmount(cash, fx),
        tax = baseAmount(wht, fx),
        gain = bank + tax - ar;
      await tx.query(
        "INSERT INTO payments(id,tenant_id,entity_id,invoice_id,payment_date,amount_minor,wht_minor,fx_micros,reference,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
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
          { account: "1000", debit: bank },
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
          paid + settled === total ? "Paid" : "Issued",
        ],
      );
      break;
    }
    case "invoice.void": {
      const i = await record(tx, "invoices", c.id, ctx);
      await entityDate(tx, i.entity_id, c.date, ctx);
      if (i.status !== "Issued" || BigInt(i.paid_minor) !== 0n)
        reject(
          409,
          "Only unpaid issued invoices can be voided. Paid invoices require a credit note.",
        );
      if (c.date < String(i.issue_date).slice(0, 10))
        reject(400, "Reversal date cannot precede invoice date.");
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
          String(prior.expense_date).slice(0, 10) !== c.date
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
      if (amount <= 0n) reject(400, "Expense must be greater than zero.");
      await tx.query(
        "INSERT INTO expenses(id,tenant_id,entity_id,deal_id,description,amount_minor,expense_date,reference,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
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
        ],
      );
      await post(tx, ctx, c.entity_id, c.date, "expense", id, c.description, [
        { account: "5000", debit: amount },
        { account: "1000", credit: amount },
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
