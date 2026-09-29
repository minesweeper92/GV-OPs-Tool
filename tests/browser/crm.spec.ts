import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID as uuid } from "node:crypto";

async function fixture(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const me = await (await page.request.get("/api/me")).json();
  const data = await (await page.request.get("/api/data")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/commands", {
      headers: { origin: "http://127.0.0.1:4322", "x-csrf-token": me.csrf },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const company = (
    await command({
      action: "company.create",
      name: `CRM browser ${uuid().slice(0, 8)}`,
      customer: true,
      vendor: false,
      service_entity_id: null,
    })
  ).id;
  const contact = (
    await command({
      action: "contact.create",
      first_name: "CRM Buyer",
      email: "",
      company_id: company,
      role: "Buyer",
    })
  ).id;
  const entity = data.entities.find((e: any) => e.code === "PVT").id;
  const lead = (
    await command({
      action: "lead.create",
      company_id: company,
      contact_id: contact,
      entity_id: entity,
      title: "CRM browser video",
      next_action: "Discuss brief",
      due_date: "2026-01-01",
    })
  ).id;
  return { company, contact, entity, lead };
}

test("rich profiles persist, secondary email is searchable and mobile editor is accessible", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { company, contact, entity } = await fixture(page);
  const secondary = `crm-${uuid()}@example.test`;
  await page.goto(`/?view=contact/${contact}`);
  await page.getByRole("button", { name: "Edit contact", exact: true }).click();
  await page
    .getByLabel("Job title", { exact: true })
    .fill("Marketing director");
  await page.getByRole("button", { name: "Add email", exact: true }).click();
  await page.getByLabel("Email 2", { exact: true }).fill(secondary);
  await page.getByRole("button", { name: "Add phone", exact: true }).click();
  await page.getByLabel("Phone 2", { exact: true }).fill("+92 300 0000000");
  await page.getByLabel("Tags (comma separated)").fill("Video, Website");
  await page.getByLabel("Usually serviced by").selectOption(entity);
  await page.getByLabel("Default currency").selectOption("USD");
  await page.getByLabel("Marketing consent").selectOption("Opted out");
  await page.getByLabel("Consent date").fill("2026-01-01");
  await page.getByLabel("Consent source / evidence").fill("Client request");
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText(secondary, { exact: false }).first(),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  const saved = data.contacts.find((c: any) => c.id === contact);
  expect(saved.additional_emails[0].value).toBe(secondary);
  expect(saved.currency).toBe("USD");
  expect(saved.marketing_consent).toBe("Opted out");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?view=contacts");
  await page.getByLabel("Search this view").fill(secondary);
  await expect(
    page.getByRole("link", { name: "CRM Buyer", exact: true }),
  ).toBeVisible();
  await page.goto(`/?view=company/${company}`);
  await page.getByRole("button", { name: "Edit company", exact: true }).click();
  await page.getByLabel("Trading name").fill("Browser Studio");
  await page.getByLabel("Shipping address").fill("Sample delivery address");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Browser Studio", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("lead closure, manual correspondence and tasks survive conversion and completion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { lead, contact } = await fixture(page);
  await page.goto(`/?view=lead/${lead}`);
  await page.getByRole("button", { name: "Update lead", exact: true }).click();
  await page.getByLabel("Lead status").selectOption("Disqualified");
  await expect(page.getByLabel("Next action", { exact: true })).toHaveCount(0);
  await page
    .getByLabel("Disqualification reason")
    .fill("Client postponed project");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Qualify & create deal" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Update lead", exact: true }).click();
  await page.getByLabel("Lead status").selectOption("Connected");
  await page
    .getByLabel("Next action", { exact: true })
    .fill("Prepare director options");
  await page.getByLabel("Next action due").fill("2026-01-02");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Log activity", exact: true }).click();
  await page.getByLabel("Activity kind").selectOption("Email");
  await page
    .getByLabel("Subject", { exact: true })
    .fill("Director options discussed");
  await page
    .getByLabel("Reference link (HTTPS)")
    .fill("https://outlook.office.com/mail/");
  await page
    .getByLabel("Activity notes")
    .fill("Two alternatives requested; manual record only.");
  await page
    .getByRole("button", { name: "Save activity", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel("Task title").fill("Prepare two director costs");
  await page.getByLabel("Due at (local time)").fill("2026-01-02T10:00");
  await page.getByLabel("Priority", { exact: true }).selectOption("High");
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Qualify & create deal" }).click();
  await page.getByRole("link", { name: "Open linked deal" }).click();
  await expect(
    page.getByText("Director options discussed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Prepare two director costs" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "test-results/crm-deal-review.png",
    fullPage: true,
  });
  await page.goto("/?view=home");
  await expect(
    page.getByRole("heading", { name: "My tasks", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Prepare two director costs", { exact: true }),
  ).toBeVisible();
  await page.goto("/?view=tasks");
  await page.getByRole("button", { name: "Review task", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByLabel("Task status").selectOption("Done");
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("Prepare two director costs", { exact: true }),
  ).toHaveCount(0);
  await page.goto(`/?view=contact/${contact}`);
  await expect(
    page.getByText("Director options discussed", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Done", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});
