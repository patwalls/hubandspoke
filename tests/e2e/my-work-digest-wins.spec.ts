import { test, expect } from "@playwright/test";
import postgres from "postgres";

// wins-reach-makers M4: the morning email carries, under its button, the
// posts you edited that beat their account's usual since the last email —
// each with its ×N and "why it won". A win you didn't edit, or one noted
// before the last email, isn't there. /my-work/email previews it.
test("the morning email names the posts you edited that beat their usual", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  try {
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id as string;
    expect(me).toBeTruthy();
    // Something waiting, so there is an email at all.
    await sql`
      INSERT INTO production_items (title, brand, status, post_type, editor_user_id)
      VALUES (${`E2E waiting ${stamp}`}, 'starter-story', 'Assigned', 'tiktok', ${me})`;
    const note = (text: string, lift: number, at: string) =>
      sql.json({ note: text, lift, generatedAt: at, model: "e2e" });
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
    await sql`
      INSERT INTO production_items (title, brand, status, post_type, editor_user_id, views, published_at, win_note) VALUES
        (${`E2E fresh win ${stamp}`}, 'starter-story', 'Published', 'tiktok', ${me}, 8400, now() - interval '2 days',
          ${note("Opened on the exact revenue number instead of the founder's name.", 8.4, now)}),
        (${`E2E old win ${stamp}`}, 'starter-story', 'Published', 'tiktok', ${me}, 5000, now() - interval '9 days',
          ${note("An old note from last week's email.", 3, old)}),
        (${`E2E someone else's win ${stamp}`}, 'starter-story', 'Published', 'tiktok', NULL, 9000, now() - interval '1 day',
          ${note("Not yours.", 9, now)})`;

    await page.goto("/my-work/email");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const wins = page.locator("[data-digest-wins]");
    await expect(wins).toBeVisible({ timeout: 15_000 });
    await expect(wins).toContainText("A post you edited beat its usual");
    await expect(wins).toContainText(`E2E fresh win ${stamp}`);
    await expect(wins).toContainText("8.4× its usual");
    await expect(wins).toContainText("Opened on the exact revenue number");
    await expect(wins).not.toContainText("E2E old win");
    await expect(wins).not.toContainText("someone else");
    await expect(page.locator("[data-digest-preview]")).toContainText(`E2E waiting ${stamp}`);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E % ${stamp}`}`;
    await sql.end();
  }
});
