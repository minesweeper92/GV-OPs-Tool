import { z } from "zod";
import { minor } from "./money.ts";
const id = z.uuid(),
  text = z.string().trim().min(1).max(200),
  date = z.iso.date();
export const signedAmount = z
  .string()
  .regex(
    /^-?\d{1,13}(\.\d{1,2})?$/,
    "Use a signed decimal with at most two decimal places.",
  );
export const signedMinor = (s: string) =>
  s.startsWith("-") ? -minor(s.slice(1)) : minor(s);
const statementLine = z.strictObject({
  date,
  description: text,
  reference: z.string().trim().max(200),
  amount: signedAmount,
});
const amount = z
  .string()
  .regex(
    /^\d{1,13}(\.\d{1,2})?$/,
    "Use an amount with at most two decimal places.",
  );
const allocation = z.strictObject({
  account_code: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
  debit: amount,
  credit: amount,
  memo: z.string().trim().max(400),
});
// The bank side is implied by the direction; allocations must balance it.
export function bankTransactionProblem(t: {
  direction: "in" | "out";
  amount: string;
  lines: { debit: string; credit: string }[];
}) {
  const total = minor(t.amount);
  if (total <= 0n) return "Enter an amount greater than zero.";
  if (t.lines.some((l) => minor(l.debit) > 0n === minor(l.credit) > 0n))
    return "Each allocation needs either a debit or a credit, not both.";
  const debit = t.lines.reduce((s, l) => s + minor(l.debit), 0n),
    credit = t.lines.reduce((s, l) => s + minor(l.credit), 0n);
  const net = t.direction === "out" ? debit - credit : credit - debit;
  if (net !== total)
    return t.direction === "out"
      ? "Allocations must explain where the money went: debits less credits must equal the amount paid out."
      : "Allocations must explain where the money came from: credits less debits must equal the amount received.";
  return null;
}
export const bankCommands = [
  z.strictObject({
    action: z.literal("bank.transaction"),
    bank_id: id,
    date,
    direction: z.enum(["in", "out"]),
    amount,
    description: text,
    reference: z.string().trim().max(200),
    lines: z.array(allocation).min(1).max(50),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("bank.create"),
    entity_id: id,
    name: text,
    reference: z.string().trim().max(40),
    opening_on: date,
    opening: signedAmount,
    offset_code: z.enum(["3000", "3900"]),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("bank.import"),
    bank_id: id,
    from: date,
    to: date,
    opening: signedAmount,
    closing: signedAmount,
    reference: text,
    lines: z.array(statementLine).max(500),
    request_key: id,
  }),
  z.strictObject({
    action: z.literal("bank.match"),
    statement_id: id,
    statement_line_ids: z.array(id).min(1).max(100),
    journal_line_ids: z.array(id).min(1).max(100),
  }),
  z.strictObject({ action: z.literal("bank.unmatch"), id, reason: text }),
  z.strictObject({ action: z.literal("bank.close"), id }),
  z.strictObject({ action: z.literal("bank.cancel"), id, reason: text }),
] as const;
export interface BankAccount {
  id: string;
  entity_id: string;
  entity_code: string;
  name: string;
  reference: string;
  account_code: string;
  opening_on: string;
  opening_minor: string;
  last_reconciled_on: string;
  balance: string;
}
export interface BankStatement {
  id: string;
  bank_id: string;
  from_date: string;
  to_date: string;
  opening_minor: string;
  closing_minor: string;
  reference: string;
  status: string;
  closed_at: string | null;
}
export interface StatementLine {
  id: string;
  line_no: number;
  posted_on: string;
  description: string;
  reference: string;
  amount_minor: string;
}
export interface BankMatch {
  id: string;
  statement_id: string;
  statement_line_ids: string[];
  journal_line_ids: string[];
}
export interface BankBookLine {
  id: string;
  posted_on: string;
  description: string;
  amount: string;
  source_type: string;
}
export interface BankDetail {
  account: BankAccount;
  statements: BankStatement[];
  statement: BankStatement | null;
  lines: StatementLine[];
  matches: BankMatch[];
  books: BankBookLine[];
  bookBalance: string;
  unmatchedBookBalance: string;
  adjustedBalance: string;
  difference: string;
}

// RFC-style quoted cells, including escaped quotes and embedded newlines.
// Exact ISO dates and signed decimals avoid locale-dependent interpretation.
export function parseStatementCsv(input: string) {
  if (input.length > 100000)
    throw new Error("Use a CSV smaller than 100 KB, with up to 500 rows.");
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false,
    afterQuote = false;
  const source = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else value += c;
      continue;
    }
    if (c === '"' && !value && !afterQuote) {
      quoted = true;
      continue;
    }
    if (c === "," || c === "\n" || c === "\r") {
      row.push(value);
      value = "";
      afterQuote = false;
      if (c !== ",") {
        if (row.some((v) => v.trim())) rows.push(row);
        row = [];
        if (c === "\r" && source[i + 1] === "\n") i++;
      }
    } else {
      if (afterQuote || c === '"')
        throw new Error("Malformed quoted CSV cell.");
      value += c;
    }
  }
  if (quoted) throw new Error("Unclosed quoted CSV cell.");
  row.push(value);
  if (row.some((v) => v.trim())) rows.push(row);
  if (
    rows
      .shift()
      ?.map((c) => c.trim().toLowerCase())
      .join(",") !== "date,description,reference,amount"
  )
    throw new Error(
      "CSV headers must be Date,Description,Reference,Amount in that order.",
    );
  if (rows.length > 500)
    throw new Error("Import up to 500 statement rows at a time.");
  return rows.map((r, i) => {
    if (r.length !== 4) throw new Error(`Row ${i + 2}: expected four columns.`);
    const result = statementLine.safeParse({
      date: r[0].trim(),
      description: r[1].trim(),
      reference: r[2].trim(),
      amount: r[3].trim(),
    });
    if (!result.success)
      throw new Error(
        `Row ${i + 2}: use YYYY-MM-DD, a description and a signed decimal amount.`,
      );
    if (signedMinor(result.data.amount) === 0n)
      throw new Error(`Row ${i + 2}: amount cannot be zero.`);
    return result.data;
  });
}
