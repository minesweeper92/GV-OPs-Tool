import { z } from "zod";

const date = z.iso.date();
const amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/);
const name = z.string().trim().min(1).max(200);

export const cutoverInput = z.strictObject({
  entity_id: z.uuid(),
  cutover_date: date,
  accounts: z
    .array(
      z.strictObject({
        code: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9]{1,12}$/),
        name,
        type: z.enum(["Asset", "Liability", "Equity", "Income", "Expense"]),
        debit: amount,
        credit: amount,
      }),
    )
    .min(1)
    .max(500),
  receivables: z
    .array(
      z.strictObject({
        company: name,
        number: name,
        issue_date: date,
        due_date: date,
        amount,
      }),
    )
    .max(500),
  payables: z
    .array(
      z.strictObject({
        company: name,
        number: name,
        bill_date: date,
        due_date: date,
        amount,
      }),
    )
    .max(500),
});

export type CutoverInput = z.infer<typeof cutoverInput>;

// The import UI accepts standard CSV exports, including quoted commas and newlines.
// This parser does not guess delimiters, encodings or currency precision.
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else field += char;
    } else if (char === '"') {
      if (field || closed)
        throw new Error(`Invalid CSV quote on row ${rows.length + 1}.`);
      quoted = true;
    } else if (char === ",") {
      row.push(field.trim());
      field = "";
      closed = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else {
      if (closed && char.trim())
        throw new Error(
          `Unexpected text after a CSV quote on row ${rows.length + 1}.`,
        );
      field += char;
    }
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function tableCsv<T extends string>(
  text: string,
  columns: readonly T[],
): Record<T, string>[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((value) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
  const positions = columns.map((column) =>
    headers.indexOf(column.replace(/[^a-z0-9]/g, "")),
  );
  if (positions.some((index) => index < 0))
    throw new Error(`CSV needs these columns: ${columns.join(", ")}.`);
  return rows.slice(1).map((row, index) => {
    if (row.length !== headers.length)
      throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    return Object.fromEntries(
      columns.map((column, i) => [column, row[positions[i]]]),
    ) as Record<T, string>;
  });
}
