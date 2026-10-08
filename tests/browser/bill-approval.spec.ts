import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("bill approval rules save by entity and survive refresh", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  await page.goto("/?view=bills");
  await page
    .getByRole("button", { name: "Approval rules", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("checkbox", {
      name: "Allow finance to approve within the limit below",
    })
    .check();
  await dialog
    .getByLabel("Finance approval limit (PKR)", { exact: true })
    .fill("125000.50");
  await dialog
    .getByRole("checkbox", {
      name: "Bill creators cannot approve their own bills",
    })
    .check();
  await dialog.getByRole("button", { name: "Save approval rules" }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Approval rules", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Finance approval limit (PKR)", { exact: true }),
  ).toHaveValue("125000.50");
  await expect(
    dialog.getByRole("checkbox", {
      name: "Bill creators cannot approve their own bills",
    }),
  ).toBeChecked();
  // Restore the compatibility policy so other sample workflows are independent.
  await dialog
    .getByRole("checkbox", {
      name: "Allow finance to approve within the limit below",
    })
    .uncheck();
  await dialog
    .getByRole("checkbox", {
      name: "Bill creators cannot approve their own bills",
    })
    .uncheck();
  await dialog.getByRole("button", { name: "Save approval rules" }).click();
  await expect(dialog).not.toBeVisible();
});

test("review queues explain self-review restrictions and update when policy changes", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const me = await (await page.request.get("/api/me")).json();
  const data = await (await page.request.get("/api/data")).json();
  const entity = data.entities[0];
  const command = async (payload: Record<string, unknown>) => {
    const response = await page.request.post("/api/commands", {
      headers: { origin: "http://127.0.0.1:4322", "x-csrf-token": me.csrf },
      data: payload,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const vendor = await command({
    action: "company.create",
    name: `Review vendor ${randomUUID()}`,
    vendor: true,
    customer: false,
    service_entity_id: null,
  });
  const reference = `Review-${randomUUID()}`;
  const bill = await command({
    action: "bill.create",
    entity_id: entity.id,
    vendor_id: vendor.id,
    deal_id: null,
    reference,
    bill_date: "2030-01-01",
    due_date: "2030-01-31",
    currency: "PKR",
    fx: "1",
    lines: [
      {
        description: "Reviewable service",
        quantity: "1",
        price: "100",
        tax: "0",
        account_code: "5000",
      },
    ],
    tax_treatment: "expense",
    request_key: randomUUID(),
    notes: "",
  });
  await command({ action: "bill.submit", id: bill.id, version: 1 });
  await command({
    action: "bill.approval-policy",
    entity_id: entity.id,
    version: entity.bill_approval_version,
    finance_limit: null,
    separate_approver: true,
  });
  await page.goto("/?view=bills");
  await page.getByLabel("Search bills", { exact: true }).fill(reference);
  await page
    .getByRole("button", { name: /^Waiting for another reviewer/ })
    .click();
  await expect(
    page.getByRole("link", { name: reference, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Ready for my review/ }).click();
  await expect(
    page.getByRole("link", { name: reference, exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: /^Waiting for another reviewer/ })
    .click();
  await page.getByRole("link", { name: reference, exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Bill review status" }),
  ).toContainText("A different person must review this bill");
  await expect(
    page.getByRole("button", { name: "Approve & post", exact: true }),
  ).toHaveCount(0);
  await command({
    action: "bill.approval-policy",
    entity_id: entity.id,
    version: entity.bill_approval_version + 1,
    finance_limit: null,
    separate_approver: false,
  });
  await page.goto("/?view=bills");
  await page.getByLabel("Search bills", { exact: true }).fill(reference);
  await page.getByRole("button", { name: /^Ready for my review/ }).click();
  await expect(
    page.getByRole("link", { name: reference, exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: reference, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Approve & post", exact: true }),
  ).toBeVisible();
});

test("two-stage review passes from finance to a different administrator before posting", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const owner = await (await page.request.get("/api/me")).json();
  let me = owner;
  const data = await (await page.request.get("/api/data")).json();
  const entity = data.entities[0];
  const command = async (payload: Record<string, unknown>) => {
    const response = await page.request.post("/api/commands", {
      headers: { origin: "http://127.0.0.1:4322", "x-csrf-token": me.csrf },
      data: payload,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  await command({
    action: "bill.approval-policy",
    entity_id: entity.id,
    version: entity.bill_approval_version,
    finance_limit: null,
    separate_approver: false,
    two_stage: true,
  });
  const vendor = await command({
    action: "company.create",
    name: `Two-stage ${randomUUID()}`,
    vendor: true,
    customer: false,
    service_entity_id: null,
  });
  const bill = await command({
    action: "bill.create",
    entity_id: entity.id,
    vendor_id: vendor.id,
    deal_id: null,
    reference: `Stage-${randomUUID()}`,
    bill_date: "2030-02-01",
    due_date: "2030-02-28",
    currency: "PKR",
    fx: "1",
    lines: [
      {
        description: "Reviewed cost",
        quantity: "1",
        price: "100",
        tax: "0",
        account_code: "5000",
      },
    ],
    tax_treatment: "expense",
    request_key: randomUUID(),
    notes: "",
  });
  await command({ action: "bill.submit", id: bill.id, version: 1 });
  const accounts = await (await page.request.get("/api/demo-accounts")).json();
  const finance = accounts.find(
    (a: any) => a.tenant_id === owner.organization.id && a.role === "finance",
  );
  const login = async (userId: string) => {
    const response = await page.request.post("/api/demo-login", {
      headers: { origin: "http://127.0.0.1:4322" },
      data: { tenantId: owner.organization.id, userId },
    });
    expect(response.ok()).toBeTruthy();
    me = await (await page.request.get("/api/me")).json();
    // A hash-only navigation would retain the prior user's query cache after
    // this test-only API sign-in. A full document navigation loads fresh identity.
    await page.goto(`/?view=bill/${bill.id}`);
  };
  await login(finance.user_id);
  await page
    .getByRole("button", { name: "Complete first review", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Bill review status" }),
  ).toContainText("A different administrator must give final approval");
  await expect(
    page.getByRole("button", { name: "Approve & post", exact: true }),
  ).toHaveCount(0);
  let snapshot = await (await page.request.get("/api/data")).json();
  expect(snapshot.bills.find((b: any) => b.id === bill.id).status).toBe(
    "Pending approval",
  );
  await login(owner.user.id);
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Approve & post", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Record vendor payment", exact: true }),
  ).toBeVisible();
  snapshot = await (await page.request.get("/api/data")).json();
  const posted = snapshot.bills.find((b: any) => b.id === bill.id);
  expect(posted.status).toBe("Open");
  expect(posted.reviewed_by).toBe(finance.user_id);
  expect(posted.approved_by).toBe(owner.user.id);
  await expect(
    page.getByRole("heading", { name: "Approval history", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("First review completed — not posted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Final approval — posted to books", { exact: true }),
  ).toBeVisible();
  const trail = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Approval history", exact: true }),
  });
  await expect(trail).toContainText(finance.name);
  await expect(trail).toContainText(owner.user.name);
  await command({
    action: "bill.approval-policy",
    entity_id: entity.id,
    version: snapshot.entities.find((e: any) => e.id === entity.id)
      .bill_approval_version,
    finance_limit: null,
    separate_approver: false,
    two_stage: false,
  });
});
