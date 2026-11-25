import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Opening a post marks your notifications about it read, and the bell's badge
// drops right away. The badge only counts the last 14 days, so a pile of old
// unread rows no longer pins it at "99+" (src/lib/notifications/unread.ts).
test("opening a post clears its notifications from the bell badge", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id as string;
    expect(me).toBeTruthy();
    // Start from a clean badge.
    expect((await page.request.post("/api/notifications/mark-read", { data: { all: true } })).ok()).toBeTruthy();

    const create = async (title: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: ["instagram"],
          postType: "instagram_reel",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const opened = await create(`E2E opened post ${stamp}`);
    const other = await create(`E2E other post ${stamp}`);
    // Self-assignments never notify and this DB has one user, so the rows a
    // teammate's comment/assignment would create are written here.
    const notify = async (id: string, kind: string, daysAgo = 0) =>
      sql`INSERT INTO notifications (user_id, kind, content_item_id, payload, created_at)
          VALUES (${me}, ${kind}, ${id}, ${sql.json({ kind, title: "t" })},
                  now() - make_interval(days => ${daysAgo}))`;
    await notify(opened, "assigned");
    await notify(opened, "assigned");
    await notify(other, "assigned");
    await notify(other, "assigned", 30); // old and unread: listed, not counted

    await page.goto("/starter-story/production");
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }
    const bell = page.getByRole("button", { name: "Notifications" });
    await expect(bell).toHaveText("3");

    await page.goto(`/starter-story/content/${opened}`);
    await expect(bell).toHaveText("1");
    const left = await sql`SELECT count(*)::int AS n FROM notifications
      WHERE user_id = ${me} AND content_item_id = ${opened} AND read_at IS NULL`;
    expect(left[0].n).toBe(0);

    await bell.click();
    await expect(page.getByRole("link", { name: new RegExp(`E2E other post ${stamp}`) })).toHaveCount(2);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
  } finally {
    await sql.end();
  }
});
