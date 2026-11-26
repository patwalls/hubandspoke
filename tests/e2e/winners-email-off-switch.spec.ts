import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The Monday winners email goes to everyone (2026-11-26), so it has an off
// switch: /winners-email (linked from the email's footer, the dashboard's
// Beat their usual list and My Work) shows the email and turns it off.
test("Monday winners email page shows the email and turns it off", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const session = await (await page.request.get("/api/auth/session")).json();
  const me = session?.user?.id as string;
  expect(me).toBeTruthy();
  try {
    await sql`UPDATE users SET winners_email_enabled = true WHERE id = ${me}`;
    await page.goto("/my-work");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await page.getByRole("link", { name: "Monday email" }).click();
    await expect(page).toHaveURL(/\/winners-email$/);
    await expect(page.getByRole("heading", { name: "Monday winners email" })).toBeVisible();
    // Either the email itself (with its own off link) or the "nothing won" note.
    await expect(
      page.locator("[data-winners-email-preview]").getByText(/Turn it off|no email this week/),
    ).toBeVisible();

    await expect(page.locator("[data-digest-state]")).toHaveText("Monday email is on");
    await page.getByRole("button", { name: "Turn off" }).click();
    await expect(page.locator("[data-digest-state]")).toHaveText("Monday email is off");
    const [row] = await sql<{ on: boolean }[]>`SELECT winners_email_enabled AS on FROM users WHERE id = ${me}`;
    expect(row.on).toBe(false);
    await page.reload();
    await expect(page.locator("[data-digest-state]")).toHaveText("Monday email is off");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page.locator("[data-digest-state]")).toHaveText("Monday email is on");
  } finally {
    await sql`UPDATE users SET winners_email_enabled = true WHERE id = ${me}`;
    await sql.end();
  }
});
