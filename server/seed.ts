import { randomUUID as uuid } from "node:crypto";
import type { Database } from "./db.ts";
import { execute, seedAccounts, type Context } from "./domain.ts";
export async function seed(db: Database) {
  await db.transaction(async (tx) => {
    if ((await tx.query("SELECT id FROM tenants LIMIT 1")).rows.length) return;
    const tenantId = uuid(),
      otherTenant = uuid(),
      admin = uuid(),
      sales = uuid(),
      finance = uuid(),
      viewer = uuid(),
      pvt = uuid(),
      aop = uuid();
    await tx.query("INSERT INTO tenants(id,name) VALUES($1,$2),($3,$4)", [
      tenantId,
      "Grid Velocity · sample",
      otherTenant,
      "Separate organization · sample",
    ]);
    for (const [id, name, role] of [
      [admin, "Owner", "admin"],
      [sales, "Sales rep", "sales"],
      [finance, "Accountant", "finance"],
      [viewer, "Read-only reviewer", "viewer"],
    ]) {
      await tx.query("INSERT INTO users(id,name,email) VALUES($1,$2,$3)", [
        id,
        name,
        `${role}@example.test`,
      ]);
      await tx.query(
        "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
        [tenantId, id, role],
      );
    }
    await tx.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
      [otherTenant, admin, "admin"],
    );
    for (const [id, name, code, t] of [
      [pvt, "Sample Private Limited", "PVT", tenantId],
      [aop, "Sample Partnership", "AOP", tenantId],
      [uuid(), "Separate Sample Entity", "OTH", otherTenant],
    ]) {
      await tx.query(
        "INSERT INTO entities(id,tenant_id,name,code) VALUES($1,$2,$3,$4)",
        [id, t, name, code],
      );
      await seedAccounts(tx, t, id);
    }
    const ctx: Context = { tenantId, userId: sales, role: "admin" },
      company = await execute(tx, ctx, {
        action: "company.create",
        name: "Meridian Creative",
        domain: "meridian.example.test",
        industry: "Media",
        address: "Synthetic demonstration address",
        tax_id: "",
        customer: false,
        vendor: false,
        service_entity_id: pvt,
      });
    const contact = await execute(tx, ctx, {
      action: "contact.create",
      first_name: "Maya",
      last_name: "Noor",
      email: "maya@example.test",
      phone: "",
      title: "Marketing lead",
      source: "Referral",
      notes: "Synthetic sample contact.",
      company_id: company.id,
      role: "Decision maker",
    });
    const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const lead = await execute(tx, ctx, {
      action: "lead.create",
      company_id: company.id,
      contact_id: contact.id,
      entity_id: pvt,
      title: "Brand launch film",
      source: "Referral",
      next_action: "Discuss the production brief",
      due_date: due,
    });
    const deal = await execute(tx, ctx, {
      action: "lead.convert",
      id: lead.id,
    });
    await execute(tx, ctx, {
      action: "quote.create",
      deal_id: deal.id,
      option_name: "Studio production",
      currency: "PKR",
      fx: "1",
      lines: [
        {
          description: "Creative direction and production",
          quantity: "1",
          price: "250000",
          tax: "0",
        },
      ],
      terms: "Illustrative pricing only. Tax has not been configured.",
    });
    await execute(tx, ctx, {
      action: "lead.create",
      company_id: company.id,
      contact_id: contact.id,
      entity_id: aop,
      title: "Website refresh",
      source: "Existing relationship",
      next_action: "Confirm pages and delivery date",
      due_date: due,
    });
  });
}
