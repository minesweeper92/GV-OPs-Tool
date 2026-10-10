import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { testOrigin } from "./test-origin";

test("full contact creation works without an employer and persists optional details", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await page.getByRole("button", { name: "New contact", exact: true }).click();
  const name = `Independent ${randomUUID().slice(0, 6)}`;
  await page.getByLabel("First name", { exact: true }).fill(name);
  await page
    .getByLabel("Primary email", { exact: true })
    .fill(`${randomUUID()}@example.test`);
  await page
    .getByText("Full details, owner and custom fields", { exact: true })
    .click();
  await page.getByLabel("Department", { exact: true }).fill("Brand marketing");
  await page
    .getByLabel("Preferred channel", { exact: true })
    .selectOption("Email");
  await page
    .getByRole("button", { name: "Add custom field", exact: true })
    .click();
  await page.getByLabel("Custom field 1 name").fill("Client tier");
  await page.getByLabel("Custom field 1 value").fill("Priority");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  const data = await (await page.request.get("/api/data")).json();
  const contact = data.contacts.find((c: any) => c.first_name === name);
  expect(contact.profile.department).toBe("Brand marketing");
  expect(contact.profile.custom_fields[0].value).toBe("Priority");
  expect(data.affiliations.some((a: any) => a.contact_id === contact.id)).toBe(
    false,
  );
  await page.getByRole("link", { name, exact: true }).click();
  await page.getByText("Full profile details", { exact: true }).click();
  await expect(
    page.getByText("Brand marketing", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("direct invoice form saves discounted lines, reusable items and immutable customer details", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Invoices", exact: true })
    .click();
  await page.getByRole("button", { name: "New invoice", exact: true }).click();
  const data = await (await page.request.get("/api/data")).json();
  const company = data.companies[0],
    entity = data.entities.find((e: any) => e.code === "PVT");
  await page
    .getByLabel("Issuing legal entity", { exact: true })
    .selectOption(entity.id);
  await page
    .getByLabel("Customer company", { exact: true })
    .selectOption(company.id);
  const reference = `PO-${randomUUID().slice(0, 8)}`;
  await page
    .getByLabel("Description 1", { exact: true })
    .fill("Brand strategy workshop");
  await page.getByLabel("Unit price 1", { exact: true }).fill("1000");
  await page.getByLabel("Quantity 1", { exact: true }).fill("2");
  await page.getByLabel("Tax % 1", { exact: true }).fill("18");
  await page.getByText("Unit, section and discount").click();
  await page.getByLabel("Discount 1", { exact: true }).fill("10");
  await page.getByLabel("Unit 1", { exact: true }).fill("days");
  await page.getByLabel("Section 1", { exact: true }).fill("Strategy");
  await page.getByLabel("Overall discount").fill("10");
  await page.getByLabel("Shipping charges").fill("100");
  await page.getByLabel("Shipping tax %").fill("18");
  await expect(page.locator(".quote-totals-grand")).toContainText(
    "PKR 2,029.60",
  );
  await page.getByText("More customer, billing and PDF details").click();
  await page
    .getByLabel("Purchase order number", { exact: true })
    .fill(reference);
  await page
    .getByLabel("Billing address", { exact: true })
    .fill("Invoice snapshot address");
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page.getByRole("button", { name: "New invoice", exact: true }).click();
  await expect(
    page.getByLabel("Customer company", { exact: true }),
  ).toHaveValue(company.id);
  await expect(
    page.getByLabel("Issuing legal entity", { exact: true }),
  ).toHaveValue(entity.id);
  await expect(page.getByLabel("Description 1", { exact: true })).toHaveValue(
    "Brand strategy workshop",
  );
  await expect(page.locator(".quote-totals-grand")).toContainText(
    "PKR 2,029.60",
  );
  await page.getByText("More customer, billing and PDF details").click();
  await expect(page.getByLabel("Billing address", { exact: true })).toHaveValue(
    "Invoice snapshot address",
  );
  await page.getByText("Unit, section and discount").click();
  await expect(page.getByLabel("Unit 1", { exact: true })).toHaveValue("days");
  await expect(page.getByLabel("Section 1", { exact: true })).toHaveValue(
    "Strategy",
  );
  await page
    .getByRole("button", { name: "Save line 1 to item library", exact: true })
    .click();
  await expect(
    page.getByText("Item saved to this workspace's reusable item library."),
  ).toBeVisible();
  await expect(page.getByLabel("Purchase order number")).toHaveValue(reference);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/expanded-invoice-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Save as draft", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "New invoice" })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith("gv-invoice-draft-v1:"),
      ),
    ),
  ).toEqual([]);
  let saved = await (await page.request.get("/api/data")).json();
  const invoice = saved.invoices.find(
    (i: any) => i.details.purchase_order === reference,
  );
  expect(invoice.deal_id).toBe(null);
  expect(invoice.net_minor).toBe("172000");
  expect(invoice.tax_minor).toBe("30960");
  expect(invoice.lines[1].kind).toBe("shipping");
  expect(
    saved.catalogItems.some((i: any) => i.name === "Brand strategy workshop"),
  ).toBe(true);
  const me = await (await page.request.get("/api/me")).json();
  const changedAmounts = await page.request.post("/api/commands", {
    headers: {
      origin: testOrigin,
      "x-csrf-token": me.csrf,
    },
    data: {
      action: "document.invoice-edit",
      id: invoice.id,
      version: invoice.version,
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      terms: invoice.terms,
      details: { ...invoice.details, shipping_amount: "999" },
    },
  });
  expect(changedAmounts.status()).toBe(409);
  await page.goto(`/?view=invoice/${invoice.id}`);
  await expect(page.getByText(reference, { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Edit draft details", exact: true })
    .click();
  await page.getByLabel("Customer reference", { exact: true }).fill("Reviewed");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/expanded-invoice-document.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Issue invoice", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Issue and post", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit draft details", exact: true }),
  ).toHaveCount(0);
  saved = await (await page.request.get("/api/data")).json();
  expect(saved.invoices.find((i: any) => i.id === invoice.id).status).toBe(
    "Issued",
  );
  expect(errors).toEqual([]);
});

test("Create menu opens invoice and inline customer creation preserves the draft", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await page.locator(".global-create > summary").click();
  await expect(
    page.getByRole("button", { name: "New contact", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New invoice", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "New invoice" }),
  ).toBeVisible();
  const entity = (await (await page.request.get("/api/data")).json())
    .entities[0];
  await page
    .getByLabel("Issuing legal entity", { exact: true })
    .selectOption(entity.id);
  await page
    .getByLabel("Description 1", { exact: true })
    .fill("Strategy session");
  await page.getByLabel("Unit price 1", { exact: true }).fill("1200");
  await page.getByRole("button", { name: "New customer", exact: true }).click();
  const name = `Invoice customer ${randomUUID().slice(0, 8)}`;
  await expect(page.getByLabel("New customer company name")).toBeFocused();
  await page.getByLabel("New customer company name").fill(name);
  await page
    .getByLabel("Website domain (optional)")
    .fill("invoice.example.test");
  await page.getByLabel("Tax registration (optional)").fill("NTN-123");
  await page.getByLabel("Billing address (optional)").fill("Office 12, Lahore");
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page.locator(".global-create > summary").click();
  await page.getByRole("button", { name: "New invoice", exact: true }).click();
  await expect(page.getByLabel("New customer company name")).toHaveValue(name);
  await expect(page.getByLabel("Billing address (optional)")).toHaveValue(
    "Office 12, Lahore",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (await new AxeBuilder({ page }).include(".invoice-composer").analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: "test-results/invoice-inline-customer-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create & select customer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Add a customer company" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Description 1", { exact: true })).toHaveValue(
    "Strategy session",
  );
  await expect(page.getByLabel("Unit price 1", { exact: true })).toHaveValue(
    "1200",
  );
  const selectedId = await page
    .getByLabel("Customer company", { exact: true })
    .inputValue();
  expect(selectedId).not.toBe("");
  await expect(
    page.getByLabel("Customer company", { exact: true }),
  ).toBeFocused();
  await page.getByText("More customer, billing and PDF details").click();
  await expect(page.getByLabel("Billing address", { exact: true })).toHaveValue(
    "Office 12, Lahore",
  );
  await expect(page.getByLabel("Customer tax ID", { exact: true })).toHaveValue(
    "NTN-123",
  );
  await page
    .getByRole("button", { name: "Save as draft", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "New invoice" })).toHaveCount(
    0,
  );
  const data = await (await page.request.get("/api/data")).json();
  expect(data.companies.find((c: any) => c.id === selectedId)?.name).toBe(name);
  expect(
    data.invoices.some((invoice: any) => invoice.company_id === selectedId),
  ).toBe(true);
});

test("inline invoice customer picker reuses an existing company", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Invoices", exact: true })
    .click();
  await page.getByRole("button", { name: "New invoice", exact: true }).click();
  const before = await (await page.request.get("/api/data")).json();
  const existing = before.companies[0];
  await page.getByRole("button", { name: "New customer", exact: true }).click();
  await page.getByLabel("New customer company name").fill(existing.name);
  await page.getByLabel("New customer company name").press("Enter");
  await expect(
    page.getByLabel("Customer company", { exact: true }),
  ).toHaveValue(existing.id);
  const after = await (await page.request.get("/api/data")).json();
  expect(after.companies.length).toBe(before.companies.length);
});
