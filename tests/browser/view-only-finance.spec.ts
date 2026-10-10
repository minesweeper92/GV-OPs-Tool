import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const origin = `http://127.0.0.1:${process.env.GV_BROWSER_PORT || 4322}`;
async function signIn(page: Page, name: string) {
  await page.goto("/");
  await page
    .getByRole("button", { name: `${name} Grid Velocity · sample` })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const me = await (await page.request.get("/api/me")).json();
  return async (path: string, payload: Record<string, unknown>) => {
    const response = await page.request.post(`/api/${path}`, {
      headers: { origin, "x-csrf-token": me.csrf },
      data: payload,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
}
async function accountant(page: Page) {
  const team = await (await page.request.get("/api/team")).json();
  return team.members.find(
    (m: { name: string }) => m.name === "Accountant",
  ) as { id: string; version: number };
}

test("a books.view-only finance profile sees records but no create or post actions", async ({
  page,
}) => {
  const owner = await signIn(page, "Owner");
  const data = await (await page.request.get("/api/data")).json();
  const entity = data.entities[0];
  // Allow full finance to review within limit, so any hidden review action
  // below is down to the narrowed profile rather than the approval policy.
  await owner("commands", {
    action: "bill.approval-policy",
    entity_id: entity.id,
    version: entity.bill_approval_version,
    finance_limit: "100000000",
    separate_approver: false,
    two_stage: false,
  });
  const vendor = await owner("commands", {
    action: "company.create",
    name: `View-only vendor ${randomUUID()}`,
    vendor: true,
    customer: false,
    service_entity_id: null,
  });
  const reference = `ViewOnly-${randomUUID()}`;
  const bill = await owner("commands", {
    action: "bill.create",
    entity_id: entity.id,
    vendor_id: vendor.id,
    deal_id: null,
    reference,
    bill_date: "2030-02-01",
    due_date: "2030-02-28",
    currency: "PKR",
    fx: "1",
    lines: [
      {
        description: "Reviewable service",
        quantity: "1",
        price: "100",
        tax: "0",
        account_code: "5000",
      },
    ],
    tax_treatment: "expense",
    request_key: randomUUID(),
    notes: "",
  });
  await owner("commands", { action: "bill.submit", id: bill.id, version: 1 });
  const profile = await owner("team/role", {
    name: `Books view only ${randomUUID().slice(0, 8)}`,
    baseRole: "finance",
    capabilities: ["books.view"],
  });
  const member = await accountant(page);
  await owner("team/member", {
    userId: member.id,
    role: "finance",
    active: true,
    version: member.version,
    roleProfileId: profile.id,
  });

  try {
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    // Sign-out reloads the page; navigating before it settles aborts on CI.
    await expect(
      page.getByRole("heading", { name: "Choose a sample role" }),
    ).toBeVisible();
    await signIn(page, "Accountant");
    const me = await (await page.request.get("/api/me")).json();
    expect(me.user.role).toBe("finance");
    expect(me.user.capabilities).toEqual(["books.view"]);

    // Navigation keeps the finance areas readable.
    await expect(
      page.getByRole("navigation", { name: "Main navigation" }),
    ).toContainText("Purchases");

    const screens: [string, string, string[]][] = [
      ["bills", "Bills", ["New bill", "Approval rules"]],
      ["vendors", "Vendors", ["New vendor"]],
      ["purchase-orders", "Purchase orders", ["New purchase order"]],
      ["vendor-credits", "Vendor credits", ["New vendor credit"]],
      ["vendor-payments", "Payments made", ["Record vendor payment"]],
      ["vendor-advances", "Vendor advances", ["Record advance"]],
      ["recurring-bills", "Recurring bills", ["New recurring bill"]],
      ["recurring", "Recurring invoices", ["New schedule"]],
      ["recurring-expenses", "Recurring expenses", ["New schedule"]],
      ["credits", "Credit notes", ["New credit note"]],
      ["projects", "Projects", ["Start project"]],
      ["banking", "Banking", ["Add bank account"]],
      ["expenses", "Expenses", ["Record expense"]],
      ["invoices", "Invoices", ["New invoice"]],
    ];
    for (const [view, heading, hidden] of screens) {
      await page.goto(`/?view=${view}`);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
        view,
      ).toBeVisible();
      for (const name of hidden)
        await expect(
          page.getByRole("button", { name, exact: true }),
          `${view}: ${name}`,
        ).toHaveCount(0);
    }

    // The pending bill is visible but cannot be reviewed or approved.
    await page.goto("/?view=bills");
    await page.getByLabel("Search bills", { exact: true }).fill(reference);
    await page.getByRole("button", { name: /^Ready for my review/ }).click();
    await expect(
      page.getByRole("link", { name: reference, exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: /^Waiting for another reviewer/ })
      .click();
    await page.getByRole("link", { name: reference, exact: true }).click();
    await expect(
      page.getByRole("status", { name: "Bill review status" }),
    ).toContainText(
      "Permission to record financial transactions is required to review vendor bills.",
    );
    for (const name of [
      "Approve & post",
      "Complete first review",
      "Return to draft",
      "Void bill",
      "Record vendor payment",
    ])
      await expect(
        page.getByRole("button", { name, exact: true }),
        name,
      ).toHaveCount(0);

    // Ledger screens: no manual journal, schedule or period actions.
    await page.goto("/#journals");
    await page.getByLabel("Legal entity view").selectOption(entity.id);
    await expect(
      page.getByRole("heading", { name: "Journal entries", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Report start date")).toBeVisible();
    await expect(page.getByText("Loading ledger…")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "+ New manual journal", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(() => (location.hash = "journal-schedules"));
    await expect(
      page.getByRole("heading", {
        name: "Recurring journals",
        exact: true,
        level: 2,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "+ New recurring journal",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.evaluate(() => (location.hash = "period-close"));
    await expect(
      page.getByRole("heading", { name: "Month-end close", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("table").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^(Soft-close|Close|Reopen) month$/ }),
    ).toHaveCount(0);
    await page.screenshot({
      path: "test-results/view-only-finance.png",
      fullPage: true,
    });

    // Hidden actions are still refused if a client sends them anyway.
    const blocked = await page.evaluate(async (id) => {
      const me = await (await fetch("/api/me")).json();
      const r = await fetch("/api/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": me.csrf,
        },
        body: JSON.stringify({ action: "bill.approve", id, version: 2 }),
      });
      return r.status;
    }, bill.id);
    expect(blocked).toBe(403);
  } finally {
    // Later specs rely on the seeded Accountant having full finance access.
    await page.context().clearCookies();
    const restore = await signIn(page, "Owner");
    const member = await accountant(page);
    await restore("team/member", {
      userId: member.id,
      role: "finance",
      active: true,
      version: member.version,
      roleProfileId: null,
    });
  }
});
