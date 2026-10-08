import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";

const origin = "http://127.0.0.1:4322";
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

test("an administrator limits a teammate to one legal entity", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  const owner = await signIn(page, "Owner");
  const data = await (await page.request.get("/api/data")).json();
  const pvt = data.entities.find((e: { code: string }) => e.code === "PVT"),
    aop = data.entities.find((e: { code: string }) => e.code === "AOP");
  const vendor = await owner("commands", {
    action: "company.create",
    name: `Entity grant vendor ${randomUUID()}`,
    vendor: true,
    customer: false,
    service_entity_id: null,
  });
  const references: Record<string, string> = {};
  for (const entity of [pvt, aop]) {
    references[entity.code] =
      `${entity.code}-grant-${randomUUID().slice(0, 8)}`;
    await owner("commands", {
      action: "bill.create",
      entity_id: entity.id,
      vendor_id: vendor.id,
      deal_id: null,
      reference: references[entity.code],
      bill_date: "2030-04-01",
      due_date: "2030-04-30",
      currency: "PKR",
      fx: "1",
      lines: [
        {
          description: "Entity grant check",
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
  }

  try {
    await page.goto("/?view=team");
    await page
      .getByRole("button", { name: "Manage Accountant", exact: true })
      .click();
    const drawer = page.getByRole("dialog");
    const entities = drawer.getByRole("group", { name: "Legal entities" });
    await expect(
      entities.getByLabel("All legal entities, including ones added later"),
    ).toBeChecked();
    await entities.getByLabel("Only selected legal entities").check();
    await expect(
      drawer.getByRole("button", { name: "Save access", exact: true }),
    ).toBeDisabled();
    await entities.getByLabel(`PVT — ${pvt.name}`).check();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await drawer
      .getByRole("button", { name: "Save access", exact: true })
      .click();
    await expect(drawer).not.toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: "Accountant" }).first(),
    ).toContainText("PVT");

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    // Sign-out reloads the page; navigating before it settles aborts on CI.
    await expect(
      page.getByRole("heading", { name: "Choose a sample role" }),
    ).toBeVisible();
    await signIn(page, "Accountant");
    await page.goto("/?view=bills");
    await expect(
      page.getByRole("heading", { name: "Bills", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: references.PVT, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: references.AOP, exact: true }),
    ).toHaveCount(0);
    const entityView = page.getByLabel("Legal entity view");
    await expect(entityView.locator("option", { hasText: "AOP" })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: "test-results/entity-grants-bills.png",
      fullPage: true,
    });
  } finally {
    // Later specs rely on the seeded Accountant seeing every entity.
    await page.context().clearCookies();
    const restore = await signIn(page, "Owner");
    const team = await (await page.request.get("/api/team")).json();
    const member = team.members.find(
      (m: { name: string }) => m.name === "Accountant",
    );
    await restore("team/member", {
      userId: member.id,
      role: member.role,
      active: true,
      version: member.version,
      roleProfileId: null,
      entityIds: null,
    });
  }
});
