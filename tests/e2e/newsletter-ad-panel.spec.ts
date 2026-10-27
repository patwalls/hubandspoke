import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The issue's ad (the template's sponsor section) has its own side panel:
// marked as an ad, its main link up top, paste-in copy used as written, and
// Remove / Put it back. Asana is the optional source, last. The draft's ad is
// put back the way it was afterwards.
test("the newsletter ad panel: paste an ad, see its link, remove it and put it back", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  type Row = { id: string; brand: string; special_copy: string | null; special_original: string | null; special_mode: string | null; special_source: unknown; sections: unknown };
  let saved: Row | undefined;
  try {
    [saved] = await sql<Row[]>`
      SELECT d.id, b.slug AS brand, d.special_copy, d.special_original, d.special_mode, d.special_source, d.sections
      FROM newsletter_drafts d
      JOIN formats f ON f.id = d.format_id
      JOIN brands b ON b.slug = d.brand
      WHERE d.status = 'ready' AND f.name = 'Sunday Breakfast'
        AND (d.screenshots IS NULL OR d.screenshots = '{}'::jsonb)
      ORDER BY d.updated_at DESC LIMIT 1`;
    test.skip(!saved, "no drafted Sunday Breakfast issue in this DB");
    // Start from a known ad.
    await sql`UPDATE newsletter_drafts SET special_copy = 'Old sponsor copy here.', special_original = 'Old sponsor copy here.', special_mode = 'verbatim', special_source = NULL, revision = revision + 1 WHERE id = ${saved!.id}`;

    await page.goto(`/${saved!.brand}/newsletters?open=${saved!.id}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});

    await page.getByText("Old sponsor copy here.").first().click({ timeout: 30_000 });
    await expect(page.getByText("Ad · The Special")).toBeVisible();
    await expect(page.getByText("Main link")).toBeVisible();

    await page.getByPlaceholder(/Paste the ad from Slack/).fill("Acme is the CRM for one-person shops. Free for 30 days.");
    await page.getByPlaceholder(/Link \(optional\)/).fill("https://acme.example/try");
    await page.getByRole("button", { name: "Use as written" }).last().click();
    await expect(page.getByText("Acme is the CRM for one-person shops.").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('input[value="https://acme.example/try"]')).toBeVisible();
    await page.screenshot({ path: ".playwright-mcp/screenshots/newsletter-ad-panel.png" });

    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText(/No ad in this issue/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Acme is the CRM for one-person shops.")).toHaveCount(0);
    await page.screenshot({ path: ".playwright-mcp/screenshots/newsletter-ad-removed.png" });

    await page.getByRole("button", { name: "Put it back" }).click();
    await expect(page.getByText("Acme is the CRM for one-person shops.").first()).toBeVisible({ timeout: 15_000 });
    // Out of the in-place editor, the canvas marks the section as the ad (the sent email doesn't).
    await page.getByRole("button", { name: /Subject & preview text/ }).click();
    await expect(page.getByText("Ad", { exact: true }).first()).toBeVisible();
    await page.getByText("Acme is the CRM for one-person shops.").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".playwright-mcp/screenshots/newsletter-ad-canvas.png" });
  } finally {
    if (saved)
      await sql`UPDATE newsletter_drafts SET special_copy = ${saved.special_copy}, special_original = ${saved.special_original}, special_mode = ${saved.special_mode}, special_source = ${sql.json(saved.special_source as never)}, sections = ${sql.json(saved.sections as never)}, revision = revision + 1 WHERE id = ${saved.id}`;
    await sql.end();
  }
});
