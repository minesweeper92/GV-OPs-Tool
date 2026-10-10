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
const offset = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};

test("finance chases an overdue invoice: reminder, promise, dispute and credit hold", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, "Owner");
  const me = await (await page.request.get("/api/me")).json();
  const post = (payload: Record<string, unknown>) =>
    page.request.post("/api/commands", {
      headers: { origin: testOrigin, "x-csrf-token": me.csrf },
      data: payload,
    });
  const command = async (payload: Record<string, unknown>) => {
    const response = await post(payload);
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const data = await (await page.request.get("/api/data")).json();
  const entity = data.entities[0];
  const customerName = `Late Payer ${randomUUID().slice(0, 8)}`;
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
  const draft = async () =>
    (
      await command({
        action: "document.invoice-create",
        entity_id: entity.id,
        company_id: customer.id,
        issue_date: offset(-40),
        due_date: offset(-20),
        currency: "PKR",
        fx: "1",
        lines: [
          {
            description: "Work",
            quantity: "1",
            price: "250000",
            tax: "0",
            unit: "",
            section: "",
          },
        ],
        billing_kind: "earned",
        label: "Work",
        terms: "",
        details,
        request_key: randomUUID(),
      })
    ).id as string;
  const invoiceId = await draft();
  await command({ action: "invoice.issue", id: invoiceId });
  const number = (
    await (await page.request.get("/api/data")).json()
  ).invoices.find((i: { id: string }) => i.id === invoiceId).number as string;

  await page.goto("/#collections");
  await page.reload();
  const section = page.getByRole("region", { name: customerName, exact: true });
  await expect(section).toContainText("PKR 250,000.00");
  await expect(section).toContainText("20 days overdue");
  const drawer = page.getByRole("dialog");

  // An administrator sets the reminder schedule for the legal entity.
  await page
    .getByRole("button", { name: "Reminder schedule", exact: true })
    .click();
  const entityPicker = drawer.getByLabel("Legal entity", { exact: true });
  if (await entityPicker.count()) await entityPicker.selectOption(entity.id);
  await expect(drawer).toContainText("Nothing is emailed");
  const existing = await drawer.getByRole("group").count();
  for (let n = existing; n > 0; n--)
    await drawer
      .getByRole("button", { name: `Remove step ${n}`, exact: true })
      .click();
  await drawer.getByRole("button", { name: "Add step", exact: true }).click();
  await drawer.getByLabel("Subject for step 1").fill("Invoice due today");
  await drawer.getByRole("button", { name: "Add step", exact: true }).click();
  await expect(drawer.getByLabel("Days from due date for step 2")).toHaveValue(
    "7",
  );
  await drawer.getByLabel("Subject for step 2").fill("One week overdue");
  await drawer
    .getByLabel("Message for step 2")
    .fill("Please confirm when we can expect payment.");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await drawer
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(drawer).not.toBeVisible();
  await expect(section).toContainText("One week overdue");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "test-results/collections-worklist.png",
    fullPage: true,
  });

  // A reminder is a prompt: the person follows up and records it.
  await section
    .getByRole("button", { name: `Follow up ${number}`, exact: true })
    .click();
  await expect(drawer).toContainText("The system does not send anything");
  await expect(drawer).toContainText(
    "Please confirm when we can expect payment.",
  );
  await drawer.getByLabel("Note", { exact: true }).fill("Called accounts.");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(section).toContainText("Invoice due today");

  // A promise to pay pauses reminders and sets the next action.
  await section
    .getByRole("button", { name: "Log contact", exact: true })
    .click();
  await drawer
    .getByLabel("What was said", { exact: true })
    .fill("Payment is in Friday's run.");
  await drawer.getByLabel("The customer promised a payment").check();
  await drawer
    .getByLabel("About invoice", { exact: true })
    .selectOption(invoiceId);
  await drawer.getByLabel("Promised amount", { exact: true }).fill("250000");
  await drawer.getByLabel("Promised by", { exact: true }).fill(offset(5));
  await drawer.getByLabel("Set a next action").check();
  await drawer
    .getByLabel("Next action", { exact: true })
    .fill("Confirm the transfer landed");
  await drawer.getByLabel("Next action due", { exact: true }).fill(offset(6));
  await drawer
    .getByLabel("Responsible", { exact: true })
    .selectOption({ index: 1 });
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(section).toContainText("Paused · promised by");
  await expect(section).toContainText("Confirm the transfer landed");
  await expect(section).toContainText("Payment is in Friday's run.");

  // A dispute pauses reminders until it is resolved.
  await section
    .getByRole("button", { name: `Mark ${number} disputed`, exact: true })
    .click();
  await drawer.getByLabel("Disputed amount (PKR)").fill("50000");
  await drawer
    .getByLabel("What the customer disputes", { exact: true })
    .fill("Second deliverable not received.");
  await drawer
    .getByLabel("Dispute owner", { exact: true })
    .selectOption({ index: 1 });
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(section).toContainText("Paused · in dispute");
  await expect(section).toContainText("PKR 50,000.00 in dispute");
  await section
    .getByRole("button", {
      name: `Resolve dispute on ${number}`,
      exact: true,
    })
    .click();
  await drawer
    .getByLabel("How it was resolved", { exact: true })
    .fill("Deliverable re-sent and accepted.");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(section).toContainText("Paused · promised by");

  // A blocking hold stops the next invoice on the server, then is released.
  await section
    .getByRole("button", { name: "Place credit hold", exact: true })
    .click();
  await drawer.getByLabel("Effect", { exact: true }).selectOption("block");
  await drawer
    .getByLabel("Reason", { exact: true })
    .fill("Overdue beyond agreed terms.");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  const holds = page.getByRole("region", { name: "Credit holds" });
  const hold = holds.getByRole("listitem").filter({ hasText: customerName });
  await expect(hold).toContainText("New quotes and invoices blocked");
  const next = await draft();
  const refused = await post({ action: "invoice.issue", id: next });
  expect(refused.status()).toBe(409);
  expect(await refused.text()).toContain("credit hold");
  await hold.getByRole("button", { name: "Release hold", exact: true }).click();
  await drawer
    .getByLabel("Why the hold is released", { exact: true })
    .fill("Payment plan agreed.");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(hold).toHaveCount(0);
  await command({ action: "invoice.issue", id: next });

  // The contact and its task are on the customer's own record.
  const after = await (await page.request.get("/api/data")).json();
  expect(
    after.collectionContacts.some(
      (c: { company_id: string; next_action: string }) =>
        c.company_id === customer.id &&
        c.next_action === "Confirm the transfer landed",
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#collections");
  await expect(section).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);

  // Someone without accounting access is not offered the screen.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose a sample role" }),
  ).toBeVisible();
  await signIn(page, "Sales rep");
  await expect(
    page.getByRole("link", { name: "Collections", exact: true }),
  ).toHaveCount(0);
});
