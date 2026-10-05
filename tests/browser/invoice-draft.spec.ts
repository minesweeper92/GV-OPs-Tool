import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("invoice recovery retries a lost committed response without duplicating the invoice", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Invoices", exact: true })
    .click();
  await page.getByRole("button", { name: "New invoice", exact: true }).click();
  const data = await (await page.request.get("/api/data")).json();
  await page
    .getByLabel("Customer company", { exact: true })
    .selectOption(data.companies[0].id);
  await page
    .getByLabel("Issuing legal entity", { exact: true })
    .selectOption(data.entities[0].id);
  const subject = `Recovered invoice ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("Subject", { exact: true }).fill(subject);
  await page
    .getByLabel("Description 1", { exact: true })
    .fill("Strategy workshop");
  await page.getByLabel("Unit price 1", { exact: true }).fill("5000");
  await page.getByLabel("Adjustment (after tax)").fill("-");
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page.getByRole("button", { name: "New invoice", exact: true }).click();
  await expect(page.getByLabel("Adjustment (after tax)")).toHaveValue("-");
  await page.getByLabel("Adjustment (after tax)").fill("0");
  await page.getByLabel("Invoice date", { exact: true }).fill("");
  await expect(page.getByLabel("Due date", { exact: true })).toHaveValue("");
  await page.getByLabel("Invoice date", { exact: true }).fill("2026-10-04");
  await page.getByLabel("Due date", { exact: true }).fill("2026-10-30");
  let intercepted = false;
  await page.route("**/api/commands", async (route) => {
    if (
      !intercepted &&
      route.request().postDataJSON().action === "document.invoice-create"
    ) {
      intercepted = true;
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBeTruthy();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Save as draft", exact: true })
    .click();
  await expect(
    page.locator(".invoice-composer").getByRole("alert"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page.getByRole("button", { name: "New invoice", exact: true }).click();
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue(
    subject,
  );
  await expect(page.getByLabel("Due date", { exact: true })).toHaveValue(
    "2026-10-30",
  );
  await page
    .getByRole("button", { name: "Save as draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "New invoice", exact: true }),
  ).toHaveCount(0);
  const saved = await (await page.request.get("/api/data")).json();
  expect(
    saved.invoices.filter(
      (invoice: any) => invoice.details.subject === subject,
    ),
  ).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith("gv-invoice-draft-v1:"),
      ),
    ),
  ).toEqual([]);
});

test("discarded invoice fields do not return on the next create", async ({
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
  await page.getByLabel("Description 1", { exact: true }).fill("Discard me");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Close invoice", exact: true })
    .click();
  await page.getByRole("button", { name: "New invoice", exact: true }).click();
  await expect(page.getByLabel("Description 1", { exact: true })).toHaveValue(
    "",
  );
});
