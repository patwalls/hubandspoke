import { test, expect } from "@playwright/test";
import postgres from "postgres";
import type { Page } from "@playwright/test";
import { createDefaultDoc } from "../../src/lib/clip-editor/doc";

async function dismissWhatsNew(page: Page) {
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
}

// clip-trim M2: the format page's Clip look card says, in one quiet line, how
// often editors cut the run-up off this format's AI clip windows — the habit
// new clip ideas learn. Clip edits are seeded straight into clip_edits.
test("format page shows where editors trim the AI clip window", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const name = `E2E Clip Trims ${Date.now()}`;
    const [format] = await sql`
      INSERT INTO formats (name, brand, instructions, is_clippable_format) VALUES (${name}, 'starter-story', 'plain', true) RETURNING id`;
    const [pillar] = await sql`
      INSERT INTO production_items (title, brand, status) VALUES (${`${name} pillar`}, 'starter-story', 'Published') RETURNING id`;
    // Six edited clips of a 100–160 s window: four cut the opening (8, 10, 12,
    // 20 s), two kept the AI's start.
    for (const head of [8, 10, 12, 20, 0, 0]) {
      const doc = structuredClone(createDefaultDoc({ startSec: 100, endSec: 160, hook: "Same hook" }));
      if (head) doc.sections.find((s) => s.role === "body")!.removals.push({ startSec: 100, endSec: 100 + head, reason: "manual" });
      const [idea] = await sql`
        INSERT INTO clip_ideas (source_production_item_id, batch_id, start_sec, end_sec, hook, angle, rationale, generated_by, target_format)
        VALUES (${pillar.id}, gen_random_uuid(), 100, 160, 'Same hook', 'e2e', 'e2e', 'e2e', ${name}) RETURNING id`;
      await sql`INSERT INTO clip_edits (clip_idea_id, doc, revision) VALUES (${idea.id}, ${sql.json(doc)}, 2)`;
    }

    await page.goto(`/starter-story/formats/${format.id}`);
    await dismissWhatsNew(page);
    const line = page.getByTestId("clip-trims");
    await expect(line).toBeVisible({ timeout: 15000 });
    await expect(line).toHaveText("Editors cut the opening on 4 of 6 clips (~11s)");
    await expect(page.getByText(/ending on/)).toHaveCount(0);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql.end();
  }
});
