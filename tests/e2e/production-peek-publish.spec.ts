import { test, expect } from "@playwright/test";
import postgres from "postgres";

// review-doesnt-wait M1: a Review post's peek on In Production takes the live
// link and publishes it, then steps to the next post — no trip to the post page.

test("paste the live link in the peek: the post goes Published and the peek moves on", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E PeekPublish ${Date.now()}`;
  try {
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const res = await page.request.post("/api/production-items", {
        data: { title: `${tag} part ${n}`, platform: ["linkedin"], postType: "linkedin", brand: "starter-story" },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      ids.push((await res.json()).id as string);
    }
    for (const id of ids) {
      await sql`UPDATE production_items SET status = 'Review', editor_user_id = NULL, published_link = NULL WHERE id = ${id}`;
    }

    await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    const rows = page.locator("[data-production-row]");
    await expect(rows).toHaveCount(2);
    const order = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-production-row")!));
    const title = (id: string) => `${tag} part ${ids.indexOf(id) + 1}`;

    const first = page.locator(`[data-production-row="${order[0]}"]`);
    await first.hover();
    await first.getByRole("button", { name: "Peek" }).click();
    await expect(page.getByTestId("production-peek-title")).toHaveText(title(order[0]));
    const box = page.getByTestId("production-peek-publish");
    await expect(box).toBeVisible();

    // A link from another platform is refused before it's saved.
    await box.getByRole("textbox").fill("https://www.instagram.com/p/ABC123/");
    await expect(box.getByRole("button", { name: "Mark published" })).toBeDisabled();

    const link = `https://www.linkedin.com/feed/update/urn:li:activity:${Date.now()}/`;
    await box.getByRole("textbox").fill(link);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
    await box.getByRole("textbox").press("Enter");

    // The published row leaves the list and the peek steps to the other post.
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId("production-peek-title")).toHaveText(title(order[1]));
    const [row] = await sql`SELECT status, published_link FROM production_items WHERE id = ${order[0]}`;
    expect(row.status).toBe("Published");
    expect(row.published_link).toBe(link);
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});

test("no link box on a post still being edited", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E PeekNoPublish ${Date.now()}`;
  try {
    const res = await page.request.post("/api/production-items", {
      data: { title: `${tag} part 1`, platform: ["linkedin"], postType: "linkedin", brand: "starter-story" },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    await sql`UPDATE production_items SET status = 'Assigned' WHERE id = ${id}`;

    await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    const row = page.locator(`[data-production-row="${id}"]`);
    await row.hover();
    await row.getByRole("button", { name: "Peek" }).click();
    await expect(page.getByTestId("production-peek-title")).toHaveText(`${tag} part 1`);
    await expect(page.getByTestId("production-peek-publish")).toHaveCount(0);
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});
