import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { createDefaultDoc } from "../../src/lib/clip-editor/doc";

// clip-trim M4: on an idea written before the writer learned this format's
// opening cut, the clip editor offers one quiet line — "Editors usually cut
// ~Ns off the start" + a button that cuts the run-up to the nearest sentence
// start. One undo step; undo brings the offer back. Like the stitch spec, the
// idea is seeded into the DB and the flag + editor session are served from
// here (the e2e DB has no archived video to presign).

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

test("an older idea offers to skip the run-up, cut to a sentence start, one undo", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const editorUserId = (await (await page.request.get("/api/auth/session")).json())?.user?.id;
    const pillar = await page.request.post("/api/production-items", {
      data: { title: `E2E pillar ${stamp}`, platform: ["youtube_long"], postType: "youtube_long", publishedDate: "2026-11-06", brand: "starter-story", editorUserId },
    });
    expect(pillar.ok(), await pillar.text()).toBeTruthy();
    const pillarId = (await pillar.json()).id as string;
    const title = `E2E run-up ${stamp}`;
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

    const saved: { doc: { sections: { removals: { startSec: number; endSec: number }[] }[] } }[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT" && /\/api\/clip-ideas\/[^/]+\/editor$/.test(r.url())) saved.push(r.postDataJSON());
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
          runUpHabit: { headSec: 8, headCut: 19, clips: 45 },
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
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Editor beta")).toBeVisible({ timeout: 20_000 });

    // Habit 8 s → target 18 s; sentences start at 16 s and 19 s → 19 s ("we sent…") is nearer.
    const line = dialog.getByTestId("skip-run-up");
    await expect(line).toContainText("Editors usually cut ~8s off the start");
    const button = line.getByRole("button", { name: "Skip the first 9s" });
    await expect(button).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await button.click();
    await expect(line).toHaveCount(0);
    await expect
      .poll(() => saved.at(-1)?.doc.sections.flatMap((s) => s.removals.map((r) => [r.startSec, r.endSec])), { timeout: 15_000 })
      .toEqual([[10, 19]]);

    // Undo brings the offer back.
    await page.keyboard.press("Meta+z");
    await expect(dialog.getByTestId("skip-run-up")).toBeVisible();
  } finally {
    await sql.end();
  }
});
