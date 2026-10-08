import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

test("bill adds a vendor inline and retains the bill details", async ({
  page,
}) => {
  // Reproduce a slower sign-in: navigation must not cancel session creation.
  await page.route("**/api/demo-login", async (route) => {
    await delay(250);
    await route.continue();
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await expect(
    page.getByRole("heading", { name: "My day", exact: true }),
  ).toBeVisible();
  await page.goto("/?view=bills");
  await page.getByRole("button", { name: "New bill", exact: true }).click();
  await page
    .getByLabel("Vendor bill number", { exact: true })
    .fill("INLINE-REFERENCE");
  await page.getByRole("button", { name: "Add vendor", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save bill draft", exact: true }),
  ).toBeDisabled();
  const name = `Inline vendor ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("New vendor name", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Create & select vendor", exact: true })
    .click();
  await expect(page.getByLabel("Vendor", { exact: true })).not.toHaveValue("");
  await expect(
    page.getByLabel("Vendor bill number", { exact: true }),
  ).toHaveValue("INLINE-REFERENCE");
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.getByRole("button", { name: "New bill", exact: true }).click();
  await expect(page.getByLabel("Vendor", { exact: true })).not.toHaveValue("");
});

test("contact draft recovers native and profile fields and clears after save", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  await page.getByRole("button", { name: "New contact", exact: true }).click();
  const name = `Recovered ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("First name", { exact: true }).fill(name);
  await page.getByLabel("Primary email", { exact: true }).fill("incomplete@");
  await page.getByRole("button", { name: "Add company", exact: true }).click();
  await page
    .getByLabel("New company name", { exact: true })
    .fill("Unfinished studio");
  await page
    .getByRole("button", { name: "Back to contact", exact: true })
    .click();
  await page
    .getByText("Full details, owner and custom fields", { exact: true })
    .click();
  await page.getByLabel("Department", { exact: true }).fill("Production");
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.reload();
  await page.getByRole("button", { name: "New contact", exact: true }).click();
  await expect(page.getByLabel("First name", { exact: true })).toHaveValue(
    name,
  );
  await expect(page.getByLabel("Primary email", { exact: true })).toHaveValue(
    "incomplete@",
  );
  await page.getByRole("button", { name: "Add company", exact: true }).click();
  await expect(
    page.getByLabel("New company name", { exact: true }),
  ).toHaveValue("Unfinished studio");
  await page
    .getByRole("button", { name: "Back to contact", exact: true })
    .click();
  await page
    .getByText("Full details, owner and custom fields", { exact: true })
    .click();
  await expect(page.getByLabel("Department", { exact: true })).toHaveValue(
    "Production",
  );
  await page
    .getByLabel("Primary email", { exact: true })
    .fill("recovery@example.test");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((k) =>
          k.startsWith("gv-crm-draft-v1:"),
        ).length,
    ),
  ).toBe(0);
});

test("lead creates company and contact inline without losing its draft", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Owner Grid Velocity · sample" })
    .click();
  await page.getByRole("link", { name: "Leads", exact: true }).click();
  await page.getByRole("button", { name: "New lead", exact: true }).click();
  const title = `Inline project ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("Lead title", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Add company", exact: true }).click();
  await page
    .getByLabel("New company name", { exact: true })
    .fill(`Lead company ${randomUUID()}`);
  await page
    .getByRole("button", { name: "Create & select company", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add contact here", exact: true })
    .click();
  await page.getByLabel("New contact first name").fill("Ali");
  await page
    .getByRole("button", { name: "Create & select contact", exact: true })
    .click();
  await expect(page.getByLabel("Contact", { exact: true })).not.toHaveValue("");
  await expect(page.getByLabel("Lead title", { exact: true })).toHaveValue(
    title,
  );
  await page.getByRole("button", { name: "Keep draft & close" }).click();
  await page.getByRole("button", { name: "New lead", exact: true }).click();
  await expect(page.getByLabel("Lead title", { exact: true })).toHaveValue(
    title,
  );
  await expect(page.getByLabel("Contact", { exact: true })).not.toHaveValue("");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  await page.getByRole("button", { name: "New lead", exact: true }).click();
  await expect(page.getByLabel("Lead title", { exact: true })).toHaveValue("");
});
