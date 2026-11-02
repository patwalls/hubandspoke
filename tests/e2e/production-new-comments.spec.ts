import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// In Production: a post someone else commented on in the last 2 days shows a
// quiet "💬 N" after its title; your own comments, old ones and notes marked
// done don't count. Clicking it opens the peek, which lists the comments.

async function makePost(page: Page, title: string): Promise<string> {
  const res = await page.request.post("/api/production-items", {
    data: {
      title,
      platform: ["linkedin"],
      postType: "linkedin",
      publishedDate: new Date().toISOString().slice(0, 10),
      brand: "starter-story",
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).id as string;
}

test("posts with fresh comments from others say so on the list", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Comments ${Date.now()}`;
  const ids: string[] = [];
  try {
    const [me] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = 'e2e@local.test'`;
    const fresh = await makePost(page, `${tag} fresh feedback`);
    const mine = await makePost(page, `${tag} my own note`);
    const stale = await makePost(page, `${tag} old feedback`);
    ids.push(fresh, mine, stale);
    await sql`UPDATE production_items SET status = 'Review' WHERE id IN ${sql([fresh, mine, stale])}`;
    const comment = async (id: string, userId: string | null, author: string | null, hoursAgo: number, body: string) => {
      await sql`
        INSERT INTO content_comments (content_item_id, user_id, author_name, body, created_at)
        VALUES (${id}, ${userId}, ${author}, ${body}, now() - ${`${hoursAgo} hours`}::interval)`;
    };
    await comment(fresh, null, "Kate Reviewer", 3, "Tighten the hook in the first line");
    await comment(fresh, null, "Sam Producer", 20, "Cover image is too dark");
    await comment(fresh, me.id, null, 1, "On it");
    await comment(mine, me.id, null, 1, "Note to self");
    await comment(stale, null, "Kate Reviewer", 72, "Looks good");
    // One more write through the app so the 60 s report cache is dropped
    // after the rows above changed underneath it.
    ids.push(await makePost(page, `E2E cache bust ${Date.now()}`));

    await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();
    await expect(page.locator("[data-production-row]")).toHaveCount(3);

    const marker = (id: string) => page.locator(`[data-production-row="${id}"]`).getByTestId("new-comments");
    await expect(marker(fresh)).toHaveText("2");
    await expect(marker(fresh)).toHaveAttribute(
      "title",
      "2 new comments in the last 2 days · latest from Kate, 3h ago",
    );
    await expect(marker(mine)).toHaveCount(0);
    await expect(marker(stale)).toHaveCount(0);

    // Full page in its default state — the marker must be a quiet thing here.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    await marker(fresh).click();
    const peek = page.getByTestId("production-peek");
    await expect(peek).toBeVisible();
    await expect(peek).toContainText("Tighten the hook in the first line");
  } finally {
    if (ids.length) await sql`DELETE FROM production_items WHERE id IN ${sql(ids)}`;
    await sql.end();
  }
});
