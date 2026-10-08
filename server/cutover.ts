import { createHash, randomUUID as uuid } from "node:crypto";
import type { SQL } from "./db.ts";
import { audit, post, Problem, type Context } from "./domain.ts";
import { minor } from "../shared/money.ts";
import type { CutoverInput } from "../shared/cutover.ts";
import { hasCapability } from "../shared/permissions.ts";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalized = (value: string) => value.trim().toLocaleLowerCase("en");
const pkr = (value: bigint) => {
  const absolute = value < 0n ? -value : value;
  return `PKR ${value < 0n ? "-" : ""}${String(absolute / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${String(absolute % 100n).padStart(2, "0")}`;
};
type Check = { label: string; ok: boolean; detail: string };

export async function cutoverHistory(tx: SQL, ctx: Context, entityId: string) {
  if (!hasCapability(ctx, "books.view"))
    throw new Problem(403, "Finance access is required.");
  return (
    await tx.query(
      `SELECT id,entity_id,cutover_date,account_count,receivable_count,payable_count,posted_at,posted_by,payload_hash,source_data
     FROM cutover_batches WHERE entity_id=$1`,
      [entityId],
    )
  ).rows;
}

export async function previewCutover(
  tx: SQL,
  ctx: Context,
  input: CutoverInput,
) {
  if (!hasCapability(ctx, "books.view"))
    throw new Problem(403, "Finance access is required.");
  const entity = (
    await tx.query("SELECT id,name,code,lock_date FROM entities WHERE id=$1", [
      input.entity_id,
    ])
  ).rows[0];
  if (!entity) throw new Problem(404, "Legal entity not found.");
  const [
    existing,
    companies,
    banks,
    journals,
    batches,
    documents,
    statements,
    periods,
  ] = await Promise.all([
    tx.query(
      "SELECT code,name,type,active FROM accounts WHERE entity_id=$1 ORDER BY code",
      [entity.id],
    ),
    tx.query("SELECT id,name,customer,vendor FROM companies ORDER BY name"),
    tx.query(
      `SELECT b.id,b.account_code,b.opening_on,b.opening_minor,b.last_reconciled_on,b.offset_code,
      coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS balance
      FROM bank_accounts b LEFT JOIN journal_lines l ON l.entity_id=b.entity_id AND l.account_code=b.account_code
      WHERE b.entity_id=$1 GROUP BY b.id ORDER BY b.account_code`,
      [entity.id],
    ),
    tx.query(
      "SELECT source_type,posted_on FROM journals WHERE entity_id=$1 ORDER BY posted_on",
      [entity.id],
    ),
    tx.query("SELECT id FROM cutover_batches WHERE entity_id=$1", [entity.id]),
    tx.query(
      "SELECT (SELECT count(*) FROM invoices WHERE entity_id=$1)::int AS invoices,(SELECT count(*) FROM bills WHERE entity_id=$1)::int AS bills",
      [entity.id],
    ),
    tx.query(
      "SELECT count(*)::int AS count FROM bank_statements s JOIN bank_accounts b ON b.id=s.bank_id WHERE b.entity_id=$1 AND s.status<>'Cancelled'",
      [entity.id],
    ),
    tx.query(
      "SELECT status FROM accounting_periods WHERE entity_id=$1 AND month=date_trunc('month',$2::date)::date",
      [entity.id, input.cutover_date],
    ),
  ]);
  const checks: Check[] = [];
  const check = (label: string, ok: boolean, detail: string) =>
    checks.push({ label, ok, detail });
  check(
    "One cutover per legal entity",
    batches.rows.length === 0,
    batches.rows.length
      ? "This entity already has a posted cutover. It cannot be imported twice."
      : "No earlier cutover.",
  );
  const lock = entity.lock_date ? String(entity.lock_date).slice(0, 10) : null;
  check(
    "Accounting date is open",
    (!lock || input.cutover_date > lock) &&
      !["Closed", "Soft closed"].includes(periods.rows[0]?.status),
    lock && input.cutover_date <= lock
      ? `Locked through ${lock}.`
      : periods.rows[0]?.status && periods.rows[0].status !== "Open"
        ? "The cutover month is restricted."
        : "The cutover date can accept entries.",
  );
  const noDocuments =
    documents.rows[0].invoices === 0 && documents.rows[0].bills === 0;
  check(
    "No existing trade documents",
    noDocuments,
    noDocuments
      ? "No invoices or bills to duplicate."
      : "Existing invoices or bills would risk duplicate receivables/payables.",
  );
  const allowedJournals = journals.rows.every(
    (j) =>
      j.source_type === "bank-opening" &&
      String(j.posted_on).slice(0, 10) <= input.cutover_date,
  );
  check(
    "Only bank setup entries exist",
    allowedJournals,
    allowedJournals
      ? "No operational entries to duplicate."
      : "Other ledger activity must be reviewed before cutover; this wizard does not overwrite it.",
  );
  check(
    "No active bank statements",
    statements.rows[0].count === 0,
    statements.rows[0].count === 0
      ? "No existing statement reconciliation to disturb."
      : "Reconciled or draft statements require separate review before migration.",
  );
  const accountMap = new Map(existing.rows.map((a) => [a.code, a]));
  const entries = new Map<string, bigint>();
  let debit = 0n,
    credit = 0n;
  for (const [index, a] of input.accounts.entries()) {
    const dr = minor(a.debit),
      cr = minor(a.credit),
      current = accountMap.get(a.code);
    if (entries.has(a.code))
      check(
        `Trial balance row ${index + 2}`,
        false,
        `Duplicate account ${a.code}.`,
      );
    if (dr && cr)
      check(
        `Trial balance row ${index + 2}`,
        false,
        "Use debit or credit, not both.",
      );
    if (a.code === "3900" && (dr || cr))
      check(
        `Trial balance row ${index + 2}`,
        false,
        "Do not import a balance into opening balance clearing.",
      );
    if (a.code.startsWith("10B") && !current)
      check(
        `Trial balance row ${index + 2}`,
        false,
        "Create the named bank account first, then include its code in the trial balance.",
      );
    if (current && (!current.active || current.type !== a.type))
      check(
        `Trial balance row ${index + 2}`,
        false,
        `Account ${a.code} must be active and have type ${current.type}.`,
      );
    entries.set(a.code, dr - cr);
    debit += dr;
    credit += cr;
  }
  check(
    "Trial balance agrees",
    debit === credit,
    `Debits ${pkr(debit)}; credits ${pkr(credit)}.`,
  );
  for (const bank of banks.rows) {
    const balance = BigInt(bank.balance);
    check(
      `Bank ${bank.account_code}`,
      entries.has(bank.account_code) &&
        entries.get(bank.account_code) === balance &&
        bank.opening_on <= input.cutover_date &&
        bank.last_reconciled_on === bank.opening_on &&
        (balance === 0n || bank.offset_code === "3900"),
      `Trial balance must include ${bank.account_code} at its verified opening of ${pkr(balance)}, offset to 3900.`,
    );
  }
  for (const a of input.accounts) {
    if (
      a.code.startsWith("10B") &&
      !banks.rows.some((b) => b.account_code === a.code)
    )
      check(
        `Bank ${a.code}`,
        false,
        "This code is not a named bank account for this entity.",
      );
  }
  const companyMap = new Map<string, typeof companies.rows>();
  for (const company of companies.rows) {
    const key = normalized(company.name);
    companyMap.set(key, [...(companyMap.get(key) || []), company]);
  }
  const invoiceNumbers = new Set<string>();
  const validateDocs = (
    rows: CutoverInput["receivables"] | CutoverInput["payables"],
    kind: "receivable" | "payable",
  ) => {
    let total = 0n;
    const refs = new Set<string>();
    for (const [index, doc] of rows.entries()) {
      const company = companyMap.get(normalized(doc.company)) || [];
      const date = "issue_date" in doc ? doc.issue_date : doc.bill_date;
      const amount = minor(doc.amount);
      const reference = `${normalized(doc.company)}|${normalized(doc.number)}`;
      const errors: string[] = [];
      if (
        company.length !== 1 ||
        !company[0][kind === "receivable" ? "customer" : "vendor"]
      )
        errors.push("match one existing company flagged as a customer/vendor");
      if (refs.has(reference))
        errors.push("duplicate company and document number");
      if (kind === "receivable" && invoiceNumbers.has(normalized(doc.number)))
        errors.push("duplicate invoice number for this entity");
      if (date > input.cutover_date)
        errors.push("document date follows cutover");
      if (doc.due_date < date) errors.push("due date precedes document date");
      if (!amount) errors.push("amount must be positive");
      if (errors.length)
        check(`${kind} row ${index + 2}`, false, errors.join("; "));
      refs.add(reference);
      total += amount;
      if (kind === "receivable") invoiceNumbers.add(normalized(doc.number));
    }
    return total;
  };
  const ar = validateDocs(input.receivables, "receivable");
  const ap = validateDocs(input.payables, "payable");
  check(
    "Receivables reconcile",
    (entries.get("1100") || 0n) === ar,
    `Open customer invoices ${pkr(ar)}; account 1100 ${pkr(entries.get("1100") || 0n)}.`,
  );
  check(
    "Payables reconcile",
    -(entries.get("2000") || 0n) === ap,
    `Open vendor bills ${pkr(ap)}; account 2000 ${pkr(-(entries.get("2000") || 0n))}.`,
  );
  const preflightHash = hash({
    input,
    accounts: existing.rows,
    companies: companies.rows,
    banks: banks.rows,
    journals: journals.rows,
    batches: batches.rows,
    documents: documents.rows,
    statements: statements.rows,
    periods: periods.rows,
    lock,
  });
  return {
    entity: { id: entity.id, code: entity.code, name: entity.name },
    date: input.cutover_date,
    checks,
    canCommit: checks.every((c) => c.ok),
    totals: {
      debit: String(debit),
      credit: String(credit),
      receivables: String(ar),
      payables: String(ap),
    },
    counts: {
      accounts: input.accounts.length,
      receivables: input.receivables.length,
      payables: input.payables.length,
    },
    preflightHash,
  };
}

