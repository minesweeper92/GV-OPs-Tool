import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID as uuid } from "node:crypto";
import { initialSalesDefaults } from "../../shared/document-defaults";

async function setup(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const me = await (await page.request.get("/api/me")).json();
  const command = async (data: unknown) => {
    const r = await page.request.post("/api/commands", {
      headers: { origin: new URL(page.url()).origin, "x-csrf-token": me.csrf },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const entity = await command({
    action: "entity.create",
    name: `Defaults QA ${uuid().slice(0, 8)}`,
    code: `D${uuid().slice(0, 6).toUpperCase()}`,
    address: "Fictional office",
    tax_id: "",
  });
  await page.goto("/?view=settings");
  await page.getByLabel("Defaults for legal entity").selectOption(entity.id);
  return { command, entity, me };
}

test("entity defaults recover and save, prefill new invoices/quotes, preserve edits and saved snapshots", async ({
  page,
}) => {
  const { command, entity } = await setup(page);
  await page
    .getByLabel("Default payment term", { exact: true })
    .selectOption("month-end");
  await page.getByLabel("Quote validity (days)", { exact: true }).fill("14");
  await page
    .getByLabel("Default quote customer notes", { exact: true })
    .fill("Quote entity note");
  await page
    .getByLabel("Default invoice customer notes", { exact: true })
    .fill("Invoice entity note");
  await page
    .getByLabel("Default invoice terms and conditions", { exact: true })
    .fill("Entity invoice terms");
  await page
    .getByLabel("Default payment instructions", { exact: true })
    .fill("Entity bank instructions");
  await expect(
    page.getByText("Unsaved settings are saved in this browser tab", {
      exact: false,
    }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Defaults for legal entity").selectOption(entity.id);
  await expect(
    page.getByLabel("Default invoice customer notes", { exact: true }),
  ).toHaveValue("Invoice entity note");
  await page
    .getByRole("button", { name: "Save document defaults", exact: true })
    .click();
  await expect(
    page.getByText(
      "Document defaults saved. Existing documents are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(/Version 1 · Owner/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const company = await command({
    action: "company.create",
    name: `Default customer ${uuid()}`,
    customer: true,
    vendor: false,
    service_entity_id: null,
  });
  const contact = await command({
    action: "contact.create",
    first_name: "Default",
    last_name: "QA",
    email: "",
    company_id: company.id,
    role: "Primary",
  });
  const lead = await command({
    action: "lead.create",
    company_id: company.id,
    contact_id: contact.id,
    entity_id: entity.id,
    title: `Default project ${uuid()}`,
    next_action: "Prepare quote",
    due_date: "2030-01-01",
  });
  const deal = await command({ action: "lead.convert", id: lead.id });
  await page.goto("/?view=invoices");
  await page.getByRole("button", { name: "New invoice", exact: true }).click();
  await page
    .getByLabel("Customer company", { exact: true })
    .selectOption(company.id);
  await page
    .getByLabel("Issuing legal entity", { exact: true })
    .selectOption(entity.id);
  await page.getByLabel("Invoice date", { exact: true }).fill("2028-02-05");
  await expect(page.getByLabel("Due date", { exact: true })).toHaveValue(
    "2028-02-29",
  );
  await expect(page.getByLabel("Customer notes", { exact: true })).toHaveValue(
    "Invoice entity note",
  );
  await expect(
    page.getByLabel("Terms & conditions", { exact: true }),
  ).toHaveValue("Entity invoice terms");
  await page
    .getByLabel("Customer notes", { exact: true })
    .fill("Deliberate custom note");
  await page.getByLabel("Due date", { exact: true }).fill("2028-03-15");
  await page.getByLabel("Invoice date", { exact: true }).fill("2028-02-06");
  await expect(page.getByLabel("Due date", { exact: true })).toHaveValue(
    "2028-03-15",
  );
  await page.getByLabel("Payment term", { exact: true }).selectOption("net15");
  await expect(page.getByLabel("Due date", { exact: true })).toHaveValue(
    "2028-02-21",
  );
  await page
    .getByLabel("Description 1", { exact: true })
    .fill("Defaults QA work");
  await page.getByLabel("Unit price 1", { exact: true }).fill("100");
  await page
    .getByRole("button", { name: "Save as draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "New invoice", exact: true }),
  ).toHaveCount(0);
  let data = await (await page.request.get("/api/data")).json();
  const invoice = data.invoices.find((i: any) => i.company_id === company.id);
  expect(invoice.details.customer_notes).toBe("Deliberate custom note");
  expect(invoice.details.payment_term.days).toBe(15);
  await page.getByRole("link", { name: "Quotes", exact: true }).click();
  await page
    .locator("main#main")
    .getByRole("button", { name: "New quote", exact: true })
    .click();
  await page
    .getByLabel("Customer name", { exact: true })
    .selectOption(company.id);
  await page
    .getByLabel("Related opportunity", { exact: true })
    .selectOption(deal.id);
  await page.getByLabel("Quote date", { exact: true }).fill("2028-02-05");
  await expect(page.getByLabel("Expiry date", { exact: true })).toHaveValue(
    "2028-02-19",
  );
  await expect(page.getByLabel("Customer notes", { exact: true })).toHaveValue(
    "Quote entity note",
  );
  await page
    .getByRole("button", { name: "Keep draft & close", exact: true })
    .click();
  await page.goto("/?view=settings");
  await page.getByLabel("Defaults for legal entity").selectOption(entity.id);
  await page
    .getByLabel("Default invoice customer notes", { exact: true })
    .fill("Changed later");
  await page
    .getByRole("button", { name: "Save document defaults", exact: true })
    .click();
  await expect(
    page.getByText(
      "Document defaults saved. Existing documents are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  data = await (await page.request.get("/api/data")).json();
  expect(
    data.invoices.find((i: any) => i.id === invoice.id).details.customer_notes,
  ).toBe("Deliberate custom note");
});

test("conflicting defaults keep the draft; explicit reload recovers the current version", async ({
  page,
}) => {
  const { command, entity } = await setup(page);
  await page
    .getByLabel("Default quote customer notes", { exact: true })
    .fill("My unsaved version");
  const data = await (await page.request.get("/api/data")).json();
  await command({
    action: "settings.sales-defaults",
    entity_id: entity.id,
    version: 0,
    request_key: uuid(),
    settings: {
      ...initialSalesDefaults(),
      quote_notes: "Another editor saved",
    },
  });
  await page
    .getByRole("button", { name: "Save document defaults", exact: true })
    .click();
  await expect(
    page
      .locator('form[aria-label="Document defaults form"]')
      .getByRole("alert"),
  ).toContainText("another session");
  await expect(
    page.getByLabel("Default quote customer notes", { exact: true }),
  ).toHaveValue("My unsaved version");
  await page.reload();
  await page.getByLabel("Defaults for legal entity").selectOption(entity.id);
  await expect(
    page.getByText("Another session saved newer defaults.", { exact: false }),
  ).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Discard and reload", exact: true })
    .click();
  await expect(
    page.getByLabel("Default quote customer notes", { exact: true }),
  ).toHaveValue("Another editor saved");
});

test("custom terms retain incomplete days without silently making them due on receipt", async ({
  page,
}) => {
  const { entity } = await setup(page);
  await page
    .getByRole("button", { name: "Add payment term", exact: true })
    .click();
  await page.getByLabel("Term 7 name", { exact: true }).fill("Net 21 custom");
  await page.getByLabel("Term 7 days", { exact: true }).fill("");
  await expect(page.getByLabel("Term 7 days", { exact: true })).toHaveValue("");
  await page.reload();
  await page.getByLabel("Defaults for legal entity").selectOption(entity.id);
  await expect(page.getByLabel("Term 7 days", { exact: true })).toHaveValue("");
  await page.getByLabel("Term 7 days", { exact: true }).fill("21");
  await page
    .getByLabel("Default payment term", { exact: true })
    .selectOption({ label: "Net 21 custom" });
  await page
    .getByRole("button", { name: "Save document defaults", exact: true })
    .click();
  await expect(
    page.getByText(
      "Document defaults saved. Existing documents are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  expect(
    data.documentDefaults
      .find((d: any) => d.entity_id === entity.id)
      .settings.terms.find((t: any) => t.name === "Net 21 custom").days,
  ).toBe(21);
});

test("a lost settings save response can be retried without creating another version", async ({
  page,
}) => {
  const { entity } = await setup(page);
  await page
    .getByLabel("Default quote customer notes", { exact: true })
    .fill("Retry-safe settings");
  let once = false;
  await page.route("**/api/commands", async (route) => {
    if (
      !once &&
      route.request().postDataJSON().action === "settings.sales-defaults"
    ) {
      once = true;
      const r = await route.fetch();
      expect(r.ok()).toBeTruthy();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Save document defaults", exact: true })
    .click();
  await expect(
    page
      .locator('form[aria-label="Document defaults form"]')
      .getByRole("alert"),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Defaults for legal entity").selectOption(entity.id);
  await page
    .getByRole("button", { name: "Save document defaults", exact: true })
    .click();
  await expect(
    page.getByText(
      "Document defaults saved. Existing documents are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  expect(
    data.documentDefaultsHistory.filter((h: any) => h.entity_id === entity.id),
  ).toHaveLength(1);
});
