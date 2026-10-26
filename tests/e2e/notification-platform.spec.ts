import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Cross-posts share their post's title, so the bell names each notification's
// platform: two assignments with the same title read "Instagram Reel ·" and "TikTok ·".
test("bell notifications name each post's platform", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const title = `E2E same-title notification ${Date.now()}`;
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const create = async (platform: string, postType: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: [platform],
          postType,
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const reelId = await create("instagram", "instagram_reel");
    const tiktokId = await create("tiktok", "tiktok");
    // Self-assignments never notify, and this DB has one user, so the
    // notifications a teammate's assignment would create are written here.
    for (const id of [reelId, tiktokId]) {
      await sql`INSERT INTO notifications (user_id, kind, content_item_id, payload)
        VALUES (${me}, 'assigned', ${id}, ${sql.json({ kind: "assigned", title })})`;
    }

    await page.goto("/starter-story/production");
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }

    await page.getByRole("button", { name: "Notifications" }).click();
    const rows = page.getByRole("link", { name: new RegExp(title) });
    await expect(rows).toHaveCount(2);
    const tags = rows.locator("[data-notification-platform]");
    await expect(tags.filter({ hasText: "Instagram Reel" })).toHaveCount(1);
    await expect(tags.filter({ hasText: "TikTok" })).toHaveCount(1);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
  } finally {
    await sql.end();
  }
});