export async function commitCutover(
  tx: SQL,
  ctx: Context,
  input: CutoverInput,
  preflightHash: string,
  requestKey: string,
  confirmation: string,
) {
  if (ctx.role !== "admin")
    throw new Problem(403, "Only an administrator can post opening balances.");
  const payloadHash = hash(input);
  const prior = (
    await tx.query(
      "SELECT id,payload_hash FROM cutover_batches WHERE request_key=$1",
      [requestKey],
    )
  ).rows[0];
  if (prior) {
    if (prior.payload_hash !== payloadHash)
      throw new Problem(409, "This retry key belongs to another cutover.");
    return { id: prior.id };
  }
  // Serializes cutover with bank creation, period changes and normal postings.
  await tx.query("SELECT id FROM entities WHERE id=$1 FOR UPDATE", [
    input.entity_id,
  ]);
  const preview = await previewCutover(tx, ctx, input);
  if (confirmation !== preview.entity.code)
    throw new Problem(400, "Type the legal entity code to confirm posting.");
  if (preflightHash !== preview.preflightHash)
    throw new Problem(409, "The cutover preview is stale. Review it again.");
  if (!preview.canCommit)
    throw new Problem(409, "Resolve every cutover check before posting.");
  const batchId = uuid();
  await tx.query(
    "INSERT INTO cutover_batches(id,tenant_id,entity_id,cutover_date,request_key,payload_hash,account_count,receivable_count,payable_count,posted_by,source_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      batchId,
      ctx.tenantId,
      input.entity_id,
      input.cutover_date,
      requestKey,
      payloadHash,
      input.accounts.length,
      input.receivables.length,
      input.payables.length,
      ctx.userId,
      JSON.stringify(input),
    ],
  );
  const entity = (
    await tx.query("SELECT name,address,tax_id FROM entities WHERE id=$1", [
      input.entity_id,
    ])
  ).rows[0];
  const existing = new Set(
    (
      await tx.query("SELECT code FROM accounts WHERE entity_id=$1", [
        input.entity_id,
      ])
    ).rows.map((a) => a.code),
  );
  for (const account of input.accounts)
    if (!existing.has(account.code))
      await tx.query(
        "INSERT INTO accounts(tenant_id,entity_id,code,name,type) VALUES($1,$2,$3,$4,$5)",
        [
          ctx.tenantId,
          input.entity_id,
          account.code,
          account.name,
          account.type,
        ],
      );
  const companies = (await tx.query("SELECT id,name FROM companies")).rows;
  const companyId = (name: string) =>
    companies.find((c) => normalized(c.name) === normalized(name))!
      .id as string;
  for (const item of input.receivables) {
    const id = uuid(),
      amount = minor(item.amount);
    const line = [
      {
        description: `Opening receivable ${item.number}`,
        quantity: "1",
        price: item.amount,
        tax: "0",
        subtotal: String(amount),
        taxMinor: "0",
      },
    ];
    await tx.query(
      `INSERT INTO invoices(id,tenant_id,entity_id,company_id,customer_name,issuer_name,issuer_address,issuer_tax_id,terms,
      number,status,issue_date,due_date,currency,fx_micros,lines,net_minor,tax_minor,total_minor,billing_kind,label,request_key,request_payload,opening_batch_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'',$9,'Issued',$10,$11,'PKR',1000000,$12,$13,0,$13,'earned','Opening receivable',$14,$15,$16)`,
      [
        id,
        ctx.tenantId,
        input.entity_id,
        companyId(item.company),
        item.company,
        entity.name,
        entity.address,
        entity.tax_id,
        item.number,
        item.issue_date,
        item.due_date,
        JSON.stringify(line),
        String(amount),
        uuid(),
        JSON.stringify(item),
        batchId,
      ],
    );
    await post(
      tx,
      ctx,
      input.entity_id,
      input.cutover_date,
      "invoice",
      id,
      `Opening receivable ${item.number}`,
      [
        { account: "1100", debit: amount },
        { account: "3900", credit: amount },
      ],
    );
  }
  for (const item of input.payables) {
    const id = uuid(),
      amount = minor(item.amount);
    const line = [
      {
        description: `Opening payable ${item.number}`,
        quantity: "1",
        price: item.amount,
        tax: "0",
        subtotal: String(amount),
        taxMinor: "0",
        account_code: "3900",
      },
    ];
    await tx.query(
      `INSERT INTO bills(id,tenant_id,entity_id,vendor_id,vendor_name,entity_name,reference,bill_date,due_date,currency,fx_micros,
      lines,tax_treatment,net_minor,tax_minor,total_minor,base_minor,status,last_activity_on,created_by,request_key,request_payload,opening_batch_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PKR',1000000,$10,'expense',$11,0,$11,$11,'Open',$12,$13,$14,$15,$16)`,
      [
        id,
        ctx.tenantId,
        input.entity_id,
        companyId(item.company),
        item.company,
        entity.name,
        item.number,
        item.bill_date,
        item.due_date,
        JSON.stringify(line),
        String(amount),
        input.cutover_date,
        ctx.userId,
        uuid(),
        JSON.stringify(item),
        batchId,
      ],
    );
    await post(
      tx,
      ctx,
      input.entity_id,
      input.cutover_date,
      "bill",
      id,
      `Opening payable ${item.number}`,
      [
        { account: "3900", debit: amount },
        { account: "2000", credit: amount },
      ],
    );
  }
  for (const account of input.accounts) {
    if (
      ["1100", "2000", "3900"].includes(account.code) ||
      account.code.startsWith("10B")
    )
      continue;
    const balance = minor(account.debit) - minor(account.credit);
    if (!balance) continue;
    await post(
      tx,
      ctx,
      input.entity_id,
      input.cutover_date,
      "cutover-opening",
      uuid(),
      `Opening balance ${account.code}`,
      balance > 0n
        ? [
            { account: account.code, debit: balance },
            { account: "3900", credit: balance },
          ]
        : [
            { account: account.code, credit: -balance },
            { account: "3900", debit: -balance },
          ],
    );
  }
  const clearing = (
    await tx.query(
      "SELECT coalesce(sum(debit_minor-credit_minor),0)::text AS amount FROM journal_lines WHERE entity_id=$1 AND account_code='3900'",
      [input.entity_id],
    )
  ).rows[0].amount;
  if (BigInt(clearing) !== 0n)
    throw new Problem(
      409,
      `Opening balance clearing is ${clearing}, not zero. Nothing was posted.`,
    );
  const finalAccounts = (
    await tx.query(
      "SELECT account_code,coalesce(sum(debit_minor-credit_minor),0)::text AS amount FROM journal_lines WHERE entity_id=$1 GROUP BY account_code",
      [input.entity_id],
    )
  ).rows;
  const finalMap = new Map(
    finalAccounts.map((row) => [row.account_code, BigInt(row.amount)]),
  );
  for (const account of input.accounts) {
    const expected = minor(account.debit) - minor(account.credit);
    if ((finalMap.get(account.code) || 0n) !== expected)
      throw new Problem(
        409,
        `Account ${account.code} does not match its source trial balance. Nothing was posted.`,
      );
  }
  // Imported historical numbers must not be accidentally reissued by a matching series.
  const series = (
    await tx.query(
      "SELECT id,prefix,next_number FROM number_series WHERE entity_id=$1 AND kind='invoice' FOR UPDATE",
      [input.entity_id],
    )
  ).rows;
  for (const s of series) {
    let next = BigInt(s.next_number);
    for (const item of input.receivables) {
      const suffix = item.number.startsWith(s.prefix)
        ? item.number.slice(s.prefix.length)
        : "";
      if (/^\d+$/.test(suffix) && BigInt(suffix) >= next)
        next = BigInt(suffix) + 1n;
    }
    if (next > 999999999999n)
      throw new Problem(
        409,
        "An imported invoice number exceeds the supported numbering series. Nothing was posted.",
      );
    if (next > BigInt(s.next_number))
      await tx.query("UPDATE number_series SET next_number=$2 WHERE id=$1", [
        s.id,
        String(next),
      ]);
  }
  // The source trial balance is the closing position of the prior system. New
  // operational postings start on the following day, protecting the baseline.
  await tx.query("UPDATE entities SET lock_date=$2 WHERE id=$1", [
    input.entity_id,
    input.cutover_date,
  ]);
  await audit(tx, ctx, batchId, "cutover.post", {
    entity_id: input.entity_id,
    date: input.cutover_date,
    payload_hash: payloadHash,
    ...preview.counts,
  });
  return { id: batchId };
}
