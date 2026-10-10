import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { testOrigin } from "./test-origin";

test("bill recovery preserves retry identity and edit drafts can be resumed or discarded", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const me = await (await page.request.get("/api/me")).json();
  const data = await (await page.request.get("/api/data")).json();
  const response = await page.request.post("/api/commands", {
    headers: { origin: testOrigin, "x-csrf-token": me.csrf },
    data: {
      action: "company.create",
      name: `Draft vendor ${randomUUID().slice(0, 8)}`,
      vendor: true,
      customer: false,
      service_entity_id: null,
    },
  });
  expect(response.ok()).toBeTruthy();
  const vendor = (await response.json()).id;
  await page.goto("/?view=bills");
  await page.getByRole("button", { name: "New bill", exact: true }).click();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption(data.entities[0].id);
  await page.getByLabel("Vendor", { exact: true }).selectOption(vendor);
  const reference = `DRAFT-${randomUUID().slice(0, 8)}`;
  await page.getByLabel("Vendor bill number", { exact: true }).fill(reference);
  await page
    .getByLabel("Description 1", { exact: true })
    .fill("Project equipment hire");
  await page.getByLabel("Unit cost before tax 1", { exact: true }).fill("1000");
  let intercepted = false;
  await page.route("**/api/commands", async (route) => {
    if (
      !intercepted &&
      route.request().postDataJSON().action === "bill.create"
    ) {
      intercepted = true;
      const result = await route.fetch();
      expect(result.ok(), await result.text()).toBeTruthy();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Save bill draft", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page.getByRole("button", { name: "New bill", exact: true }).click();
  await expect(
    page.getByLabel("Vendor bill number", { exact: true }),
  ).toHaveValue(reference);
  await page
    .getByRole("button", { name: "Save bill draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: reference, exact: true }),
  ).toBeVisible();
  const saved = await (await page.request.get("/api/data")).json();
  expect(
    saved.bills.filter((bill: any) => bill.reference === reference),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page
    .getByLabel("Notes", { exact: true })
    .fill("Resume this edited bill");
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue(
    "Resume this edited bill",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("");
});
