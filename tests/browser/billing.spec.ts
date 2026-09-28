import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID as uuid } from "node:crypto";
async function setup(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const me = await (await page.request.get("/api/me")).json(),
    data = await (await page.request.get("/api/data")).json(),
    entity = data.entities.find((e: any) => e.code === "PVT").id;
  const command = async (c: Record<string, unknown>) => {
    const r = await page.request.post("/api/commands", {
      headers: { origin: "http://127.0.0.1:4322", "x-csrf-token": me.csrf },
      data: c,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const company = (
      await command({
        action: "company.create",
        name: `Billing browser client ${uuid().slice(0, 8)}`,
        customer: true,
        vendor: false,
        service_entity_id: null,
      })
    ).id,
    contact = (
      await command({
        action: "contact.create",
        first_name: "Billing client",
        email: "",
        company_id: company,
        role: "Buyer",
      })
    ).id;
  const accepted = async (name: string) => {
    const lead = (
        await command({
          action: "lead.create",
          entity_id: entity,
          company_id: company,
          contact_id: contact,
          title: name,
          next_action: "Quote",
          due_date: "2026-01-01",
        })
      ).id,
      deal = (await command({ action: "lead.convert", id: lead })).id,
      quote = (
        await command({
          action: "quote.create",
          deal_id: deal,
          option_name: "Approved service",
          currency: "PKR",
          fx: "1",
          lines: [
            {
              description: "Creative service",
              quantity: "1",
              price: "1000",
              tax: "18",
            },
          ],
        })
      ).id;
    await command({ action: "quote.accept", id: quote, reference: "Approved" });
    return quote;
  };
  return { command, accepted, entity };
}
test("credit issue, application, reversal and refund work through accessible screens", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, accepted } = await setup(page),
    quote = await accepted("Credit UI job");
  const id = (
    await command({
      action: "invoice.create",
      quote_id: quote,
      issue_date: "2026-01-01",
      due_date: "2026-01-31",
      request_key: uuid(),
    })
  ).id;
  await command({ action: "invoice.issue", id });
  await page.goto(`/?view=invoice/${id}`);
  await page.getByRole("link", { name: "Create credit note" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Credit: Creative service").fill("200");
  await page.getByLabel("Reason", { exact: true }).fill("Scope reduction");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("button", { name: "Issue credit note", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const snapshot = await (await page.request.get("/api/data")).json(),
    credit = snapshot.credits.find((c: any) => c.invoice_id === id);
  await page.getByRole("link", { name: credit.number, exact: true }).click();
  await page
    .getByRole("button", { name: "Apply to invoice", exact: true })
    .click();
  await page.getByLabel("Apply to invoice").selectOption(id);
  await page.getByRole("button", { name: "Apply credit", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Apply to invoice", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Reverse application" }).click();
  await page.getByLabel("Reason", { exact: true }).fill("Return money instead");
  await page
    .getByRole("button", { name: "Reverse credit application", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Record refund", exact: true })
    .click();
  await page.getByLabel("Payment reference").fill("Refund transfer");
  await page
    .getByRole("button", { name: "Record customer refund", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("cell", { name: "Refund transfer", exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "test-results/credit-note-workflow.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("recurring expense review and invoice drafts are navigable without automatic posting", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { accepted, entity } = await setup(page);
  const quote = await accepted("Monthly retainer UI");
  await page.goto("/#recurring-expenses");
  await page.getByRole("button", { name: "New schedule" }).click();
  await page.getByLabel("Schedule name").fill("Studio internet");
  await page.getByLabel("Expense description").fill("Monthly internet charge");
  await page.getByLabel("Amount per cycle (PKR)", { exact: true }).fill("5000");
  await page.getByLabel("Total cycles (optional)").fill("1");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("link", { name: "Studio internet", exact: true })
    .click();
  await page.getByRole("button", { name: "Generate due drafts" }).click();
  await page.getByRole("button", { name: "Review & post expense" }).click();
  await page.getByLabel("Payment reference").fill("Internet bank debit");
  await page.getByRole("button", { name: "Post paid expense" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("cell", { name: "Posted", exact: true }),
  ).toBeVisible();
  await page.goto("/#recurring");
  await page.getByRole("button", { name: "New schedule" }).click();
  await page.getByLabel("Issuing entity").selectOption(entity);
  await page.getByLabel("Schedule name").fill("Monthly creative retainer");
  await page.getByLabel("Accepted recurring contract").selectOption(quote);
  await page.getByLabel("Total cycles (optional)").fill("1");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("link", { name: "Monthly creative retainer", exact: true })
    .click();
  await page.getByRole("button", { name: "Generate due drafts" }).click();
  await expect(
    page.getByRole("link", { name: "Open draft invoice · Draft" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "test-results/recurring-billing-workflow.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Open draft invoice · Draft" }).click();
  await expect(
    page.getByRole("button", { name: "Issue invoice", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
