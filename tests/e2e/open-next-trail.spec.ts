import { test, expect } from "@playwright/test";
import postgres from "postgres";

// publish-one-trip M5 (a measurement). After "Then open next" lands on the
// next Ready post, publishers mostly go straight back to In Production and
// open a post from there. The marks say whether they reopen the post they
// had landed on (back-to-list + reopened-same) or pick another one.
test("a bounce to the list after Open next, and the post reopened, are both marked", async ({ page }) => {
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
    const title = `E2E trail ${stamp}`;
    const sourceId = await create(title, "instagram_reel");
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${sourceId}`;
    const crossPost = async (postType: string, age: string) => {
      const id = await create(title, postType);
      await sql`UPDATE production_items SET status = 'Ready To Publish', source_type = 'cross_post', reposted_from_item_id = ${sourceId}, updated_at = now() - ${age}::interval WHERE id = ${id}`;
      return id;
    };
    const linkedinId = await crossPost("linkedin", "2 hours");
    const threadsId = await crossPost("threads", "1 hour");
    const marks = async (screen: string) => {
      const [r] = await sql`SELECT count(*)::int AS n FROM usage_events WHERE screen = ${screen} AND user_id = ${me}`;
      return r.n as number;
    };
    const backBefore = await marks("publish:open-next:back-to-list");
    const sameBefore = await marks("publish:open-next:reopened-same");

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${linkedinId}`);
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    await expect(dialog.getByTestId("publish-open-next")).toBeVisible();
    await dialog.locator("#publish-link").fill(`https://www.linkedin.com/feed/update/e2e-trail-${stamp}`);
    await dialog.locator("#publish-link").press("Enter");
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${threadsId}$`));
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("hs:publish-open-next-landed"))).toContain(threadsId);

    // Straight back to the list: a bounce.
    await page.goto("/starter-story/production");
    await expect.poll(() => marks("publish:open-next:back-to-list")).toBe(backBefore + 1);

    // And the post it had landed on, opened again from there.
    await page.goto(`/starter-story/content/${threadsId}`);
    await expect.poll(() => marks("publish:open-next:reopened-same")).toBe(sameBefore + 1);
    expect(await page.evaluate(() => sessionStorage.getItem("hs:publish-open-next-landed"))).toBeNull();
    // Nothing on screen changed: the post page as it always was (and the
    // Threads preview's placeholder reads "…", not "\\u2026").
    await expect(page.getByPlaceholder("Start a thread…")).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    // Back on the list again: the trail is spent, no second bounce.
    await page.goto("/starter-story/production");
    await page.waitForTimeout(1500);
    expect(await marks("publish:open-next:back-to-list")).toBe(backBefore + 1);
  } finally {
    await sql.end();
  }
});
