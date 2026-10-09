import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import {
  openDatabase,
  migrate,
  bindEnvironment,
  inTenant,
} from "../server/db.ts";
import { seed } from "../server/seed.ts";
import { createApp } from "../server/app.ts";
import {
  workflowProgress,
  type ApprovalRun,
} from "../shared/approval-workflows.ts";

test("workflow progress requires all current votes and never skips a step", () => {
  const run = {
    outcome: "Pending",
    steps: [
      {
        label: "Both",
        mode: "all",
        people: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
        ],
      },
      { label: "Final", mode: "any", people: [{ id: "c", name: "C" }] },
    ],
    votes: [],
  } as unknown as ApprovalRun;
  assert.equal(workflowProgress(run, "c").allowed, false);
  assert.equal(workflowProgress(run, "a").final, false);
  run.votes.push({ step: 0, user_id: "a" } as never);
  assert.equal(workflowProgress(run, "a").allowed, false);
  assert.equal(workflowProgress(run, "b").allowed, true);
  run.votes.push({ step: 0, user_id: "b" } as never);
  assert.equal(workflowProgress(run, "c").final, true);
  run.outcome = "Returned";
  assert.equal(workflowProgress(run, "c").allowed, false);
});

test("shared bills and PO approvals retain people/rules, enforce steps, access, separation and atomic posting", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  await bindEnvironment(db, "sample");
  const tenant = (
    await db.query("SELECT id FROM tenants WHERE name LIKE 'Grid%' LIMIT 1")
  ).rows[0].id;
  const director = uuid();
  await db.query("INSERT INTO users(id,name,email) VALUES($1,$2,$3)", [
    director,
    "Director reviewer",
    `${director}@example.test`,
  ]);
  await db.query(
    "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",
    [tenant, director],
  );
  const origin = "http://127.0.0.1:4320",
    host = "127.0.0.1:4320",
    app = createApp(db, origin);
  await app.ready();
  t.after(() => app.close());
  const accounts = (
    await app.inject({ url: "/api/demo-accounts", headers: { host } })
  ).json();
  async function login(name: string) {
    const a = accounts.find(
      (a: any) => a.name === name && a.tenant_id === tenant,
    );
    const r = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers: { host, origin },
      payload: { userId: a.user_id, tenantId: tenant },
    });
    assert.equal(r.statusCode, 200, r.body);
    const cookie = r.headers["set-cookie"]!.toString().split(";")[0];
    const me = (
      await app.inject({ url: "/api/me", headers: { host, cookie } })
    ).json();
    return {
      id: a.user_id,
      call: (url: string, payload?: any) =>
        app.inject({
          method: payload ? "POST" : "GET",
          url,
          headers: { host, origin, cookie, "x-csrf-token": me.csrf },
          payload,
        }),
    };
  }
  const owner = await login("Owner"),
    finance = await login("Accountant"),
    admin = await login("Director reviewer"),
    sales = await login("Sales rep");
  const ok = async (p: any) => {
    const r = await p;
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const data = () => ok(owner.call("/api/data"));
  const initial = await data(),
    entity = initial.entities[0].id;
  assert.ok(initial.approvalPeople.some((p: any) => p.name === "Accountant"));
  assert.ok(!initial.approvalPeople.some((p: any) => p.name === "Sales rep"));
  assert.ok(!initial.approvalPeople.some((p: any) => p.role === "viewer"));
  const profile = uuid();
  await db.query(
    "INSERT INTO role_profiles(id,tenant_id,name,base_role,capabilities) VALUES($1,$2,'Approval finance','finance',$3)",
    [profile, tenant, JSON.stringify(["books.view", "books.post"])],
  );
  await db.query(
    "UPDATE memberships SET role_profile_id=$1 WHERE tenant_id=$2 AND user_id=$3",
    [profile, tenant, finance.id],
  );
  const steps = [
    {
      label: "Production and finance",
      minimum: "0",
      mode: "all",
      approvers: [
        { kind: "role", id: "finance" },
        { kind: "profile", id: profile },
        { kind: "user", id: director },
      ],
    },
    {
      label: "Director release",
      minimum: "0",
      mode: "any",
      approvers: [{ kind: "role", id: "admin" }],
    },
  ];
  const rules = (
    kind: string,
    version: number,
    next = steps,
    separate = true,
  ) => ({
    action: "approval.rules",
    entity_id: entity,
    kind,
    version,
    separate,
    steps: next,
  });
  assert.equal(
    (await finance.call("/api/commands", rules("bill", 0))).statusCode,
    403,
  );
  await ok(owner.call("/api/commands", rules("bill", 0)));
  assert.equal(
    (await owner.call("/api/commands", rules("bill", 0))).statusCode,
    409,
  );
  const vendor = await ok(
    owner.call("/api/commands", {
      action: "company.create",
      name: `Workflow vendor ${uuid()}`,
      vendor: true,
      customer: false,
      service_entity_id: null,
    }),
  );
  const fields = {
    vendor_id: vendor.id,
    deal_id: null,
    currency: "PKR",
    fx: "1",
    tax_treatment: "expense",
    lines: [
      {
        description: "Fictional approval work",
        quantity: "1",
        price: "100",
        tax: "0",
        account_code: "5000",
      },
    ],
    request_key: uuid(),
    reference: `Workflow-${uuid()}`,
  };
  const created = await ok(
    owner.call("/api/commands", {
      action: "bill.create",
      entity_id: entity,
      ...fields,
      bill_date: "2030-04-01",
      due_date: "2030-04-30",
      notes: "",
    }),
  );
  const bill = async () =>
    (await data()).bills.find((b: any) => b.id === created.id);
  const billAction = async (who: typeof owner, verb: string) => {
    const b = await bill();
    return who.call("/api/commands", {
      action: `bill.${verb}`,
      id: b.id,
      version: b.version,
    });
  };
  await ok(billAction(owner, "submit"));
  let b = await bill();
  assert.equal(
    b.workflow.steps[0].people.length,
    2,
    "role/profile overlap is deduplicated",
  );
  assert.deepEqual(
    b.workflow.steps[1].people.map((p: any) => p.id),
    [director],
    "creator excluded",
  );
  const ledger = async () =>
    Number(
      (
        await db.query(
          "SELECT count(*) AS n FROM journals WHERE tenant_id=$1",
          [tenant],
        )
      ).rows[0].n,
    );
  const before = await ledger();
  assert.equal((await billAction(owner, "approve")).statusCode, 403);
  assert.equal((await billAction(sales, "review")).statusCode, 403);
  await ok(
    owner.call(
      "/api/commands",
      rules("bill", 1, [
        {
          label: "Changed later",
          minimum: "0",
          mode: "any",
          approvers: [{ kind: "role", id: "finance" }],
        },
      ]),
    ),
  );
  assert.equal(
    (await bill()).workflow.steps.length,
    2,
    "pending rules retained",
  );
  await ok(billAction(finance, "review"));
  assert.equal(await ledger(), before);
  assert.equal(
    (await billAction(finance, "review")).statusCode,
    403,
    "same person cannot vote twice in step",
  );
  await ok(billAction(admin, "review"));
  assert.equal(await ledger(), before);
  await ok(billAction(admin, "approve"));
  assert.equal((await bill()).status, "Open");
  assert.equal(await ledger(), before + 1);
  b = await bill();
  assert.equal(b.workflow.outcome, "Approved");
  assert.equal((await billAction(admin, "approve")).statusCode, 409);

  // A small PO skips a higher threshold; final approval issues, never posts.
  await ok(
    owner.call(
      "/api/commands",
      rules("purchase-order", 0, [
        {
          label: "Finance",
          minimum: "0",
          mode: "any",
          approvers: [{ kind: "role", id: "finance" }],
        },
        {
          label: "Large orders",
          minimum: "200",
          mode: "any",
          approvers: [{ kind: "role", id: "admin" }],
        },
      ]),
    ),
  );
  const poCreated = await ok(
    owner.call("/api/commands", {
      action: "purchase-order.create",
      entity_id: entity,
      ...fields,
      request_key: uuid(),
      order_date: "2030-04-01",
      delivery_date: null,
    }),
  );
  const po = async () =>
    (await data()).purchaseOrders.find((p: any) => p.id === poCreated.id);
  const poAction = async (who: typeof owner, verb: string, comment = "") => {
    const p = await po();
    return who.call("/api/commands", {
      action: `purchase-order.${verb}`,
      id: p.id,
      version: p.version,
      comment,
    });
  };
  let p = await po();
  assert.equal(
    (
      await owner.call("/api/commands", {
        action: "purchase-order.status",
        id: p.id,
        version: p.version,
        status: "Issued",
        reason: "Bypass attempt",
      })
    ).statusCode,
    409,
  );
  await ok(poAction(owner, "submit"));
  assert.equal((await po()).status, "Pending approval");
  const run = (await data()).approvalRuns.find(
    (r: any) => r.document_id === poCreated.id,
  );
  assert.equal(run.steps.length, 1);
  await db.query(
    "UPDATE memberships SET entity_ids=$1 WHERE tenant_id=$2 AND user_id=$3",
    [
      [initial.entities.find((e: any) => e.id !== entity).id],
      tenant,
      finance.id,
    ],
  );
  assert.notEqual(
    (await poAction(finance, "review")).statusCode,
    200,
    "revoked entity cannot approve",
  );
  await db.query(
    "UPDATE memberships SET entity_ids=NULL WHERE tenant_id=$1 AND user_id=$2",
    [tenant, finance.id],
  );
  assert.equal(
    (await poAction(owner, "return")).statusCode,
    400,
    "return requires reason",
  );
  await ok(poAction(owner, "return", "Change delivery"));
  assert.equal((await po()).status, "Draft");
  await ok(poAction(owner, "submit"));
  const count = await ledger();
  await ok(poAction(finance, "review"));
  assert.equal((await po()).status, "Issued");
  assert.equal(await ledger(), count);
  const other = (
    await db.query("SELECT id FROM tenants WHERE id<>$1 LIMIT 1", [tenant])
  ).rows[0].id;
  const foreign = await inTenant(
    db,
    other,
    async (tx) =>
      (
        await tx.query("SELECT * FROM approval_runs WHERE document_id=$1", [
          created.id,
        ])
      ).rows,
  );
  assert.equal(foreign.length, 0);
  const directory = await inTenant(
    db,
    other,
    async (tx) =>
      (
        await tx.query("SELECT * FROM gv_approval_directory() WHERE id=$1", [
          director,
        ])
      ).rows,
  );
  assert.equal(directory.length, 0);
});
