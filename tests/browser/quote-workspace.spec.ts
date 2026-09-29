import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

test("quote navigation, customer/project selection, draft, detail and manual sharing", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
  const name = `Quote customer ${randomUUID().slice(0, 8)}`;
  const company = (
    await command({
      action: "company.create",
      name,
      customer: true,
      vendor: false,
      service_entity_id: null,
    })
  ).id;
  const contact = (
    await command({
      action: "contact.create",
      first_name: "Nadia",
      email: "",
      company_id: company,
      role: "Marketing manager",
    })
  ).id;
  const lead = (
    await command({
      action: "lead.create",
      company_id: company,
      contact_id: contact,
      entity_id: entity.id,
      title: "Identity refresh",
      next_action: "Prepare cost",
      due_date: "2026-10-15",
    })
  ).id;
  const deal = (await command({ action: "lead.convert", id: lead })).id;
  await page.reload();
  await page.getByRole("link", { name: "Quotes", exact: true }).click();
  await page
    .locator("main#main")
    .getByRole("button", { name: "New quote", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "New quote" })).toBeVisible();
  await page.getByLabel("Search customers").fill(name.slice(0, 13));
  await page.getByLabel("Customer name").selectOption(company);
  await page.getByLabel("Project / opportunity").selectOption(deal);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel("Named option").fill("Director A");
  await page
    .getByLabel("Subject", { exact: true })
    .fill("Identity concept and design");
  await page.getByLabel("Reference number").fill("BRAND-2026");
  await page
    .getByLabel("Description 1", { exact: true })
    .fill("Identity design");
  await page.getByLabel("Unit price 1", { exact: true }).fill("50000");
  await page.getByLabel("Tax % 1", { exact: true }).fill("0");
  await page.screenshot({
    path: "test-results/quote-composer-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByRole("heading", { name: "New quote" })).toHaveCount(0);
  const saved = await (await page.request.get("/api/data")).json();
  const quote = saved.quotes.find((q: any) => q.deal_id === deal);
  expect(quote.number).toMatch(/^QT-\d{6}$/);
  expect(quote.details.reference).toBe("BRAND-2026");
  await expect(page).toHaveURL(new RegExp(`#quote/${quote.id}$`));
  await expect(page.locator(".page-heading h1")).toHaveText(quote.number);
  await expect(page.locator(".quote-summary-card")).toContainText(
    "Identity concept and design",
  );
  await page.getByRole("button", { name: "PDF preview" }).click();
  await expect(page.locator(".document .document-number")).toHaveText(
    quote.number,
  );
  await expect(
    page.getByText("Identity concept and design", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Next step: share this quote", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/quote-workspace-desktop.png",
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(
    page.getByText("No sharing or acceptance recorded yet."),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Quote details" }).click();
  await page.getByRole("button", { name: "Mark as sent", exact: true }).click();
  await page
    .getByLabel("Email link or message reference")
    .fill("Outlook message reference QA-77");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText("Outlook message reference QA-77")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/quote-workspace-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Accept this version" }).click();
  await page.getByLabel("Acceptance evidence").fill("Approved quote QA-77");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Convert to invoice" }).click();
  await expect(
    page.getByRole("heading", { name: "Convert quote to invoice" }),
  ).toBeVisible();
  await expect(page.getByLabel("Customer company")).toHaveValue(company);
  await expect(page.getByLabel("Project name")).toHaveValue("Identity refresh");
  await page.getByRole("button", { name: "New prefix" }).click();
  const prefix = `QA${randomUUID().slice(0, 5).toUpperCase()}-`;
  await page.getByLabel("Series name").fill(`QA series ${prefix}`);
  await page.getByLabel("Prefix", { exact: true }).fill(prefix);
  await page.getByLabel("Next number").fill("12");
  await page.getByLabel("Digits").fill("4");
  await page.getByRole("button", { name: "Save prefix and use it" }).click();
  await expect(page.getByLabel("invoice number preview")).toHaveValue(
    `${prefix}0012`,
  );
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.locator(".page-heading h1")).toHaveText(`${prefix}0012`);
  await expect(page.locator(".quote-action-bar")).toContainText("Not sent");
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await page.getByRole("button", { name: "Issue and post" }).click();
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await page
    .getByLabel("Email link or message reference")
    .fill("Outlook invoice QA-77");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".quote-action-bar")).toContainText("Sent");
  const final = await (await page.request.get("/api/data")).json();
  const invoiced = final.invoices.find((i: any) => i.quote_id === quote.id);
  expect(invoiced.number).toBe(`${prefix}0012`);
  expect(
    final.invoiceDeliveryEvents.some(
      (e: any) =>
        e.invoice_id === invoiced.id && e.reference === "Outlook invoice QA-77",
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("new customer and project can be created without losing a quote draft", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  const customerName = `Inline quote customer ${randomUUID().slice(0, 8)}`;
  await page.getByRole("link", { name: "Quotes", exact: true }).click();
  await page
    .locator("main#main")
    .getByRole("button", { name: "New quote", exact: true })
    .click();
  await page
    .getByLabel("Subject", { exact: true })
    .fill("Film production proposal");
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Company name").fill(customerName);
  await page.getByLabel("Primary contact first name").fill("Ayesha");
  await page
    .getByLabel("Primary contact email")
    .fill(`ayesha-${randomUUID().slice(0, 8)}@example.com`);
  await page.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByLabel("Customer name")).toHaveValue(/.+/);
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue(
    "Film production proposal",
  );
  await page.getByLabel("Project name").last().fill("Launch film");
  await page
    .getByLabel("Issuing legal entity")
    .selectOption(data.entities[0].id);
  await page.getByLabel("Project contact").selectOption({ label: "Ayesha" });
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByLabel("Project / opportunity")).toHaveValue(/.+/);
  await page.getByRole("button", { name: "New prefix" }).click();
  const quotePrefix = `Q${randomUUID().slice(0, 5).toUpperCase()}-`;
  await page.getByLabel("Series name").fill(`Quote series ${quotePrefix}`);
  await page.getByLabel("Prefix", { exact: true }).fill(quotePrefix);
  await page.getByLabel("Next number").fill("9");
  await page.getByLabel("Digits").fill("3");
  await page.getByRole("button", { name: "Save prefix and use it" }).click();
  await expect(page.getByLabel("quote number preview")).toHaveValue(
    `${quotePrefix}009`,
  );
  await page.getByLabel("Named option").fill("Director A");
  await page
    .getByLabel("Description 1", { exact: true })
    .fill("Film production");
  await page.getByLabel("Unit price 1", { exact: true }).fill("10000");
  await page
    .getByLabel("Sent message reference")
    .fill("Outlook message draft ref 123");
  await page.getByRole("button", { name: "Save & mark as sent" }).click();
  await expect(page.locator(".page-heading h1")).toHaveText(
    `${quotePrefix}009`,
  );
  await expect(page.locator(".quote-action-bar")).toContainText("Sent");
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText("Outlook message draft ref 123")).toBeVisible();
});
