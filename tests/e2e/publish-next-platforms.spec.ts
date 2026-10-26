import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Cross-posts of one post share its title, so after a Publish the next card
// names what's left by platform and links each one: the curator kept going
// back to the production list to pick the next platform because the card
// showed only the (identical) title.
test("after a Publish, the card lists the post's other cross-posts by platform", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    await sql`UPDATE production_items SET status = 'Killed' WHERE editor_user_id = ${me} AND status IN ('Assigned', 'Ready To Publish', 'Review')`;
    const create = async (title: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: ["linkedin"],
          postType: "linkedin",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
          editorUserId: me,
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const title = `E2E Business Breakdown ${stamp}`;
    const sourceId = await create(title);
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${sourceId}`;
    const crossPost = async (postType: string, age: string) => {
      const id = await create(title);
      await sql`UPDATE production_items SET status = 'Ready To Publish', source_type = 'cross_post', reposted_from_item_id = ${sourceId}, post_type = ${postType}, updated_at = now() - ${age}::interval WHERE id = ${id}`;
      return id;
    };
    const linkedinId = await crossPost("linkedin", "4 hours");
    await crossPost("threads", "3 hours");
    await crossPost("youtube_community", "2 hours");
    const facebookId = await crossPost("facebook_post", "1 hour");

    await page.goto(`/starter-story/content/${linkedinId}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();
    // The small link names the platform too.
    await expect(page.getByTestId("up-next")).toContainText("Threads ·");

    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    await dialog.locator("#publish-link").fill(`https://www.linkedin.com/feed/update/e2e-${stamp}`);
    await dialog.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(dialog).toBeHidden();

    const card = page.getByTestId("up-next-card");
    await expect(card).toContainText("Published. Still to post (3)");
    const buttons = card.getByTestId("up-next-siblings").getByRole("link");
    await expect(buttons).toHaveText(["Threads", "YouTube Community", "Facebook"]);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    // Pick any platform, not only the first.
    await buttons.filter({ hasText: "Facebook" }).click();
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${facebookId}$`));
  } finally {
    await sql.end();
  }
});
