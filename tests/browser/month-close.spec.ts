import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("month-end review, soft-close, final close and audited reopen work in the UI", async ({
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
  const me = await (await page.request.get("/api/me")).json();
  const code = `C${randomUUID().slice(0, 6).toUpperCase()}`;
  const created = await page.request.post("/api/commands", {
    headers: { "x-csrf-token": me.csrf, origin: "http://127.0.0.1:4322" },
    data: {
      action: "entity.create",
      name: "Close review company",
      code,
      tax_id: "",
      address: "",
    },
  });
  expect(created.ok()).toBe(true);
  const entityId = (await created.json()).id;
  const now = new Date();
  const month = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  )
    .toISOString()
    .slice(0, 7);
  await page.goto("/#period-close");
  await page.reload(); // The API-created entity must refresh the app's cached entity list.
  await page.getByLabel("Legal entity view").selectOption(entityId);
  await page.getByLabel("Accounting month").fill(month);
  await expect(
    page.getByRole("heading", { name: "Before you close" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Month-end close checks" }),
  ).toContainText("Debits equal credits");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel("Reason or review note").fill("Trial balance reviewed");
  await page.getByRole("button", { name: "Soft-close month" }).click();
  await expect(page.getByText("Open → Soft closed")).toBeVisible();
  await page.getByLabel("Reason or review note").fill("Final review complete");
  await page.getByRole("button", { name: "Close month" }).click();
  await expect(page.getByText("Soft closed → Closed")).toBeVisible();
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    (document.activeElement as HTMLElement)?.blur();
  });
  await page.screenshot({ path: "test-results/month-end-closed.png" });
  await page
    .getByLabel("Reason or review note")
    .fill("A further adjustment is needed");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reopen month" }).click();
  await expect(page.getByText("Closed → Open")).toBeVisible();
  await page.reload();
  await page.getByLabel("Legal entity view").selectOption(entityId);
  await page.getByLabel("Accounting month").fill(month);
  await expect(page.getByText("Closed → Open")).toBeVisible();
  const locked = await page.request.post("/api/commands", {
    headers: { "x-csrf-token": me.csrf, origin: "http://127.0.0.1:4322" },
    data: {
      action: "period.close",
      entity_id: entityId,
      date: `${month}-01`,
      reason: "Earlier close",
    },
  });
  expect(locked.ok()).toBe(true);
  await page.reload();
  await page.getByLabel("Legal entity view").selectOption(entityId);
  await page.getByLabel("Accounting month").fill(month);
  await expect(
    page.getByRole("heading", { name: "Release earlier date lock" }),
  ).toBeVisible();
  await page.getByLabel("Reason for unlocking").fill("Move to monthly close");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Release old lock" }).click();
  await expect(
    page.getByRole("heading", { name: "Earlier lock releases" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Earlier date lock releases" }),
  ).toContainText("Move to monthly close");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
