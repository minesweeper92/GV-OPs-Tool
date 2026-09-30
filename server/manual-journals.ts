import { createHash, randomUUID as uuid } from "node:crypto";
import type { SQL } from "./db.ts";
import { audit, post, Problem, type Context } from "./domain.ts";
import { minor } from "../shared/money.ts";
import { controlledAccountCodes } from "../shared/accounting.ts";
import type { Command } from "../shared/commands.ts";

type JournalCommand = Extract<
  Command,
  { action: "manual-journal.create" | "manual-journal.reverse" }
>;
type JournalLine = {
  account_code: string;
  debit: string;
  credit: string;
  memo: string;
};

// These accounts have dedicated sub-ledgers. A free-form journal against one would
// leave a customer, vendor, bank or tax balance inconsistent with its detail.
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function postingEntity(tx: SQL, entityId: string, date: string) {
  const entity = (
    await tx.query("SELECT id,lock_date FROM entities WHERE id=$1 FOR UPDATE", [
      entityId,
    ])
  ).rows[0];
  if (!entity) throw new Problem(404, "Legal entity not found.");
  if (entity.lock_date && date <= String(entity.lock_date).slice(0, 10))
    throw new Problem(
      409,
      "This accounting period is locked. Choose a later date.",
    );
}

async function priorRequest(
  tx: SQL,
  sourceType: string,
  key: string,
  expectedHash: string,
) {
  const prior = (
    await tx.query(
      "SELECT id,request_hash FROM journals WHERE source_type=$1 AND source_id=$2",
      [sourceType, key],
    )
  ).rows[0];
  if (!prior) return null;
  if (prior.request_hash !== expectedHash)
    throw new Problem(409, "This retry key was used for a different journal.");
  return { id: prior.id as string };
}

export async function validatedManualLines(
  tx: SQL,
  entityId: string,
  input: JournalLine[],
) {
  const accountCodes = [...new Set(input.map((line) => line.account_code))];
  if (accountCodes.some((code) => controlledAccountCodes.has(code)))
    throw new Problem(
      400,
      "Use the corresponding invoice, bill, payment or bank workflow for a control account.",
    );
  const bankAccounts = (
    await tx.query(
      "SELECT account_code FROM bank_accounts WHERE entity_id=$1 AND account_code=ANY($2::text[])",
      [entityId, accountCodes],
    )
  ).rows;
  if (bankAccounts.length)
    throw new Problem(400, "Use the banking workflow for a bank account.");
  const accounts = (
    await tx.query(
      "SELECT code FROM accounts WHERE entity_id=$1 AND active AND code=ANY($2::text[])",
      [entityId, accountCodes],
    )
  ).rows;
  if (accounts.length !== accountCodes.length)
    throw new Problem(400, "Choose accounts from this legal entity's chart.");
  const lines = input.map((line) => ({
    account: line.account_code,
    debit: minor(line.debit),
    credit: minor(line.credit),
    memo: line.memo,
  }));
  if (lines.some((line) => line.debit > 0n === line.credit > 0n))
    throw new Problem(
      400,
      "Each line needs either a debit or a credit, not both.",
    );
  const debit = lines.reduce((sum, line) => sum + line.debit, 0n);
  const credit = lines.reduce((sum, line) => sum + line.credit, 0n);
  if (debit === 0n || debit !== credit)
    throw new Problem(400, "Journal debits and credits must balance.");
  if (debit > 9_000_000_000_000_000n)
    throw new Problem(400, "Journal total exceeds the supported amount.");
  return { lines, debit };
}

export async function executeManualJournal(
  tx: SQL,
  ctx: Context,
  command: JournalCommand,
) {
  if (!["admin", "finance"].includes(ctx.role))
    throw new Problem(403, "Only finance staff can post manual journals.");

  if (command.action === "manual-journal.create") {
    const hash = fingerprint({
      entity_id: command.entity_id,
      date: command.date,
      reference: command.reference,
      memo: command.memo,
      lines: command.lines,
      ...(command.auto_reverse_on
        ? { auto_reverse_on: command.auto_reverse_on }
        : {}),
    });
    const prior = await priorRequest(tx, "manual", command.request_key, hash);
    if (prior) return prior;
    await postingEntity(tx, command.entity_id, command.date);
    if (command.auto_reverse_on && command.auto_reverse_on <= command.date)
      throw new Problem(400, "The reversal date must follow the posting date.");
    const { lines, debit } = await validatedManualLines(
      tx,
      command.entity_id,
      command.lines,
    );
    const id = await post(
      tx,
      ctx,
      command.entity_id,
      command.date,
      "manual",
      command.request_key,
      `Manual journal ${command.reference}`,
      lines,
      { reference: command.reference, memo: command.memo, requestHash: hash },
    );
    if (command.auto_reverse_on)
      await tx.query(
        "INSERT INTO journal_reversal_tasks(id,tenant_id,entity_id,original_journal_id,due_date) VALUES($1,$2,$3,$4,$5)",
        [uuid(), ctx.tenantId, command.entity_id, id, command.auto_reverse_on],
      );
    await audit(tx, ctx, id, "manual-journal.post", {
      entity_id: command.entity_id,
      date: command.date,
      reference: command.reference,
      memo: command.memo,
      debit_minor: String(debit),
    });
    return { id };
  }

  const hash = fingerprint({
    id: command.id,
    date: command.date,
    reason: command.reason,
  });
  const prior = await priorRequest(
    tx,
    "manual-reversal",
    command.request_key,
    hash,
  );
  if (prior) return prior;
  const original = (
    await tx.query(
      "SELECT * FROM journals WHERE id=$1 AND source_type='manual'",
      [command.id],
    )
  ).rows[0];
  if (!original) throw new Problem(404, "Manual journal not found.");
  if (command.date < String(original.posted_on).slice(0, 10))
    throw new Problem(400, "A reversal cannot predate its original journal.");
  await postingEntity(tx, original.entity_id, command.date);
  const alreadyReversed = (
    await tx.query("SELECT id FROM journals WHERE reverses_journal_id=$1", [
      command.id,
    ])
  ).rows[0];
  if (alreadyReversed)
    throw new Problem(409, "This journal already has a reversal.");
  const originalLines = (
    await tx.query(
      "SELECT account_code,debit_minor,credit_minor,memo FROM journal_lines WHERE journal_id=$1 ORDER BY line_number,id",
      [command.id],
    )
  ).rows;
  const id = await post(
    tx,
    ctx,
    original.entity_id,
    command.date,
    "manual-reversal",
    command.request_key,
    `Reversal of ${original.external_reference}`,
    originalLines.map((line) => ({
      account: line.account_code,
      debit: BigInt(line.credit_minor),
      credit: BigInt(line.debit_minor),
      memo: line.memo,
    })),
    {
      reference: original.external_reference,
      memo: command.reason,
      requestHash: hash,
      reversesJournalId: original.id,
    },
  );
  await audit(tx, ctx, original.id, "manual-journal.reverse", {
    reversal_id: id,
    date: command.date,
    reason: command.reason,
  });
  await tx.query(
    "UPDATE journal_reversal_tasks SET status='Posted',reversal_journal_id=$2,posted_on=$3 WHERE original_journal_id=$1 AND status='Pending review'",
    [original.id, id, command.date],
  );
  return { id };
}
