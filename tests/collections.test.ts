import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import {
  openDatabase,
  migrate,
  bindEnvironment,
  inTenant,
  type Row,
} from "../server/db.ts";
import { seed } from "../server/seed.ts";
import { Problem, execute, type Context } from "../server/domain.ts";
import { executeDocument } from "../server/documents.ts";
import {
  executeCollection,
  collectionSnapshot,
} from "../server/collections.ts";
import {
  collectionWorklist,
  scheduleProblem,
  type CollectionContact,
  type InvoiceDispute,
  type ReminderSchedule,
} from "../shared/collections.ts";

const status = (code: number) => (e: unknown) =>
  e instanceof Problem && e.status === code;

test("the worklist groups real overdue balances and knows when to pause reminders", () => {
  const steps = [
    { key: "before", offset_days: -3, subject: "Due soon", body: "" },
    { key: "due", offset_days: 0, subject: "Due today", body: "" },
    { key: "late-7", offset_days: 7, subject: "One week overdue", body: "" },
    { key: "late-30", offset_days: 30, subject: "One month overdue", body: "" },
  ];
  const schedule: ReminderSchedule = {
    id: "s1",
    entity_id: "e1",
    version: 2,
    name: "Standard",
    steps,
    pause_on_promise: true,
  };
  const invoice = (id: string, over: Row = {}) => ({
    id,
    number: id.toUpperCase(),
    entity_id: "e1",
    company_id: "c1",
    currency: "PKR",
    due_date: "2026-09-01",
    status: "Issued",
    balance: 100000n,
    ...over,
  });
  const contact = (over: Partial<CollectionContact>): CollectionContact => ({
    id: uuid(),
    entity_id: "e1",
    company_id: "c1",
    invoice_id: null,
    kind: "Call",
    summary: "Spoke",
    contacted_on: "2026-09-20",
    promise_date: null,
    promise_amount_minor: null,
    next_action: "",
    next_action_due: null,
    assignee_id: null,
    created_by_name: "Owner",
    ...over,
  });
  const dispute: InvoiceDispute = {
    id: "d1",
    entity_id: "e1",
    company_id: "c1",
    invoice_id: "disputed",
    reason: "Scope",
    amount_minor: "40000",
    owner_id: "u",
    opened_on: "2026-09-10",
    opened_by_name: "Owner",
    resolved_on: null,
    resolution: null,
  };
  const base = {
    today: "2026-09-15",
    companies: [
      { id: "c1", name: "Acme" },
      { id: "c2", name: "Zed" },
    ],
    contacts: [] as CollectionContact[],
    disputes: [] as InvoiceDispute[],
    holds: [],
    schedules: [{ ...schedule, id: "old", version: 1, steps: [] }, schedule],
    followups: [],
    onAccount: [
      { company_id: "c1", entity_id: "e1", currency: "PKR", available: 25000n },
    ],
  };
  const list = collectionWorklist({
    ...base,
    invoices: [
      invoice("old"),
      invoice("usd", {
        currency: "USD",
        balance: 500n,
        due_date: "2026-09-10",
      }),
      invoice("other-entity", { entity_id: "e2", due_date: "2026-09-12" }),
      invoice("not-due", { due_date: "2026-10-30" }),
      invoice("paid", { balance: 0n }),
      invoice("draft", { status: "Draft" }),
      invoice("zed", { company_id: "c2", due_date: "2026-09-14" }),
    ],
  });
  // Most overdue customer first; nothing merged across entity or currency.
  assert.deepEqual(
    list.map((c) => c.name),
    ["Acme", "Zed"],
  );
  const acme = list[0];
  assert.deepEqual(
    acme.invoices.map((i) => i.id),
    ["old", "usd", "other-entity"],
  );
  assert.equal(acme.balances.length, 3);
  const pkr = acme.balances.find(
    (b) => b.entity_id === "e1" && b.currency === "PKR",
  )!;
  assert.equal(pkr.overdue, 100000n);
  assert.equal(pkr.on_account, 25000n);
  assert.equal(acme.oldest_days_overdue, 14);
  // The latest version applies; the most recent step already due is the one to do.
  const reminder = acme.invoices[0].reminder;
  assert.ok(
    reminder.state === "due" &&
      reminder.step.key === "late-7" &&
      reminder.since === "2026-09-08",
  );
  // An entity with no schedule simply has no reminders.
  assert.equal(acme.invoices[2].reminder.state, "none");

  // A reminder due before the due date brings a not-yet-overdue invoice in.
  const early = collectionWorklist({
    ...base,
    today: "2026-10-28",
    invoices: [invoice("not-due", { due_date: "2026-10-30" })],
  });
  assert.equal(early[0].invoices[0].days_overdue, 0);
  assert.equal(early[0].invoices[0].reminder.state, "due");

  // Disputes always pause; promises pause while they are still in the future.
  const paused = collectionWorklist({
    ...base,
    disputes: [dispute],
    contacts: [
      contact({
        invoice_id: "promised",
        promise_date: "2026-09-20",
        promise_amount_minor: "100000",
        next_action: "Call back",
        next_action_due: "2026-09-21",
        assignee_id: "u",
      }),
      contact({
        invoice_id: "broken",
        promise_date: "2026-09-12",
        promise_amount_minor: "100000",
        contacted_on: "2026-09-05",
      }),
    ],
    invoices: [invoice("disputed"), invoice("promised"), invoice("broken")],
  })[0];
  const by = (id: string) => paused.invoices.find((i) => i.id === id)!;
  assert.deepEqual(by("disputed").reminder, {
    state: "paused",
    reason: "dispute",
  });
  assert.deepEqual(by("promised").reminder, {
    state: "paused",
    reason: "promise",
    until: "2026-09-20",
  });
  assert.equal(by("broken").promise_broken, true);
  assert.equal(by("broken").reminder.state, "due");
  assert.equal(paused.balances[0].disputed, 40000n);
  assert.equal(paused.last_contact!.contacted_on, "2026-09-20");
  assert.equal(paused.next_action!.next_action, "Call back");
  assert.equal(paused.reminders_due, 1);

  // Once a step is followed up, the next one waits its turn.
  const after = collectionWorklist({
    ...base,
    followups: [
      {
        id: "f",
        invoice_id: "old",
        schedule_id: "s1",
        step_key: "late-7",
        outcome: "Done manually",
        note: "",
        followed_up_on: "2026-09-15",
        created_by_name: "Owner",
      },
    ],
    invoices: [invoice("old")],
  })[0].invoices[0].reminder;
  assert.ok(after.state === "due" && after.step.key === "due");
  assert.match(
    scheduleProblem([steps[0], { ...steps[1], key: "before" }])!,
    /own key/,
  );
  assert.match(
    scheduleProblem([steps[0], { ...steps[1], offset_days: -3 }])!,
    /same day/,
  );
  assert.equal(scheduleProblem(steps), null);
});

