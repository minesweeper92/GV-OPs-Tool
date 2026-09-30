import { createHash } from "node:crypto";
import type { SQL } from "./db.ts";
import { audit, Problem, type Context } from "./domain.ts";
import type { Command } from "../shared/commands.ts";

type AccountCommand = Extract<
  Command,
  { action: "account.create" | "account.update" | "account.set-active" }
>;
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function executeAccount(tx: SQL, ctx: Context, c: AccountCommand) {
  if (ctx.role !== "admin")
    throw new Problem(
      403,
      "Only an administrator can change the chart of accounts.",
    );
  const entity = (
    await tx.query("SELECT id FROM entities WHERE id=$1", [c.entity_id])
  ).rows[0];
  if (!entity) throw new Problem(404, "Legal entity not found.");

  if (c.action === "account.create") {
    if (c.code.startsWith("10B"))
      throw new Problem(
        400,
        "Codes beginning 10B are reserved for bank accounts.",
      );
    const hash = fingerprint({
      code: c.code,
      name: c.name,
      type: c.type,
      parent_code: c.parent_code,
      description: c.description,
    });
    const prior = (
      await tx.query(
        "SELECT id,code,request_hash FROM accounts WHERE entity_id=$1 AND created_request_key=$2",
        [c.entity_id, c.request_key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== hash)
        throw new Problem(
          409,
          "This retry key was used for a different account.",
        );
      return { id: prior.id, code: prior.code };
    }
    if (c.parent_code) {
      const parent = (
        await tx.query(
          "SELECT type,active FROM accounts WHERE entity_id=$1 AND code=$2",
          [c.entity_id, c.parent_code],
        )
      ).rows[0];
      if (!parent || !parent.active || parent.type !== c.type)
        throw new Problem(
          400,
          "Choose an active parent account of the same type.",
        );
    }
    const account = (
      await tx.query(
        `INSERT INTO accounts(tenant_id,entity_id,code,name,type,parent_code,description,created_request_key,request_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          ctx.tenantId,
          c.entity_id,
          c.code,
          c.name,
          c.type,
          c.parent_code,
          c.description,
          c.request_key,
          hash,
        ],
      )
    ).rows[0];
    await audit(tx, ctx, account.id, "account.create", {
      entity_id: c.entity_id,
      code: c.code,
      name: c.name,
      type: c.type,
      parent_code: c.parent_code,
    });
    return { id: account.id, code: c.code };
  }

  const account = (
    await tx.query(
      "SELECT * FROM accounts WHERE entity_id=$1 AND code=$2 FOR UPDATE",
      [c.entity_id, c.code],
    )
  ).rows[0];
  if (!account)
    throw new Problem(404, "Account not found in this legal entity.");
  if (account.system)
    throw new Problem(403, "System accounts cannot be changed.");
  if (account.version !== c.version)
    throw new Problem(409, "This account changed. Refresh before saving.");

  if (c.action === "account.update") {
    await tx.query(
      "UPDATE accounts SET name=$3,description=$4,version=version+1 WHERE entity_id=$1 AND code=$2",
      [c.entity_id, c.code, c.name, c.description],
    );
    await audit(tx, ctx, account.id, "account.update", {
      before: { name: account.name, description: account.description },
      after: { name: c.name, description: c.description },
    });
  } else {
    if (account.active === c.active) return { id: account.id, code: c.code };
    if (
      !c.active &&
      (
        await tx.query(
          "SELECT id FROM accounts WHERE entity_id=$1 AND parent_code=$2 AND active LIMIT 1",
          [c.entity_id, c.code],
        )
      ).rows.length
    )
      throw new Problem(409, "Deactivate child accounts first.");
    await tx.query(
      "UPDATE accounts SET active=$3,version=version+1 WHERE entity_id=$1 AND code=$2",
      [c.entity_id, c.code, c.active],
    );
    await audit(
      tx,
      ctx,
      account.id,
      c.active ? "account.reactivate" : "account.deactivate",
      { entity_id: c.entity_id, code: c.code },
    );
  }
  return { id: account.id, code: c.code };
}
