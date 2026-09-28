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
      "vendors",
      "bills",
      "vendor-payments",
      "payables",
      "settings",
      "team",
      "organizations",
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

test("vendor bill approval, partial payments, balances and corrections reach the ledger", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) => dialog.accept());
  await owner(page);
  await page.getByRole("link", { name: "Vendors", exact: true }).click();
  await page.getByRole("button", { name: "New vendor", exact: true }).click();
  await page
    .getByLabel("Company name", { exact: true })
    .fill("Studio Supplies Test");
  await expect(page.getByLabel("Vendor", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "Bills", exact: true }).click();
  await page.getByRole("button", { name: "New bill", exact: true }).click();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption({ label: "Sample Private Limited (PVT)" });
  await page
    .getByLabel("Vendor", { exact: true })
    .selectOption({ label: "Studio Supplies Test" });
  await page
    .getByLabel("Vendor bill number", { exact: true })
    .fill("STUDIO-BILL-101");
  await page.getByLabel("Bill date", { exact: true }).fill("2026-09-20");
  await page.getByLabel("Due date", { exact: true }).fill("2026-10-20");
  await page
    .getByLabel("Project (optional)", { exact: true })
    .selectOption({ label: "Brand launch film" });
  await page
    .getByLabel("Description 1", { exact: true })
    .fill("Set design and lighting");
  await page.getByLabel("Account 1", { exact: true }).selectOption("5200");
  await page
    .getByLabel("Unit cost before tax 1", { exact: true })
    .fill("100000");
  await page.getByLabel("Tax % 1", { exact: true }).fill("18");
  await page
    .getByLabel("Purchase tax treatment", { exact: true })
    .selectOption("recoverable");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("button", { name: "Save bill draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "STUDIO-BILL-101", exact: true }),
  ).toBeVisible();
  const billUrl = page.url();
  await expect(page.getByText("Not posted", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Submit for approval", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Approve & post", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Record vendor payment", exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("button", { name: "Record vendor payment", exact: true })
    .click();
  await page.getByLabel("Payment date", { exact: true }).fill("2026-09-21");
  await page
    .getByLabel("Cash paid to vendor (PKR)", { exact: true })
    .fill("40000");
  await page
    .getByLabel("Withholding deducted (PKR)", { exact: true })
    .fill("10000");
  await page.getByLabel("Bank charge (PKR)", { exact: true }).fill("500");
  await page
    .getByLabel("Payment reference", { exact: true })
    .fill("VENDOR-BANK-1");
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  await expect(page.getByText("PKR 68,000.00", { exact: true })).toBeVisible();
  await page
    .getByRole("link", { name: "Payable balances", exact: true })
    .click();
  await expect(
    page.getByRole("row").filter({ hasText: "STUDIO-BILL-101" }),
  ).toContainText("PKR 68,000.00");
  await page.screenshot({
    path: "test-results/payable-balances.png",
    fullPage: true,
  });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.goto(billUrl);
  await page
    .getByRole("button", { name: "Record vendor payment", exact: true })
    .click();
  await page.getByLabel("Payment date", { exact: true }).fill("2026-09-22");
  await page
    .getByLabel("Payment reference", { exact: true })
    .fill("VENDOR-BANK-2");
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText("Paid", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/vendor-bill-paid.png",
    fullPage: true,
  });
  for (const ref of ["VENDOR-BANK-1", "VENDOR-BANK-2"]) {
    await page
      .getByRole("row")
      .filter({ hasText: ref })
      .getByRole("button", { name: "Reverse", exact: true })
      .click();
    await page
      .getByLabel("Reversal / cancellation date", { exact: true })
      .fill("2026-09-23");
    await page.getByLabel("Reason", { exact: true }).fill("QA correction");
    await page
      .getByRole("button", { name: "Record reversal", exact: true })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  await page.getByRole("button", { name: "Void bill", exact: true }).click();
  await page
    .getByLabel("Reversal / cancellation date", { exact: true })
    .fill("2026-09-24");
  await page.getByLabel("Reason", { exact: true }).fill("Cancelled purchase");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Void bill", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText("Voided", { exact: true })).toBeVisible();
  await page
    .getByLabel("Legal entity view", { exact: true })
    .selectOption({ label: "PVT · Sample Private Limited" });
  await page.getByRole("link", { name: "Journals", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Bill STUDIO-BILL-101 · Studio Supplies Test",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Void bill STUDIO-BILL-101: Cancelled purchase",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Trial balance", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "Accounts payable" }),
  ).toContainText("PKR 0.00");
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

test("team invitation, cancellation and member access are usable and audited", async ({
  page,
}) => {
  await owner(page);
  await page.getByRole("link", { name: "Team & access", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Team & access", exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: "test-results/new-workspace-team.png",
    fullPage: true,
  });
  await page.getByLabel("Teammate email").fill("invited@example.test");
  await page.getByLabel("Invitation role").selectOption("sales");
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(page.getByLabel("Invitation link")).toHaveValue(/#join\//);
  const invite = page
    .getByRole("row")
    .filter({ hasText: "invited@example.test" });
  await expect(invite).toContainText("Pending");
  page.on("dialog", (dialog) => dialog.accept());
  await invite.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(invite).toContainText("Revoked");
  await page
    .getByRole("button", { name: "Manage Read-only reviewer", exact: true })
    .click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByLabel("Organization access", { exact: true })
    .selectOption("removed");
  await page.getByRole("button", { name: "Save access", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Read-only reviewer" }),
  ).toContainText("Removed");
  await page
    .getByRole("button", { name: "Manage Read-only reviewer", exact: true })
    .click();
  await page
    .getByLabel("Organization access", { exact: true })
    .selectOption("active");
  await page.getByRole("button", { name: "Save access", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Manage Owner", exact: true }).click();
  await page.getByLabel("Role", { exact: true }).selectOption("viewer");
  await page.getByRole("button", { name: "Save access", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "at least one active administrator",
  );
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page.getByRole("link", { name: "Activity log", exact: true }).click();
  await expect(page.getByText("team · access changed").first()).toBeVisible();
});

test("organization creation and switching clear previous records", async ({
  page,
}) => {
  await owner(page);
  await page.getByRole("link", { name: /Switch organization:/ }).click();
  await page
    .getByRole("button", { name: "Create organization", exact: true })
    .click();
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Browser-created workspace");
  await page
    .getByLabel("First legal entity name")
    .fill("Browser Private Limited");
  await page.getByLabel("Entity code", { exact: true }).fill("BPL");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("button", { name: "Create and open", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: /Switch organization: Browser-created workspace/,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await expect(page.getByText("Maya Noor", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: /Switch organization:/ }).click();
  await page
    .locator(".access-card")
    .filter({ hasText: "Grid Velocity · sample" })
    .getByRole("button", { name: "Open organization" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await expect(page.getByText("Maya Noor", { exact: true })).toBeVisible();
});

test("an invited teammate accepts and opens the correct organization", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Separate organization · sample" })
    .click();
  await page.getByRole("link", { name: "Team & access", exact: true }).click();
  await page.getByLabel("Teammate email").fill("finance@example.test");
  await page.getByLabel("Invitation role").selectOption("finance");
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(page.getByLabel("Invitation link")).toHaveValue(/#join\//);
  const link = await page.getByLabel("Invitation link").inputValue();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose a sample role" }),
  ).toBeVisible();
  await page.goto(link);
  await page
    .getByRole("button", { name: "Accountant Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Invitations for finance@example.test" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(
    page.getByRole("link", {
      name: /Switch organization: Separate organization/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Team & access", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Companies", exact: true }).click();
  await expect(
    page.getByText("Meridian Creative", { exact: true }),
  ).toHaveCount(0);
});
