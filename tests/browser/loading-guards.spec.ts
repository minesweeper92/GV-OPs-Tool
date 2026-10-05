import { test, expect } from "@playwright/test";

test("lead and task routes wait for records before rendering", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  const data = await (await page.request.get("/api/data")).json();
  for (const view of [`lead/${data.leads[0].id}`, "tasks"]) {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/api/data", async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto(`/?view=${view}`, { waitUntil: "domcontentloaded" });
      await expect(
        page.getByLabel("Loading records", { exact: true }),
      ).toBeVisible();
    } finally {
      release();
    }
    if (view === "tasks")
      await expect(
        page.getByRole("heading", { name: "Tasks", exact: true }),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("heading", { name: data.leads[0].title, exact: true }),
      ).toBeVisible();
    await page.unroute("**/api/data");
  }
  expect(errors).toEqual([]);
});
