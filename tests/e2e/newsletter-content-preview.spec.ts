import { test, expect } from "@playwright/test";
import postgres from "postgres";

// A newsletter item with an edition previews as the designed email itself on
// its content page (the editor's exact HTML in a frame), not the empty
// "Inbox · Body copy…" mock.
test("the content page shows a newsletter's designed email", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const [row] = await sql<{ id: string; brand: string; subject: string | null }[]>`
      SELECT p.id, b.slug AS brand, d.subject
      FROM newsletter_drafts d
      JOIN production_items p ON p.id = d.production_item_id
      JOIN accounts a ON a.id = p.account_id
      JOIN brands b ON b.id = a.brand_id
      WHERE d.status = 'ready' AND p.post_type = 'newsletter'
        AND p.status <> 'Published' -- a published post shows its live embed instead
        -- picked screenshots need S3 to presign, which a local DB has no creds for
        AND (d.screenshots IS NULL OR d.screenshots = '{}'::jsonb)
      ORDER BY d.updated_at DESC LIMIT 1`;
    test.skip(!row, "no drafted newsletter edition in this DB");

    await page.goto(`/${row.brand}/content/${row.id}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 10_000 }).catch(() => {});
    const frame = page.frameLocator('iframe[title="Newsletter email"]');
    await expect(frame.locator("table").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Body copy…")).toHaveCount(0);
    if (row.subject) await expect(page.getByText(row.subject, { exact: true }).first()).toBeVisible();
    // Sized to the email, not a scrolling 150px box.
    const box = await page.locator('iframe[title="Newsletter email"]').boundingBox();
    expect(box!.height).toBeGreaterThan(600);
    await page.locator('iframe[title="Newsletter email"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".playwright-mcp/screenshots/newsletter-content-preview.png", fullPage: true });
  } finally {
    await sql.end();
  }
});
