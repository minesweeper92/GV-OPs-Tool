import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { testOrigin } from "./test-origin";

async function signIn(page: Page, name: string) {
  await page.goto("/");
  await page
    .getByRole("button", { name: `${name} Grid Velocity · sample` })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
}

test("one customer payment settles several invoices, holds the rest and reverses cleanly", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, "Owner");
  const me = await (await page.request.get("/api/me")).json();
  const command = async (payload: Record<string, unknown>) => {
    const response = await page.request.post("/api/commands", {
      headers: { origin: testOrigin, "x-csrf-token": me.csrf },
      data: payload,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const data = await (await page.request.get("/api/data")).json();
  const entity = data.entities[0];
  const customerName = `Receipt Customer ${randomUUID().slice(0, 8)}`;
  const customer = await command({
    action: "company.create",
    name: customerName,
    domain: "",
    industry: "",
    tax_id: "",
    address: "",
    customer: true,
    vendor: false,
    service_entity_id: null,
  });
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
  const invoice = async (price: string, tax: string, due: string) => {
    const created = await command({
      action: "document.invoice-create",
      entity_id: entity.id,
      company_id: customer.id,
      issue_date: "2031-01-05",
      due_date: due,
      currency: "PKR",
      fx: "1",
      lines: [
        {
          description: "Work",
          quantity: "1",
          price,
          tax,
          unit: "",
          section: "",
        },
      ],
      billing_kind: "earned",
      label: "Work",
      terms: "",
      details,
      request_key: randomUUID(),
    });
    await command({ action: "invoice.issue", id: created.id });
    const all = await (await page.request.get("/api/data")).json();
    return all.invoices.find((i: { id: string }) => i.id === created.id)
      .number as string;
  };
  const older = await invoice("100000", "0", "2031-01-20");
  const newer = await invoice("550000", "16", "2031-02-20");
  const bankName = `Receipts Bank ${randomUUID().slice(0, 6)}`;
  await command({
    action: "bank.create",
    entity_id: entity.id,
    name: bankName,
    reference: "RCPT",
    opening_on: "2031-01-01",
    opening: "0",
    offset_code: "3900",
    request_key: randomUUID(),
  });

  await page.goto("/#customer-receipts");
  await page.reload();
  await page
    .getByRole("button", { name: "Record customer receipt", exact: true })
    .click();
  const drawer = page.getByRole("dialog");
  await drawer
    .getByLabel("Legal entity", { exact: true })
    .selectOption(entity.id);
  await drawer
    .getByLabel("Customer", { exact: true })
    .selectOption({ label: customerName });
  await drawer
    .getByLabel("Received into", { exact: true })
    .selectOption({ label: `${bankName} · PKR` });
  await drawer.getByLabel("Receipt date", { exact: true }).fill("2031-02-01");
  await drawer.getByLabel("Reference", { exact: true }).fill("TRF-88421");
  await drawer
    .getByLabel("Cash received (PKR)", { exact: true })
    .fill("600000");
  await drawer.getByLabel("Bank charge (PKR)", { exact: true }).fill("500");
  // Domestic receipts do not ask for an exchange rate.
  await expect(drawer.getByLabel(/Exchange rate/)).toHaveCount(0);
  await drawer
    .getByRole("button", { name: "Suggest oldest first", exact: true })
    .click();
  await expect(drawer.getByLabel(`Cash for ${older}`)).toHaveValue("100000.00");
  await expect(drawer.getByLabel(`Cash for ${newer}`)).toHaveValue("500000.00");
  // The customer also withheld income tax and the whole sales tax.
  await drawer.getByLabel(`Income tax withheld for ${newer}`).fill("60000");
  await drawer.getByLabel(`Sales tax withheld for ${newer}`).fill("88000");
  const summary = drawer.locator(".receipt-summary");
  await expect(summary).toContainText("exceeds its outstanding balance");
  await expect(
    drawer.getByRole("button", { name: "Review receipt", exact: true }),
  ).toBeDisabled();
  await drawer.getByLabel(`Cash for ${newer}`).fill("400000");
  await expect(summary).toContainText("PKR 100,000.00");
  await expect(summary).toContainText("PKR 599,500.00");
  await expect(summary).toContainText("never reaches the bank");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // The unfinished receipt survives closing the form in this tab.
  await drawer
    .getByRole("button", { name: "Keep draft & close", exact: true })
    .click();
  await expect(drawer).not.toBeVisible();
  await page
    .getByRole("button", { name: "Record customer receipt", exact: true })
    .click();
  await expect(drawer.getByLabel("Reference", { exact: true })).toHaveValue(
    "TRF-88421",
  );
  await expect(drawer.getByLabel(`Cash for ${newer}`)).toHaveValue("400000");

  await drawer
    .getByRole("button", { name: "Review receipt", exact: true })
    .click();
  const posting = drawer.getByRole("region", { name: "What will be posted" });
  await expect(
    posting.getByRole("row").filter({ hasText: bankName }),
  ).toContainText("PKR 599,500.00");
  await expect(
    posting.getByRole("row").filter({ hasText: "(1210)" }),
  ).toContainText("PKR 88,000.00");
  await expect(
    posting.getByRole("row").filter({ hasText: "(2410)" }),
  ).toContainText("PKR 100,000.00");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await drawer
    .getByRole("button", { name: "Post receipt", exact: true })
    .click();
  await expect(drawer).not.toBeVisible();

  const row = page.getByRole("row").filter({ hasText: "TRF-88421" });
  await expect(row).toContainText("PKR 100,000.00 unapplied");
  await expect(
    page.getByRole("region", { name: "Cash on account" }),
  ).toContainText(customerName);
  await page.screenshot({
    path: "test-results/customer-receipts-list.png",
    fullPage: true,
  });
  await row.getByRole("link", { name: "TRF-88421", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Receipt TRF-88421", exact: true }),
  ).toBeVisible();

  // Apply the cash on account to what is still owed, then refund the rest.
  await page
    .getByRole("button", { name: "Apply to an invoice", exact: true })
    .click();
  await expect(drawer.getByLabel("Amount to apply (PKR)")).toHaveValue(
    "90000.00",
  );
  await drawer
    .getByLabel("Application date", { exact: true })
    .fill("2031-02-05");
  await drawer.getByRole("button", { name: "Apply cash", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page.locator(".receipt-detail")).toContainText(
    "PKR 10,000.00 unapplied",
  );
  await page
    .getByRole("button", { name: "Record refund", exact: true })
    .click();
  await expect(drawer.getByLabel("Amount refunded (PKR)")).toHaveValue(
    "10000.00",
  );
  await drawer.getByLabel("Refund date", { exact: true }).fill("2031-02-06");
  await drawer.getByLabel("Refund reference", { exact: true }).fill("REFUND-1");
  await drawer
    .getByRole("button", { name: "Record refund", exact: true })
    .click();
  await expect(drawer).not.toBeVisible();
  await expect(page.locator(".receipt-detail")).toContainText(
    "Fully allocated",
  );
  await expect(
    page.getByRole("button", { name: "Reverse receipt", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: "test-results/customer-receipt-detail.png",
    fullPage: true,
  });

  // The invoice itself shows which receipt and application settled it.
  await page.getByRole("link", { name: newer, exact: true }).first().click();
  await expect(page.getByText("PKR 148,000.00 withheld")).toBeVisible();
  await expect(page.getByText("Cash on account from")).toBeVisible();

  // The customer statement shows the receipt and how the cash was used.
  await page.goto(`/#customer-statements/${customer.id}`);
  await page.getByLabel("Statement to").fill("2031-12-31");
  await page.getByLabel("Statement from").fill("2031-01-01");
  await expect(
    page.getByText("Customer receipt (cash and withholding)").first(),
  ).toBeVisible();
  await expect(page.getByText("Unapplied cash refunded").first()).toBeVisible();

  // Undo in order: refund, application, then the whole receipt.
  await page.goto("/#customer-receipts");
  await page
    .getByRole("row")
    .filter({ hasText: "TRF-88421" })
    .getByRole("link", { name: "TRF-88421", exact: true })
    .click();
  const reverse = async (button: string, date: string, reason: string) => {
    await page.getByRole("button", { name: button, exact: true }).click();
    await drawer.getByLabel("Reversal date", { exact: true }).fill(date);
    await drawer.getByLabel("Reason", { exact: true }).fill(reason);
    await drawer
      .getByRole("button", { name: "Confirm reversal", exact: true })
      .click();
    await expect(drawer).not.toBeVisible();
  };
  await reverse("Reverse refund", "2031-02-07", "Refund bounced");
  await reverse("Reverse application", "2031-02-08", "Wrong invoice");
  await expect(page.locator(".receipt-detail")).toContainText(
    "PKR 100,000.00 unapplied",
  );
  await reverse("Reverse receipt", "2031-02-09", "Posted to wrong customer");
  await expect(page.locator(".receipt-detail")).toContainText("Reversed");
  await expect(
    page.getByRole("button", { name: "Apply to an invoice", exact: true }),
  ).toHaveCount(0);
  // Both invoices are open again for their full amounts.
  const after = await (await page.request.get("/api/data")).json();
  for (const number of [older, newer]) {
    const i = after.invoices.find(
      (x: { number: string }) => x.number === number,
    );
    expect(i.status).toBe("Issued");
    expect(i.paid_minor).toBe("0");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#customer-receipts");
  await page
    .getByRole("button", { name: "Record customer receipt", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await drawer
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  expect(errors).toEqual([]);

  // Someone without accounting access is not offered the screen.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose a sample role" }),
  ).toBeVisible();
  await signIn(page, "Sales rep");
  await expect(
    page.getByRole("link", { name: "Customer receipts", exact: true }),
  ).toHaveCount(0);
});
