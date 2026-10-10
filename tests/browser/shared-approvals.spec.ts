import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID as uuid } from "node:crypto";

test("shared approval settings recover drafts; PO submits, reviews and issues with saved reviewers", async ({
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
  const command = async (data: unknown) => {
    const r = await page.request.post("/api/commands", {
      headers: {
        origin: `http://127.0.0.1:${process.env.GV_BROWSER_PORT || 4322}`,
        "x-csrf-token": me.csrf,
      },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const name = `Review entity ${uuid().slice(0, 8)}`;
  const entity = await command({
    action: "entity.create",
    name,
    code: `R${uuid().slice(0, 6).toUpperCase()}`,
    address: "Fictional office",
    tax_id: "",
  });
  await page.goto("/?view=approval-workflows");
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption(entity.id);
  await page
    .getByLabel("Document type", { exact: true })
    .selectOption("purchase-order");
  await page.getByLabel("Step 1 name", { exact: true }).fill("Owner release");
  await page
    .getByRole("checkbox", { name: "Administrators", exact: true })
    .uncheck();
  await page
    .getByRole("checkbox", { name: "Owner · person", exact: true })
    .check();
  await page
    .getByRole("checkbox", {
      name: "Exclude the document creator from every step",
    })
    .uncheck();
  await expect(
    page.getByRole("status").filter({ hasText: "Unsaved changes retained" }),
  ).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.reload();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption(entity.id);
  await page
    .getByLabel("Document type", { exact: true })
    .selectOption("purchase-order");
  await expect(page.getByLabel("Step 1 name", { exact: true })).toHaveValue(
    "Owner release",
  );
  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved rules · version 1" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const vendor = await command({
    action: "company.create",
    name: `Review vendor ${uuid()}`,
    vendor: true,
    customer: false,
    service_entity_id: null,
  });
  const order = await command({
    action: "purchase-order.create",
    entity_id: entity.id,
    vendor_id: vendor.id,
    deal_id: null,
    order_date: "2030-04-01",
    delivery_date: null,
    currency: "PKR",
    fx: "1",
    lines: [
      {
        description: "Fictional approval delivery",
        quantity: "1",
        price: "100",
        tax: "0",
        account_code: "5000",
      },
    ],
    tax_treatment: "expense",
    request_key: uuid(),
  });
  await page.goto(`/?view=purchase-orders#purchase-orders/${order.id}`);
  await page
    .getByRole("button", { name: "Submit for approval", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Approval steps · Pending" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Issue purchase order", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Review & issue", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Final approval — issue purchase order",
    }),
  ).toBeVisible();
  await page
    .getByLabel("Review note (optional)", { exact: true })
    .fill("Reviewed fictional order");
  await page
    .getByRole("button", { name: "Approve & issue", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Convert to bill", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Approval steps · Approved" }),
  ).toBeVisible();
  await expect(
    page.getByText("Owner — Approved: Reviewed fictional order", {
      exact: true,
    }),
  ).toBeVisible();
});
