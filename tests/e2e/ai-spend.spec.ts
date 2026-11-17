import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The admin AI-spend page rolls llm_calls up by feature and estimates cost
// from src/lib/llm/prices.ts. Seed a few calls (today, a week ago) and check
// the page shows them, costliest first, with an unpriced model flagged.
test("admins see AI spend by feature", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `e2e-ai-${Date.now()}`;
  try {
    const day = 86_400_000;
    const rows = [
      // 5 clip-idea calls on Sonnet: 5 × (200K in × $2/M + 20K out × $10/M) = $3.00
      ...Array.from({ length: 5 }, (_, i) => ({ feature: `${tag}-clip-ideas`, provider: "anthropic", model: "claude-sonnet-5-5", input: 200_000, output: 20_000, audio: 0, at: new Date(Date.now() - i * day) })),
      // 2 transcriptions: 2 × 30 min × $0.006 = $0.36
      ...Array.from({ length: 2 }, (_, i) => ({ feature: `${tag}-transcribe`, provider: "openai", model: "whisper-1", input: 0, output: 0, audio: 1800, at: new Date(Date.now() - (i + 7) * day) })),
      // An unpriced model: counted, flagged, not in the totals.
      { feature: `${tag}-enhance`, provider: "openai", model: "gpt-image-2", input: 1000, output: 4000, audio: 0, at: new Date() },
    ];
    for (const r of rows) {
      await sql`INSERT INTO llm_calls (provider, feature, model, input_tokens, output_tokens, audio_seconds, created_at)
        VALUES (${r.provider}, ${r.feature}, ${r.model}, ${r.input}, ${r.output}, ${r.audio}, ${r.at})`;
    }

    await page.goto("/settings/ai-spend");
    await expect(page.getByRole("heading", { name: "AI spend" })).toBeVisible();
    const totals = page.getByTestId("ai-spend-totals");
    await expect(totals).toContainText("$3.36");
    await expect(totals).toContainText("Claude");
    await expect(totals).toContainText("$3.00");

    const featureRows = page.locator("tbody tr");
    await expect(featureRows.first()).toContainText(`${tag}-clip-ideas`);
    await expect(featureRows.first()).toContainText("$3.00");
    await expect(page.getByRole("row", { name: new RegExp(`${tag}-transcribe`) })).toContainText("60 audio min");
    await expect(page.getByRole("row", { name: new RegExp(`${tag}-enhance`) })).toContainText("+?");
    await expect(page.getByText(/No price yet for gpt-image-2/)).toBeVisible();

    // The settings nav links to it.
    await expect(page.getByRole("link", { name: "AI spend" })).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql`DELETE FROM llm_calls WHERE feature LIKE ${`${tag}%`}`;
    await sql.end();
  }
});
