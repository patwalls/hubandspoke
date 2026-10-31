import { test, expect } from "@playwright/test";
import postgres from "postgres";

// People open a post from In Production, go back to the list and open the
// next one. Opened from the list, the content page now says where you are in
// that status group and steps through it (‹ › or j / k), and its back link
// returns to In Production instead of the Content tab.
test("a post opened from In Production steps through its status group", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Run ${Date.now()}`;
  try {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const res = await page.request.post("/api/production-items", {
        data: {
          title: `${tag} part ${n}`,
          platform: ["linkedin"],
          postType: "linkedin",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      ids.push((await res.json()).id as string);
    }
    // Oldest first, so the list (newest first by default) shows part 3, 2, 1.
    for (const [i, id] of ids.entries()) {
      await sql`UPDATE production_items SET status = 'Review', created_at = now() - ${`${3 - i} minutes`}::interval WHERE id = ${id}`;
    }

    await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const links = page.getByRole("link", { name: new RegExp(tag) });
    await expect(links).toHaveCount(3);
    const order = await links.allTextContents();
    await links.nth(1).click();
    await expect(page).toHaveURL(/\/starter-story\/content\//);

    const run = page.getByTestId("production-run");
    await expect(run).toBeVisible();
    await expect(page.getByTestId("production-run-position")).toHaveText("Review · 2 of 3");
    await expect(run.getByRole("link", { name: "← In Production" })).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    // ›  goes to the list's next row.
    await run.getByRole("link", { name: "Next" }).click();
    await expect(page.getByTestId("production-run-position")).toHaveText("Review · 3 of 3");
    expect(order).toHaveLength(3);

    // k steps back (not while typing in a field).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("k");
    await expect(page.getByTestId("production-run-position")).toHaveText("Review · 2 of 3");

    // Back goes to the filtered production list, not Content.
    await run.getByRole("link", { name: "← In Production" }).click();
    await expect(page).toHaveURL(/\/starter-story\/production/);
    await expect(links).toHaveCount(3);

    // Opened from anywhere else (no remembered run), it's the plain Content link.
    await page.evaluate(() => window.sessionStorage.removeItem("hs:production-run"));
    await page.goto(`/starter-story/content/${ids[0]}`);
    await expect(page.getByRole("link", { name: "← Content" })).toBeVisible();
    await expect(page.getByTestId("production-run")).toHaveCount(0);
  } finally {
    // Left in Review, they'd sit on other specs' My Work.
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});
