import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// review-doesnt-wait M2 + M3: a Review post's peek on In Production approves
// it to Ready To Publish, and a Review post nobody has touched in 14 days asks
// "still needed?" with On Hold / Kill — all without opening the post.

type Sql = ReturnType<typeof postgres>;

// Each test loads the list (and waits out the What's new pop-up) up to twice.
test.describe.configure({ timeout: 90_000 });

async function makePosts(page: Page, sql: Sql, tag: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const res = await page.request.post("/api/production-items", {
      data: { title: `${tag} part ${i}`, platform: ["linkedin"], postType: "linkedin", publishedDate: new Date().toISOString().slice(0, 10), brand: "starter-story" },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    ids.push((await res.json()).id as string);
  }
  for (const id of ids) await sql`UPDATE production_items SET status = 'Review', published_link = NULL WHERE id = ${id}`;
  return ids;
}

/** Put a post in Review `days` ago, optionally with a comment `commentDays` ago. */
async function ageInReview(sql: Sql, id: string, days: number, commentDays?: number) {
  await sql`INSERT INTO content_events (content_item_id, event_type, payload, created_at)
    VALUES (${id}, 'status_change', ${sql.json({ type: "status_change", from: "Assigned", to: "Review" })}, now() - make_interval(days => ${days}))`;
  if (commentDays != null) {
    await sql`INSERT INTO content_comments (content_item_id, body, created_at)
      VALUES (${id}, 'Looks close', now() - make_interval(days => ${commentDays}))`;
  }
}

async function peek(page: Page, tag: string, id: string) {
  await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
  const popup = page.getByRole("dialog", { name: "What's new" });
  await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
  const row = page.locator(`[data-production-row="${id}"]`);
  await row.hover();
  await row.getByRole("button", { name: "Peek" }).click();
  await expect(page.getByTestId("production-peek-title")).toBeVisible({ timeout: 20_000 });
}

test("Approve in the peek moves a Review post to Ready To Publish and steps on", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E PeekApprove ${Date.now()}`;
  try {
    const ids = await makePosts(page, sql, tag, 2);
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
    // First peek of the run compiles the route on a dev server: give it time.
    await expect(page.getByTestId("production-peek-title")).toHaveText(title(order[0]), { timeout: 20_000 });
    // A fresh Review post: Approve, no "still needed?".
    await expect(page.getByTestId("production-peek-stale")).toHaveCount(0);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT.replace(".png", "-approve.png") });
    await page.getByRole("button", { name: "Approve → Ready To Publish" }).click();

    await expect(page.getByTestId("production-peek-title")).toHaveText(title(order[1]));
    // Still on the list (Ready To Publish is a pipeline group), now regrouped.
    await expect(rows).toHaveCount(2);
    const [row] = await sql`SELECT status FROM production_items WHERE id = ${order[0]}`;
    expect(row.status).toBe("Ready To Publish");
    const [ev] = await sql`SELECT payload FROM content_events WHERE content_item_id = ${order[0]} AND event_type = 'status_change' ORDER BY created_at DESC LIMIT 1`;
    expect(ev.payload.to).toBe("Ready To Publish");

    // Once approved, its peek offers posting, not approving again.
    await peek(page, tag, order[0]);
    await expect(page.getByTestId("production-peek-title")).toHaveText(title(order[0]));
    await expect(page.getByTestId("production-peek-publish")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve → Ready To Publish" })).toHaveCount(0);
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});

test("a Review post untouched for 14 days asks 'still needed?': On Hold", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E PeekStaleHold ${Date.now()}`;
  try {
    const [id] = await makePosts(page, sql, tag, 1);
    // The prod shape: in Review for weeks, last comment 17 d ago.
    await ageInReview(sql, id, 40, 17);
    await peek(page, tag, id);
    const stale = page.getByTestId("production-peek-stale");
    await expect(stale).toContainText("In Review 40d, no comments in 14 days. Still needed?");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT.replace(".png", "-stale.png") });
    await stale.getByRole("button", { name: "On Hold" }).click();
    await expect.poll(async () => (await sql`SELECT status FROM production_items WHERE id = ${id}`)[0].status).toBe("On Hold");
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});

test("a stale Review post can be killed from the peek, with a reason", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E PeekStaleKill ${Date.now()}`;
  try {
    const [id] = await makePosts(page, sql, tag, 1);
    await ageInReview(sql, id, 30);
    await peek(page, tag, id);
    await page.getByTestId("production-peek-stale").getByRole("button", { name: "Kill…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("Abandoned, the guest pulled out");
    await dialog.getByRole("button", { name: "Kill post" }).click();
    await expect(page.locator(`[data-production-row="${id}"]`)).toHaveCount(0);
    const [row] = await sql`SELECT status FROM production_items WHERE id = ${id}`;
    expect(row.status).toBe("Killed");
    // The reason lands where every kill's does (the "killed" event).
    const [ev] = await sql`SELECT payload FROM content_events WHERE content_item_id = ${id} AND event_type = 'killed'`;
    expect(ev.payload.reason).toBe("Abandoned, the guest pulled out");
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});

test("a Review post with a recent comment is not asked 'still needed?'", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E PeekNotStale ${Date.now()}`;
  try {
    const [id] = await makePosts(page, sql, tag, 1);
    await ageInReview(sql, id, 20, 3);
    await peek(page, tag, id);
    await expect(page.getByRole("button", { name: "Approve → Ready To Publish" })).toBeVisible();
    await expect(page.getByTestId("production-peek-stale")).toHaveCount(0);
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});
