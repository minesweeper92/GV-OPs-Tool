import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import type { TestContext } from "node:test";
import { type Database, inTenant } from "../server/db.ts";
import { seedAccounts } from "../server/domain.ts";
import { createApp } from "../server/app.ts";
export async function verifyCrm(t: TestContext, db: Database) {
  const tenant = uuid(),
    entity = uuid(),
    admin = uuid(),
    sales = uuid(),
    finance = uuid(),
    viewer = uuid(),
    outsider = uuid();
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO tenants VALUES($1,'CRM QA'),($2,'CRM outsider')",
      [tenant, outsider],
    );
    for (const [id, role] of [
      [admin, "admin"],
      [sales, "sales"],
      [finance, "finance"],
      [viewer, "viewer"],
    ]) {
      await tx.query("INSERT INTO users VALUES($1,$2,$3)", [
        id,
        role,
        `${id}@example.test`,
      ]);
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [tenant, id, role],
      );
    }
    await tx.query(
      "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,'CRM entity','CRM')",
      [entity, tenant],
    );
    await seedAccounts(tx, tenant, entity);
  });
  const app = createApp(db, "http://127.0.0.1:4320");
  await app.ready();
  t.after(() => app.close());
  async function login(userId: string) {
    const headers = { host: "127.0.0.1:4320", origin: "http://127.0.0.1:4320" };
    const r = await app.inject({
      method: "POST",
      url: "/api/demo-login",
      headers,
      payload: { userId, tenantId: tenant },
    });
    const cookie = String(r.headers["set-cookie"]).split(";")[0],
      me = (
        await app.inject({ url: "/api/me", headers: { ...headers, cookie } })
      ).json();
    return async (
      url: string,
      payload?: Record<string, unknown>,
      status = 200,
    ) => {
      const r = await app.inject({
        method: payload ? "POST" : "GET",
        url,
        headers: { ...headers, cookie, "x-csrf-token": me.csrf },
        payload,
      });
      assert.equal(r.statusCode, status, r.body);
      return r.json();
    };
  }
  const call = await login(admin),
    rep = await login(sales),
    accountant = await login(finance),
    read = await login(viewer),
    cmd = (c: Record<string, unknown>, s = 200) => call("/api/commands", c, s),
    data = () => call("/api/data");
  const company = (
      await cmd({
        action: "company.create",
        name: "Original client",
        customer: true,
        vendor: false,
        service_entity_id: null,
      })
    ).id,
    contact = (
      await cmd({
        action: "contact.create",
        first_name: "Bob",
        company_id: company,
        role: "Director",
        email: "bob@crm.test",
      })
    ).id;
  const edit = {
    action: "crm.contact-edit",
    id: contact,
    version: 1,
    first_name: "Robert",
    last_name: "Ali",
    email: "bob@crm.test",
    phone: "+92 123",
    title: "Marketing director",
    source: "Referral",
    notes: "Prefers afternoon calls",
    lifecycle: "SQL",
    additional_emails: [{ label: "Work", value: "Robert@crm.test" }],
    additional_phones: [{ label: "Mobile", value: "+92 456" }],
    address: "Lahore",
    social_url: "https://example.test/robert",
    tags: ["Video", "Web"],
    currency: "USD",
    service_entity_id: entity,
    marketing_consent: "Opted out",
    consent_date: "2026-01-01",
    consent_source: "Asked by email",
  };
  await t.test(
    "editable rich contacts have version conflicts, canonical email uniqueness and consent validation",
    async () => {
      await cmd({ ...edit, consent_source: "" }, 400);
      await cmd({ ...edit, social_url: "javascript:alert(1)" }, 400);
      await cmd({ ...edit, social_url: "not a url" }, 400);
      await cmd({ ...edit, social_url: "" });
      await cmd(edit, 409);
      const c = (await data()).contacts.find((c: any) => c.id === contact);
      assert.equal(c.first_name, "Robert");
      assert.equal(c.version, 2);
      assert.equal(c.additional_emails[0].value, "robert@crm.test");
      assert.equal(c.service_entity_id, entity);
      assert.equal(c.marketing_consent, "Opted out");
      await cmd(
        {
          action: "contact.create",
          first_name: "Duplicate",
          company_id: company,
          role: "Buyer",
          email: "ROBERT@crm.test",
        },
        409,
      );
      await cmd(
        {
          ...edit,
          version: 2,
          additional_emails: [{ label: "Duplicate", value: "BOB@crm.test" }],
        },
        400,
      );
      const another = (
        await cmd({
          action: "contact.create",
          first_name: "Another",
          company_id: company,
          role: "Buyer",
          email: "other@crm.test",
        })
      ).id;
      await cmd(
        { ...edit, id: another, version: 1, email: "other@crm.test" },
        409,
      );
      await read("/api/commands", { ...edit, version: 2 }, 403);
      await rep("/api/commands", { ...edit, version: 2 }, 403);
      await accountant("/api/commands", {
        ...edit,
        version: 2,
        notes: "Finance updated",
      });
      assert.equal(
        (await data()).contacts.find((c: any) => c.id === contact).version,
        3,
      );
      assert.equal(
        (
          await inTenant(db, outsider, (tx) =>
            tx.query("SELECT * FROM contact_email_addresses"),
          )
        ).rows.length,
        0,
      );
    },
  );
  const lead = (
    await cmd({
      action: "lead.create",
      company_id: company,
      contact_id: contact,
      entity_id: entity,
      title: "Website brief",
      next_action: "Call client",
      due_date: "2026-01-02",
    })
  ).id;
  const update = {
    action: "crm.lead-edit",
    id: lead,
    version: 1,
    title: "Website project",
    source: "Referral",
    status: "Attempted",
    next_action: "Call again",
    due_date: "2026-01-03",
    reason: "",
  };
  let taskId: string, activityId: string, deal: string;
  await t.test(
    "qualification states close cleanly and reopen only with an action and date",
    async () => {
      await accountant("/api/commands", update, 403);
      await cmd(update);
      await cmd(update, 409);
      await cmd(
        { ...update, version: 2, status: "Disqualified", reason: "" },
        400,
      );
      await cmd({
        ...update,
        version: 2,
        status: "Disqualified",
        reason: "Timing not right",
        next_action: "",
        due_date: null,
      });
      let l = (await data()).leads.find((l: any) => l.id === lead);
      assert.equal(l.next_action, null);
      assert.equal(l.due_date, null);
      assert.equal(l.disqualified_reason, "Timing not right");
      await cmd({ action: "lead.convert", id: lead }, 409);
      await cmd(
        {
          ...update,
          version: 3,
          status: "Connected",
          next_action: "",
          due_date: null,
        },
        400,
      );
      await cmd({ ...update, version: 3, status: "Connected" });
      l = (await data()).leads.find((l: any) => l.id === lead);
      assert.equal(l.disqualified_reason, "");
    },
  );
  await t.test(
    "manual activity is immutable, safe linked and idempotent; tasks retain lead context after conversion",
    async () => {
      const c = {
        action: "crm.activity",
        record_type: "lead",
        record_id: lead,
        kind: "Email",
        subject: "Website brief received",
        body: "Client confirmed scope",
        occurred_at: "2026-01-02T10:00:00+05:00",
        outcome: "Ready to quote",
        reference_url: "https://outlook.office.com/mail/",
        request_key: uuid(),
      };
      activityId = (await cmd(c)).id;
      assert.equal((await cmd(c)).id, activityId);
      await cmd({ ...c, body: "Changed" }, 409);
      await cmd(
        { ...c, request_key: uuid(), occurred_at: "2099-01-01T00:00:00Z" },
        400,
      );
      await cmd({ ...c, request_key: uuid(), record_id: uuid() }, 404);
      await rep("/api/commands", { ...c, request_key: uuid() }, 403);
      const task = {
        action: "crm.task",
        record_type: "lead",
        record_id: lead,
        title: "Prepare estimate",
        notes: "Two director options",
        due_at: "2026-01-04T12:00:00+05:00",
        priority: "High",
        assignee_id: finance,
        request_key: uuid(),
      };
      taskId = (await cmd(task)).id;
      assert.equal((await cmd(task)).id, taskId);
      await cmd({ ...task, title: "Duplicate" }, 409);
      await cmd({ ...task, request_key: uuid(), assignee_id: sales }, 409);
      await cmd({ ...task, request_key: uuid(), assignee_id: viewer }, 409);
      deal = (await cmd({ action: "lead.convert", id: lead })).id;
      assert.equal((await cmd({ action: "lead.convert", id: lead })).id, deal);
      const d = await data();
      assert.equal(d.deals.find((d: any) => d.id === deal).lead_id, lead);
      assert.equal(
        d.crmActivities.find((a: any) => a.id === activityId).record_id,
        lead,
      );
      assert.equal(
        d.crmTasks.find((a: any) => a.id === taskId).record_id,
        lead,
      );
      assert.equal(d.leads.find((l: any) => l.id === lead).next_action, null);
      await cmd({ ...update, version: 5 }, 409);
      await assert.rejects(() =>
        inTenant(db, tenant, (tx) =>
          tx.query("UPDATE crm_activities SET body=$2 WHERE id=$1", [
            activityId,
            "Rewrite",
          ]),
        ),
      );
    },
  );
  await t.test(
    "task review is versioned, assignable only to accessible active members and audited on the parent",
    async () => {
      const c = {
        action: "crm.task-edit",
        id: taskId,
        version: 1,
        title: "Prepare estimate",
        notes: "Done",
        due_at: "2026-01-04T07:00:00Z",
        priority: "High",
        assignee_id: finance,
        status: "Done",
      };
      await accountant("/api/commands", c);
      await accountant("/api/commands", c, 409);
      let d = await data(),
        t = d.crmTasks.find((t: any) => t.id === taskId);
      assert.equal(t.status, "Done");
      assert.ok(t.completed_at);
      assert.ok(
        d.events.some(
          (e: any) => e.record_id === lead && e.action === "crm.task-edit",
        ),
      );
      await cmd({ ...c, version: 2, status: "Open" });
      t = (await data()).crmTasks.find((t: any) => t.id === taskId);
      assert.equal(t.completed_at, null);
      await db.query(
        "UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2",
        [tenant, finance],
      );
      await cmd({ ...c, version: 3 }, 409);
      await db.query(
        "UPDATE memberships SET active=true WHERE tenant_id=$1 AND user_id=$2",
        [tenant, finance],
      );
      const repData = await rep("/api/data");
      assert.equal(repData.crmActivities.length, 0);
      assert.equal(repData.crmTasks.length, 0);
      assert.deepEqual(
        repData.crmMembers.map((m: any) => m.id),
        [sales],
      );
      for (const table of ["crm_activities", "crm_tasks"])
        assert.equal(
          (
            await inTenant(db, outsider, (tx) =>
              tx.query(`SELECT * FROM ${table}`),
            )
          ).rows.length,
          0,
        );
    },
  );
  await t.test(
    "company and employer changes preserve quotes, financial identity and historical associations",
    async () => {
      const quote = (
        await cmd({
          action: "quote.create",
          deal_id: deal,
          option_name: "Website",
          currency: "PKR",
          fx: "1",
          lines: [
            { description: "Website", quantity: "1", price: "100", tax: "0" },
          ],
        })
      ).id;
      const editCompany = {
        action: "crm.company-edit",
        id: company,
        version: 1,
        name: "Renamed client",
        trading_name: "Client trading",
        domain: "example.test",
        industry: "Media",
        size: "20–50",
        tax_id: "QA",
        address: "New address",
        shipping_address: "Studio",
        customer: true,
        vendor: false,
        service_entity_id: entity,
      };
      await cmd(editCompany);
      await cmd(editCompany, 409);
      await cmd({ ...editCompany, version: 2, customer: false }, 409);
      const second = (
        await cmd({
          action: "company.create",
          name: "New employer",
          customer: true,
          vendor: false,
          service_entity_id: null,
        })
      ).id;
      const a = (await data()).affiliations.find(
        (a: any) => a.contact_id === contact,
      );
      await cmd({
        action: "contact.end-association",
        id: a.id,
        ended_on: a.started_on.slice(0, 10),
      });
      await cmd({
        action: "contact.associate",
        contact_id: contact,
        company_id: second,
        role: "Marketing director",
        work_email: "new@crm.test",
        started_on: a.started_on.slice(0, 10),
      });
      const d = await data();
      assert.equal(
        d.quotes.find((q: any) => q.id === quote).customer_name,
        "Original client",
      );
      assert.equal(d.deals.find((x: any) => x.id === deal).company_id, company);
      assert.equal(d.deals.find((x: any) => x.id === deal).entity_id, entity);
      assert.equal(
        d.affiliations.filter((a: any) => a.contact_id === contact).length,
        2,
      );
    },
  );
}
