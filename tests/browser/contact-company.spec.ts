import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

async function openContact(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await page.getByRole("button", { name: "New contact", exact: true }).click();
}

test("inline company creation preserves a rich contact draft and saves its affiliation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openContact(page);
  const firstName = `Inline ${randomUUID().slice(0, 8)}`;
  const companyName = `Studio ${randomUUID().slice(0, 8)}`;
  const email = `${randomUUID()}@example.test`;
  await page.getByLabel("First name", { exact: true }).fill(firstName);
  await page.getByLabel("Last name", { exact: true }).fill("Ali");
  await page.getByLabel("Primary email", { exact: true }).fill(email);
  await page
    .getByLabel("Primary phone", { exact: true })
    .fill("+92 300 1234567");
  await page
    .getByLabel("Job title", { exact: true })
    .fill("Marketing director");
  await page
    .getByText("Full details and custom fields", { exact: true })
    .click();
  await page.getByLabel("Department", { exact: true }).fill("Brand marketing");
  await page
    .getByRole("button", { name: "Add custom field", exact: true })
    .click();
  await page.getByLabel("Custom field 1 name").fill("Client tier");
  await page.getByLabel("Custom field 1 value").fill("Priority");
  await page.getByRole("button", { name: "Add company", exact: true }).click();
  await expect(
    page.getByLabel("New company name", { exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("New company name", { exact: true }).fill(companyName);
  await page
    .getByLabel("Company website (optional)")
    .fill("studio.example.test");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "test-results/contact-company-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByLabel("New company name", { exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/contact-company-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create & select company", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Add a company", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Company", { exact: true })).toBeFocused();
  const companyId = await page
    .getByLabel("Company", { exact: true })
    .inputValue();
  expect(companyId).not.toBe("");
  await expect(page.getByLabel("First name", { exact: true })).toHaveValue(
    firstName,
  );
  await expect(page.getByLabel("Primary email", { exact: true })).toHaveValue(
    email,
  );
  await expect(page.getByLabel("Department", { exact: true })).toHaveValue(
    "Brand marketing",
  );
  await expect(page.getByLabel("Custom field 1 value")).toHaveValue("Priority");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  const data = await (await page.request.get("/api/data")).json();
  const contact = data.contacts.find((c: any) => c.first_name === firstName);
  expect(contact.last_name).toBe("Ali");
  expect(contact.phone).toBe("+92 300 1234567");
  expect(contact.title).toBe("Marketing director");
  expect(contact.profile.department).toBe("Brand marketing");
  expect(contact.profile.custom_fields[0].value).toBe("Priority");
  expect(data.companies.find((c: any) => c.id === companyId).name).toBe(
    companyName,
  );
  expect(
    data.affiliations.some(
      (a: any) => a.contact_id === contact.id && a.company_id === companyId,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("Back, Escape and duplicate selection preserve contact and company drafts", async ({
  page,
}) => {
  await openContact(page);
  const data = await (await page.request.get("/api/data")).json();
  const company = data.companies[0];
  await page.getByLabel("First name", { exact: true }).fill("Draft contact");
  await page.getByLabel("Company", { exact: true }).selectOption(company.id);
  await page.getByRole("button", { name: "Add company", exact: true }).click();
  await page
    .getByLabel("New company name", { exact: true })
    .fill("Unfinished company");
  await page
    .getByRole("button", { name: "Back to contact", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add company", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("Company", { exact: true })).toHaveValue(
    company.id,
  );
  await expect(page.getByLabel("First name", { exact: true })).toHaveValue(
    "Draft contact",
  );
  await page.getByRole("button", { name: "Add company", exact: true }).click();
  await expect(
    page.getByLabel("New company name", { exact: true }),
  ).toHaveValue("Unfinished company");
  await page.getByLabel("New company name", { exact: true }).press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Add company", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Add company", exact: true }).click();
  await page.getByLabel("New company name", { exact: true }).fill(company.name);
  await expect(
    page.getByRole("button", { name: "Create & select company", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: `Use ${company.name}`, exact: false })
    .click();
  await expect(page.getByLabel("Company", { exact: true })).toHaveValue(
    company.id,
  );
  await expect(page.getByLabel("Company", { exact: true })).toBeFocused();
  const after = await (await page.request.get("/api/data")).json();
  expect(after.companies.length).toBe(data.companies.length);
});

test("company can be created before contact is complete and safely retried after a lost response", async ({
  page,
}) => {
  await openContact(page);
  await page.getByRole("button", { name: "Add company", exact: true }).click();
  await page
    .getByRole("button", { name: "Create & select company", exact: true })
    .click();
  await expect(
    page.getByText("Enter the company name.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("New company name", { exact: true }),
  ).toBeFocused();
  const name = `Retry ${randomUUID().slice(0, 8)}`;
  const keys: string[] = [];
  await page.route("**/api/commands", async (route) => {
    const payload = route.request().postDataJSON();
    if (payload.action !== "company.create") return route.continue();
    keys.push(payload.request_key);
    if (keys.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      // The server committed, but the browser never received the success.
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel("New company name", { exact: true }).fill(name);
  await page.getByLabel("New company name", { exact: true }).press("Enter");
  await expect(
    page.getByRole("region", { name: "Add a company" }).getByRole("alert"),
  ).toBeVisible();
  await expect(
    page.getByLabel("New company name", { exact: true }),
  ).toHaveValue(name);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Create & select company", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Add a company", exact: true }),
  ).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await expect(page.getByLabel("First name", { exact: true })).toHaveValue("");
  const data = await (await page.request.get("/api/data")).json();
  const companies = data.companies.filter((c: any) => c.name === name);
  expect(companies).toHaveLength(1);
  await expect(page.getByLabel("Company", { exact: true })).toHaveValue(
    companies[0].id,
  );
});
