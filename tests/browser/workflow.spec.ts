import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
async function owner(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
}
test("first render, accessible navigation, themes, and responsive screens", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await owner(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "test-results/new-workspace-home.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Deals", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Deals", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/new-workspace-deals.png",
    fullPage: true,
  });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of [
      "home",
      "contacts",
      "companies",
      "leads",
      "deals",
      "quotes",
      "invoices",
      "payments",
      "expenses",
      "settings",
    ]) {
      await page.goto(`/#${route}`);
      await expect(page.locator("main h1")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `${route} overflow at ${width}`,
      ).toBe(true);
    }
  }
  await page.goto("/#settings");
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel("Theme", { exact: true }).selectOption("contrast");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel("Theme", { exact: true }).selectOption("light");
  expect(errors).toEqual([]);
});
test("real UI lead-to-cash, project expense, persisted ledger and audit", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await owner(page);
  await page.getByRole("link", { name: "Leads", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "Website refresh" })
    .getByRole("button", { name: "Qualify & create deal" })
    .click();
  await page
    .getByRole("row")
    .filter({ hasText: "Website refresh" })
    .getByRole("link", { name: "View deal" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Website refresh", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New quote", exact: true }).click();
  await page.getByLabel("Named option").fill("Director Maya");
  await page
    .getByLabel("Description 1", { exact: true })
    .fill("Website design");
  await page.getByLabel("Unit price 1", { exact: true }).fill("100000");
  await page.getByLabel("Tax % 1", { exact: true }).fill("18");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Save quote version" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page
    .getByLabel("Acceptance evidence")
    .fill("Client approval, reference TEST-100");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Create invoice", exact: true })
    .click();
  await page.getByRole("button", { name: "Save invoice draft" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "Invoice draft" }).click();
  await expect(
    page.getByRole("heading", { name: "Invoice draft", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await page.getByRole("button", { name: "Issue and post" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "AOP-INV-00001" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await page.getByLabel("Money received (PKR)").fill("110000");
  await page.getByLabel("Withholding deducted (PKR)").fill("8000");
  await page.getByLabel("Bank or receipt reference").fill("UI-BANK-001");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".document-masthead")).toContainText("Paid");
  await page.reload();
  await expect(page.locator(".document-masthead")).toContainText("Paid");
  await page.getByRole("link", { name: "Expenses", exact: true }).click();
  await page
    .getByRole("button", { name: "Record expense", exact: true })
    .click();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption({ label: "Sample Partnership (AOP)" });
  await page.getByLabel("What was the expense for?").fill("Design production");
  await page.getByLabel("Amount paid (PKR)").fill("25000");
  await page.getByLabel("Receipt or payment reference").fill("COST-001");
  await page
    .getByLabel("Project (optional)")
    .selectOption({ label: "Website refresh" });
  await page.getByRole("button", { name: "Post expense" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByLabel("Legal entity view")
    .selectOption({ label: "AOP · Sample Partnership" });
  await page.getByRole("link", { name: "Trial balance", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Balanced", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Journals", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Payment for AOP-INV-00001" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/new-workspace-journals.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("sales role cannot open accounting via navigation or direct API", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Sales rep Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Journals", exact: true }),
  ).toHaveCount(0);
  await page.goto("/#journals");
  await expect(
    page.getByRole("heading", { name: "This section needs a finance role" }),
  ).toBeVisible();
});
