import { test, expect } from "@playwright/test";
import postgres from "postgres";

test.use({ video: process.env.E2E_VIDEO === "1" ? "retain-on-failure" : "off" });

// publish-one-trip M6. After a Publish, "Then open next" offers the post's
// next platform in the order this person usually publishes them, not the
// order the cross-posts happened to be created in.
test("Then open next follows the order you publish a post's platforms in", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    await sql`UPDATE production_items SET status = 'Killed' WHERE editor_user_id = ${me} AND status IN ('Assigned', 'Ready To Publish', 'Review')`;
    const create = async (title: string, postType: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: [postType],
          postType,
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
          editorUserId: me,
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const family = async (title: string, types: string[]) => {
      const sourceId = await create(title, "instagram_reel");
      await sql`UPDATE production_items SET status = 'Published' WHERE id = ${sourceId}`;
      const ids: string[] = [];
      for (const t of types) {
        const id = await create(title, t);
        await sql`UPDATE production_items SET source_type = 'cross_post', reposted_from_item_id = ${sourceId} WHERE id = ${id}`;
        ids.push(id);
      }
      return { sourceId, ids };
    };

    // History: twice this month, LinkedIn → Threads → TikTok.
    for (const day of [3, 2]) {
      const { ids } = await family(`E2E order history ${stamp} ${day}`, ["linkedin", "threads", "tiktok"]);
      for (const [i, id] of ids.entries()) {
        await sql`UPDATE production_items SET status = 'Published' WHERE id = ${id}`;
        await sql`INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
          VALUES (${id}, ${me}, 'status_change', ${sql.json({ type: "status_change", from: "Ready To Publish", to: "Published" })},
                  now() - ${`${day} days`}::interval + ${`${i * 4} minutes`}::interval)`;
      }
    }

    // Today's post: TikTok was touched longest ago, so it used to come first.
    const title = `E2E order today ${stamp}`;
    const { ids: [linkedinId, tiktokId, threadsId] } = await family(title, ["linkedin", "tiktok", "threads"]);
    for (const [id, age] of [[linkedinId, "3 hours"], [tiktokId, "2 hours"], [threadsId, "1 hour"]]) {
      await sql`UPDATE production_items SET status = 'Ready To Publish', updated_at = now() - ${age}::interval WHERE id = ${id}`;
    }

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${linkedinId}`);
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    const offer = dialog.getByTestId("publish-open-next");
    await expect(offer).toContainText(`Then open this post's next platform: Threads · ${title}`);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await dialog.locator("#publish-link").fill(`https://www.linkedin.com/feed/update/e2e-order-${stamp}`);
    await dialog.locator("#publish-link").press("Enter");
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${threadsId}$`));
  } finally {
    await sql.end();
  }
});
