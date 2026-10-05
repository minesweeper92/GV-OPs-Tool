import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
test("vendor credit issue retry, application, refund, reversals and bill balances work end to end", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const me = await (await page.request.get("/api/me")).json(),
    data = await (await page.request.get("/api/data")).json();
  const command = async (c: unknown) => {
    const r = await page.request.post("/api/commands", {
      headers: { origin: "http://127.0.0.1:4322", "x-csrf-token": me.csrf },
      data: c,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const vendor = await command({
    action: "company.create",
    name: `Credits vendor ${randomUUID()}`,
    vendor: true,
    customer: false,
    service_entity_id: null,
  });
  const bill = await command({
    action: "bill.create",
    entity_id: data.entities[0].id,
    vendor_id: vendor.id,
    deal_id: null,
    reference: `VC-BILL-${randomUUID()}`,
    bill_date: "2031-01-01",
    due_date: "2031-02-01",
    currency: "PKR",
    fx: "1",
    lines: [
      {
        description: "Equipment hire",
        quantity: "1",
        price: "1000",
        tax: "18",
        account_code: "5200",
      },
    ],
    tax_treatment: "recoverable",
    notes: "",
    request_key: randomUUID(),
  });
  await command({ action: "bill.submit", id: bill.id, version: 1 });
  await command({ action: "bill.approve", id: bill.id, version: 2 });
  page.on("dialog", (d) =>
    d.type() === "prompt"
      ? d.accept(d.message().includes("date") ? "2031-01-02" : "Correction")
      : d.accept(),
  );
  await page.goto(`/?view=bill/${bill.id}`);
  await page
    .getByRole("link", { name: "Record vendor credit", exact: true })
    .click();
  await page.getByLabel("Transaction date", { exact: true }).fill("2031-01-01");
  const reference = `VENDOR-CREDIT-${randomUUID()}`;
  await page
    .getByLabel("Vendor credit reference", { exact: true })
    .fill(reference);
  await page.getByLabel("Reason", { exact: true }).fill("Returned equipment");
  await page.getByLabel("Credit subtotal 1", { exact: true }).fill("500");
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact || ""),
    ),
  ).toEqual([]);
  let intercepted = false;
  await page.route("**/api/commands", async (route) => {
    if (
      !intercepted &&
      route.request().postDataJSON().action === "vendor-credit.create"
    ) {
      intercepted = true;
      const r = await route.fetch();
      expect(r.ok(), await r.text()).toBeTruthy();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Issue vendor credit", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page
    .getByRole("button", { name: "Keep draft & close", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByLabel("Credit subtotal 1", { exact: true }),
  ).toHaveValue("500");
  await page
    .getByRole("button", { name: "Issue vendor credit", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply to bill", exact: true }),
  ).toBeVisible();
  const saved = await (await page.request.get("/api/data")).json(),
    credits = saved.vendorCredits.filter((v: any) => v.reference === reference);
  expect(credits).toHaveLength(1);
  const credit = credits[0];
  expect(credit.available).toBe("59000");
  await page
    .getByRole("button", { name: "Apply to bill", exact: true })
    .click();
  await page
    .getByLabel("Bill to credit", { exact: true })
    .selectOption(bill.id);
  await page.getByLabel("Transaction date", { exact: true }).fill("2031-01-01");
  await page.getByLabel("Amount", { exact: true }).fill("300");
  await page.getByRole("button", { name: "Apply credit", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reverse application", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Record refund received", exact: true })
    .click();
  await page.getByLabel("Transaction date", { exact: true }).fill("2031-01-01");
  await page
    .getByLabel("Refund reference", { exact: true })
    .fill("Vendor bank refund");
  await page
    .getByRole("button", { name: "Record refund", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reverse refund", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Source bill", exact: true }).click();
  await expect(page.getByText("PKR 300.00", { exact: true })).toBeVisible();
  await expect(page.getByText("PKR 880.00", { exact: true })).toBeVisible();
  await page.goto(`/#vendor-credits/${credit.id}`);
  await page
    .getByRole("button", { name: "Reverse refund", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reverse refund", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reverse application", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reverse application", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reverse credit", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reverse credit", exact: true }),
  ).toHaveCount(0);
  const corrected = await (await page.request.get("/api/data")).json();
  expect(
    corrected.bills.find((b: any) => b.id === bill.id).credited_minor,
  ).toBe("0");
  expect(
    corrected.vendorCredits.find((v: any) => v.id === credit.id).reversal_date,
  ).toBe("2031-01-02");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});
