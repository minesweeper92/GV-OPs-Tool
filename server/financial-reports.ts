import type { SQL, Row } from "./db.ts";
import { Problem, type Context } from "./domain.ts";
import { round } from "../shared/money.ts";
import {
  ageBucket,
  type ReportFilter,
  type FinancialReport,
  type AccountBalance,
  type AgeingReport,
  type AccountDetail,
} from "../shared/reporting.ts";

async function scope(tx: SQL, ctx: Context, entityId: string) {
  if (!["admin", "finance"].includes(ctx.role))
    throw new Problem(403, "A finance role is required for financial reports.");
  const entities = (
    await tx.query(
      "SELECT id,code,name FROM entities WHERE ($1::uuid IS NULL OR id=$1) ORDER BY code",
      [entityId === "all" ? null : entityId],
    )
  ).rows;
  if (entityId !== "all" && !entities.length)
    throw new Problem(404, "Entity not found in this organization.");
  return entities as FinancialReport["entities"];
}
const sum = (rows: AccountBalance[], f: (r: AccountBalance) => bigint) =>
  rows.reduce((v, r) => v + f(r), 0n);
const movement = (r: AccountBalance) => BigInt(r.debit) - BigInt(r.credit);

export async function ageing(
  tx: SQL,
  ids: string[],
  asOf: string,
  kind: "ar" | "ap",
  control: bigint,
  partyId: string | null = null,
): Promise<AgeingReport> {
  // Each effect is tied to its immutable journal date. Current document status and
  // cumulative paid totals cannot answer a historical "as at" question.
  const effects =
    kind === "ar"
      ? `
    SELECT i.id AS doc,j.id AS journal,CASE WHEN j.source_type='invoice' THEN i.total_minor ELSE -i.total_minor END AS amount
    FROM invoices i JOIN journals j ON j.source_id=i.id AND j.source_type IN ('invoice','invoice_void')
    UNION ALL
    SELECT p.invoice_id,j.id,-(p.amount_minor+p.wht_minor) FROM payments p JOIN journals j ON j.source_id=p.id AND j.source_type='payment'
    UNION ALL SELECT a.invoice_id,j.id,-a.amount_minor FROM credit_applications a JOIN journals j ON j.source_id=a.id AND j.source_type='credit-application'
    UNION ALL SELECT a.invoice_id,j.id,a.amount_minor FROM application_reversals r JOIN credit_applications a ON a.id=r.application_id JOIN journals j ON j.source_id=r.id AND j.source_type='credit-application-reversal'`
      : `SELECT b.id AS doc,j.id AS journal,CASE WHEN j.source_type='bill' THEN b.total_minor ELSE -b.total_minor END AS amount
    FROM bills b JOIN journals j ON j.source_id=b.id AND j.source_type IN ('bill','bill-void')
    UNION ALL
    SELECT p.bill_id,j.id,-(p.amount_minor+p.wht_minor) FROM vendor_payments p JOIN journals j ON j.source_id=p.id AND j.source_type='vendor-payment'
    UNION ALL
    SELECT p.bill_id,j.id,p.amount_minor+p.wht_minor FROM vendor_payments p JOIN vendor_payment_reversals r ON r.payment_id=p.id JOIN journals j ON j.source_id=r.id AND j.source_type='vendor-payment-reversal'
    UNION ALL SELECT a.bill_id,j.id,-a.amount_minor FROM vendor_credit_applications a JOIN journals j ON j.source_id=a.id AND j.source_type='vendor-credit-application'
    UNION ALL SELECT a.bill_id,j.id,a.amount_minor FROM vendor_application_reversals r JOIN vendor_credit_applications a ON a.id=r.application_id JOIN journals j ON j.source_id=r.id AND j.source_type='vendor-credit-application-reversal'`;
  const documents =
    kind === "ar"
      ? `SELECT i.id,i.entity_id,i.company_id AS party_id,i.customer_name AS party,i.number,i.issue_date AS date,i.due_date,i.currency FROM invoices i`
      : `SELECT id,entity_id,vendor_id AS party_id,vendor_name AS party,reference AS number,bill_date AS date,due_date,currency FROM bills`;
  const rows = (
    await tx.query(
      `WITH effects AS (${effects}), documents AS (${documents}), balances AS (
    SELECT ef.doc,sum(ef.amount)::text AS outstanding,coalesce(sum(${kind === "ar" ? "l.delta" : "-l.delta"}),0)::text AS base
    FROM effects ef JOIN journals j ON j.id=ef.journal LEFT JOIN (SELECT journal_id,sum(debit_minor-credit_minor) AS delta FROM journal_lines WHERE account_code=$3 GROUP BY journal_id) l ON l.journal_id=j.id
    WHERE j.entity_id=ANY($1::uuid[]) AND j.posted_on<=$2 GROUP BY ef.doc)
    SELECT d.*,e.code AS entity_code,b.outstanding,b.base FROM balances b JOIN documents d ON d.id=b.doc JOIN entities e ON e.id=d.entity_id
    WHERE ($4::uuid IS NULL OR d.party_id=$4) AND (b.outstanding::numeric<>0 OR b.base::numeric<>0) ORDER BY d.due_date,e.code,d.party,d.number`,
      [ids, asOf, kind === "ar" ? "1100" : "2000", partyId],
    )
  ).rows;
  const buckets = [0n, 0n, 0n, 0n, 0n];
  const items = rows.map((r) => {
    const age = ageBucket(asOf, r.due_date);
    buckets[age.bucket] += BigInt(r.base);
    return { ...r, ...age };
  });
  const total = buckets.reduce((a, b) => a + b, 0n);
  return {
    documents: items as AgeingReport["documents"],
    buckets: buckets.map(String),
    total: String(total),
    control: String(control),
    difference: String(control - total),
  };
}

