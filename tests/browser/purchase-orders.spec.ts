import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

test("purchase order draft recovery, partial bill conversion and lost response retry", async ({
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
  const vendorResponse = await page.request.post("/api/commands", {
    headers: {
      origin: `http://127.0.0.1:${process.env.GV_BROWSER_PORT || 4322}`,
      "x-csrf-token": me.csrf,
    },
    data: {
      action: "company.create",
      name: `PO vendor ${randomUUID()}`,
      vendor: true,
      customer: false,
      service_entity_id: null,
    },
  });
  expect(vendorResponse.ok()).toBeTruthy();
  const vendor = (await vendorResponse.json()).id;
  await page.goto("/?view=purchase-orders");
  await page
    .getByRole("button", { name: "New purchase order", exact: true })
    .click();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption(data.entities[0].id);
  await page.getByLabel("Vendor", { exact: true }).selectOption(vendor);
  await page.getByLabel("Order date", { exact: true }).fill("2030-01-01");
  await page
    .getByLabel("description 1", { exact: true })
    .fill("Equipment hire");
  await page.getByLabel("quantity 1", { exact: true }).fill("10");
  await page.getByLabel("price 1", { exact: true }).fill("100");
  await page
    .getByRole("button", { name: "Keep draft and close", exact: true })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "New purchase order", exact: true })
    .click();
  await expect(page.getByLabel("description 1", { exact: true })).toHaveValue(
    "Equipment hire",
  );
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact || ""),
    ),
  ).toEqual([]);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Issue purchase order", exact: true }),
  ).toBeVisible();
  page.once("dialog", (d) => d.accept("Approved vendor order"));
  await page
    .getByRole("button", { name: "Issue purchase order", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Convert to bill", exact: true })
    .click();
  const reference = `PO-BILL-${randomUUID()}`;
  await page
    .getByLabel("Vendor bill reference", { exact: true })
    .fill(reference);
  await page.getByLabel("Bill date", { exact: true }).fill("2030-01-01");
  await page.getByLabel("Due date", { exact: true }).fill("2030-02-01");
  await page.getByLabel("Bill quantity 1", { exact: true }).fill("4");
  let intercepted = false;
  await page.route("**/api/commands", async (route) => {
    if (
      !intercepted &&
      route.request().postDataJSON().action === "purchase-order.bill"
    ) {
      intercepted = true;
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBeTruthy();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Create draft bill", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page
    .getByRole("button", { name: "Keep draft and close", exact: true })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "Convert to bill", exact: true })
    .click();
  await expect(
    page.getByLabel("Vendor bill reference", { exact: true }),
  ).toHaveValue(reference);
  await expect(page.getByLabel("Bill quantity 1", { exact: true })).toHaveValue(
    "4",
  );
  await page
    .getByRole("button", { name: "Create draft bill", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: reference, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit draft", exact: true }),
  ).toHaveCount(0);
  const saved = await (await page.request.get("/api/data")).json();
  expect(
    saved.bills.filter((b: any) => b.reference === reference),
  ).toHaveLength(1);
  await page
    .getByRole("link", { name: "View purchase order", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "6.000", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});
