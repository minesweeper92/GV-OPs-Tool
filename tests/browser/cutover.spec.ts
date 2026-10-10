import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("opening balances require review, reconcile and post once in the UI", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  let me = await (await page.request.get("/api/me")).json();
  let headers = {
    "x-csrf-token": me.csrf,
    origin: `http://127.0.0.1:${process.env.GV_BROWSER_PORT || 4322}`,
  };
  const code = `X${randomUUID().slice(0, 6).toUpperCase()}`;
  const customer = `Customer ${code}`,
    vendor = `Vendor ${code}`;
  const organization = await page.request.post("/api/organizations", {
    headers,
    data: {
      name: `Cutover workspace ${code}`,
      entityName: `Cutover ${code}`,
      entityCode: code,
      requestKey: randomUUID(),
    },
  });
  expect(organization.ok()).toBe(true);
  const switched = await page.request.post("/api/organizations/switch", {
    headers,
    data: { id: (await organization.json()).id },
  });
  expect(switched.ok()).toBe(true);
  me = await (await page.request.get("/api/me")).json();
  headers = {
    "x-csrf-token": me.csrf,
    origin: `http://127.0.0.1:${process.env.GV_BROWSER_PORT || 4322}`,
  };
  const entityId = (await (await page.request.get("/api/data")).json())
    .entities[0].id;
  for (const [name, isCustomer, isVendor] of [
    [customer, true, false],
    [vendor, false, true],
  ] as const) {
    const response = await page.request.post("/api/commands", {
      headers,
      data: {
        action: "company.create",
        name,
        domain: "",
        industry: "",
        tax_id: "",
        address: "",
        customer: isCustomer,
        vendor: isVendor,
        service_entity_id: entityId,
        request_key: randomUUID(),
      },
    });
    expect(response.ok()).toBe(true);
  }
  const bank = await page.request.post("/api/commands", {
    headers,
    data: {
      action: "bank.create",
      entity_id: entityId,
      name: `Bank ${code}`,
      reference: "SAMPLE",
      opening_on: "2026-08-31",
      opening: "1000.00",
      offset_code: "3900",
      request_key: randomUUID(),
    },
  });
  expect(bank.ok()).toBe(true);
  await page.goto("/?view=opening-balances");
  await page.getByLabel("Legal entity view").selectOption(entityId);
  await expect(
    page.getByRole("heading", { name: `Cutover ${code} · opening balances` }),
  ).toBeVisible();
  await page.getByLabel("Old books closing date").fill("2026-08-31");
  const uploads = [
    [
      "Opening trial balance and account chart CSV",
      "accounts.csv",
      `code,name,type,debit,credit\n10B0001,Bank ${code},Asset,1000.00,0\n1100,Accounts receivable,Asset,500.00,0\n2000,Accounts payable,Liability,0,200.00\n3000,Owner equity,Equity,0,1300.00\n`,
    ],
    [
      "Unpaid customer invoices CSV",
      "receivables.csv",
      `company,number,issue_date,due_date,amount\n${customer},OLD-INV-${code},2026-08-10,2026-09-15,500.00\n`,
    ],
    [
      "Unpaid vendor bills CSV",
      "payables.csv",
      `company,number,bill_date,due_date,amount\n${vendor},OLD-BILL-${code},2026-08-11,2026-09-20,200.00\n`,
    ],
  ] as const;
  for (const [label, name, content] of uploads)
    await page.getByLabel(label).setInputFiles({
      name,
      mimeType: "text/csv",
      buffer: Buffer.from(content),
    });
  await expect(page.getByText("4 rows loaded")).toBeVisible();
  await page.getByRole("button", { name: "Review cutover" }).click();
  const review = page.getByRole("region", { name: "Cutover review" });
  await expect(review).toContainText("All checks pass");
  await expect(review).toContainText("Receivables reconcile");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "test-results/cutover-review.png",
    fullPage: true,
  });
  await page.getByLabel("Entity code confirmation").fill(code);
  await page.getByRole("button", { name: "Post opening balances" }).click();
  await expect(
    page.getByRole("heading", { name: "Posted cutover" }),
  ).toBeVisible();
  const evidenceDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download reviewed import record" })
    .click();
  expect((await evidenceDownload).suggestedFilename()).toContain("gv-cutover-");
  await expect(
    page.getByText("Cutover posted.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Legal entity view").selectOption(entityId);
  await expect(
    page.getByRole("heading", { name: "Posted cutover" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
