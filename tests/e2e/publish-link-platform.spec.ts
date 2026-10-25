import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The content page's Publish dialog catches a link from another platform
// (a TikTok link on an Instagram Reel) before it's saved, and the publish
// route refuses one whichever screen sends it.
test("publish dialog and route refuse a link from another platform", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E reel ${stamp}`,
        platform: ["instagram_reel"],
        postType: "instagram_reel",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    await sql`UPDATE production_items SET status = 'Ready To Publish' WHERE id = ${id}`;

    // The route: wrong platform → 400, item untouched.
    const wrong = await page.request.post(`/api/production-items/${id}/publish`, {
      data: { mode: "publish", link: `https://www.tiktok.com/@e2e/video/${stamp}` },
    });
    expect(wrong.status()).toBe(400);
    expect((await wrong.json()).error).toMatch(/tiktok/i);
    const [row] = await sql`SELECT status, published_link FROM production_items WHERE id = ${id}`;
    expect(row.status).toBe("Ready To Publish");
    expect(row.published_link).toBeNull();

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${id}`);
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    const box = dialog.getByLabel("Published link");
    await box.fill(`https://www.tiktok.com/@e2e/video/${stamp}`);
    await expect(dialog.getByTestId("publish-link-mismatch")).toContainText("tiktok");
    await expect(dialog.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    // The right link publishes.
    await box.fill(`https://www.instagram.com/reel/e2e${stamp}/`);
    await expect(dialog.getByTestId("publish-link-mismatch")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(dialog).toBeHidden();
    const [after] = await sql`SELECT status FROM production_items WHERE id = ${id}`;
    expect(after.status).toBe("Published");
  } finally {
    await sql.end();
  }
});
