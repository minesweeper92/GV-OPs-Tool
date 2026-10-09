import { test, expect, type Page } from "@playwright/test";

async function start(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  await page.getByRole("button", { name: "Accountant", exact: true }).click();
  await page
    .getByRole("link", { name: "Manual journals", exact: true })
    .click();
  return data.entities as { id: string; code: string }[];
}
async function blockDraftStorage(page: Page) {
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === window.sessionStorage) throw Error("Blocked for QA");
      return original.call(this, key, value);
    };
  });
}

test("blocked account draft cancels section, entity, dates, sign-out and history navigation without losing input", async ({
  page,
}) => {
  const entities = await start(page);
  const pvt = entities.find((e) => e.code === "PVT")!;
  const aop = entities.find((e) => e.code === "AOP")!;
  await page
    .getByRole("link", { name: "Chart of accounts", exact: true })
    .click();
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await blockDraftStorage(page);
  await page
    .getByRole("button", { name: "+ New account", exact: true })
    .click();
  await page
    .getByLabel("Account name", { exact: true })
    .fill("Do not lose this account");
  await expect(
    page.getByText("Draft recovery is unavailable in this browser.", {
      exact: false,
    }),
  ).toBeVisible();
  const url = page.url();
  for (const leave of [
    () => page.getByRole("link", { name: "Contacts", exact: true }).click(),
    () => page.getByLabel("Legal entity view").selectOption(aop.id),
    () => page.getByLabel("Report start date").fill("2026-01-02"),
    () => page.getByRole("button", { name: "Sign out", exact: true }).click(),
  ]) {
    page.once("dialog", (dialog) => dialog.dismiss());
    await leave();
    await expect(page).toHaveURL(url);
    await expect(page.getByLabel("Legal entity view")).toHaveValue(pvt.id);
    await expect(page.getByLabel("Account name", { exact: true })).toHaveValue(
      "Do not lose this account",
    );
  }
  await expect(page.getByLabel("Report start date")).toHaveValue("2026-01-01");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(url);
  await expect(page.getByLabel("Account name", { exact: true })).toHaveValue(
    "Do not lose this account",
  );
  // A cancelled Back must preserve the original history rather than replacing it.
  page.once("dialog", (dialog) => dialog.accept());
  await page.goBack();
  await expect(page).toHaveURL(/view=journals/);
  await page.goForward();
  await expect(page).toHaveURL(url);
  await expect(
    page.getByRole("button", { name: "Resume account draft", exact: true }),
  ).toHaveCount(0);
});

test("blocked journal draft cancels hash changes and can explicitly leave through the sidebar", async ({
  page,
}) => {
  const entities = await start(page);
  await page
    .getByLabel("Legal entity view")
    .selectOption(entities.find((e) => e.code === "PVT")!.id);
  await blockDraftStorage(page);
  await page
    .getByRole("button", { name: "+ New manual journal", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Explanation", exact: true })
    .fill("Preserve interrupted adjustment");
  await expect(
    page.getByText("Draft storage is unavailable", { exact: false }),
  ).toBeVisible();
  const url = page.url();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.evaluate(() => {
    location.hash = "accounts";
  });
  await expect(page).toHaveURL(url);
  await expect(
    page.getByRole("textbox", { name: "Explanation", exact: true }),
  ).toHaveValue("Preserve interrupted adjustment");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await expect(page).toHaveURL(/view=contacts/);
});

test("a pending journal save blocks leaving even when tab recovery is available", async ({
  page,
}) => {
  const entities = await start(page);
  const pvt = entities.find((e) => e.code === "PVT")!;
  const aop = entities.find((e) => e.code === "AOP")!;
  await page.getByLabel("Legal entity view").selectOption(pvt.id);
  await page
    .getByRole("button", { name: "+ New manual journal", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Explanation", exact: true })
    .fill("Delayed save safety");
  await page
    .getByRole("textbox", { name: "Reference", exact: true })
    .fill("NAV-SAFETY");
  const lines = page
    .getByRole("group", { name: "Journal lines" })
    .locator(".manual-journal-line");
  await lines
    .nth(0)
    .getByRole("combobox", { name: "Account", exact: true })
    .selectOption("1500");
  await lines
    .nth(0)
    .getByRole("textbox", { name: "Debit (PKR)", exact: true })
    .fill("1");
  await lines
    .nth(1)
    .getByRole("combobox", { name: "Account", exact: true })
    .selectOption("5000");
  await lines
    .nth(1)
    .getByRole("textbox", { name: "Credit (PKR)", exact: true })
    .fill("1");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/commands", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page
      .getByRole("button", { name: "Review journal", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Post journal", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    page.once("dialog", (dialog) => {
      expect(dialog.type()).toBe("alert");
      return dialog.dismiss();
    });
    await page.getByLabel("Legal entity view").selectOption(aop.id);
    await expect(page.getByLabel("Legal entity view")).toHaveValue(pvt.id);
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("link", { name: "Contacts", exact: true }).click();
    await expect(page).toHaveURL(/view=journals/);
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: "Saving…", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Delayed save safety", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await expect(page).toHaveURL(/view=contacts/);
});
