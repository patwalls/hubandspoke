import { test, expect } from "@playwright/test";
import postgres from "postgres";

// wins-reach-makers M3: the winner-notes cron rings the editor's bell when a
// post they edited beats its usual. The cron needs real metrics and an LLM, so
// the row it writes is inserted here; the spec checks how the bell reads it.
test("the bell tells an editor their post beat its usual, with the why", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const title = `E2E winning post ${Date.now()}`;
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const res = await page.request.post("/api/production-items", {
      data: {
        title,
        platform: ["tiktok"],
        postType: "tiktok",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    const note = "Opens on the dollar figure instead of the founder's name.";
    await sql`INSERT INTO notifications (user_id, kind, content_item_id, payload)
      VALUES (${me}, 'win', ${id}, ${sql.json({ kind: "win", title, lift: 4.24, note })})`;

    await page.goto("/starter-story/production");
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }

    await page.getByRole("button", { name: "Notifications" }).click();
    const row = page.getByRole("link", { name: new RegExp(title) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("A post you edited beat its usual · 4.2×");
    await expect(row).toContainText(note);
    await expect(row).not.toContainText("teammate");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${id}`));
  } finally {
    await sql.end();
  }
});
