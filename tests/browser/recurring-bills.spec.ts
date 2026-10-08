import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
test("recurring vendor bill draft recovery, lost-response retry and reviewed posting work through the UI", async ({
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
  const vendorName = `Recurring vendor ${randomUUID()}`;
  const response = await page.request.post("/api/commands", {
    headers: { origin: "http://127.0.0.1:4322", "x-csrf-token": me.csrf },
    data: {
      action: "company.create",
      name: vendorName,
      vendor: true,
      customer: false,
      service_entity_id: null,
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.goto("/?view=recurring-bills");
  await page
    .getByRole("button", { name: "New recurring bill", exact: true })
    .click();
  const form = page.getByRole("dialog"),
    name = `Monthly office lease ${randomUUID()}`;
  await form.getByLabel("Schedule name", { exact: true }).fill(name);
  await form
    .getByLabel("Vendor", { exact: true })
    .selectOption({ label: vendorName });
  await form.getByLabel("Maximum cycles (optional)", { exact: true }).fill("1");
  await form.getByLabel("description 1", { exact: true }).fill("Office lease");
  await form.getByLabel("price 1", { exact: true }).fill("25000");
  await form
    .getByLabel("Bill notes", { exact: true })
    .fill("Review the vendor invoice before approval.");
  await form.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "New recurring bill", exact: true })
    .click();
  await expect(form.getByLabel("Schedule name", { exact: true })).toHaveValue(
    name,
  );
  await expect(form.getByLabel("price 1", { exact: true })).toHaveValue(
    "25000",
  );
  const violations = (
    await new AxeBuilder({ page }).analyze()
  ).violations.filter((v) => ["serious", "critical"].includes(v.impact || ""));
  expect(violations).toEqual([]);
  let lost = false;
  await page.route("**/api/commands", async (route) => {
    if (
      route.request().postDataJSON().action === "bill-schedule.create" &&
      !lost
    ) {
      lost = true;
      const r = await route.fetch();
      expect(r.ok()).toBeTruthy();
      await route.abort("failed");
    } else await route.continue();
  });
  await form
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await expect(form.getByRole("alert")).toBeVisible();
  await form
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await expect(form).not.toBeVisible();
  await page.unroute("**/api/commands");
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  let data = await (await page.request.get("/api/data")).json();
  const schedules = data.billSchedules.filter((p: any) => p.name === name);
  expect(schedules).toHaveLength(1);
  if (schedules[0].status === "Active")
    await page
      .getByRole("button", { name: "Generate next draft", exact: true })
      .click();
  await expect(page.getByText("Draft created", { exact: true })).toBeVisible();
  data = await (await page.request.get("/api/data")).json();
  const cycles = data.billScheduleOccurrences.filter(
    (o: any) => o.schedule_id === schedules[0].id,
  );
  expect(cycles).toHaveLength(1);
  expect(data.bills.find((b: any) => b.id === cycles[0].bill_id).status).toBe(
    "Draft",
  );
  await page.getByRole("link", { name: /Recurring draft/ }).click();
  await page
    .getByRole("button", { name: "Submit for approval", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Approve & post", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm & post", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Record vendor payment", exact: true }),
  ).toBeVisible();
  await page.goto("/?view=recurring-bills");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "New recurring bill", exact: true })
    .click();
  await expect(form.getByLabel("Schedule name", { exact: true })).toHaveValue(
    "",
  );
  await form
    .getByLabel("Schedule name", { exact: true })
    .fill("Discarded draft");
  page.once("dialog", (d) => d.accept());
  await form.getByRole("button", { name: "Discard", exact: true }).click();
  await page
    .getByRole("button", { name: "New recurring bill", exact: true })
    .click();
  await expect(form.getByLabel("Schedule name", { exact: true })).toHaveValue(
    "",
  );
  expect(errors).toEqual([]);
});
