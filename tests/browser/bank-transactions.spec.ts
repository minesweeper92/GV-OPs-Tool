import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("money with no document behind it is recorded against the right accounts", async ({
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
  await page.goto("/#banking");
  await page
    .getByRole("button", { name: "Add bank account", exact: true })
    .click();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption({ label: "AOP · Sample Partnership" });
  await page.getByLabel("Account name", { exact: true }).fill("QA Cash Box");
  await page
    .getByLabel("Account label / last four digits", { exact: true })
    .fill("CASH");
  await page
    .getByLabel("Opening balance date", { exact: true })
    .fill("2026-08-31");
  await page
    .getByLabel("Verified opening balance (PKR)", { exact: true })
    .fill("5000");
  await page
    .getByLabel("Opening balance offset", { exact: true })
    .selectOption("3900");
  await page
    .getByRole("button", { name: "Create bank account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "QA Cash Box", exact: true }),
  ).toBeVisible();

  // An owner drawing: one allocation mirrors the amount automatically.
  await page
    .getByRole("button", { name: "Record transaction", exact: true })
    .click();
  const drawer = page.getByRole("dialog");
  await drawer
    .getByLabel("Common purpose", { exact: true })
    .selectOption("Owner drawing");
  await expect(drawer.getByLabel("Money out", { exact: true })).toBeChecked();
  await drawer.getByLabel("Date", { exact: true }).fill("2026-09-10");
  await drawer.getByLabel("Amount · PKR", { exact: true }).fill("1000");
  await drawer
    .getByLabel("Account 1", { exact: true })
    .selectOption({ label: "3000 · Owner equity" });
  await expect(drawer.getByRole("status")).toContainText("Balanced");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await drawer
    .getByRole("button", { name: "Review transaction", exact: true })
    .click();
  await expect(
    drawer.getByRole("heading", { name: "Review before posting" }),
  ).toBeFocused();
  await expect(drawer).toContainText("Sample Partnership");
  await expect(drawer).toContainText("2026-09-10");
  await drawer
    .getByRole("button", { name: "Post transaction", exact: true })
    .click();
  await expect(drawer).not.toBeVisible();

  // Interest less a charge: two allocations must explain the amount received.
  await page
    .getByRole("button", { name: "Record transaction", exact: true })
    .click();
  await drawer.getByLabel("Money in", { exact: true }).check();
  await drawer.getByLabel("Date", { exact: true }).fill("2026-09-30");
  await drawer.getByLabel("Amount · PKR", { exact: true }).fill("500");
  await drawer
    .getByLabel("Description", { exact: true })
    .fill("Profit on deposit less bank charge");
  await drawer
    .getByLabel("Account 1", { exact: true })
    .selectOption({ label: "4000 · Service revenue" });
  await drawer.getByLabel("Credit 1", { exact: true }).fill("600");
  await drawer
    .getByRole("button", { name: "Add allocation", exact: true })
    .click();
  await drawer
    .getByLabel("Account 2", { exact: true })
    .selectOption({ label: "5300 · Bank charges" });
  await drawer.getByLabel("Debit 2", { exact: true }).fill("50");
  await expect(drawer.getByRole("status")).toContainText("must explain");
  await expect(
    drawer.getByRole("button", { name: "Review transaction", exact: true }),
  ).toBeDisabled();
  await drawer.getByLabel("Debit 2", { exact: true }).fill("100");
  await expect(drawer.getByRole("status")).toContainText("Balanced");
  // Control and bank accounts are not offered.
  await expect(
    drawer
      .getByLabel("Account 2", { exact: true })
      .locator("option", { hasText: "1100" }),
  ).toHaveCount(0);
  await drawer
    .getByRole("button", { name: "Review transaction", exact: true })
    .click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await drawer
    .getByRole("button", { name: "Post transaction", exact: true })
    .click();
  await expect(drawer).not.toBeVisible();

  await page.goto("/#banking");
  await expect(
    page.getByRole("row").filter({ hasText: "QA Cash Box" }),
  ).toContainText("4,500.00");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "QA Cash Box" }).click();
  await page
    .getByRole("button", { name: "Record transaction", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("bank drafts survive close and reload, require fresh review, and retry a lost response without duplicating", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  await page.goto("/#banking");
  await page.getByRole("link", { name: "QA Cash Box" }).click();
  await page
    .getByRole("button", { name: "Record transaction", exact: true })
    .click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("Date", { exact: true }).fill("2026-09-30");
  await drawer.getByLabel("Amount · PKR", { exact: true }).fill("75");
  await drawer
    .getByLabel("Description", { exact: true })
    .fill("Retained bank charge");
  await drawer.getByLabel("Reference", { exact: true }).fill("RECOVERY-1");
  await drawer.getByLabel("Account 1", { exact: true }).selectOption("5300");
  await drawer
    .getByLabel("Note 1", { exact: true })
    .fill("Keep this allocation");
  await drawer.getByRole("button", { name: "Close · keep draft" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Record transaction", exact: true })
    .click();
  await expect(drawer.getByLabel("Description", { exact: true })).toHaveValue(
    "Retained bank charge",
  );
  await expect(drawer.getByLabel("Reference", { exact: true })).toHaveValue(
    "RECOVERY-1",
  );
  await expect(drawer.getByLabel("Note 1", { exact: true })).toHaveValue(
    "Keep this allocation",
  );
  await expect(
    drawer.getByRole("button", { name: "Post transaction", exact: true }),
  ).toHaveCount(0);
  // Malformed amounts must not silently turn into zero allocations.
  await drawer.getByLabel("Credit 1", { exact: true }).fill("oops");
  await expect(
    drawer.getByRole("button", { name: "Review transaction", exact: true }),
  ).toBeDisabled();
  await drawer.getByLabel("Credit 1", { exact: true }).fill("");
  await drawer
    .getByRole("button", { name: "Review transaction", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.route(
    "**/api/commands",
    async (route) => {
      if (route.request().postDataJSON()?.action !== "bank.transaction")
        return route.continue();
      await route.fetch(); // Commit, but lose the response, as on an interrupted connection.
      await route.abort("failed");
    },
    { times: 1 },
  );
  await drawer
    .getByRole("button", { name: "Post transaction", exact: true })
    .click();
  await expect(drawer.getByRole("alert")).toBeVisible();
  await drawer.getByRole("button", { name: "Close · keep draft" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Record transaction", exact: true })
    .click();
  await drawer
    .getByRole("button", { name: "Review transaction", exact: true })
    .click();
  await drawer
    .getByRole("button", { name: "Post transaction", exact: true })
    .click();
  await expect(drawer).not.toBeVisible();
  await page.goto("/#banking");
  await expect(
    page.getByRole("row").filter({ hasText: "QA Cash Box" }),
  ).toContainText("4,425.00");
  await page.getByRole("link", { name: "QA Cash Box" }).click();
  await page
    .getByRole("button", { name: "Record transaction", exact: true })
    .click();
  await expect(drawer.getByLabel("Description", { exact: true })).toHaveValue(
    "",
  );
  await drawer.getByLabel("Description", { exact: true }).fill("Discard me");
  page.once("dialog", (d) => d.accept());
  await drawer.getByRole("button", { name: "Discard draft" }).click();
  await expect(drawer.getByLabel("Description", { exact: true })).toHaveValue(
    "",
  );
  await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
  // A blocked browser must never claim that an entry was retained.
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw Error("Blocked");
    };
  });
  await page
    .getByRole("button", { name: "Record transaction", exact: true })
    .click();
  await drawer.getByLabel("Description", { exact: true }).fill("Unsaved entry");
  await expect(drawer).toContainText("Draft storage is unavailable");
  page.once("dialog", (d) => d.dismiss());
  await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(drawer).toBeVisible();
});
