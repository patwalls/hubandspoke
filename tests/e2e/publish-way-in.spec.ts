import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The way into the Publish tab from where the curator works: after
// cross-posting a video, its content page's Cross-post tab says how many
// cross-posts are ready and opens the Publish tab with that video's group on
// top; a ready cross-post's Publish dialog offers the same when siblings wait.
// Account, media and cross-post links are seeded straight into the DB (the
// real cross-post route needs S3 media to copy).
test("cross-post tab and publish dialog lead to the Publish tab, focused on the video", async ({
  page,
}) => {
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

    // An older, unrelated ready post so the focused group has to move up.
    const otherPillarId = await create(`E2E other pillar ${stamp}`, "youtube_long");
    const otherId = await create(`E2E other tiktok ${stamp}`, "tiktok");

    const pillarTitle = `E2E way-in pillar ${stamp}`;
    const pillarId = await create(pillarTitle, "youtube_long");
    const sourceId = await create(`E2E way-in instagram ${stamp}`, "instagram_post");
    const xId = await create(`E2E way-in x ${stamp}`, "x");
    const linkedinId = await create(`E2E way-in linkedin ${stamp}`, "linkedin");

    const [account] = await sql`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'instagram', ${`e2e_${stamp}`} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;
    await sql`
      UPDATE production_items SET status = 'Ready To Publish', pillar_content_item_id = ${otherPillarId},
        updated_at = now() - interval '1 day'
      WHERE id = ${otherId}`;
    await sql`
      UPDATE production_items SET status = 'Published', account_id = ${account.id},
        pillar_content_item_id = ${pillarId}, descript_composition_id = ${`e2e-${stamp}`},
        published_link = ${`https://www.instagram.com/p/e2e${stamp}/`}
      WHERE id = ${sourceId}`;
    await sql`
      UPDATE production_items SET status = 'Ready To Publish', source_type = 'cross_post',
        reposted_from_item_id = ${sourceId}, pillar_content_item_id = ${pillarId}
      WHERE id IN (${xId}, ${linkedinId})`;

    // The What's new pop-up can open after the page renders; close it whenever it shows.
    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${sourceId}?tab=cross-post`);
    const banner = page.getByTestId("cross-post-publish-tab");
    await expect(banner).toContainText("2 cross-posts are ready to publish.");

    await banner.getByRole("link", { name: "Open Publish tab" }).click();
    await expect(page).toHaveURL(/\/starter-story\/publish\?focus=/);
    const groups = page.getByTestId("publish-group");
    await expect(groups.first()).toContainText(pillarTitle);
    await expect(groups.first()).toHaveAttribute("data-focused", "true");
    await expect(groups.first().getByTestId("publish-row")).toHaveCount(2);
    await expect(groups.filter({ hasText: `E2E other pillar ${stamp}` })).toHaveCount(1);
    // The cursor is already in the video's first link box.
    await expect(groups.first().getByRole("textbox").first()).toBeFocused();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    // A ready cross-post's own page: the Publish dialog points at the tab.
    await page.goto(`/starter-story/content/${xId}`);
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const hint = page.getByTestId("publish-dialog-publish-tab");
    await expect(hint).toContainText("1 more post from this video is ready to publish.");
    await hint.getByRole("link", { name: "Paste all their links on the Publish tab" }).click();
    await expect(page).toHaveURL(new RegExp(`/starter-story/publish\\?focus=${xId}`));
    await expect(page.getByTestId("publish-group").first()).toContainText(pillarTitle);
  } finally {
    await sql.end();
  }
});
