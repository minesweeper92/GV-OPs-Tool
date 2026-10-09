import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID as uuid, createHash } from "node:crypto";
import { openDatabase, migrate, inTenant } from "../server/db.ts";
import {
  billReviewDecision,
  type BillApprovalPolicy,
} from "../shared/bill-approval.ts";

test("tier migration keeps pending first reviews and legacy policies intact", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  // Apply every migration before 034, exactly as an existing database has.
  const list = (
    await readFile(new URL("../server/db.ts", import.meta.url), "utf8")
  ).match(/"\.\/(schema\.sql|migrations\/\d{3}_[\w-]+\.sql)"/g)!;
  const before = list
    .map((p) => p.slice(3, -1))
    .filter((p) => !/migrations\/0(3[4-9]|[4-9]\d)/.test(p));
  assert.equal(before.at(-1), "migrations/033_entity_grants.sql");
  await db.transaction(async (tx) => {
    await tx.query(
      "CREATE TABLE migrations(version integer PRIMARY KEY,checksum text NOT NULL)",
    );
    for (const [index, path] of before.entries()) {
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
    maker = uuid(),
    reviewer = uuid(),
    entity = uuid(),
    vendor = uuid(),
    pending = uuid(),
    draft = uuid();
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO tenants VALUES($1,'Legacy approvals')", [
      tenant,
    ]);
    for (const id of [maker, reviewer])
      await tx.query("INSERT INTO users VALUES($1,'Legacy',$2)", [
        id,
        `${id}@example.test`,
      ]);
    await tx.query(
      "INSERT INTO entities(id,tenant_id,name,code,bill_two_stage,bill_finance_limit_minor) VALUES($1,$2,'Legacy entity','LEG',true,'500000')",
      [entity, tenant],
    );
    await tx.query(
      "INSERT INTO companies(id,tenant_id,name,owner_id) VALUES($1,$2,'Legacy vendor',$3)",
      [vendor, tenant, maker],
    );
    for (const [id, status] of [
      [pending, "Pending approval"],
      [draft, "Draft"],
    ])
      await tx.query(
        `INSERT INTO bills(id,tenant_id,entity_id,vendor_id,vendor_name,entity_name,reference,bill_date,due_date,currency,fx_micros,lines,tax_treatment,net_minor,tax_minor,total_minor,base_minor,status,last_activity_on,created_by,request_key,request_payload)
         VALUES($1,$2,$3,$4,'Legacy vendor','Legacy entity',$5,'2026-09-01','2026-09-30','PKR',1000000,'[]','expense',10000,0,10000,10000,$6,'2026-09-01',$7,$8,'{}')`,
        [id, tenant, entity, vendor, `L-${id}`, status, maker, uuid()],
      );
    // The pending bill already completed its first (legacy two-stage) review.
    await tx.query(
      "UPDATE bills SET reviewed_by=$2,reviewed_at=now(),version=version+1 WHERE id=$1",
      [pending, reviewer],
    );
  });

  await migrate(db);

  await inTenant(db, tenant, async (tx) => {
    const rows = (
      await tx.query(
        "SELECT id,approval_round,version,approval_policy FROM bills ORDER BY status",
      )
    ).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId[pending].approval_round, 1);
    assert.equal(byId[pending].version, 2, "backfill must not bump versions");
    assert.equal(byId[draft].approval_round, 0);
    assert.equal(byId[draft].approval_policy, null);
    assert.equal(byId[pending].approval_policy.source, "upgrade");
    assert.equal(byId[pending].approval_policy.bill_two_stage, true);
    const approvals = (
      await tx.query(
        "SELECT round,step,approver_id FROM bill_approvals WHERE bill_id=$1",
        [pending],
      )
    ).rows;
    assert.deepEqual(approvals, [{ round: 1, step: 0, approver_id: reviewer }]);
    // The legacy two-stage policy still means: the next step is the final
    // administrator approval, by someone other than the first reviewer.
    const policy = (
      await tx.query("SELECT * FROM entities WHERE id=$1", [entity])
    ).rows[0] as BillApprovalPolicy;
    assert.equal(policy.bill_approval_tiers, null);
    const bill = {
      created_by: maker,
      base_minor: "10000",
      approvals: [reviewer],
    };
    assert.equal(
      billReviewDecision("admin", uuid(), bill, policy).action,
      "approve",
    );
    assert.equal(
      billReviewDecision("admin", reviewer, bill, policy).allowed,
      false,
    );
    assert.equal(
      billReviewDecision("finance", uuid(), bill, policy).allowed,
      false,
    );
  });
});
