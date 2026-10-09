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
async function nav(page: Page, group: string, label: string) {
  const toggle = page.getByRole("button", { name: group, exact: true });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await page.getByRole("link", { name: label, exact: true }).click();
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
      "tasks",
      "deals",
      "quotes",
      "invoices",
      "payments",
      "expenses",
      "vendors",
      "bills",
      "vendor-payments",
      "payables",
      "financial-reports",
      "banking",
      "projects",
      "credits",
      "recurring",
      "recurring-expenses",
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
test("accepted work to project, advance invoice, delivery recognition and profitability", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await owner(page);
  const me = await (await page.request.get("/api/me")).json(),
    data = await (await page.request.get("/api/data")).json();
  const entity = data.entities.find((e: any) => e.code === "PVT");
  const command = async (payload: Record<string, unknown>) => {
    const r = await page.request.post("/api/commands", {
      headers: { origin: "http://127.0.0.1:4322", "x-csrf-token": me.csrf },
      data: payload,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const company = (
    await command({
      action: "company.create",
      name: "Project browser client",
      customer: true,
      vendor: false,
      service_entity_id: null,
    })
  ).id;
  const contact = (
    await command({
      action: "contact.create",
      first_name: "Maya",
      email: "",
      company_id: company,
      role: "Client producer",
    })
  ).id;
  const lead = (
    await command({
      action: "lead.create",
      entity_id: entity.id,
      company_id: company,
      contact_id: contact,
      title: "Product launch film",
      next_action: "Approve quote",
      due_date: "2026-01-01",
    })
  ).id;
  const deal = (await command({ action: "lead.convert", id: lead })).id;
  const quote = (
    await command({
      action: "quote.create",
      deal_id: deal,
      option_name: "Director Maya",
      currency: "PKR",
      fx: "1",
      lines: [
        {
          description: "Launch film",
          quantity: "1",
          price: "100000",
          tax: "18",
        },
      ],
    })
  ).id;
  await command({
    action: "quote.accept",
    id: quote,
    reference: "QA approval",
  });
  await page.goto("/?view=projects");
  await page
    .getByRole("button", { name: "Start project", exact: true })
    .click();
  await page.getByLabel("Accepted quote").selectOption(quote);
  await page.getByLabel("Confirm issuing entity").selectOption(entity.id);
  await page.getByLabel("Project code").fill("FILM-QA");
  await page.getByLabel("Cost budget (PKR)").fill("25000");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("link", { name: "Product launch film", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Project profitability" }),
  ).toBeVisible();
  const projectUrl = page.url();
  await page
    .getByRole("button", { name: "Add milestone", exact: true })
    .click();
  await page.getByLabel("Milestone name").fill("40% mobilisation advance");
  await page.getByLabel("Milestone subtotal (PKR)").fill("40000");
  await page.getByLabel("Revenue treatment").selectOption("advance");
  await page.getByRole("button", { name: "Save milestone" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Create invoice", exact: true })
    .click();
  await page.getByRole("button", { name: "Save invoice draft" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("link", { name: /INV-\d+/, exact: true })
    .first()
    .click();
  await expect(page.locator(".document")).toContainText("PKR 47,200.00");
  await page
    .getByRole("button", { name: "Issue invoice", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("deferred revenue");
  await page.getByRole("button", { name: "Issue and post" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await page.getByLabel("Bank or receipt reference").fill("QA-ADVANCE");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Recognise delivered work", exact: true })
    .click();
  await page.getByLabel("Delivered subtotal (PKR)").fill("20000");
  await page.getByLabel("Delivery evidence").fill("First cut accepted");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await nav(page, "Purchases", "Expenses");
  await page
    .getByRole("button", { name: "Record expense", exact: true })
    .click();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption(entity.id);
  await page.getByLabel("What was the expense for?").fill("Crew costs");
  await page.getByLabel("Amount paid (PKR)").fill("21000");
  await page.getByLabel("Receipt or payment reference").fill("QA-CREW");
  await page.getByLabel("Project (optional)").selectOption(deal);
  await page.getByRole("button", { name: "Post expense" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto(projectUrl);
  const metric = (label: string) =>
    page
      .locator(".project-metrics > div")
      .filter({ has: page.getByText(label, { exact: true }) });
  await expect(metric("Earned revenue")).toContainText("PKR 20,000.00");
  await expect(metric("Cash collected")).toContainText("PKR 47,200.00");
  await expect(metric("Deferred revenue")).toContainText("PKR 20,000.00");
  await expect(metric("Posted costs")).toContainText("PKR 21,000.00");
  await expect(metric("Net project result")).toContainText("PKR -1,000.00");
  await expect(page.getByRole("status")).toContainText("80%");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.reload();
  await expect(metric("Cash collected")).toContainText("PKR 47,200.00");
  await page.screenshot({
    path: "test-results/project-profitability.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("vendor bill approval, partial payments, balances and corrections reach the ledger", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) => dialog.accept());
  await owner(page);
  await nav(page, "Purchases", "Vendors");
  await page.getByRole("button", { name: "New vendor", exact: true }).click();
  await page
    .getByLabel("Company name", { exact: true })
    .fill("Studio Supplies Test");
  await expect(page.getByLabel("Vendor", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await nav(page, "Purchases", "Bills");
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
  await page
    .getByLabel("Notes", { exact: true })
    .fill("Bill recovery QA notes");
  const projectId = await page
    .getByLabel("Project (optional)", { exact: true })
    .inputValue();
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page.getByRole("button", { name: "New bill", exact: true }).click();
  await expect(
    page.getByLabel("Vendor bill number", { exact: true }),
  ).toHaveValue("STUDIO-BILL-101");
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue(
    "Bill recovery QA notes",
  );
  await expect(page.getByLabel("Account 1", { exact: true })).toHaveValue(
    "5200",
  );
  await expect(
    page.getByLabel("Purchase tax treatment", { exact: true }),
  ).toHaveValue("recoverable");
  await expect(
    page.getByLabel("Project (optional)", { exact: true }),
  ).toHaveValue(projectId);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("button", { name: "Save bill draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "STUDIO-BILL-101", exact: true }),
  ).toBeVisible();
  const billUrl = page.url();
  await expect(page.getByText("Not posted", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith("gv-bill-draft-v1:"),
      ),
    ),
  ).toEqual([]);
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
  await nav(page, "Purchases", "Payable balances");
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
  await nav(page, "Accountant", "Manual journals");
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
  await nav(page, "Accountant", "Trial balance");
  await expect(
    page.getByRole("row").filter({ hasText: "Accounts payable" }),
  ).toContainText("PKR 0.00");
  expect(errors).toEqual([]);
});
test("historical financial reports, drill-down, export and responsive ageing", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await owner(page);
  await page
    .getByRole("link", { name: "Financial reports", exact: true })
    .click();
  await page.getByLabel("From", { exact: true }).fill("2026-09-01");
  await page.getByLabel("As at", { exact: true }).fill("2026-09-21");
  await page.getByRole("button", { name: "Run report", exact: true }).click();
  await page.getByLabel("Report", { exact: true }).selectOption("ap");
  await page
    .getByLabel("Legal entity view", { exact: true })
    .selectOption({ label: "PVT · Sample Private Limited" });
  await expect(page.getByLabel("As at", { exact: true })).toHaveValue(
    "2026-09-21",
  );
  await expect(page.getByLabel("Report", { exact: true })).toHaveValue("ap");
  await page
    .getByLabel("Legal entity view", { exact: true })
    .selectOption("all");
  await expect(
    page.getByRole("row").filter({ hasText: "STUDIO-BILL-101" }),
  ).toContainText("PKR 68,000.00");
  await expect(page.getByRole("alert")).not.toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe(
    "gv-ap-2026-09-21.csv",
  );
  await page.getByLabel("Ageing view", { exact: true }).selectOption("summary");
  await expect(
    page.getByRole("row").filter({ hasText: "Studio Supplies Test" }),
  ).toContainText("PKR 68,000.00");
  await page.getByLabel("Report", { exact: true }).selectOption("balance");
  await page
    .getByRole("button", { name: "2000 · Accounts payable", exact: true })
    .filter({ visible: true })
    .last()
    .click();
  await expect(page.getByRole("dialog")).toContainText("Bill STUDIO-BILL-101");
  await expect(page.getByRole("dialog")).toContainText("PKR -68,000.00");
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page.getByLabel("Report", { exact: true }).selectOption("cash");
  await expect(
    page.getByText("Net operating cash", { exact: false }),
  ).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.getByLabel("Report", { exact: true }).selectOption("ap");
  await page.screenshot({
    path: "test-results/historical-ageing.png",
    fullPage: true,
  });
  await page.getByLabel("As at", { exact: true }).fill("2026-09-24");
  await page.getByRole("button", { name: "Run report", exact: true }).click();
  await expect(
    page.getByText("No outstanding posted documents at this date.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("bank account, recorded expense, CSV preview, grouped match and reconciliation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) =>
    dialog.type() === "prompt" ? dialog.accept("Review test") : dialog.accept(),
  );
  await owner(page);
  await page.getByRole("link", { name: "Banking", exact: true }).click();
  await page
    .getByRole("button", { name: "Add bank account", exact: true })
    .click();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption({ label: "AOP · Sample Partnership" });
  await page
    .getByLabel("Account name", { exact: true })
    .fill("QA Operating Bank");
  await page
    .getByLabel("Account label / last four digits", { exact: true })
    .fill("4321");
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
    page.getByRole("heading", { name: "QA Operating Bank", exact: true }),
  ).toBeVisible();
  const bankUrl = page.url();
  await nav(page, "Purchases", "Expenses");
  await page
    .getByRole("button", { name: "Record expense", exact: true })
    .click();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption({ label: "Sample Partnership (AOP)" });
  await page
    .getByLabel("Bank account", { exact: true })
    .selectOption({ label: "QA Operating Bank · PKR" });
  await page
    .getByLabel("What was the expense for?", { exact: true })
    .fill("QA office supplies");
  await page.getByLabel("Amount paid (PKR)", { exact: true }).fill("1000");
  await page.getByLabel("Expense date", { exact: true }).fill("2026-09-05");
  await page
    .getByLabel("Receipt or payment reference", { exact: true })
    .fill("QA-BANK");
  await page.getByRole("button", { name: "Post expense", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto(bankUrl);
  await page
    .getByRole("button", { name: "Import statement", exact: true })
    .click();
  await page
    .getByLabel("Statement reference", { exact: true })
    .fill("September QA");
  await page.getByLabel("Statement to", { exact: true }).fill("2026-09-30");
  await page
    .getByLabel("Statement closing balance (PKR)", { exact: true })
    .fill("4000");
  await page
    .getByLabel("Statement CSV", { exact: true })
    .fill(
      "Date,Description,Reference,Amount\n2026-09-05,Part A,QA-1,-600\n2026-09-05,Part B,QA-2,-400",
    );
  await page.getByRole("button", { name: "Preview rows", exact: true }).click();
  await expect(
    page.getByText("2 rows · Net movement PKR -1,000.00", { exact: true }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Import statement", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByLabel("Statement row 1", { exact: true }).check();
  await page.getByLabel("Statement row 2", { exact: true }).check();
  await page.getByLabel("Ledger QA office supplies", { exact: true }).check();
  await page
    .getByRole("button", { name: "Match selected", exact: true })
    .click();
  await page.getByRole("button", { name: "Undo match 1", exact: true }).click();
  await page.getByLabel("Statement row 1", { exact: true }).check();
  await page.getByLabel("Statement row 2", { exact: true }).check();
  await page.getByLabel("Ledger QA office supplies", { exact: true }).check();
  await page
    .getByRole("button", { name: "Match selected", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Complete reconciliation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "September QA · Reconciled",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "September QA · Reconciled",
      exact: true,
    }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: "test-results/bank-reconciliation.png",
    fullPage: true,
  });
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
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.locator(".page-heading h1")).toHaveText(/QT-\d{6}/);
  await page.getByRole("button", { name: "Accept this version" }).click();
  await page
    .getByLabel("Acceptance evidence")
    .fill("Client approval, reference TEST-100");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Convert to invoice", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Convert quote to invoice" }),
  ).toBeVisible();
  let lostInvoiceResponse = false;
  await page.route("**/api/commands", async (route) => {
    if (
      !lostInvoiceResponse &&
      route.request().postDataJSON().action === "invoice.create"
    ) {
      lostInvoiceResponse = true;
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBeTruthy();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(
    page.locator(".invoice-composer").getByRole("alert"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Resume invoice draft", exact: true })
    .click();
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.locator(".page-heading h1")).toHaveText(/INV-\d+/);
  const invoiceNumber = await page.locator(".page-heading h1").innerText();
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await page.getByRole("button", { name: "Issue and post" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: invoiceNumber }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await page.getByLabel("Money received (PKR)").fill("110000");
  await page.getByLabel("Income tax withheld (PKR)").fill("8000");
  await page.getByLabel("Bank or receipt reference").fill("UI-BANK-001");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".document-masthead")).toContainText("Paid");
  await page.reload();
  await expect(page.locator(".document-masthead")).toContainText("Paid");
  await nav(page, "Purchases", "Expenses");
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
  await nav(page, "Accountant", "Trial balance");
  await expect(
    page.getByRole("cell", { name: "Balanced", exact: true }),
  ).toBeVisible();
  await nav(page, "Accountant", "Manual journals");
  await expect(
    page.getByRole("heading", { name: `Payment for ${invoiceNumber}` }),
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
  await page.locator(".global-create > summary").click();
  await expect(
    page.getByRole("button", { name: "New lead", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New invoice", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Manual journals", exact: true }),
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
  await nav(page, "Organization", "Team & access");
  await expect(
    page.getByRole("heading", { name: "Team & access", exact: true }),
  ).toBeVisible();
  await page.getByText("Built-in role permissions", { exact: true }).click();
  const permissions = page.getByRole("region", {
    name: "Built-in role permissions",
  });
  await expect(
    permissions
      .getByRole("row")
      .filter({ hasText: "Approve and post vendor bills" }),
  ).toContainText("AllowedNot allowedNot allowedNot allowed");
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
  await nav(page, "Organization", "Activity log");
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
  await nav(page, "Organization", "Team & access");
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
