import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("an administrator narrows a teammate with a custom role", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  // Unique per run so repeated runs against one server do not collide.
  const roleName = `Books reviewer ${test.info().repeatEachIndex + 1}`;
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  // Wait for the session before navigating, or CI can race the sign-in.
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  await page.goto("/?view=team");
  await expect(
    page.getByRole("heading", { name: "Team & access", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "New custom role", exact: true })
    .click();
  await page.getByLabel("Role name", { exact: true }).fill(roleName);
  await page.getByLabel("Template", { exact: true }).selectOption("finance");
  const permissions = page.getByRole("group", { name: "Permissions" });
  await expect(permissions.getByRole("checkbox")).toHaveCount(3);
  // Removing view access also removes the dependent posting permission.
  await permissions
    .getByLabel("View accounting and banking", { exact: true })
    .uncheck();
  await expect(
    permissions.getByLabel("Record financial transactions", { exact: true }),
  ).not.toBeChecked();
  await permissions
    .getByLabel("View accounting and banking", { exact: true })
    .check();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Create role", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const role = page
    .getByRole("region", { name: "Custom roles" })
    .getByRole("row")
    .filter({ hasText: roleName });
  await expect(role).toContainText(
    "View accounting and banking, Maintain contacts and companies",
  );

  await page
    .getByRole("button", { name: "Manage Accountant", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Custom role", { exact: true })
    .selectOption({ label: roleName });
  await page.getByRole("button", { name: "Save access", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Accountant" }).first(),
  ).toContainText(`${roleName} (finance template)`);
  await page.screenshot({
    path: "test-results/custom-roles-team.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Accountant Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  await page.goto("/?view=invoices");
  await expect(
    page.getByRole("heading", { name: "Invoices", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New invoice", exact: true }),
  ).toHaveCount(0);
  // The server rejects posting even if a client sends the command anyway.
  const status = await page.evaluate(async () => {
    const me = await (await fetch("/api/me")).json();
    const r = await fetch("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": me.csrf },
      body: JSON.stringify({
        action: "entity.create",
        name: "Blocked",
        code: "BLK",
      }),
    });
    return { status: r.status, body: await r.text() };
  });
  expect(status.status).toBe(403);
  expect(status.body).toContain("does not allow this action");
});
