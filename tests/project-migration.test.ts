import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID as uuid, createHash } from "node:crypto";
import { openDatabase, migrate, inTenant } from "../server/db.ts";
test("project migration preserves an already-paid legacy invoice and immutable snapshots", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  const paths = [
    "schema.sql",
    "migrations/002_access.sql",
    "migrations/003_payables.sql",
    "migrations/004_banking.sql",
  ];
  await db.transaction(async (tx) => {
    await tx.query(
      "CREATE TABLE migrations(version integer PRIMARY KEY,checksum text NOT NULL)",
    );
    for (const [index, path] of paths.entries()) {
      const sql = await readFile(
        new URL(`../server/${path}`, import.meta.url),
        "utf8",
      );
      await tx.exec!(sql);
      await tx.query("INSERT INTO migrations VALUES($1,$2)", [
        index + 1,
        createHash("sha256").update(sql).digest("hex"),
      ]);
    }
  });
  const tenant = uuid(),
    user = uuid(),
    entity = uuid(),
    company = uuid(),
    contact = uuid(),
    deal = uuid(),
    quote = uuid(),
    invoice = uuid();
  const lines = [
    {
      description: "Legacy work",
      quantity: "2",
      price: "100",
      tax: "18",
      subtotal: "20000",
      taxMinor: "3600",
    },
  ];
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO tenants VALUES($1,'Legacy test')", [tenant]);
    await tx.query("INSERT INTO users VALUES($1,'Legacy user',$2)", [
      user,
      `${user}@example.test`,
    ]);
    await tx.query(
      "INSERT INTO entities(id,tenant_id,name,code,next_invoice) VALUES($1,$2,'Legacy entity','LEG',2)",
      [entity, tenant],
    );
    await tx.query(
      "INSERT INTO companies(id,tenant_id,name,owner_id) VALUES($1,$2,'Legacy client',$3)",
      [company, tenant, user],
    );
    await tx.query(
      "INSERT INTO contacts(id,tenant_id,first_name,owner_id) VALUES($1,$2,'Legacy',$3)",
      [contact, tenant, user],
    );
    await tx.query(
      "INSERT INTO deals(id,tenant_id,company_id,contact_id,entity_id,name,stage,owner_id) VALUES($1,$2,$3,$4,$5,'Legacy project','Won',$6)",
      [deal, tenant, company, contact, entity, user],
    );
    await tx.query(
      "INSERT INTO quotes(id,tenant_id,deal_id,entity_id,option_name,revision,currency,fx_micros,lines,net_minor,tax_minor,total_minor,customer_name,issuer_name,issuer_address,issuer_tax_id) VALUES($1,$2,$3,$4,'Original',1,'PKR',1000000,$5,20000,3600,23600,'Legacy client','Legacy issuer','','')",
      [quote, tenant, deal, entity, JSON.stringify(lines)],
    );
    await tx.query("UPDATE deals SET accepted_quote_id=$2 WHERE id=$1", [
      deal,
      quote,
    ]);
    await tx.query(
      "INSERT INTO invoices(id,tenant_id,entity_id,deal_id,quote_id,number,status,issue_date,due_date,paid_minor,paid_base_minor) VALUES($1,$2,$3,$4,$5,'LEG-INV-00001','Paid','2026-01-01','2026-01-31',23600,23600)",
      [invoice, tenant, entity, deal, quote],
    );
  });
  await migrate(db);
  await migrate(db);
  const old = (
    await inTenant(db, tenant, (tx) =>
      tx.query("SELECT * FROM invoices WHERE id=$1", [invoice]),
    )
  ).rows[0];
  assert.equal(old.status, "Paid");
  assert.equal(old.number, "LEG-INV-00001");
  assert.equal(old.paid_minor, "23600");
  assert.equal(old.total_minor, "23600");
  assert.equal(old.net_minor, "20000");
  assert.deepEqual(old.lines, lines);
  assert.equal(old.billing_kind, "earned");
  await assert.rejects(() =>
    inTenant(db, tenant, (tx) =>
      tx.query("UPDATE invoices SET label=$2 WHERE id=$1", [
        invoice,
        "Changed",
      ]),
    ),
  );
  assert.equal(
    (await db.query("SELECT next_invoice FROM entities WHERE id=$1", [entity]))
      .rows[0].next_invoice,
    2,
  );
});
