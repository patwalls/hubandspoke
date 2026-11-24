import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { createDefaultDoc } from "../../src/lib/clip-editor/doc";

// clip-editor-finishes M1: the clip editor stays open unless you mean to close
// it. A click on the strip around it is ignored; Esc first lets go of what's
// selected (highlighted words, a text layer on the stage) or leaves the field
// you're typing in, and only closes the editor when nothing is left to drop.
// Before this, any of those closed the whole editor (and reloaded the video on
// reopen). Same seeding as clip-editor-skip-run-up.spec.ts.

test.use({ viewport: { width: 1600, height: 1000 } });
test.setTimeout(120_000);

const at = (text: string, start: number) =>
  text.split(" ").map((t, i) => ({ text: t, startSec: start + i * 0.5, endSec: start + i * 0.5 + 0.45 }));
// The idea's window is 10–50 s. A run-up sentence, a restart, then the point at 19 s.
const words = [
  ...at("so yeah um before we get into it let me just say this.", 10),
  ...at("okay where was I.", 16),
  ...at("we sent four hundred cold emails in one week and booked thirty calls from them", 19),
  ...at("and that is the whole playbook we still use every single month to this day honestly", 30),
  ...at("it works because nobody else in our niche bothers to do it by hand anymore at all", 40),
].map((w, index) => ({ index, ...w }));

test("stray clicks and Esc on a selection keep the clip editor open; Esc with nothing selected closes it", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const editorUserId = (await (await page.request.get("/api/auth/session")).json())?.user?.id;
    const pillar = await page.request.post("/api/production-items", {
      data: { title: `E2E pillar ${stamp}`, platform: ["youtube_long"], postType: "youtube_long", publishedDate: "2026-11-06", brand: "starter-story", editorUserId },
    });
    expect(pillar.ok(), await pillar.text()).toBeTruthy();
    const pillarId = (await pillar.json()).id as string;
    const title = `E2E stays-open ${stamp}`;
    const item = await page.request.post("/api/production-items", {
      data: { title, platform: ["tiktok"], postType: "tiktok", publishedDate: "2026-11-06", brand: "starter-story", editorUserId },
    });
    expect(item.ok(), await item.text()).toBeTruthy();
    const [idea] = await sql`
      INSERT INTO clip_ideas (source_production_item_id, batch_id, start_sec, end_sec, hook, angle, rationale, generated_by, target_format)
      VALUES (${pillarId}, gen_random_uuid(), 10, 50, 'Cold email still works', 'e2e', 'e2e', 'claude-haiku-5-5:hook-v3', 'Repackage Section w/ Hook')
      RETURNING id`;
    await sql`
      UPDATE production_items SET status = 'Idea', source_clip_idea_id = ${idea.id}, pillar_content_item_id = ${pillarId},
        format = 'Repackage Section w/ Hook'
      WHERE id = ${(await item.json()).id}`;

    const _saved: { doc: { sections: { removals: { startSec: number; endSec: number }[] }[] } }[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT" && /\/api\/clip-ideas\/[^/]+\/editor$/.test(r.url())) _saved.push(r.postDataJSON());
    });
    await page.route(/\/api\/feature-flags$/, async (route) => {
      const json = await (await route.fetch()).json();
      await route.fulfill({ json: { ...json, flags: { ...json.flags, clipEditor: true } } });
    });
    await page.route(/\/api\/clip-ideas\/[^/]+\/editor$/, async (route) => {
      if (route.request().method() !== "GET") return route.fulfill({ json: { revision: 2 } });
      await route.fulfill({
        json: {
          clipIdea: { id: idea.id, status: "suggested", hook: "Cold email still works", angle: "", rationale: "", startSec: 10, endSec: 50, targetFormat: "Repackage Section w/ Hook", acceptedProductionItemId: null },
          brand: "starter-story",
          formatLook: null,
          runUpHabit: null,
          edit: { id: `edit-${idea.id}`, revision: 1, doc: createDefaultDoc({ startSec: 10, endSec: 50, hook: "Cold email still works" }) },
          imageUrls: {},
          mediaUrls: {},
          source: { productionItemId: pillarId, title: "E2E pillar", videoUrl: "/e2e-no-video.mp4", durationSec: 60 },
          words,
          carriedFixes: [],
          offeredFixes: null,
          speakers: null,
          wordsSynthetic: false,
          latestRender: null,
          post: null,
          reviewNotes: null,
          supportingMoments: [],
          stitchPending: false,
        },
      });
    });

    const flagsLoaded = page.waitForResponse(/\/api\/feature-flags$/);
    await page.goto("/starter-story/queue");
    await flagsLoaded;
    await page.getByRole("dialog", { name: "What's new" }).getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    const row = page.getByRole("button", { name: title });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    const editor = page.getByText("Editor beta");
    await expect(editor).toBeVisible({ timeout: 20_000 });

    // 1. A click on the strip around the editor doesn't close it.
    await page.mouse.click(4, 500);
    await page.waitForTimeout(400);
    await expect(editor).toBeVisible();

    // 2. Esc with words highlighted drops the highlight, not the editor.
    await page.locator("[data-pos].text-foreground").nth(3).click();
    await page.locator("[data-pos].text-foreground").nth(6).click({ modifiers: ["Shift"] });
    const toolbar = page.getByRole("toolbar", { name: "Selected words" });
    await expect(toolbar).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(toolbar).toBeHidden();
    await expect(editor).toBeVisible();

    // 3. Esc with a text layer picked on the stage drops the pick (its
    //    inspector panel loses the blue ring), not the editor.
    await page.getByRole("button", { name: "Text", exact: true }).first().click();
    await page.getByRole("button", { name: "Text", exact: true }).last().click();
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Text 1" }) });
    await expect(panel).toHaveClass(/border-sky-400/);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect(panel).not.toHaveClass(/border-sky-400/);

    // 4. Nothing left to drop: Esc closes the editor, as it always did.
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden({ timeout: 10_000 });
  } finally {
    await sql.end();
  }
});
