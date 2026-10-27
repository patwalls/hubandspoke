import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The newsletter editor's Revise (Pat, 2026-10-27): a Revise button next to
// Preview drops down one note for the whole email, and each section has its
// own Revise box (the button reads Revise once there's a note). Read-only:
// never submits (that's a paid model run).
test("Revise: a whole-email note next to Preview, and a Revise box in each section", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  let draft: { id: string; brand: string; sections: { key: string; markdown: string }[] } | undefined;
  try {
    [draft] = await sql<{ id: string; brand: string; sections: { key: string; markdown: string }[] }[]>`
      SELECT d.id, d.brand, d.sections FROM newsletter_drafts d JOIN formats f ON f.id = d.format_id
      WHERE d.status = 'ready' AND f.name = 'Sunday Breakfast' AND jsonb_array_length(d.regenerating) = 0
      ORDER BY d.updated_at DESC LIMIT 1`;
  } finally {
    await sql.end();
  }
  test.skip(!draft, "no drafted Sunday Breakfast issue in this DB");
  // A plain line of text from a story section, to click it in the email.
  const line = draft!.sections
    .flatMap((s) => s.markdown.split("\n"))
    .map((l) => l.replace(/[*_#>[\]`]/g, "").replace(/\(http[^)]*\)/g, "").trim())
    .find((l) => l.length > 40 && !l.startsWith("-") && !/^\d+\./.test(l));
  test.skip(!line, "no plain text line to click");

  await page.goto(`/${draft!.brand}/newsletters?open=${draft!.id}`);
  await page.getByRole("dialog", { name: "What's new" }).getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});

  const revise = page.getByTestId("newsletter-revise");
  await expect(revise).toBeVisible({ timeout: 30_000 });
  // Right after Preview in the header.
  const preview = page.getByRole("button", { name: "Preview", exact: true });
  expect((await revise.boundingBox())!.x).toBeGreaterThan((await preview.boundingBox())!.x);
  await revise.click();
  await expect(page.getByText("Revise the whole email")).toBeVisible();
  await expect(page.getByTestId("newsletter-revise-submit")).toBeDisabled();
  await page.getByTestId("newsletter-revise-note").fill("Cut it by a third and less hype in the intro.");
  await expect(page.getByTestId("newsletter-revise-submit")).toBeEnabled();
  await page.screenshot({ path: ".playwright-mcp/screenshots/newsletter-revise-whole.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByText("Revise the whole email")).toHaveCount(0);

  await page.getByText(line!.slice(0, 30)).first().click();
  const note = page.getByTestId("section-revise-note");
  await expect(note).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toBeVisible();
  await note.fill("Mention the database is free.");
  await expect(page.getByRole("button", { name: "Revise", exact: true }).last()).toBeVisible();
  await page.screenshot({ path: ".playwright-mcp/screenshots/newsletter-revise-section.png" });
});
