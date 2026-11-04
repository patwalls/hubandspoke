import { test, expect } from "@playwright/test";
import postgres from "postgres";
import type { Page } from "@playwright/test";
import { applyLook, createDefaultDoc, createTextLayer, lookFromDoc, type TextLayer } from "../../src/lib/clip-editor/doc";

async function dismissWhatsNew(page: Page) {
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
}

// The format page's Clip look card says, in one quiet line, what editors keep
// changing in clips that started from the look, and opens to one row per
// change. Clip edits are seeded straight into clip_edits (making them needs a
// transcript the e2e box doesn't have).
test("format page says what editors change in the clip look", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const name = `E2E Clip Look ${Date.now()}`;
    const [format] = await sql`
      INSERT INTO formats (name, brand, instructions, is_clippable_format) VALUES (${name}, 'starter-story', 'plain', true) RETURNING id`;
    const look = lookFromDoc(createDefaultDoc({ startSec: 0, endSec: 30, hook: "Placeholder hook" }));
    const saved = await page.request.put(`/api/formats/${format.id}/clip-template`, { data: { look } });
    expect(saved.ok(), await saved.text()).toBeTruthy();

    const [pillar] = await sql`
      INSERT INTO production_items (title, brand, status) VALUES (${`${name} pillar`}, 'starter-story', 'Published') RETURNING id`;
    // Four edited clips: three hid the AI hook, one of them added its own
    // text; the fourth kept the look as it was.
    for (let i = 0; i < 4; i++) {
      const doc = structuredClone(applyLook(createDefaultDoc({ startSec: 10 * i, endSec: 10 * i + 20, hook: `AI hook ${i}` }), look));
      if (i < 3) doc.layers.find((l): l is TextLayer => l.type === "text" && l.role === "hook")!.visible = false;
      if (i === 0) doc.layers.push(createTextLayer({ text: "The editor's own line", canvas: doc.canvas }));
      const [idea] = await sql`
        INSERT INTO clip_ideas (source_production_item_id, batch_id, start_sec, end_sec, hook, angle, rationale, generated_by, target_format)
        VALUES (${pillar.id}, gen_random_uuid(), ${10 * i}, ${10 * i + 20}, ${`AI hook ${i}`}, 'e2e', 'e2e', 'e2e', ${name}) RETURNING id`;
      await sql`INSERT INTO clip_edits (clip_idea_id, doc, revision) VALUES (${idea.id}, ${sql.json(doc)}, 3)`;
    }

    await page.goto(`/starter-story/formats/${format.id}`);
    await dismissWhatsNew(page);
    const line = page.getByTestId("clip-look-edits");
    await expect(line).toBeVisible({ timeout: 15000 });
    await expect(line).toContainText("Editors change: hook hidden on 3 of 4 clips · +1 more");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    await line.getByRole("button").click();
    await expect(line.getByRole("listitem")).toHaveText(["hook hidden on 3 of 4 clips", "own text added on 1 of 4 clips"]);

    // The open/closed choice is remembered in this browser.
    await page.reload();
    await dismissWhatsNew(page);
    await expect(page.getByTestId("clip-look-edits").getByRole("listitem").first()).toBeVisible({ timeout: 15000 });
  } finally {
    await sql.end();
  }
});
