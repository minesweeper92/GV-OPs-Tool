import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

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
  await page.getByText("More customer, billing and PDF details").click();
  await page
    .getByLabel("Purchase order number", { exact: true })
    .fill(reference);
  await page
    .getByLabel("Billing address", { exact: true })
    .fill("Invoice snapshot address");
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
  let saved = await (await page.request.get("/api/data")).json();
  const invoice = saved.invoices.find(
    (i: any) => i.details.purchase_order === reference,
  );
  expect(invoice.deal_id).toBe(null);
  expect(invoice.net_minor).toBe("180000");
  expect(invoice.tax_minor).toBe("32400");
  expect(
    saved.catalogItems.some((i: any) => i.name === "Brand strategy workshop"),
  ).toBe(true);
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