test("collections actions are audited, assigned safely and enforced on the server", async (t) => {
  const db = await openDatabase("memory://");
  t.after(() => db.close());
  await migrate(db);
  await seed(db);
  await bindEnvironment(db, "sample");
  const rows = (
    await db.query(
      "SELECT m.*,t.name AS organization FROM memberships m JOIN tenants t ON t.id=m.tenant_id",
    )
  ).rows;
  const owner = rows.find(
    (r) => r.role === "admin" && r.organization.startsWith("Grid"),
  )!;
  const tenant = owner.tenant_id;
  const member = (role: string) =>
    rows.find((r) => r.role === role && r.tenant_id === tenant)!;
  const admin: Context = {
    tenantId: tenant,
    userId: owner.user_id,
    role: "admin",
    name: "Owner",
  };
  const finance: Context = {
    tenantId: tenant,
    userId: member("finance").user_id,
    role: "finance",
    name: "Accountant",
  };
  const rep: Context = {
    tenantId: tenant,
    userId: member("sales").user_id,
    role: "sales",
    name: "Rep",
  };
  const run = (who: Context, c: Row) =>
    inTenant(db, who, (tx) =>
      c.action.startsWith("collection.")
        ? executeCollection(tx, who, c)
        : c.action.startsWith("document.")
          ? executeDocument(tx, who, c)
          : execute(tx, who, c),
    );
  const read = (sql: string, params: unknown[] = []) =>
    inTenant(db, tenant, async (tx) => (await tx.query(sql, params)).rows);
  const entities = await read("SELECT id,code FROM entities ORDER BY code");
  const entity = entities[0].id,
    otherEntity = entities[1].id;
  const customer = (
    await run(admin, {
      action: "company.create",
      name: `Slow payer ${uuid().slice(0, 8)}`,
      domain: "",
      industry: "",
      tax_id: "",
      address: "",
      customer: true,
      vendor: false,
      service_entity_id: null,
    })
  ).id as string;
  const details = {
    subject: "",
    reference: "",
    purchase_order: "",
    billing_address: "",
    shipping_address: "",
    customer_tax_id: "",
    attention: "",
    payment_terms: "",
    customer_notes: "",
    inclusions: "",
    exclusions: "",
    delivery_schedule: "",
    payment_schedule: "",
    payment_instructions: "",
    custom_fields: [],
  };
  const draft = async (over: Row = {}) =>
    (
      await run(admin, {
        action: "document.invoice-create",
        entity_id: entity,
        company_id: customer,
        issue_date: "2026-08-01",
        due_date: "2026-08-31",
        currency: "PKR",
        fx: "1",
        lines: [
          {
            description: "Work",
            quantity: "1",
            price: "100000",
            tax: "0",
            unit: "",
            section: "",
          },
        ],
        billing_kind: "earned",
        label: "Work",
        terms: "",
        details,
        request_key: uuid(),
        ...over,
      })
    ).id as string;
  const invoice = await draft();
  await run(admin, { action: "invoice.issue", id: invoice });
  const contact = (over: Row = {}) => ({
    action: "collection.contact",
    entity_id: entity,
    company_id: customer,
    invoice_id: invoice,
    kind: "Call",
    summary: "Spoke to accounts; payment run is Friday.",
    contacted_on: "2026-09-10",
    promise_date: null,
    promise_amount: null,
    next_action: "",
    next_action_due: null,
    assignee_id: null,
    request_key: uuid(),
    ...over,
  });

  await t.test(
    "a contact lands on the customer timeline with its promise and next action",
    async () => {
      await assert.rejects(run(rep, contact()), status(403));
      await assert.rejects(
        run(finance, contact({ promise_date: "2026-09-12" })),
        /both a date and an amount/,
      );
      await assert.rejects(
        run(
          finance,
          contact({ promise_date: "2026-09-01", promise_amount: "100000" }),
        ),
        /before the contact/,
      );
      await assert.rejects(
        run(finance, contact({ next_action: "Call back" })),
        /due date and someone responsible/,
      );
      // Only active finance or administrator members with access to the entity.
      await assert.rejects(
        run(
          finance,
          contact({
            next_action: "Call back",
            next_action_due: "2026-09-15",
            assignee_id: rep.userId,
          }),
        ),
        status(409),
      );
      await db.query(
        "UPDATE memberships SET entity_ids=$3 WHERE tenant_id=$1 AND user_id=$2",
        [tenant, finance.userId, [otherEntity]],
      );
      await assert.rejects(
        run(
          admin,
          contact({
            next_action: "Call back",
            next_action_due: "2026-09-15",
            assignee_id: finance.userId,
          }),
        ),
        /cannot open this legal entity/,
      );
      await db.query(
        "UPDATE memberships SET entity_ids=NULL WHERE tenant_id=$1 AND user_id=$2",
        [tenant, finance.userId],
      );
      const c = contact({
        promise_date: "2026-09-12",
        promise_amount: "100000",
        next_action: "Confirm receipt",
        next_action_due: "2026-09-13",
        assignee_id: finance.userId,
      });
      const { id } = await run(finance, c);
      assert.equal((await run(finance, c)).id, id);
      await assert.rejects(
        run(finance, { ...c, summary: "Changed" }),
        status(409),
      );
      const saved = (
        await read("SELECT * FROM collection_contacts WHERE id=$1", [id])
      )[0];
      const activity = (
        await read("SELECT * FROM crm_activities WHERE id=$1", [
          saved.activity_id,
        ])
      )[0];
      assert.equal(activity.record_type, "company");
      assert.equal(activity.record_id, customer);
      assert.match(activity.body, /Promised 100000 PKR by 2026-09-12/);
      const task = (
        await read("SELECT * FROM crm_tasks WHERE id=$1", [saved.task_id])
      )[0];
      assert.equal(task.assignee_id, finance.userId);
      assert.equal(task.title, "Confirm receipt");
      // A second contact reuses nothing: the timeline keeps both.
      assert.equal(
        (
          await read(
            "SELECT count(*)::int AS n FROM audit_events WHERE action='collection.contact' AND record_id=$1",
            [invoice],
          )
        )[0].n,
        1,
      );
      // An invoice from another customer cannot be attached to this one.
      const stranger = (
        await run(admin, {
          action: "company.create",
          name: `Other ${uuid().slice(0, 8)}`,
          domain: "",
          industry: "",
          tax_id: "",
          address: "",
          customer: true,
          vendor: false,
          service_entity_id: null,
        })
      ).id;
      await assert.rejects(
        run(finance, contact({ company_id: stranger })),
        /different customer or legal entity/,
      );
    },
  );

  let schedule = "";
  await t.test(
    "reminder schedules are versioned and reminders are manual follow-ups",
    async () => {
      const save = (who: Context, version: number, steps: Row[]) =>
        run(who, {
          action: "collection.schedule-save",
          entity_id: entity,
          name: "Standard",
          pause_on_promise: true,
          steps,
          version,
        });
      const steps = [
        {
          key: "due",
          offset_days: 0,
          subject: "Invoice due today",
          body: "Friendly reminder.",
        },
        {
          key: "late-7",
          offset_days: 7,
          subject: "One week overdue",
          body: "",
        },
        {
          key: "late-60",
          offset_days: 60,
          subject: "Two months overdue",
          body: "",
        },
      ];
      await assert.rejects(save(finance, 0, steps), status(403));
      await assert.rejects(
        save(admin, 0, [steps[0], { ...steps[1], offset_days: 0 }]),
        /same day/,
      );
      await save(admin, 0, [steps[0]]);
      await assert.rejects(save(admin, 0, steps), status(409));
      schedule = (await save(admin, 1, steps)).id;
      assert.deepEqual(
        (
          await read(
            "SELECT version FROM reminder_schedules WHERE entity_id=$1 ORDER BY version",
            [entity],
          )
        ).map((r) => r.version),
        [1, 2],
      );
      const follow = (over: Row = {}) => ({
        action: "collection.followup",
        invoice_id: invoice,
        step_key: "late-7",
        outcome: "Done manually",
        note: "Emailed the statement by hand.",
        date: "2026-09-10",
        ...over,
      });
      await assert.rejects(
        run(finance, follow({ step_key: "missing" })),
        status(409),
      );
      await assert.rejects(
        run(finance, follow({ step_key: "late-60" })),
        /not due yet/,
      );
      await assert.rejects(run(rep, follow()), status(403));
      const { id } = await run(finance, follow());
      assert.equal((await run(finance, follow())).id, id);
      await assert.rejects(
        run(finance, follow({ note: "Different" })),
        status(409),
      );
      const event = (
        await read(
          "SELECT details FROM audit_events WHERE action='collection.followup' AND record_id=$1",
          [invoice],
        )
      )[0];
      assert.match(JSON.stringify(event.details), /did not send a message/);
    },
  );

  await t.test(
    "a dispute pauses reminders, assigns an owner and closes its task when resolved",
    async () => {
      const open = (over: Row = {}) => ({
        action: "collection.dispute-open",
        invoice_id: invoice,
        reason: "Customer says deliverable two was not received.",
        amount: "40000",
        owner_id: finance.userId,
        date: "2026-09-11",
        request_key: uuid(),
        ...over,
      });
      await assert.rejects(
        run(finance, open({ amount: "100000.01" })),
        /within the invoice balance/,
      );
      await assert.rejects(
        run(finance, open({ owner_id: rep.userId })),
        status(409),
      );
      const { id } = await run(finance, open());
      await assert.rejects(run(finance, open()), /already has an open dispute/);
      const d = (
        await read("SELECT * FROM invoice_disputes WHERE id=$1", [id])
      )[0];
      const task = async () =>
        (await read("SELECT * FROM crm_tasks WHERE id=$1", [d.task_id]))[0];
      assert.equal((await task()).priority, "High");
      assert.equal((await task()).assignee_id, finance.userId);
      // While disputed, a reminder can be skipped but not recorded as done.
      await run(admin, {
        action: "collection.schedule-save",
        entity_id: entity,
        name: "Standard",
        pause_on_promise: true,
        version: 2,
        steps: [
          {
            key: "due",
            offset_days: 0,
            subject: "Invoice due today",
            body: "",
          },
          {
            key: "late-7",
            offset_days: 7,
            subject: "One week overdue",
            body: "",
          },
          {
            key: "late-10",
            offset_days: 10,
            subject: "Ten days overdue",
            body: "",
          },
        ],
      });
      await assert.rejects(
        run(finance, {
          action: "collection.followup",
          invoice_id: invoice,
          step_key: "late-10",
          outcome: "Done manually",
          note: "",
          date: "2026-09-12",
        }),
        /paused while this invoice is disputed/,
      );
      await run(finance, {
        action: "collection.followup",
        invoice_id: invoice,
        step_key: "late-10",
        outcome: "Skipped",
        note: "In dispute",
        date: "2026-09-12",
      });
      await assert.rejects(
        run(finance, {
          action: "collection.dispute-resolve",
          id,
          resolution: "Redelivered",
          date: "2026-09-10",
        }),
        /before it was opened/,
      );
      const resolve = {
        action: "collection.dispute-resolve",
        id,
        resolution: "Deliverable re-sent and accepted.",
        date: "2026-09-14",
      };
      const first = (await run(finance, resolve)).id;
      assert.equal((await run(finance, resolve)).id, first);
      await assert.rejects(
        run(finance, { ...resolve, resolution: "Other" }),
        status(409),
      );
      assert.equal((await task()).status, "Done");
      // A new dispute can be opened once the earlier one is resolved.
      await run(finance, open({ date: "2026-09-15" }));
    },
  );

  await t.test(
    "a blocking credit hold refuses new sales until it is released; a warning does not",
    async () => {
      const place = (mode: string, over: Row = {}) => ({
        action: "collection.hold-place",
        entity_id: entity,
        company_id: customer,
        mode,
        reason: "Three invoices over 60 days.",
        date: "2026-09-16",
        request_key: uuid(),
        ...over,
      });
      await assert.rejects(run(rep, place("block")), status(403));
      const warned = (await run(finance, place("warn"))).id;
      await assert.rejects(
        run(finance, place("block")),
        /already has a credit hold/,
      );
      const allowed = await draft({
        issue_date: "2026-09-17",
        due_date: "2026-10-17",
      });
      await run(admin, { action: "invoice.issue", id: allowed });
      await run(finance, {
        action: "collection.hold-release",
        id: warned,
        reason: "Replaced by a block",
        date: "2026-09-18",
      });
      const blocked = (
        await run(finance, place("block", { date: "2026-09-18" }))
      ).id;
      const refused = await draft({
        issue_date: "2026-09-19",
        due_date: "2026-10-19",
      });
      await assert.rejects(
        run(admin, { action: "invoice.issue", id: refused }),
        /on credit hold in this legal entity/,
      );
      // The hold is per legal entity: the same customer can still be invoiced elsewhere.
      const elsewhere = await draft({
        entity_id: otherEntity,
        issue_date: "2026-09-19",
        due_date: "2026-10-19",
      });
      await run(admin, { action: "invoice.issue", id: elsewhere });
      await assert.rejects(
        run(finance, {
          action: "collection.hold-release",
          id: blocked,
          reason: "Paid",
          date: "2026-09-17",
        }),
        /before it was placed/,
      );
      await run(finance, {
        action: "collection.hold-release",
        id: blocked,
        reason: "Balance cleared.",
        date: "2026-09-20",
      });
      // Quotes are refused too, for whichever customer and entity the deal belongs to.
      const buyer = (
        await run(admin, {
          action: "contact.create",
          first_name: "Buyer",
          last_name: "",
          phone: "",
          title: "",
          source: "",
          notes: "",
          email: `buyer-${uuid()}@example.test`,
          company_id: customer,
          role: "Buyer",
        })
      ).id;
      const lead = (
        await run(admin, {
          action: "lead.create",
          company_id: customer,
          contact_id: buyer,
          entity_id: entity,
          title: "New work",
          source: "",
          next_action: "Send quote",
          due_date: "2026-10-01",
        })
      ).id;
      const deal = {
        id: (await run(admin, { action: "lead.convert", id: lead })).id,
        entity_id: entity,
        company_id: customer,
      };
      const quote = {
        action: "quote.create",
        deal_id: deal.id,
        option_name: "Option A",
        currency: "PKR",
        fx: "1",
        lines: [
          {
            description: "Work",
            quantity: "1",
            price: "1000",
            tax: "0",
            unit: "",
            section: "",
          },
        ],
        terms: "",
      };
      const dealHold = (
        await run(
          finance,
          place("block", {
            entity_id: deal.entity_id,
            company_id: deal.company_id,
            date: "2026-09-20",
          }),
        )
      ).id;
      await assert.rejects(
        run(admin, quote),
        /on credit hold in this legal entity/,
      );
      await run(finance, {
        action: "collection.hold-release",
        id: dealHold,
        reason: "Cleared.",
        date: "2026-09-21",
      });
      assert.ok((await run(admin, quote)).id);
      await run(admin, { action: "invoice.issue", id: refused });
      assert.equal(
        (await read("SELECT status FROM invoices WHERE id=$1", [refused]))[0]
          .status,
        "Issued",
      );
    },
  );

  await t.test(
    "history is append-only and limited to visible legal entities",
    async () => {
      for (const table of [
        "collection_contacts",
        "invoice_disputes",
        "customer_credit_holds",
        "reminder_schedules",
        "reminder_followups",
      ])
        await assert.rejects(
          inTenant(db, tenant, (tx) => tx.query(`DELETE FROM ${table}`)),
          table,
        );
      const full = await inTenant(db, admin, (tx) =>
        collectionSnapshot(tx, admin),
      );
      assert.ok(
        full.collectionContacts.length &&
          full.invoiceDisputes.length &&
          full.reminderFollowups.length,
      );
      assert.equal(
        full.reminderSchedules.find((s) => s.entity_id === entity)!.version,
        3,
      );
      assert.ok(schedule);
      const limited: Context = { ...finance, entityIds: [otherEntity] };
      const hidden = await inTenant(db, limited, (tx) =>
        collectionSnapshot(tx, limited),
      );
      assert.equal(hidden.collectionContacts.length, 0);
      assert.equal(hidden.invoiceDisputes.length, 0);
      assert.equal(hidden.creditHolds.length, 0);
      await assert.rejects(run(limited, contact()), status(404));
      // Sales reps see holds (so they are warned) but not collections detail.
      const sales = await inTenant(db, rep, (tx) =>
        collectionSnapshot(tx, rep),
      );
      assert.ok(sales.creditHolds.length);
      assert.equal(sales.collectionContacts.length, 0);
    },
  );
});
