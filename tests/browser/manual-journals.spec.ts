import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

test("five-line journal draft survives navigation and reload without crossing entities or recurring forms", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  const pvt = data.entities.find((e: { code: string }) => e.code === "PVT");
  const aop = data.entities.find((e: { code: string }) => e.code === "AOP");
  await page.goto("/#journals");
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await page.getByRole("button", { name: "+ New manual journal" }).click();
  await page.getByLabel("Reference", { exact: true }).fill("DRAFT-FIVE");
  await page.getByLabel("Explanation").fill("Interrupted adjustment");
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "+ Add line", exact: true }).click();
  const lines = page
    .getByRole("group", { name: "Journal lines" })
    .locator(".manual-journal-line");
  for (let i = 0; i < 5; i++) {
    await lines
      .nth(i)
      .getByRole("combobox", { name: "Account", exact: true })
      .selectOption(i === 4 ? "3000" : "5000");
    await lines
      .nth(i)
      .getByLabel(i === 4 ? "Credit (PKR)" : "Debit (PKR)", { exact: true })
      .fill(i === 4 ? "100" : "25");
    await lines
      .nth(i)
      .getByLabel("Line note", { exact: true })
      .fill(`Retain line ${i + 1}`);
  }
  await page
    .getByRole("button", { name: "Review journal", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close · keep draft", exact: true })
    .click();
  await page.getByLabel("Legal entity view").selectOption(aop.id);
  await expect(
    page.getByRole("button", { name: "Resume draft", exact: true }),
  ).toHaveCount(0);
  await page.goto("/#journal-schedules");
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await expect(
    page.getByRole("button", { name: "Resume draft", exact: true }),
  ).toHaveCount(0);
  await page.goto("/#journals");
  await page.reload();
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await page.getByRole("button", { name: "Resume draft", exact: true }).click();
  await expect(page.getByLabel("Reference", { exact: true })).toHaveValue(
    "DRAFT-FIVE",
  );
  await expect(lines).toHaveCount(5);
  await expect(
    lines.nth(4).getByLabel("Line note", { exact: true }),
  ).toHaveValue("Retain line 5");
  await expect(
    page.getByRole("button", { name: "Post journal", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Review journal", exact: true })
    .click();
  await page.getByRole("button", { name: "Post journal", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Manual journal DRAFT-FIVE" }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await expect(
    page.getByRole("button", { name: "Resume draft", exact: true }),
  ).toHaveCount(0);
  await page.goto("/#journal-schedules");
  await page.getByRole("button", { name: "+ New recurring journal" }).click();
  await page.getByLabel("Schedule name").fill("Recover recurring pattern");
  await page
    .getByRole("combobox", { name: "Frequency", exact: true })
    .selectOption("quarterly");
  await page.getByLabel("Number of occurrences (optional)").fill("8");
  await page.reload();
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await page.getByRole("button", { name: "Resume draft", exact: true }).click();
  await expect(page.getByLabel("Schedule name")).toHaveValue(
    "Recover recurring pattern",
  );
  await expect(
    page.getByRole("combobox", { name: "Frequency", exact: true }),
  ).toHaveValue("quarterly");
  await expect(page.getByLabel("Number of occurrences (optional)")).toHaveValue(
    "8",
  );
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(page.getByLabel("Schedule name")).toHaveValue("");
});

test("manual journal review, posting and reversal work in the accounting UI", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  const entity = data.entities.find((e: { code: string }) => e.code === "PVT");
  await page.goto("/#journals");
  await page.getByLabel("Legal entity view").selectOption(entity.id);
  await expect(
    page.getByRole("heading", { name: "Journal entries" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "+ New manual journal" }).click();
  await page.getByLabel("Reference", { exact: true }).fill("UI-ADJ-001");
  await page.getByLabel("Explanation").fill("Move recorded cost to equipment");
  const lines = page
    .getByRole("group", { name: "Journal lines" })
    .locator(".manual-journal-line");
  await lines.nth(0).getByLabel("Account").selectOption("1500");
  await lines.nth(0).getByLabel("Debit (PKR)").fill("250.00");
  await lines.nth(1).getByLabel("Account").selectOption("5000");
  await lines.nth(1).getByLabel("Credit (PKR)").fill("250.00");
  await expect(page.getByText("Balanced", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review journal" }).click();
  await expect(
    page.getByText("The journal cannot be edited afterward", { exact: false }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Post journal" }).click();
  await expect(
    page.getByRole("heading", { name: "Manual journal UI-ADJ-001" }),
  ).toBeVisible();
  await expect(page.getByText("Move recorded cost to equipment")).toBeVisible();
  await page.screenshot({
    path: "test-results/manual-journal-posted.png",
    fullPage: true,
  });
  await page
    .locator("section")
    .filter({
      has: page.getByRole("heading", {
        name: "Manual journal UI-ADJ-001",
        exact: true,
      }),
    })
    .getByRole("button", { name: "Reverse this journal" })
    .click();
  await page.getByLabel("Reason").fill("Incorrect classification");
  await page.getByRole("button", { name: "Post reversal" }).click();
  await expect(
    page.getByRole("heading", { name: "Reversal of UI-ADJ-001" }),
  ).toBeVisible();
  await expect(page.getByText("Reversed by a later journal")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("recurring journals generate review drafts and scheduled reversals", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  const entity = data.entities.find((e: { code: string }) => e.code === "PVT");
  await page.goto("/#journal-schedules");
  await page.getByLabel("Legal entity view").selectOption(entity.id);
  await page.getByRole("button", { name: "+ New recurring journal" }).click();
  const prior = new Date();
  prior.setUTCMonth(prior.getUTCMonth() - 1, 15);
  const first = prior.toISOString().slice(0, 10);
  await page.getByLabel("First occurrence date").fill(first);
  await page.getByLabel("Schedule name").fill("UI monthly accrual");
  await page.getByLabel("Reference", { exact: true }).fill("UI-RECUR");
  await page.getByLabel("Explanation").fill("Accrue monthly cost");
  await page.getByLabel("Number of occurrences (optional)").fill("1");
  await page
    .getByLabel("Prepare a reversal for the first day of the following month")
    .check();
  const lines = page
    .getByRole("group", { name: "Journal lines" })
    .locator(".manual-journal-line");
  await lines.nth(0).getByLabel("Account").selectOption("5000");
  await lines.nth(0).getByLabel("Debit (PKR)").fill("42.50");
  await lines.nth(1).getByLabel("Account").selectOption("3000");
  await lines.nth(1).getByLabel("Credit (PKR)").fill("42.50");
  await page.getByRole("button", { name: "Review schedule" }).click();
  await expect(
    page.getByText("This creates a monthly schedule", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.getByText("UI monthly accrual")).toBeVisible();
  await page.getByRole("button", { name: "Generate due drafts" }).click();
  await expect(page.getByText("UI-RECUR-1")).toBeVisible();
  await page.getByRole("button", { name: "Review before posting" }).click();
  await page.getByRole("button", { name: "Post reviewed journal" }).click();
  await expect(page.getByText("Due", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Review reversal" }).click();
  await page.getByLabel("Reason").fill("Accrual reversed next month");
  await page.getByRole("button", { name: "Post exact reversal" }).click();
  await expect(page.getByText("Posted", { exact: true }).first()).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("account drafts recover create/edit details without crossing entities or overwriting concurrent edits", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  const pvt = data.entities.find((e: { code: string }) => e.code === "PVT");
  const aop = data.entities.find((e: { code: string }) => e.code === "AOP");
  const code = `D${randomUUID().slice(0, 6).toUpperCase()}`;
  await page.goto("/#accounts");
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account code").fill("D");
  await page.getByLabel("Account name").fill("Recovered account");
  await page.getByLabel("Parent account").selectOption("5000");
  await page.getByLabel("Description").fill("Retain unfinished setup");
  await page
    .getByRole("button", { name: "Close · keep account draft" })
    .click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "+ New account" }).click();
  await expect(
    page.getByRole("button", { name: "Resume account draft" }),
  ).toBeVisible();
  await page.getByLabel("Legal entity view").selectOption(aop.id);
  await expect(
    page.getByRole("button", { name: "Resume account draft" }),
  ).toHaveCount(0);
  await page.goto("/#journals");
  await page.goto("/#accounts");
  await page.reload();
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await page.getByRole("button", { name: "Resume account draft" }).click();
  await expect(page.getByLabel("Account code")).toHaveValue("D");
  await expect(page.getByLabel("Parent account")).toHaveValue("5000");
  await expect(page.getByLabel("Description")).toHaveValue(
    "Retain unfinished setup",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByLabel("Account code").fill(code);
  const retryKeys: string[] = [];
  await page.route("**/api/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.action !== "account.create") return route.continue();
    retryKeys.push(command.request_key);
    if (retryKeys.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.locator(".chart-of-accounts").getByRole("alert"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close · keep account draft" })
    .click();
  await page.reload();
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await page.getByRole("button", { name: "Resume account draft" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  const row = page.getByRole("row").filter({ hasText: code });
  await expect(row).toContainText("Recovered account");
  await expect(row).toHaveCount(1);
  expect(retryKeys).toHaveLength(2);
  expect(retryKeys[1]).toBe(retryKeys[0]);
  await page.unroute("**/api/commands");
  await expect(
    page.getByRole("button", { name: "Resume account draft" }),
  ).toHaveCount(0);
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Account name").fill("My unsaved changes");
  await page
    .getByRole("button", { name: "Close · keep account draft" })
    .click();
  const peer = await context.newPage();
  await peer.goto("/#accounts");
  await peer.getByLabel("Legal entity view").selectOption(pvt.id);
  await peer
    .getByRole("row")
    .filter({ hasText: code })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await peer.getByLabel("Account name").fill("Other tab saved first");
  await peer.getByRole("button", { name: "Save changes" }).click();
  await expect(peer.getByRole("row").filter({ hasText: code })).toContainText(
    "Other tab saved first",
  );
  await peer.close();
  await page.reload();
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await page.getByRole("button", { name: "Resume account draft" }).click();
  await expect(page.getByLabel("Account name")).toHaveValue(
    "My unsaved changes",
  );
  await expect(page.getByLabel("Account code")).toBeDisabled();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page
      .locator(".chart-of-accounts")
      .getByText("This account changed. Refresh before saving.", {
        exact: true,
      }),
  ).toBeVisible();
  await expect(page.getByLabel("Account name")).toHaveValue(
    "My unsaved changes",
  );
  await expect(row).toContainText("Other tab saved first");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard account draft" }).click();
  await page.reload();
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await expect(
    page.getByRole("button", { name: "Resume account draft" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    Storage.prototype.setItem = function () {
      throw Error("Storage blocked in this test");
    };
  });
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Keep me open");
  await expect(
    page.getByText(
      "Draft recovery is unavailable in this browser. Keep this page open or save before navigating away.",
    ),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Account name")).toHaveValue("Keep me open");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard account draft" }).click();
});

test("chart account creation, editing and deactivation are usable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  const entity = data.entities.find((e: { code: string }) => e.code === "PVT");
  const code = `A${randomUUID().slice(0, 6).toUpperCase()}`;
  await page.goto("/#accounts");
  await page.getByLabel("Legal entity view").selectOption(entity.id);
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account code").fill(code);
  await page.getByLabel("Account name").fill("Browser overhead");
  await page.getByLabel("Type").selectOption("Expense");
  await page.getByLabel("Parent account").selectOption("5000");
  await page.getByLabel("Description").fill("Team operating costs");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Create account" }).click();
  const row = page.getByRole("row").filter({ hasText: code });
  await expect(row).toContainText("Browser overhead");
  await expect(row).toContainText("Active");
  await page.screenshot({
    path: "test-results/chart-of-accounts.png",
    fullPage: true,
  });
  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Account name").fill("Studio overhead");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(row).toContainText("Studio overhead");
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(row).toContainText("Inactive");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
