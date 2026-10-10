import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

test("vendor advance draft recovery, application, refund and dated reversals work end to end", async ({
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
  const command = async (data: unknown) => {
    const response = await page.request.post("/api/commands", {
      headers: {
        origin: `http://127.0.0.1:${process.env.GV_BROWSER_PORT || 4322}`,
        "x-csrf-token": me.csrf,
      },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const vendor = await command({
    action: "company.create",
    name: `Advance UI ${randomUUID()}`,
    vendor: true,
    customer: false,
    service_entity_id: null,
  });
  const reference = `ADV-UI-${randomUUID()}`;
  const bill = await command({
    action: "bill.create",
    entity_id: data.entities[0].id,
    vendor_id: vendor.id,
    deal_id: null,
    reference: `BILL-${randomUUID()}`,
    bill_date: "2039-05-01",
    due_date: "2039-06-01",
    currency: "PKR",
    fx: "1",
    lines: [
      {
        description: "Services",
        quantity: "1",
        price: "100",
        tax: "0",
        account_code: "5000",
      },
    ],
    tax_treatment: "expense",
    notes: "",
    request_key: randomUUID(),
  });
  await command({ action: "bill.submit", id: bill.id, version: 1 });
  await command({ action: "bill.approve", id: bill.id, version: 2 });
  await page.goto("/?view=vendor-advances");
  await page
    .getByRole("button", { name: "Record advance", exact: true })
    .click();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption(data.entities[0].id);
  await page.getByLabel("Vendor", { exact: true }).selectOption(vendor.id);
  await page.getByLabel("Cash paid", { exact: true }).fill("100");
  await page.getByLabel("Payment date", { exact: true }).fill("2039-05-01");
  await page.getByLabel("Reference", { exact: true }).fill(reference);
  await page.getByRole("button", { name: "Close & keep draft" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Record advance", exact: true })
    .click();
  await expect(page.getByLabel("Reference", { exact: true })).toHaveValue(
    reference,
  );
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact || ""),
    ),
  ).toEqual([]);
  let lost = false;
  await page.route("**/api/commands", async (route) => {
    if (
      !lost &&
      route.request().postDataJSON()?.action === "vendor-advance.create"
    ) {
      lost = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Record advance", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page.unroute("**/api/commands");
  await page.getByRole("button", { name: "Close & keep draft" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Record advance", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Record advance", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: reference, exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get("/api/data")).json()).vendorAdvances.filter(
      (a: any) => a.reference === reference,
    ),
  ).toHaveLength(1);
  await page
    .getByRole("button", { name: "Apply to bill", exact: true })
    .click();
  await page.getByLabel("Transaction date", { exact: true }).fill("2039-05-02");
  await page.getByLabel("Amount (PKR)", { exact: true }).fill("40");
  await page
    .getByRole("button", { name: "Apply advance", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reverse application" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Record refund received" }).click();
  await page.getByLabel("Transaction date", { exact: true }).fill("2039-05-03");
  await page
    .getByLabel("Refund reference", { exact: true })
    .fill("Refund bank receipt");
  await page
    .getByRole("button", { name: "Record refund", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reverse refund", exact: true }),
  ).toBeVisible();
  for (const [button, date] of [
    ["Reverse refund", "2039-05-04"],
    ["Reverse application", "2039-05-05"],
    ["Reverse advance", "2039-05-06"],
  ]) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await page.getByLabel("Transaction date", { exact: true }).fill(date);
    await page
      .getByLabel("Reason", { exact: true })
      .fill("Correct sample transaction");
    await page
      .getByRole("button", { name: "Confirm reversal", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  const result = await (await page.request.get("/api/data")).json();
  expect(
    result.vendorAdvances.find((a: any) => a.reference === reference)
      .reversal_date,
  ).toBeTruthy();
  expect(result.bills.find((b: any) => b.id === bill.id).paid_minor).toBe("0");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: reference, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});
