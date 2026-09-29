import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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
  await page.getByRole("button", { name: "Reverse this journal" }).click();
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
