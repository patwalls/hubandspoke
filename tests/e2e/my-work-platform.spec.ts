import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Cross-posts share their post's title, so My Work rows name the platform:
// two Assigned posts with the same title read "Instagram Reel ·" and "TikTok ·".
test("My Work rows name each post's platform", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const title = `E2E same-title cross-post ${Date.now()}`;
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
          editorUserId: me,
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const reelId = await create("instagram", "instagram_reel");
    const tiktokId = await create("tiktok", "tiktok");
    await sql`UPDATE production_items SET status = 'Assigned' WHERE id IN (${reelId}, ${tiktokId})`;

    await page.goto("/my-work");
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }

    const yourTurn = page.locator("div.rounded-lg", { has: page.getByRole("heading", { name: /Your turn/ }) });
    const rows = yourTurn.getByRole("row", { name: new RegExp(title) });
    await expect(rows).toHaveCount(2);
    const tags = rows.locator("[data-my-work-platform]");
    await expect(tags.filter({ hasText: "Instagram Reel" })).toHaveCount(1);
    await expect(tags.filter({ hasText: "TikTok" })).toHaveCount(1);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql.end();
  }
});
