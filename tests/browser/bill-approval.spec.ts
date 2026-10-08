import { test, expect } from "@playwright/test";
test("bill approval rules save by entity and survive refresh", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  await page.goto("/?view=bills");
  await page
    .getByRole("button", { name: "Approval rules", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("checkbox", {
      name: "Allow finance to approve within the limit below",
    })
    .check();
  await dialog
    .getByLabel("Finance approval limit (PKR)", { exact: true })
    .fill("125000.50");
  await dialog
    .getByRole("checkbox", {
      name: "Bill creators cannot approve their own bills",
    })
    .check();
  await dialog.getByRole("button", { name: "Save approval rules" }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Approval rules", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Finance approval limit (PKR)", { exact: true }),
  ).toHaveValue("125000.50");
  await expect(
    dialog.getByRole("checkbox", {
      name: "Bill creators cannot approve their own bills",
    }),
  ).toBeChecked();
  // Restore the compatibility policy so other sample workflows are independent.
  await dialog
    .getByRole("checkbox", {
      name: "Allow finance to approve within the limit below",
    })
    .uncheck();
  await dialog
    .getByRole("checkbox", {
      name: "Bill creators cannot approve their own bills",
    })
    .uncheck();
  await dialog.getByRole("button", { name: "Save approval rules" }).click();
  await expect(dialog).not.toBeVisible();
});
