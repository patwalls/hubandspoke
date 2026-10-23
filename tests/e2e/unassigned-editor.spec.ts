import { test, expect } from "@playwright/test";
import postgres from "postgres";

// A post can be Unassigned (no editor): the content page's editor chip offers
// "Unassigned", clearing it saves editor_user_id = NULL, and the chip says so.
test("set a post's editor to Unassigned from the content page", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E unassigned ${Date.now()}`,
        platform: ["tiktok"],
        postType: "tiktok",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
        editorUserId: me,
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;

    await page.goto(`/starter-story/content/${id}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const chip = page.getByRole("button", { name: "Assignee" });
    await chip.click();
    await page.getByRole("option", { name: "Unassigned" }).click();
    await expect(chip).toContainText("Unassigned");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await expect
      .poll(async () => (await sql`SELECT editor_user_id FROM production_items WHERE id = ${id}`)[0].editor_user_id)
      .toBeNull();
  } finally {
    await sql.end();
  }
});
