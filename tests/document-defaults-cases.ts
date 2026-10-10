import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import { inTenant, type Database } from "../server/db.ts";
import { type Context } from "../server/domain.ts";
import {
  defaultsSnapshot,
  saveDocumentDefaults,
} from "../server/document-defaults.ts";
import {
  defaultsCommands,
  initialSalesDefaults,
} from "../shared/document-defaults.ts";

export async function verifyDefaultsStorage(t: TestContext, db: Database) {
  const tenant = uuid(),
    other = uuid(),
    user = uuid(),
    entity = uuid(),
    hidden = uuid();
  await db.query(
    "INSERT INTO tenants(id,name) VALUES($1,'Defaults integration'),($2,'Defaults other')",
    [tenant, other],
  );
  await db.query(
    "INSERT INTO users(id,name,email) VALUES($1,'Defaults admin',$2)",
    [user, `${user}@example.test`],
  );
  await db.query(
    "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,'Defaults first','DF'),($3,$2,'Defaults hidden','DH')",
    [entity, tenant, hidden],
  );
  const ctx: Context = {
    tenantId: tenant,
    userId: user,
    role: "admin",
    name: "Defaults admin",
  };
  const command = defaultsCommands[0].parse({
    action: "settings.sales-defaults",
    entity_id: entity,
    version: 0,
    request_key: uuid(),
    settings: initialSalesDefaults(),
  });
  const run = (c: typeof command) =>
    inTenant(db, ctx, (tx) => saveDocumentDefaults(tx, ctx, c));
  await run(command);
  // Canonical JSON equality, not JS object-key order, must govern retries.
  await run({
    ...command,
    settings: {
      payment_instructions: "",
      invoice_terms: "",
      invoice_notes: "",
      quote_terms: "",
      quote_notes: "",
      quote_valid_days: null,
      default_term_id: "net30",
      terms: command.settings.terms,
    },
  });
  const competing = await Promise.allSettled(
    ["First editor", "Second editor"].map((note) =>
      run({
        ...command,
        version: 1,
        request_key: uuid(),
        settings: { ...command.settings, quote_notes: note },
      }),
    ),
  );
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = competing.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 409);
  await inTenant(db, ctx, async (tx) => {
    const data = await defaultsSnapshot(tx, ctx);
    assert.equal(data.documentDefaults[0].version, 2);
    assert.equal(data.documentDefaultsHistory.length, 2);
    assert.equal(
      Number(
        (
          await tx.query(
            "SELECT count(*) FROM audit_events WHERE action='settings.sales-defaults'",
          )
        ).rows[0].count,
      ),
      2,
    );
  });
  for (const scope of [
    { tenantId: other },
    { tenantId: tenant, entityIds: [hidden] },
  ]) {
    await inTenant(db, scope, async (tx) => {
      assert.equal(
        (await defaultsSnapshot(tx, ctx)).documentDefaults.length,
        0,
      );
      await assert.rejects(
        saveDocumentDefaults(
          tx,
          { ...ctx, ...scope },
          { ...command, request_key: uuid() },
        ),
        /unavailable/i,
      );
    });
  }
  // No accounting operation is involved in a settings save.
  assert.equal(
    Number(
      (
        await db.query("SELECT count(*) FROM journals WHERE tenant_id=$1", [
          tenant,
        ])
      ).rows[0].count,
    ),
    0,
  );
}
