import { test, expect } from "@playwright/test";

test("logo loads and quote recovery is scoped, discardable and resilient to corrupt storage", async ({
  page,
}) => {
  await page.goto("/");
  const logo = page.getByRole("img", { name: "Grid Velocity", exact: true });
  await expect(logo).toBeVisible();
  expect(
    await logo.evaluate(
      (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const me = await (await page.request.get("/api/me")).json();
  const key = `gv-quote-draft-v1:${me.organization.id}:${me.user.id}:new`;
  await page.getByRole("link", { name: "Quotes", exact: true }).click();
  const open = () =>
    page
      .locator("main#main")
      .getByRole("button", { name: "New quote", exact: true })
      .click();
  await open();
  await page.getByLabel("Named option").fill("Recover this option");
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  const snapshot = await page.evaluate(
    (key) => sessionStorage.getItem(key)!,
    key,
  );
  expect(
    await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key)!).optionName,
      key,
    ),
  ).toBe("Recover this option");
  await open();
  await expect(page.getByLabel("Named option")).toHaveValue(
    "Recover this option",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Close quote", exact: true }).click();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), key),
  ).toBeNull();
  await page.evaluate(
    ({ key, snapshot }) => {
      sessionStorage.setItem(key, "not valid JSON");
      sessionStorage.setItem(
        "gv-quote-draft-v1:other-tenant:other-user:new",
        snapshot,
      );
    },
    { key, snapshot },
  );
  await open();
  await expect(page.getByLabel("Named option")).toHaveValue("");
  await page.getByRole("button", { name: "Close quote", exact: true }).click();
  await page.evaluate(
    ({ key, snapshot }) => {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          ...JSON.parse(snapshot),
          savedAt: Date.now() - 86400001,
        }),
      );
    },
    { key, snapshot },
  );
  await open();
  await expect(page.getByLabel("Named option")).toHaveValue("");
});
