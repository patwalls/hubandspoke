import { test, expect } from "@playwright/test";
import postgres from "postgres";
import type { Page } from "@playwright/test";
import { createDefaultDoc, createTextLayer, type TextLayer } from "../../src/lib/clip-editor/doc";

async function dismissWhatsNew(page: Page) {
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
}

// hooks-learn M2: the format page's Clip look card says how often editors
// replace the AI hook, and opens to the pairs (AI hook → what shipped) that
// new clip ideas learn from. Clip edits are seeded straight into clip_edits.
test("format page shows how editors rewrite the AI hooks", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const name = `E2E Hook Rewrites ${Date.now()}`;
    const [format] = await sql`
      INSERT INTO formats (name, brand, instructions, is_clippable_format) VALUES (${name}, 'starter-story', 'plain', true) RETURNING id`;
    const [pillar] = await sql`
      INSERT INTO production_items (title, brand, status) VALUES (${`${name} pillar`}, 'starter-story', 'Published') RETURNING id`;
    // Three edited clips: one cut the hook down, one hid it and typed its own
    // line, one kept the AI's words.
    const ai = ["He spent 70 percent of his week on the sales floor watching his team", "Four AI models, one ad, one clear winner", "This founder kept the AI hook"];
    for (let i = 0; i < 3; i++) {
      const doc = structuredClone(createDefaultDoc({ startSec: 10 * i, endSec: 10 * i + 20, hook: ai[i] }));
      const hook = doc.layers.find((l): l is TextLayer => l.type === "text" && l.role === "hook")!;
      if (i === 0) hook.text = "70% on the sales floor";
      if (i === 1) {
        hook.visible = false;
        doc.layers.push(createTextLayer({ text: "Which AI wins?", canvas: doc.canvas }));
      }
      const [idea] = await sql`
        INSERT INTO clip_ideas (source_production_item_id, batch_id, start_sec, end_sec, hook, angle, rationale, generated_by, target_format)
        VALUES (${pillar.id}, gen_random_uuid(), ${10 * i}, ${10 * i + 20}, ${ai[i]}, 'e2e', 'e2e', 'e2e', ${name}) RETURNING id`;
      await sql`INSERT INTO clip_edits (clip_idea_id, doc, revision) VALUES (${idea.id}, ${sql.json(doc)}, 3)`;
    }

    await page.goto(`/starter-story/formats/${format.id}`);
    await dismissWhatsNew(page);
    const line = page.getByTestId("hook-rewrites");
    await expect(line).toBeVisible({ timeout: 15000 });
    await expect(line).toContainText("Editors rewrite the AI hook on 2 of 3 clips");
    await line.getByRole("button").click();
    await expect(line.getByRole("listitem")).toHaveCount(2);
    await expect(line).toContainText("→ 70% on the sales floor");
    await expect(line).toContainText("→ Which AI wins?");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql.end();
  }
});
