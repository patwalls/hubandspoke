import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The brand dashboard is the report. A post waiting on you doesn't add a bar
// above it (the Waiting on you bar was removed 2026-10-28: shown, never
// opened); the header's My Work count is the way in.
test("the dashboard opens on the report, with no waiting bar", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E dashboard home ${Date.now()}`,
        platform: ["tiktok"],
        postType: "tiktok",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
        editorUserId: me,
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    await sql`UPDATE production_items SET status = 'Assigned' WHERE id = ${id}`;

    await page.goto("/starter-story");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();
    await expect(page.getByText("Content Production").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Waiting on you")).toHaveCount(0);
    await expect(page.getByTestId("my-work-button")).toHaveAttribute("aria-label", /waiting on you/);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
  } finally {
    await sql.end();
  }
});