export async function financialReports(
  tx: SQL,
  ctx: Context,
  filter: ReportFilter,
): Promise<FinancialReport> {
  const entities = await scope(tx, ctx, filter.entityId),
    ids = entities.map((e) => e.id);
  const accounts = (
    await tx.query(
      `SELECT a.entity_id,e.code AS entity_code,a.code,a.name,a.type,
    coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE j.posted_on<$2),0)::text AS opening,
    coalesce(sum(l.debit_minor) FILTER(WHERE j.posted_on>=$2),0)::text AS debit,
    coalesce(sum(l.credit_minor) FILTER(WHERE j.posted_on>=$2),0)::text AS credit,
    coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS closing
    FROM accounts a JOIN entities e ON e.id=a.entity_id
    LEFT JOIN (journal_lines l JOIN journals j ON j.id=l.journal_id AND j.posted_on<=$3)
    ON l.entity_id=a.entity_id AND l.account_code=a.code
    WHERE a.entity_id=ANY($1::uuid[]) GROUP BY a.entity_id,e.code,a.code,a.name,a.type ORDER BY e.code,a.code`,
      [ids, filter.from, filter.to],
    )
  ).rows as AccountBalance[];
  const typed = (type: string) => accounts.filter((a) => a.type === type);
  const income = -sum(typed("Income"), movement),
    expenses = sum(typed("Expense"), movement),
    profit = income - expenses;
  const assets = sum(typed("Asset"), (r) => BigInt(r.closing)),
    liabilities = -sum(typed("Liability"), (r) => BigInt(r.closing));
  const equity = -sum(typed("Equity"), (r) => BigInt(r.closing));
  const earnings = -sum(
    accounts.filter((r) => ["Income", "Expense"].includes(r.type)),
    (r) => BigInt(r.closing),
  );
  const balance = (code: string) =>
    sum(
      accounts.filter((a) => a.code === code),
      (a) => BigInt(a.closing),
    );
  const cashAccounts = accounts.filter(
    (a) => a.code === "1000" || a.code.startsWith("10B"),
  );
  const opening = sum(cashAccounts, (a) => BigInt(a.opening)),
    closing = sum(cashAccounts, (a) => BigInt(a.closing));
  const workingCodes = [
    "1100",
    "1200",
    "1300",
    "1400",
    "2000",
    "2100",
    "2200",
    "2300",
    "2400",
  ];
  const workingCapital = -sum(
    accounts.filter((a) => workingCodes.includes(a.code)),
    movement,
  );
  let investing = 0n,
    financing = 0n;
  const unsupported = new Set<string>();
  // Classify cash actually moved, not the face value of an unpaid asset bill.
  const cashJournals = (
    await tx.query(
      `SELECT j.id,j.source_type,j.source_id,sum(l.debit_minor-l.credit_minor)::text AS cash
    FROM journals j JOIN journal_lines l ON l.journal_id=j.id AND (l.account_code='1000' OR l.account_code LIKE '10B%')
    WHERE j.entity_id=ANY($1::uuid[]) AND j.posted_on BETWEEN $2 AND $3 GROUP BY j.id`,
      [ids, filter.from, filter.to],
    )
  ).rows;
  const allocations = (
    await tx.query(
      `SELECT p.id,r.id AS reversal_id,
    coalesce((SELECT sum(l.debit_minor) FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type='bill' AND j.source_id=b.id AND l.account_code='1500'),0)::text AS capital,
    b.base_minor::text AS total,
    coalesce((SELECT sum(l.credit_minor) FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type='vendor-payment' AND j.source_id=p.id AND (l.account_code='1000' OR l.account_code LIKE '10B%')),0)::text AS bank,
    coalesce((SELECT sum(l.debit_minor) FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type='vendor-payment' AND j.source_id=p.id AND l.account_code='5300'),0)::text AS fee
    FROM vendor_payments p JOIN bills b ON b.id=p.bill_id LEFT JOIN vendor_payment_reversals r ON r.payment_id=p.id WHERE p.entity_id=ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  const allocationMap = new Map<string, bigint>();
  for (const a of allocations) {
    const equipmentCash = round(
      (BigInt(a.bank) - BigInt(a.fee)) * BigInt(a.capital),
      BigInt(a.total),
    );
    allocationMap.set(a.id, -equipmentCash);
    if (a.reversal_id) allocationMap.set(a.reversal_id, equipmentCash);
  }
  for (const j of cashJournals) {
    if (BigInt(j.cash) === 0n) continue; // Transfers between cash accounts are not cash flows.
    if (["vendor-payment", "vendor-payment-reversal"].includes(j.source_type)) {
      if (!allocationMap.has(j.source_id)) unsupported.add(j.source_type);
      else investing += allocationMap.get(j.source_id)!;
    } else if (
      ![
        "payment",
        "expense",
        "customer-refund",
        "customer-refund-reversal",
      ].includes(j.source_type)
    )
      unsupported.add(j.source_type);
  }
  // Explicit balance-sheet bridge removes non-cash capital purchases and the
  // operating payable changes associated with later capital settlements.
  const capitalMovement = sum(
    accounts.filter((a) => a.code === "1500"),
    movement,
  );
  const equityMovement = -sum(typed("Equity"), movement);
  const capitalAdjustment =
    -capitalMovement + equityMovement - investing - financing;
  for (const a of accounts)
    if (
      movement(a) !== 0n &&
      !["Income", "Expense", "Equity"].includes(a.type) &&
      !workingCodes.includes(a.code) &&
      a.code !== "1500" &&
      !cashAccounts.includes(a)
    )
      unsupported.add(`Account ${a.code}`);
  const operating = profit + workingCapital + capitalAdjustment;
  const receivables = await ageing(tx, ids, filter.to, "ar", balance("1100"));
  const payables = await ageing(tx, ids, filter.to, "ap", -balance("2000"));
  return {
    filter,
    generatedAt: new Date().toISOString(),
    entities,
    accounts,
    income: String(income),
    expenses: String(expenses),
    profit: String(profit),
    assets: String(assets),
    liabilities: String(liabilities),
    equity: String(equity),
    earnings: String(earnings),
    balanceDifference: String(assets - liabilities - equity - earnings),
    cash: {
      opening: String(opening),
      closing: String(closing),
      operating: String(operating),
      investing: String(investing),
      financing: String(financing),
      workingCapital: String(workingCapital),
      capitalAdjustment: String(capitalAdjustment),
      difference: String(closing - opening - operating - investing - financing),
      unsupported: [...unsupported],
    },
    receivables,
    payables,
  };
}

export async function accountDetail(
  tx: SQL,
  ctx: Context,
  q: ReportFilter & { code: string; offset: number },
): Promise<AccountDetail> {
  await scope(tx, ctx, q.entityId);
  const account = (
    await tx.query(
      "SELECT a.code,a.name,e.code AS entity_code FROM accounts a JOIN entities e ON e.id=a.entity_id WHERE a.entity_id=$1 AND a.code=$2",
      [q.entityId, q.code],
    )
  ).rows[0];
  if (!account) throw new Problem(404, "Account not found.");
  const totals = (
    await tx.query(
      `SELECT coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE j.posted_on<$3),0)::text AS opening,
    coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS closing,
    coalesce(sum(l.debit_minor) FILTER(WHERE j.posted_on>=$3),0)::text AS debit,
    coalesce(sum(l.credit_minor) FILTER(WHERE j.posted_on>=$3),0)::text AS credit,
    count(*) FILTER(WHERE j.posted_on>=$3)::integer AS total FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.entity_id=$1 AND l.account_code=$2 AND j.posted_on<=$4`,
      [q.entityId, q.code, q.from, q.to],
    )
  ).rows[0];
  const lines = (
    await tx.query(
      `SELECT l.id,j.id AS journal_id,j.posted_on,j.description,j.source_type,j.source_id,l.debit_minor::text AS debit,l.credit_minor::text AS credit,
    ($5::numeric+sum(l.debit_minor-l.credit_minor) OVER(ORDER BY j.posted_on,j.created_at,j.id,l.id))::text AS balance
    FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.entity_id=$1 AND l.account_code=$2 AND j.posted_on BETWEEN $3 AND $4
    ORDER BY j.posted_on,j.created_at,j.id,l.id LIMIT 100 OFFSET $6`,
      [q.entityId, q.code, q.from, q.to, totals.opening, q.offset],
    )
  ).rows;
  return { account, ...totals, lines } as AccountDetail;
}
