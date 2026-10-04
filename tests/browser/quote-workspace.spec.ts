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
      email: `nadia-${randomUUID().slice(0, 8)}@example.test`,
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
  await page.getByLabel("Related opportunity").selectOption(deal);
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
  await page.getByLabel("Overall discount").fill("10");
  await page.getByLabel("Shipping charges").fill("5000");
  await expect(page.locator(".quote-totals-grand")).toContainText(
    "PKR 50,000.00",
  );
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
  expect(quote.details.document_discount).toBe("10");
  expect(quote.details.shipping_amount).toBe("5000");
  expect(quote.lines[0].subtotal).toBe("4500000");
  expect(quote.lines[1].kind).toBe("shipping");
  await expect(page).toHaveURL(new RegExp(`#quote/${quote.id}$`));
  await expect(page.locator(".page-heading h1")).toHaveText(quote.number);
  await expect(page.locator(".quote-summary-card")).toContainText(
    "Identity concept and design",
  );
  await expect(page.locator(".quote-summary-totals")).toContainText(
    "Overall discount",
  );
  await page.getByRole("button", { name: "PDF preview" }).click();
  const attachmentName = `scope-${randomUUID().slice(0, 6)}.pdf`;
  await page.getByLabel("Add internal attachment").setInputFiles({
    name: attachmentName,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nGV attachment test\n%%EOF"),
  });
  const attachedLink = page.getByRole("link", {
    name: attachmentName,
    exact: true,
  });
  await expect(attachedLink).toBeVisible();
  const afterUpload = await (await page.request.get("/api/data")).json();
  const fileId = afterUpload.documentAttachments.find(
    (file: any) => file.filename === attachmentName,
  )?.id;
  expect(fileId).toBeTruthy();
  const download = await page.request.get(
    `/api/documents/attachments/${fileId}`,
  );
  expect(download.status()).toBe(200);
  expect(download.headers()["content-disposition"]).toContain("attachment;");
  expect(await download.body()).toEqual(
    Buffer.from("%PDF-1.7\nGV attachment test\n%%EOF"),
  );
  await expect(page.locator(".document .document-number")).toHaveText(
    quote.number,
  );
  await expect(
    page.getByText("Identity concept and design", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".document")).toContainText("Shipping charges");
  await expect(page.locator(".document .totals")).toContainText(
    "Overall discount",
  );
  await expect(
    page.getByText("Next step: create a private customer link", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Prepare customer link" }).click();
  await page.getByLabel("Customer contact").selectOption(contact);
  await page.getByRole("button", { name: "Create private link" }).click();
  await expect(
    page.getByText("Private link ready.", { exact: false }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const customerLink = await page.getByLabel("Customer link").inputValue();
  expect(customerLink).toMatch(/^http:\/\/127\.0\.0\.1:4322\/p\//);
  expect(await page.getByLabel("Email message").inputValue()).toContain(
    customerLink,
  );
  const customerPage = await page.context().newPage();
  await customerPage.goto(customerLink);
  await expect(
    customerPage.getByRole("heading", { name: quote.number }),
  ).toBeVisible();
  await expect(
    customerPage.getByRole("button", { name: "Accept quote" }),
  ).toBeVisible();
  await expect(
    customerPage.getByText("Overall discount", { exact: true }),
  ).toBeVisible();
  await expect(
    customerPage.getByText("Shipping charges").first(),
  ).toBeVisible();
  expect(
    (await new AxeBuilder({ page: customerPage }).analyze()).violations,
  ).toEqual([]);
  await customerPage.screenshot({
    path: "test-results/quote-customer-portal.png",
    fullPage: true,
  });
  await customerPage.setViewportSize({ width: 390, height: 844 });
  expect(
    await customerPage.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    customerPage.getByRole("button", { name: "Accept quote" }),
  ).toBeVisible();
  await customerPage.close();
  await page.screenshot({
    path: "test-results/quote-workspace-desktop.png",
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText("Link prepared")).toBeVisible();
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
  const respondingCustomer = await page.context().newPage();
  await respondingCustomer.goto(customerLink);
  await respondingCustomer.getByLabel("Your name").fill("Nadia Customer");
  await respondingCustomer
    .getByLabel("Comment (optional)")
    .fill("Approved quote QA-77");
  await respondingCustomer
    .getByRole("button", { name: "Accept quote" })
    .click();
  await expect(
    respondingCustomer.getByRole("heading", { name: "Response recorded" }),
  ).toBeVisible();
  await respondingCustomer.close();
  await page.reload();
  await expect(page.locator(".quote-action-bar")).toContainText("Accepted");
  await page.getByRole("button", { name: "Convert to invoice" }).click();
  await expect(
    page.getByRole("heading", { name: "Convert quote to invoice" }),
  ).toBeVisible();
  await expect(page.getByLabel("Customer company")).toHaveValue(company);
  await expect(page.getByLabel("Related opportunity")).toHaveValue(
    "Identity refresh",
  );
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
  await page.getByRole("button", { name: "Prepare invoice email" }).click();
  await page.getByLabel("Customer contact").selectOption(contact);
  await expect(page.getByLabel("Email message")).toHaveValue(
    /Please find invoice/,
  );
  await expect(
    page.getByRole("link", { name: "Open reviewed email draft" }),
  ).toHaveAttribute("href", /^mailto:/);
  await expect(page.locator(".quote-action-bar")).toContainText("Not sent");
  await page.getByRole("button", { name: "Mark as sent" }).click();
  await page
    .getByLabel("Email link or message reference")
    .fill("Outlook invoice QA-77");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".quote-action-bar")).toContainText("Sent");
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await page.getByLabel("Money received (PKR)").fill("50000");
  await page.getByLabel("Withholding deducted (PKR)").fill("0");
  await page.getByLabel("Bank or receipt reference").fill("PORTAL-BANK-001");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(page.locator(".document-masthead")).toContainText("Paid");
  const final = await (await page.request.get("/api/data")).json();
  const invoiced = final.invoices.find((i: any) => i.quote_id === quote.id);
  expect(invoiced.number).toBe(`${prefix}0012`);
  expect(invoiced.total_minor).toBe("5000000");
  expect(invoiced.lines.some((line: any) => line.kind === "shipping")).toBe(
    true,
  );
  expect(
    final.invoiceDeliveryEvents.some(
      (e: any) =>
        e.invoice_id === invoiced.id && e.reference === "Outlook invoice QA-77",
    ),
  ).toBe(true);
  expect(
    final.payments.some(
      (p: any) =>
        p.invoice_id === invoiced.id && p.reference === "PORTAL-BANK-001",
    ),
  ).toBe(true);
  await page.goto(`/#company/${company}`);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: quote.number }),
  ).toContainText("Accepted");
  await expect(page.getByRole("link", { name: `${prefix}0012` })).toBeVisible();
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
  await page.getByLabel("Opportunity name").last().fill("Launch film");
  await page
    .getByLabel("Issuing legal entity")
    .selectOption(data.entities[0].id);
  await page
    .getByLabel("Opportunity contact")
    .selectOption({ label: "Ayesha" });
  await page.getByRole("button", { name: "Create opportunity" }).click();
  await expect(page.getByLabel("Related opportunity")).toHaveValue(/.+/);
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
    .getByLabel("Discount type", { exact: true })
    .selectOption("amount");
  await page.getByLabel("Overall discount").fill("1000");
  await page.getByLabel("Shipping charges").fill("1000");
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
  await page.getByRole("tab", { name: "Quote details" }).click();
  await page.getByRole("button", { name: "Create revision" }).click();
  await expect(page.getByLabel("Overall discount")).toHaveValue("1000");
  await expect(page.getByLabel("Shipping charges")).toHaveValue("1000");
  await expect(page.getByLabel("Discount type", { exact: true })).toHaveValue(
    "amount",
  );
  await expect(page.getByLabel("Description 1", { exact: true })).toHaveValue(
    "Film production",
  );
  await expect(page.getByLabel("Description 2", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Save as draft" }).click();
  const revisions = (
    await (await page.request.get("/api/data")).json()
  ).quotes.filter(
    (quote: any) =>
      quote.option_name === "Director A" &&
      quote.customer_name === customerName,
  );
  expect(revisions).toHaveLength(2);
  expect(revisions.find((quote: any) => quote.revision === 2).total_minor).toBe(
    "1000000",
  );
});
