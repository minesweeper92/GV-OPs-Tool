import type { SQL } from "./db.ts";
// Callers hold the legal-entity lock before choosing an account or posting.
// Keeping this helper independent avoids circular imports in the posting engine.
export async function cashAccount(
  tx: SQL,
  entity: string,
  id: string | null | undefined,
  date: string,
) {
  if (!id) return "1000";
  const b = (
    await tx.query("SELECT * FROM bank_accounts WHERE id=$1 AND entity_id=$2", [
      id,
      entity,
    ])
  ).rows[0];
  if (!b)
    throw Object.assign(
      new RangeError("Choose a bank account belonging to this legal entity."),
    );
  if (date <= b.last_reconciled_on)
    throw new RangeError(
      "This bank period is reconciled. Choose a later posting date.",
    );
  return b.account_code as string;
}
