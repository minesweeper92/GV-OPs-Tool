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
  await t.test(
    "inline company creation retries are idempotent, scoped and audited once",
    async () => {
      const payload = {
        action: "company.create",
        name: "Inline company",
        domain: "inline.example.test",
        customer: false,
        vendor: false,
        service_entity_id: null,
        request_key: uuid(),
      };
      const first = await cmd(payload);
      const retry = await cmd(payload);
      assert.equal(first.id, retry.id);
      await cmd({ ...payload, name: "Different company" }, 409);
      await read("/api/commands", payload, 403);
      await rep("/api/commands", payload, 409);
      const snapshot = await data();
      assert.equal(
        snapshot.companies.filter((c: any) => c.name === payload.name).length,
        1,
      );
      assert.equal(
        snapshot.events.filter(
          (e: any) => e.record_id === first.id && e.action === "company.create",
        ).length,
        1,
      );
      const salesPayload = {
        ...payload,
        request_key: uuid(),
        name: "Sales inline company",
      };
      const owned = await rep("/api/commands", salesPayload);
      assert.equal((await rep("/api/commands", salesPayload)).id, owned.id);
      const person = await rep("/api/commands", {
        action: "contact.create",
        first_name: "Inline contact",
        company_id: owned.id,
        role: "Director",
        email: "",
      });
      assert.ok(
        (await data()).affiliations.some(
          (a: any) => a.contact_id === person.id && a.company_id === owned.id,
        ),
      );
    },
  );
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
      assert.match(
        (await data()).quotes.find((q: any) => q.id === quote).number,
        /^QT-\d{6}$/,
      );
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
  await t.test(
    "full profiles create without a company, persist typed fields and reject stale or inaccessible edits",
    async () => {
      const create = {
        ...edit,
        action: "profile.contact",
        id: undefined,
        version: undefined,
        first_name: "Independent",
        email: "independent@crm.test",
        additional_emails: [],
        company_id: null,
        owner_id: admin,
        profile: {
          department: "Marketing",
          preferred_channel: "Email",
          timezone: "Asia/Karachi",
          location: { city: "Lahore" },
          custom_fields: [{ label: "Client tier", type: "Text", value: "A" }],
        },
      };
      const id = (await cmd(create)).id;
      let d = await data(),
        c = d.contacts.find((r: any) => r.id === id);
      assert.equal(c.profile.department, "Marketing");
      assert.equal(c.profile.location.city, "Lahore");
      assert.equal(c.additional_phones.length, 1);
      assert.equal(
        d.affiliations.filter((r: any) => r.contact_id === id).length,
        0,
      );
      const updated = {
        ...create,
        id,
        version: c.version,
        profile: { ...create.profile, department: "Production" },
      };
      await cmd(updated);
      await cmd(updated, 409);
      await read("/api/commands", create, 403);
      await rep("/api/commands", { ...updated, version: c.version + 2 }, 404);
      await cmd(
        {
          ...create,
          email: "bad@crm.test",
          profile: { timezone: "Not/a_timezone" },
        },
        400,
      );
      await cmd(
        {
          ...create,
          email: "bad@crm.test",
          profile: {
            custom_fields: [{ label: "Number", type: "Number", value: "abc" }],
          },
        },
        400,
      );
      await cmd(
        {
          ...create,
          email: "bad@crm.test",
          profile: {
            custom_fields: [
              { label: "A", type: "Text", value: "1" },
              { label: "a", type: "Text", value: "2" },
            ],
          },
        },
        400,
      );
      d = await data();
      assert.ok(!d.contacts.some((c: any) => c.email === "bad@crm.test"));
      await cmd({ ...updated, version: c.version + 2, owner_id: uuid() }, 400);
    },
  );
  await t.test(
    "company defaults and entity registrations persist; commercial context carries through qualification",
    async () => {
      const companyCommand = {
        action: "profile.company",
        owner_id: admin,
        name: "Profile customer",
        trading_name: "",
        domain: "",
        industry: "",
        size: "",
        tax_id: "QA-TAX",
        address: "Billing QA",
        shipping_address: "Delivery QA",
        customer: true,
        vendor: false,
        service_entity_id: null,
        profile: {
          currency: "USD",
          payment_days: 45,
          credit_limit: "5000",
          billing_recipients: ["accounts@crm.test"],
          registrations: [
            {
              entity_id: entity,
              code: "V-123",
              status: "Active",
              instructions: "PO required",
              reference_url: "https://example.test/registration",
            },
          ],
        },
      };
      const co = (await cmd(companyCommand)).id;
      let d = await data(),
        companyRecord = d.companies.find((c: any) => c.id === co);
      assert.equal(companyRecord.profile.payment_days, 45);
      assert.equal(companyRecord.profile.registrations[0].code, "V-123");
      await cmd(
        {
          ...companyCommand,
          id: co,
          version: companyRecord.version,
          profile: { parent_company_id: co },
        },
        400,
      );
      await cmd(
        {
          ...companyCommand,
          id: co,
          version: companyRecord.version,
          profile: {
            registrations: [
              ...companyCommand.profile.registrations,
              ...companyCommand.profile.registrations,
            ],
          },
        },
        400,
      );
      const person = (
        await cmd({
          action: "contact.create",
          first_name: "Project buyer",
          email: "",
          company_id: co,
          role: "Buyer",
        })
      ).id;
      const leadCommand = {
        action: "profile.lead",
        owner_id: admin,
        company_id: co,
        contact_id: person,
        entity_id: entity,
        title: "Full project",
        source: "Referral",
        status: "Connected",
        next_action: "Discuss proposal",
        due_date: "2026-10-01",
        reason: "",
        profile: {
          brief: "Brand film",
          estimated_value: "12500",
          currency: "USD",
          end_client_id: company,
          stakeholders: [{ contact_id: person, role: "Approver" }],
          decision_process: "Board review",
          custom_fields: [{ label: "Shoot days", type: "Number", value: "3" }],
        },
      };
      const le = (await cmd(leadCommand)).id;
      const lr = (await data()).leads.find((l: any) => l.id === le);
      await cmd(
        { ...leadCommand, id: le, version: lr.version, company_id: company },
        409,
      );
      const converted = (await cmd({ action: "lead.convert", id: le })).id;
      const dr = (await data()).deals.find((d: any) => d.id === converted);
      assert.equal(dr.profile.brief, "Brand film");
      assert.equal(dr.profile.stakeholders[0].contact_id, person);
      await cmd({
        action: "profile.deal",
        id: converted,
        version: dr.version,
        owner_id: admin,
        name: "Full project revised",
        profile: { ...dr.profile, priority: "High" },
      });
      await cmd(
        {
          action: "profile.deal",
          id: converted,
          version: dr.version,
          owner_id: admin,
          name: "Stale",
          profile: {},
        },
        409,
      );
    },
  );
  await t.test(
    "direct invoice snapshots, discounts, retry protection, draft versions, credits and ledger agree",
    async () => {
      const details = {
        purchase_order: "PO-100",
        billing_address: "Frozen address",
        custom_fields: [{ label: "Campaign", type: "Text", value: "Launch" }],
      };
      const c = {
        action: "document.invoice-create",
        entity_id: entity,
        company_id: company,
        issue_date: "2026-09-01",
        due_date: "2026-10-01",
        currency: "PKR",
        fx: "1",
        billing_kind: "earned",
        label: "Standalone web work",
        terms: "QA terms",
        details,
        lines: [
          {
            description: "Design",
            quantity: "2",
            price: "100",
            tax: "18",
            unit: "days",
            section: "Creative",
            discount_type: "percent",
            discount: "10",
          },
        ],
        request_key: uuid(),
      };
      await rep("/api/commands", c, 403);
      await read("/api/commands", c, 403);
      await cmd({ ...c, company_id: uuid() }, 404);
      await cmd({ ...c, lines: [{ ...c.lines[0], discount: "101" }] }, 400);
      const id = (await cmd(c)).id;
      assert.equal((await cmd(c)).id, id);
      await cmd({ ...c, label: "Changed" }, 409);
      let i = (await data()).invoices.find((i: any) => i.id === id);
      assert.equal(i.deal_id, null);
      assert.equal(i.quote_id, null);
      assert.equal(i.net_minor, "18000");
      assert.equal(i.tax_minor, "3240");
      assert.equal(i.total_minor, "21240");
      assert.equal(i.lines[0].discountMinor, "2000");
      assert.equal(i.company_id, company);
      assert.equal(i.details.purchase_order, "PO-100");
      const change = {
        action: "document.invoice-edit",
        id,
        version: i.version,
        issue_date: "2026-09-02",
        due_date: "2026-10-02",
        terms: "Revised QA terms",
        details: { ...details, reference: "Updated before issue" },
      };
      await cmd(change);
      await cmd(change, 409);
      await cmd({ action: "invoice.issue", id });
      i = (await data()).invoices.find((i: any) => i.id === id);
      await cmd({ ...change, version: i.version }, 409);
      await assert.rejects(
        () =>
          inTenant(db, tenant, (tx) =>
            tx.query("UPDATE invoices SET details='{}' WHERE id=$1", [id]),
          ),
        /immutable/,
      );
      const ledger = await inTenant(db, tenant, (tx) =>
        tx.query(
          "SELECT account_code,debit_minor,credit_minor FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_id=$1",
          [id],
        ),
      );
      assert.equal(
        ledger.rows.find((r) => r.account_code === "1100")?.debit_minor,
        "21240",
      );
      assert.equal(
        ledger.rows.find((r) => r.account_code === "4000")?.credit_minor,
        "18000",
      );
      const credit = (
        await cmd({
          action: "credit.create",
          invoice_id: id,
          date: "2026-09-03",
          lines: [{ index: 0, amount: "20" }],
          treatment: "earned",
          reason: "QA credit",
          request_key: uuid(),
        })
      ).id;
      assert.ok((await data()).credits.some((c: any) => c.id === credit));
      await cmd({
        action: "payment.create",
        invoice_id: id,
        date: "2026-09-04",
        amount: "10",
        wht: "0",
        fx: "1",
        reference: "QA payment",
        request_key: uuid(),
      });
      assert.equal(
        (await data()).invoices.find((i: any) => i.id === id).paid_minor,
        "1000",
      );
      const reports = await call(
        `/api/financial-reports?entityId=${entity}&from=2026-09-01&to=2026-09-30`,
      );
      assert.equal(reports.receivables.difference, "0");
      assert.equal(
        reports.receivables.documents.find((d: any) => d.id === id).outstanding,
        "20240",
      );
      assert.equal(
        (await rep("/api/data")).invoices.some((i: any) => i.id === id),
        false,
      );
      assert.equal(
        (
          await inTenant(db, outsider, (tx) =>
            tx.query("SELECT * FROM invoices WHERE id=$1", [id]),
          )
        ).rows.length,
        0,
      );
    },
  );
  await t.test(
    "saved items stay tenant-scoped and discounted quote versions preserve scope through partial invoicing",
    async () => {
      const line = {
        description: "Production",
        quantity: "2",
        price: "100",
        tax: "18",
        unit: "days",
        section: "Production",
        discount_type: "amount",
        discount: "10",
      };
      const itemCommand = {
        action: "document.item-save",
        name: "Production day",
        currency: "PKR",
        line,
        request_key: uuid(),
      };
      const item = (await cmd(itemCommand)).id;
      assert.equal((await cmd(itemCommand)).id, item);
      await cmd({ ...itemCommand, name: "Other" }, 409);
      await read("/api/commands", itemCommand, 403);
      await rep(
        "/api/commands",
        { action: "document.item-archive", id: item },
        403,
      );
      assert.equal(
        (
          await inTenant(db, outsider, (tx) =>
            tx.query("SELECT * FROM catalog_items"),
          )
        ).rows.length,
        0,
      );
      const current = (await data()).deals.find(
        (d: any) => d.name === "Full project revised",
      );
      const q = {
        action: "quote.create",
        deal_id: current.id,
        option_name: "Director A",
        currency: "PKR",
        fx: "1",
        lines: [line],
        details: {
          quote_date: "2026-09-01",
          valid_until: "2026-10-01",
          purchase_order: "FROZEN-PO",
          inclusions: "One film",
        },
      };
      await cmd(
        { ...q, details: { ...q.details, valid_until: "2026-08-01" } },
        400,
      );
      const quote = (await cmd(q)).id;
      await cmd({
        action: "quote.accept",
        id: quote,
        reference: "QA acceptance",
      });
      const invoice = (
        await cmd({
          action: "invoice.create",
          quote_id: quote,
          issue_date: "2026-09-01",
          due_date: "2026-10-01",
          amount: "90",
          request_key: uuid(),
        })
      ).id;
      const i = (await data()).invoices.find((i: any) => i.id === invoice);
      assert.equal(i.net_minor, "9000");
      assert.equal(i.tax_minor, "1620");
      assert.equal(i.details.purchase_order, "FROZEN-PO");
      assert.equal(i.lines[0].section, "Production");
      assert.equal(i.lines[0].price, "90.00");
      assert.equal(i.lines[0].discount, "0");
      await cmd({ action: "document.item-archive", id: item });
      assert.ok(!(await data()).catalogItems.some((x: any) => x.id === item));
      assert.equal(
        (await data()).quotes.find((x: any) => x.id === quote).lines[0].price,
        "100",
      );
      const direct = (
        await cmd({
          action: "document.invoice-create",
          entity_id: entity,
          company_id: company,
          issue_date: "2026-09-01",
          due_date: "2026-10-01",
          currency: "PKR",
          fx: "1",
          billing_kind: "advance",
          label: "Deposit",
          terms: "",
          details: {},
          lines: [line],
          request_key: uuid(),
        })
      ).id;
      await cmd({ action: "invoice.issue", id: direct });
      await cmd({
        action: "invoice.recognise",
        id: direct,
        date: "2026-09-05",
        amount: "50",
        reference: "Delivered",
        request_key: uuid(),
      });
      assert.equal(
        (await data()).recognitions.find((r: any) => r.invoice_id === direct)
          .net_minor,
        "5000",
      );
    },
  );
}
