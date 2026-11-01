import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// In Production: a post stuck in a hand-off status (Review / Ready To
// Publish) for 3+ days says "waiting Nd" under its age; fresh posts and
// statuses where waiting is normal (Assigned) stay quiet.

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

test("posts stuck in Review show how long they've waited", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Waiting ${Date.now()}`;
  const ids: string[] = [];
  try {
    const stuck = await makePost(page, `${tag} stuck`);
    const fresh = await makePost(page, `${tag} fresh`);
    const backlog = await makePost(page, `${tag} backlog`);
    ids.push(stuck, fresh, backlog);
    const move = async (id: string, to: string, daysAgo: number) => {
      await sql`UPDATE production_items SET status = ${to}, created_at = now() - interval '20 days' WHERE id = ${id}`;
      await sql`
        INSERT INTO content_events (content_item_id, event_type, payload, created_at)
        VALUES (${id}, 'status_change', ${sql.json({ type: "status_change", from: "Assigned", to })},
                now() - ${`${daysAgo} days`}::interval)`;
    };
    await move(stuck, "Review", 5);
    await move(fresh, "Review", 1);
    await move(backlog, "Assigned", 9);
    // One more write through the app so the 60 s report cache is dropped
    // after the rows above changed underneath it.
    ids.push(await makePost(page, `E2E cache bust ${Date.now()}`));

    await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();
    await expect(page.locator("[data-production-row]")).toHaveCount(3);

    const row = (id: string) => page.locator(`[data-production-row="${id}"]`);
    const tagIn = (id: string) => row(id).getByTestId("waiting-in-status");
    await expect(tagIn(stuck)).toHaveText("waiting 5d");
    await expect(tagIn(stuck)).toHaveAttribute("title", /^In Review for 5 days, since /);
    await expect(tagIn(fresh)).toHaveCount(0);
    await expect(tagIn(backlog)).toHaveCount(0);

    // Full page in its default state — the tag must be the quiet thing here.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    if (ids.length) await sql`DELETE FROM production_items WHERE id IN ${sql(ids)}`;
    await sql.end();
  }
});
