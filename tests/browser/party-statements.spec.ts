import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { testOrigin } from "./test-origin";

test("customer and vendor statements show historical balances, credits, export and responsive UI", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  const me = await (await page.request.get("/api/me")).json();
  const data = await (await page.request.get("/api/data")).json();
  const command = async (body: Record<string, unknown>) => {
    const response = await page.request.post("/api/commands", {
      headers: { origin: testOrigin, "x-csrf-token": me.csrf },
      data: body,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const name = `=Statement ${randomUUID().slice(0, 8)}`;
  const company = (
    await command({
      action: "company.create",
      name,
      customer: true,
      vendor: true,
      service_entity_id: null,
    })
  ).id;
  const invoice = (
    await command({
      action: "document.invoice-create",
      entity_id: data.entities[0].id,
      company_id: company,
      issue_date: "2026-01-01",
      due_date: "2026-01-10",
      currency: "PKR",
      fx: "1",
      lines: [
        {
          description: "Statement work",
          quantity: "1",
          price: "1000",
          tax: "0",
        },
      ],
      billing_kind: "earned",
      label: "Statement work",
      terms: "",
      details: {},
      request_key: randomUUID(),
    })
  ).id;
  await command({ action: "invoice.issue", id: invoice });
  await command({
    action: "payment.create",
    invoice_id: invoice,
    date: "2026-01-02",
    amount: "200",
    wht: "50",
    fx: "1",
    reference: "Payment received",
    request_key: randomUUID(),
  });
  await command({
    action: "credit.create",
    invoice_id: invoice,
    date: "2026-01-03",
    lines: [{ index: 0, amount: "100" }],
    treatment: "earned",
    reason: "Scope reduced",
    request_key: randomUUID(),
  });
  const bill = (
    await command({
      action: "bill.create",
      entity_id: data.entities[0].id,
      vendor_id: company,
      deal_id: null,
      reference: "STATEMENT-BILL",
      bill_date: "2026-01-01",
      due_date: "2026-01-10",
      currency: "PKR",
      fx: "1",
      lines: [
        {
          description: "Vendor work",
          quantity: "1",
          price: "500",
          tax: "0",
          account_code: "5200",
        },
      ],
      tax_treatment: "expense",
      notes: "",
      request_key: randomUUID(),
    })
  ).id;
  await command({ action: "bill.submit", id: bill, version: 1 });
  await command({ action: "bill.approve", id: bill, version: 2 });
  await command({
    action: "vendor-payment.create",
    bill_id: bill,
    date: "2026-01-02",
    amount: "100",
    wht: "20",
    fee: "5",
    fx: "1",
    reference: "Vendor transfer",
    request_key: randomUUID(),
  });
  await page.goto(`/#customer-statements/${company}`);
  await page.getByLabel("Statement from").fill("2026-01-02");
  await page.getByLabel("Statement to").fill("2026-01-31");
  await expect(
    page.locator(".report-totals").getByText("PKR 650.00", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".report-totals").getByText("PKR 1,000.00", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("Payment received (including withholding)", { exact: false })
      .first(),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "customer-statement-2026-01-31.csv",
  );
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv).toContain(`"'${name}"`);
  expect(csv).toContain('"650.00"');
  await page.getByLabel("Statement view").selectOption("outstanding");
  await expect(
    page.getByRole("columnheader", { name: "Days overdue", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".report-paper")
      .getByText("PKR 750.00", { exact: true })
      .last(),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/customer-statement-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("Statement from").fill("2026-02-01");
  await expect(
    page.getByText(
      "Enter a valid date range; the start must not follow the end.",
    ),
  ).toBeVisible();
  await page.goto(`/#vendor-statements/${company}`);
  await page.getByLabel("Statement from").fill("2026-01-02");
  await page.getByLabel("Statement to").fill("2026-01-31");
  await expect(
    page
      .locator(".report-totals")
      .getByText("PKR 380.00", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(
    page.locator(".report-totals").getByText("PKR 500.00", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("Payment made (including withholding)", { exact: false })
      .first(),
  ).toBeVisible();
  // This suite shares its synthetic books with later ageing tests. Settle the
  // payable after the statement assertions so this fixture leaves no open bill.
  await command({
    action: "vendor-payment.create",
    bill_id: bill,
    date: "2026-02-01",
    amount: "380",
    wht: "0",
    fee: "0",
    fx: "1",
    reference: "Statement fixture settlement",
    request_key: randomUUID(),
  });
});
