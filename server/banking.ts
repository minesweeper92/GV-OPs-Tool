import { randomUUID as uuid } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL, Row } from "./db.ts";
import { Problem, post, audit, type Context } from "./domain.ts";
import { signedMinor, type BankDetail } from "../shared/banking.ts";
import { hasCapability } from "../shared/permissions.ts";

function finance(ctx: Context) {
  if (!hasCapability(ctx, "books.post"))
    throw new Problem(403, "A finance role is required for banking.");
}
const activeMatches = `SELECT m.* FROM bank_matches m JOIN bank_statements s ON s.id=m.statement_id WHERE s.status<>'Cancelled' AND NOT EXISTS(SELECT 1 FROM bank_match_reversals r WHERE r.match_id=m.id)`;
async function bank(tx: SQL, id: string) {
  const b = (
    await tx.query(
      "SELECT b.*,e.code AS entity_code FROM bank_accounts b JOIN entities e ON e.id=b.entity_id WHERE b.id=$1",
      [id],
    )
  ).rows[0];
  if (!b)
    throw new Problem(404, "Bank account not found in this organization.");
  return b;
}
async function statement(tx: SQL, id: string) {
  const s = (await tx.query("SELECT * FROM bank_statements WHERE id=$1", [id]))
    .rows[0];
  if (!s) throw new Problem(404, "Statement not found in this organization.");
  return s;
}
async function entityLock(tx: SQL, id: string) {
  const e = (
    await tx.query("SELECT * FROM entities WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (!e) throw new Problem(404, "Legal entity not found.");
  return e;
}
async function retry(
  tx: SQL,
  table: "bank_accounts" | "bank_statements",
  c: Row,
) {
  const r = (
    await tx.query(
      `SELECT id,request_payload FROM ${table} WHERE request_key=$1`,
      [c.request_key],
    )
  ).rows[0];
  if (r && !isDeepStrictEqual(r.request_payload, c))
    throw new Problem(
      409,
      "This retry key was already used for a different request.",
    );
  return r ? { id: r.id } : null;
}
export async function bankAccounts(tx: SQL, ctx: Context) {
  if (!hasCapability(ctx, "books.view")) return [];
  return (
    await tx.query(`SELECT b.id,b.entity_id,e.code AS entity_code,b.name,b.reference,b.account_code,b.opening_on,b.opening_minor::text,b.last_reconciled_on,
    coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS balance FROM bank_accounts b JOIN entities e ON e.id=b.entity_id
    LEFT JOIN journal_lines l ON l.entity_id=b.entity_id AND l.account_code=b.account_code GROUP BY b.id,e.code ORDER BY e.code,b.name`)
  ).rows;
}
export async function bankDetail(
  tx: SQL,
  ctx: Context,
  id: string,
  statementId?: string,
): Promise<BankDetail> {
  if (!hasCapability(ctx, "books.view"))
    throw new Problem(403, "Accounting view permission is required.");
  const account = await bank(tx, id);
  const statements = (
    await tx.query(
      "SELECT id,bank_id,from_date,to_date,opening_minor::text,closing_minor::text,reference,status,closed_at FROM bank_statements WHERE bank_id=$1 ORDER BY to_date DESC,created_at DESC",
      [id],
    )
  ).rows;
  const chosen = statementId
    ? statements.find((s) => s.id === statementId)
    : statements.find((s) => s.status === "Draft") ||
      statements.find((s) => s.status === "Reconciled") ||
      null;
  if (statementId && !chosen)
    throw new Problem(404, "Statement does not belong to this bank account.");
  const to = chosen?.to_date || "9999-12-31";
  const matches = (
    await tx.query(
      `SELECT m.* FROM (${activeMatches}) m JOIN bank_statements s ON s.id=m.statement_id WHERE m.bank_id=$1 AND s.to_date<=$2`,
      [id, to],
    )
  ).rows;
  const matched = new Set(
    matches.flatMap((m) => m.journal_line_ids as string[]),
  );
  const books = (
    await tx.query(
      `SELECT l.id,j.posted_on,j.description,j.source_type,(l.debit_minor-l.credit_minor)::text AS amount FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.entity_id=$1 AND l.account_code=$2 AND j.posted_on<=$3 AND j.source_type<>'bank-opening' ORDER BY j.posted_on,j.created_at,l.id`,
      [account.entity_id, account.account_code, to],
    )
  ).rows;
  const bookBalance = (
    await tx.query(
      `SELECT coalesce(sum(l.debit_minor-l.credit_minor),0)::text AS balance FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.entity_id=$1 AND l.account_code=$2 AND j.posted_on<=$3`,
      [account.entity_id, account.account_code, to],
    )
  ).rows[0].balance;
  const unmatched = books
    .filter((l) => !matched.has(l.id))
    .reduce((n, l) => n + BigInt(l.amount), 0n);
  const currentMatches = matches.filter((m) => m.statement_id === chosen?.id);
  const currentIds = new Set(
    currentMatches.flatMap((m) => m.journal_line_ids as string[]),
  );
  const lines = chosen
    ? (
        await tx.query(
          "SELECT id,line_no,posted_on,description,reference,amount_minor::text FROM bank_statement_lines WHERE statement_id=$1 ORDER BY line_no",
          [chosen.id],
        )
      ).rows
    : [];
  const adjusted = BigInt(bookBalance) - unmatched;
  const { request_payload, request_key, ...publicAccount } = account;
  return {
    account: { ...publicAccount, balance: bookBalance },
    statements,
    statement: chosen,
    lines,
    matches: currentMatches,
    books: books.filter((l) => !matched.has(l.id) || currentIds.has(l.id)),
    bookBalance,
    unmatchedBookBalance: String(unmatched),
    adjustedBalance: String(adjusted),
    difference: String(
      adjusted - BigInt(chosen?.closing_minor || account.opening_minor),
    ),
  } as BankDetail;
}
export async function executeBank(tx: SQL, ctx: Context, c: Row) {
  finance(ctx);
  const id = uuid(),
    t = ctx.tenantId;
  if (c.action === "bank.create") {
    const e = await entityLock(tx, c.entity_id);
    const prior = await retry(tx, "bank_accounts", c);
    if (prior) return prior;
    if (e.lock_date && c.opening_on <= e.lock_date)
      throw new Problem(409, "Opening date is in a locked accounting period.");
    const opening = signedMinor(c.opening),
      code = `10B${String(e.next_bank).padStart(4, "0")}`;
    await tx.query(
      "INSERT INTO accounts(tenant_id,entity_id,code,name,type,system) VALUES($1,$2,$3,$4,'Asset',true)",
      [t, e.id, code, c.name],
    );
    await tx.query("UPDATE entities SET next_bank=next_bank+1 WHERE id=$1", [
      e.id,
    ]);
    await tx.query(
      "INSERT INTO bank_accounts(id,tenant_id,entity_id,account_code,name,reference,opening_on,opening_minor,last_reconciled_on,offset_code,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10,$11)",
      [
        id,
        t,
        e.id,
        code,
        c.name,
        c.reference,
        c.opening_on,
        String(opening),
        c.offset_code,
        c.request_key,
        JSON.stringify(c),
      ],
    );
    if (opening !== 0n)
      await post(
        tx,
        ctx,
        e.id,
        c.opening_on,
        "bank-opening",
        id,
        `Opening bank balance · ${c.name}`,
        opening > 0n
          ? [
              { account: code, debit: opening },
              { account: c.offset_code, credit: opening },
            ]
          : [
              { account: code, credit: -opening },
              { account: c.offset_code, debit: -opening },
            ],
      );
    await audit(tx, ctx, id, c.action, {
      text: `Created PKR bank account ${c.name}; opening balance ${c.opening}, offset ${c.offset_code}.`,
    });
    return { id };
  }
  let s: Row | undefined;
  let target = c.bank_id;
  if (c.action === "bank.match") {
    s = await statement(tx, c.statement_id);
    target = s.bank_id;
  }
  if (c.action === "bank.close" || c.action === "bank.cancel") {
    s = await statement(tx, c.id);
    target = s.bank_id;
  }
  let match: Row | undefined;
  if (c.action === "bank.unmatch") {
    match = (await tx.query("SELECT * FROM bank_matches WHERE id=$1", [c.id]))
      .rows[0];
    if (!match) throw new Problem(404, "Match not found.");
    s = await statement(tx, match.statement_id);
    target = s.bank_id;
  }
  const b = await bank(tx, target);
  await entityLock(tx, b.entity_id);
  // Refresh after the shared entity lock: concurrent posting/matching uses this lock too.
  const lockedBank = await bank(tx, target);
  if (s) s = await statement(tx, s.id);
  if (c.action === "bank.import") {
    const prior = await retry(tx, "bank_statements", c);
    if (prior) return prior;
    if (
      (
        await tx.query(
          "SELECT id FROM bank_statements WHERE bank_id=$1 AND status='Draft'",
          [b.id],
        )
      ).rows.length
    )
      throw new Problem(
        409,
        "Finish or cancel the current draft statement first.",
      );
    const last = (
      await tx.query(
        "SELECT * FROM bank_statements WHERE bank_id=$1 AND status='Reconciled' ORDER BY to_date DESC LIMIT 1",
        [b.id],
      )
    ).rows[0];
    const previousEnd = last?.to_date || lockedBank.opening_on;
    const expected = new Date(Date.parse(previousEnd + "T00:00:00Z") + 86400000)
      .toISOString()
      .slice(0, 10);
    if (c.from !== expected || c.to < c.from)
      throw new Problem(
        400,
        `Next statement must start ${expected}, immediately after the previous reconciled date.`,
      );
    const opening = signedMinor(c.opening),
      closing = signedMinor(c.closing);
    if (opening !== BigInt(last?.closing_minor || lockedBank.opening_minor))
      throw new Problem(
        409,
        "Statement opening balance must equal the previous closing balance.",
      );
    let movement = 0n;
    for (const l of c.lines) {
      if (l.date < c.from || l.date > c.to || signedMinor(l.amount) === 0n)
        throw new Problem(
          400,
          "Every non-zero statement row must fall within the statement dates.",
        );
      movement += signedMinor(l.amount);
    }
    if (opening + movement !== closing)
      throw new Problem(
        400,
        "Opening balance plus imported movements does not equal the statement closing balance.",
      );
    await tx.query(
      "INSERT INTO bank_statements(id,tenant_id,bank_id,from_date,to_date,opening_minor,closing_minor,reference,request_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        id,
        t,
        b.id,
        c.from,
        c.to,
        String(opening),
        String(closing),
        c.reference,
        c.request_key,
        JSON.stringify(c),
      ],
    );
    for (let i = 0; i < c.lines.length; i++) {
      const l = c.lines[i];
      await tx.query(
        "INSERT INTO bank_statement_lines(id,tenant_id,statement_id,line_no,posted_on,description,reference,amount_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          uuid(),
          t,
          id,
          i + 1,
          l.date,
          l.description,
          l.reference,
          String(signedMinor(l.amount)),
        ],
      );
    }
    await audit(tx, ctx, id, c.action, {
      text: `Imported ${c.lines.length} statement rows for ${b.name}. No ledger entries were created.`,
    });
    return { id };
  }
  if (c.action === "bank.close" && s!.status === "Reconciled")
    return { id: s!.id };
  if (s!.status !== "Draft")
    throw new Problem(
      409,
      "Only a draft statement can be changed. Completed reconciliations retain their history.",
    );
  if (c.action === "bank.match") {
    if (
      new Set(c.statement_line_ids).size !== c.statement_line_ids.length ||
      new Set(c.journal_line_ids).size !== c.journal_line_ids.length
    )
      throw new Problem(400, "Select each row only once.");
    const existing = (
      await tx.query(
        `SELECT * FROM (${activeMatches}) m WHERE m.bank_id=$1 AND (m.statement_line_ids && $2::uuid[] OR m.journal_line_ids && $3::uuid[])`,
        [b.id, c.statement_line_ids, c.journal_line_ids],
      )
    ).rows;
    if (existing.length) {
      const m = existing[0];
      if (
        existing.length === 1 &&
        isDeepStrictEqual(
          [...m.statement_line_ids].sort(),
          [...c.statement_line_ids].sort(),
        ) &&
        isDeepStrictEqual(
          [...m.journal_line_ids].sort(),
          [...c.journal_line_ids].sort(),
        )
      )
        return { id: m.id };
      throw new Problem(409, "One of these rows is already matched.");
    }
    const bankRows = (
      await tx.query(
        "SELECT amount_minor FROM bank_statement_lines WHERE statement_id=$1 AND id=ANY($2::uuid[])",
        [s!.id, c.statement_line_ids],
      )
    ).rows;
    const bookRows = (
      await tx.query(
        `SELECT l.debit_minor-l.credit_minor AS amount FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.entity_id=$1 AND l.account_code=$2 AND l.id=ANY($3::uuid[]) AND j.posted_on<=$4 AND j.source_type<>'bank-opening'`,
        [b.entity_id, b.account_code, c.journal_line_ids, s!.to_date],
      )
    ).rows;
    if (
      bankRows.length !== c.statement_line_ids.length ||
      bookRows.length !== c.journal_line_ids.length
    )
      throw new Problem(
        400,
        "Selected rows must belong to this bank/statement and be posted by its closing date.",
      );
    if (
      bankRows.reduce((n, r) => n + BigInt(r.amount_minor), 0n) !==
      bookRows.reduce((n, r) => n + BigInt(r.amount), 0n)
    )
      throw new Problem(
        400,
        "Selected statement and ledger totals must match exactly.",
      );
    await tx.query(
      "INSERT INTO bank_matches(id,tenant_id,bank_id,statement_id,statement_line_ids,journal_line_ids) VALUES($1,$2,$3,$4,$5,$6)",
      [id, t, b.id, s!.id, c.statement_line_ids, c.journal_line_ids],
    );
    await audit(tx, ctx, s!.id, c.action, {
      text: `Matched ${bankRows.length} statement rows to ${bookRows.length} ledger rows.`,
      matchId: id,
    });
    return { id };
  }
  if (c.action === "bank.unmatch") {
    if (
      !(
        await tx.query(
          "SELECT id FROM bank_match_reversals WHERE match_id=$1",
          [c.id],
        )
      ).rows.length
    ) {
      await tx.query(
        "INSERT INTO bank_match_reversals(id,tenant_id,match_id,reason) VALUES($1,$2,$3,$4)",
        [id, t, c.id, c.reason],
      );
      await audit(tx, ctx, s!.id, c.action, {
        text: `Released match: ${c.reason}`,
        matchId: c.id,
      });
    }
    return { id: c.id };
  }
  if (c.action === "bank.cancel") {
    await tx.query(
      "UPDATE bank_statements SET status='Cancelled' WHERE id=$1",
      [s!.id],
    );
    await audit(tx, ctx, s!.id, c.action, {
      text: `Cancelled statement: ${c.reason}. Imported rows and match history retained.`,
    });
    return { id: s!.id };
  }
  if (c.action === "bank.close") {
    const detail = await bankDetail(tx, ctx, b.id, s!.id);
    const matched = new Set(
      detail.matches.flatMap((m) => m.statement_line_ids),
    );
    if (detail.lines.some((l) => !matched.has(l.id)))
      throw new Problem(
        409,
        "Match every statement row before completing reconciliation.",
      );
    if (detail.difference !== "0")
      throw new Problem(
        409,
        "The adjusted ledger and statement closing balance differ. Reconciliation was not completed.",
      );
    await tx.query(
      "UPDATE bank_statements SET status='Reconciled',closed_at=now() WHERE id=$1",
      [s!.id],
    );
    await tx.query(
      "UPDATE bank_accounts SET last_reconciled_on=$2 WHERE id=$1",
      [b.id, s!.to_date],
    );
    await audit(tx, ctx, s!.id, c.action, {
      text: `Reconciled ${b.name} through ${s!.to_date}.`,
      bookBalance: detail.bookBalance,
      outstanding: detail.unmatchedBookBalance,
      statementClosing: s!.closing_minor,
    });
    return { id: s!.id };
  }
  throw new Problem(400, "Unknown bank action.");
}
