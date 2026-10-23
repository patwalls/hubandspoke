import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Paste live links right on the Cross-post tab: after cross-posting a video,
// each ready cross-post has a link box on the video's own page. Paste + Enter
// publishes it and moves the cursor to the next one; a link from the wrong
// platform is caught. Account and cross-post links are seeded straight into
// the DB (the real cross-post route needs S3 media to copy).
test("cross-post tab takes each cross-post's live link in place", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const editorUserId = session?.user?.id;
    expect(editorUserId).toBeTruthy();
    const create = async (title: string, postType: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: [postType],
          postType,
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
          editorUserId,
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };

    const pillarId = await create(`E2E paste pillar ${stamp}`, "youtube_long");
    const sourceId = await create(`E2E paste x ${stamp}`, "x");
    const linkedinId = await create(`E2E paste linkedin ${stamp}`, "linkedin");
    const threadsId = await create(`E2E paste threads ${stamp}`, "threads");

    const [account] = await sql`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'x', ${`e2e_${stamp}`} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;
    await sql`
      UPDATE production_items SET status = 'Published', account_id = ${account.id},
        pillar_content_item_id = ${pillarId},
        published_link = ${`https://x.com/starter_story/status/${stamp}`}
      WHERE id = ${sourceId}`;
    await sql`
      UPDATE production_items SET status = 'Ready To Publish', source_type = 'cross_post',
        reposted_from_item_id = ${sourceId}, pillar_content_item_id = ${pillarId}
      WHERE id IN (${linkedinId}, ${threadsId})`;

    await page.goto(`/starter-story/content/${sourceId}?tab=cross-post`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible().catch(() => false)) {
      await popup.getByRole("button", { name: "Got it" }).click();
    }
    const box = page.getByTestId("cross-post-publish-tab");
    await expect(box).toContainText("2 cross-posts are ready to publish.");
    await expect(box.getByTestId("cross-post-paste-row")).toHaveCount(2);

    const linkedinBox = box.getByRole("textbox", { name: /LinkedIn/i });
    const threadsBox = box.getByRole("textbox", { name: /Threads/i });

    // Wrong platform is caught before it's saved.
    await linkedinBox.fill("https://www.threads.com/@starter_story/post/abc");
    await expect(box).toContainText("threads URL but this post is set up as linkedin");
    await linkedinBox.fill(`https://www.linkedin.com/feed/update/urn:li:ugcPost:${stamp}`);
    await linkedinBox.press("Enter");

    await expect(box).toContainText("1 cross-post is ready to publish.");
    await expect(threadsBox).toBeFocused();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: false });

    const [row] = await sql`SELECT status, published_link FROM production_items WHERE id = ${linkedinId}`;
    expect(row.status).toBe("Published");
    expect(row.published_link).toContain("linkedin.com");

    await threadsBox.fill(`https://www.threads.com/@starter_story/post/e2e${stamp}`);
    await threadsBox.press("Enter");
    await expect(box).toContainText("All posted");
  } finally {
    await sql.end();
  }
});
