import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Publishing a cross-post from its content page offers the same post's next
// cross-post waiting on you, so a curator posting one post to five platforms
// doesn't go back to the production list to find each one. (Before, the
// page's refetch after Publish swapped in "Loading…", which unmounted the
// card's memory, so it never showed after a Publish at all.)
test("publishing a cross-post offers the next one from the same post", async ({ page }) => {
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
    const sourceId = await create(`E2E source post ${stamp}`);
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${sourceId}`;
    const crossPost = async (title: string, age: string) => {
      const id = await create(title);
      await sql`UPDATE production_items SET status = 'Ready To Publish', source_type = 'cross_post', reposted_from_item_id = ${sourceId}, updated_at = now() - ${age}::interval WHERE id = ${id}`;
      return id;
    };
    // The oldest thing on your plate is unrelated: without the sibling rule it would come next.
    const olderId = await create(`E2E older unrelated ${stamp}`);
    await sql`UPDATE production_items SET status = 'Assigned', updated_at = now() - interval '5 days' WHERE id = ${olderId}`;
    const firstId = await crossPost(`E2E cross-post one ${stamp}`, "2 hours");
    const second = `E2E cross-post two ${stamp}`;
    const secondId = await crossPost(second, "1 hour");

    await page.goto(`/starter-story/content/${firstId}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();
    await expect(page.getByTestId("up-next")).toBeVisible();
    await expect(page.getByTestId("up-next-card")).toHaveCount(0);

    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    await dialog.locator("#publish-link").fill(`https://www.linkedin.com/feed/update/e2e-${stamp}`);
    await dialog.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(dialog).toBeHidden();

    const card = page.getByTestId("up-next-card");
    await expect(card).toContainText("Published. Next from the same post");
    await expect(card).toContainText(second);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await card.getByRole("link", { name: /Open next/ }).click();
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${secondId}$`));
  } finally {
    await sql.end();
  }
});
