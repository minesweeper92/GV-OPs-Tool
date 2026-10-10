import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
test("one vendor payment allocates bills, recovers a lost response and reverses all allocations", async ({
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
      headers: {
        origin: `http://127.0.0.1:${process.env.GV_BROWSER_PORT || 4322}`,
        "x-csrf-token": me.csrf,
      },
      data: c,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const vendor = await command({
    action: "company.create",
    name: `Batch vendor ${randomUUID()}`,
    vendor: true,
    customer: false,
    service_entity_id: null,
  });
  const ids: string[] = [],
    refs: string[] = [];
  for (let i = 0; i < 2; i++) {
    const reference = `BATCH-BILL-${randomUUID()}`;
    refs.push(reference);
    const b = await command({
      action: "bill.create",
      entity_id: data.entities[0].id,
      vendor_id: vendor.id,
      deal_id: null,
      reference,
      bill_date: "2031-03-01",
      due_date: "2031-04-01",
      currency: "PKR",
      fx: "1",
      lines: [
        {
          description: "Production",
          quantity: "1",
          price: "1000",
          tax: "0",
          account_code: "5200",
        },
      ],
      tax_treatment: "expense",
      notes: "",
      request_key: randomUUID(),
      acknowledge_duplicate: true,
    });
    ids.push(b.id);
    await command({ action: "bill.submit", id: b.id, version: 1 });
    await command({ action: "bill.approve", id: b.id, version: 2 });
  }
  await page.goto("/?view=vendor-payments");
  await page
    .getByRole("button", { name: "Record vendor payment", exact: true })
    .click();
  await page
    .getByLabel("Legal entity", { exact: true })
    .selectOption(data.entities[0].id);
  await page.getByLabel("Vendor", { exact: true }).selectOption(vendor.id);
  await page.getByLabel("Payment date", { exact: true }).fill("2031-03-02");
  const reference = `BATCH-PAY-${randomUUID()}`;
  await page.getByLabel("Reference", { exact: true }).fill(reference);
  await page.getByLabel("Bank charge (PKR)", { exact: true }).fill("10");
  await page.getByLabel(`Cash for ${refs[0]}`, { exact: true }).fill("900");
  await page
    .getByLabel(`Withholding for ${refs[0]}`, { exact: true })
    .fill("100");
  await page.getByLabel(`Cash for ${refs[1]}`, { exact: true }).fill("500");
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Record vendor payment", exact: true })
    .click();
  await expect(page.getByLabel("Reference", { exact: true })).toHaveValue(
    reference,
  );
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact || ""),
    ),
  ).toEqual([]);
  let lost = false;
  await page.route("**/api/commands", async (route) => {
    if (
      !lost &&
      route.request().postDataJSON().action === "vendor-payment.batch-create"
    ) {
      lost = true;
      const r = await route.fetch();
      expect(r.ok(), await r.text()).toBeTruthy();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  let latest = await (await page.request.get("/api/data")).json();
  const batch = latest.vendorPaymentBatches.filter(
    (p: any) => p.reference === reference,
  );
  expect(batch).toHaveLength(1);
  expect(batch[0].allocations).toHaveLength(2);
  expect(latest.bills.find((b: any) => b.id === ids[0]).status).toBe("Paid");
  expect(latest.bills.find((b: any) => b.id === ids[1]).paid_minor).toBe(
    "50000",
  );
  await page.getByRole("link", { name: reference, exact: true }).click();
  const popupPromise = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Remittance advice", exact: true })
    .click();
  const advice = await popupPromise;
  await expect(
    advice.getByRole("heading", { name: "Remittance advice", exact: true }),
  ).toBeVisible();
  await expect(
    advice.getByRole("button", { name: "Print / Save PDF", exact: true }),
  ).toBeVisible();
  await expect(advice.locator("body")).toContainText(reference);
  for (const ref of refs)
    await expect(
      advice.getByRole("cell", { name: ref, exact: true }),
    ).toBeVisible();
  expect(await advice.evaluate(() => window.opener)).toBeNull();
  await advice.emulateMedia({ media: "print" });
  await expect(
    advice.getByRole("button", { name: "Print / Save PDF", exact: true }),
  ).not.toBeVisible();
  await advice.close();
  await page
    .getByRole("button", { name: "Reverse payment", exact: true })
    .click();
  await page.getByLabel("Reversal date", { exact: true }).fill("2031-03-03");
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Wrong payment reference");
  await page
    .getByRole("button", { name: "Reverse entire payment", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  latest = await (await page.request.get("/api/data")).json();
  for (const id of ids)
    expect(latest.bills.find((b: any) => b.id === id).paid_minor).toBe("0");
  const reversedPromise = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Remittance advice", exact: true })
    .click();
  const reversedAdvice = await reversedPromise;
  await expect(
    reversedAdvice.getByText("REVERSED — not a current payment", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    reversedAdvice.getByText(/Wrong payment reference/),
  ).toBeVisible();
  await reversedAdvice.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Payments made", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Record vendor payment", exact: true })
    .click();
  await page
    .getByLabel("Reference", { exact: true })
    .fill("Discard this draft");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page
    .getByRole("button", { name: "Record vendor payment", exact: true })
    .click();
  await expect(page.getByLabel("Reference", { exact: true })).toHaveValue("");
  await page
    .getByRole("button", { name: "Keep draft & close", exact: true })
    .click();
  for (const id of ids) {
    const b = latest.bills.find((b: any) => b.id === id);
    await command({
      action: "bill.void",
      id,
      version: b.version,
      date: "2031-03-03",
      reason: "Test cleanup",
    });
  }
});
