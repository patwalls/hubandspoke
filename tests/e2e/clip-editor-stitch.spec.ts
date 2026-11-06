import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { createDefaultDoc } from "../../src/lib/clip-editor/doc";

// Clip stitching M2: the section picker's suggested lines from elsewhere in
// the video sit above the transcript, each one click to add. A setup plays
// before the clip, a payoff after it. Like the carried-fixes spec, the idea
// is seeded into the DB and the flag + editor session are served from here
// (the e2e DB has no archived video to presign).

test.use({ viewport: { width: 1600, height: 1000 } });
test.setTimeout(120_000);

const at = (text: string, start: number) =>
  text.split(" ").map((t, i) => ({ text: t, startSec: start + i * 0.5, endSec: start + i * 0.5 + 0.45 }));
const words = [
  ...at("first we picked one tiny niche nobody else wanted to serve", 2),
  ...at("then we cold emailed every agency in that niche for a month", 10),
  ...at("and by the end of the year it was doing forty grand a month", 40),
].map((w, index) => ({ index, ...w }));

const moments = [
  { quote: "first we picked one tiny niche nobody else wanted to serve", role: "setup", why: "Why cold email worked", startSec: 2, endSec: 7.5 },
  { quote: "and by the end of the year it was doing forty grand a month", role: "payoff", why: "What the outreach paid", startSec: 40, endSec: 47 },
];

test("suggested lines are one click to stitch in, setup before and payoff after", ({ page }) => stitchFlow(page, false));

// M3: an idea on a section from before the stitch picker opens with none;
// the editor asks the worker once (POST), polls, and the strip appears when
// the lines land. Nothing shows while it looks.
test("an older idea gets its lines to stitch in after the editor asks", ({ page }) => stitchFlow(page, true));

async function stitchFlow(page: Page, older: boolean) {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const editorUserId = (await (await page.request.get("/api/auth/session")).json())?.user?.id;
    const pillar = await page.request.post("/api/production-items", {
      data: { title: `E2E pillar ${stamp}`, platform: ["youtube_long"], postType: "youtube_long", publishedDate: "2026-11-05", brand: "starter-story", editorUserId },
    });
    expect(pillar.ok(), await pillar.text()).toBeTruthy();
    const pillarId = (await pillar.json()).id as string;
    const title = `E2E stitch ${stamp}`;
    const item = await page.request.post("/api/production-items", {
      data: { title, platform: ["tiktok"], postType: "tiktok", publishedDate: "2026-11-05", brand: "starter-story", editorUserId },
    });
    expect(item.ok(), await item.text()).toBeTruthy();
    const [idea] = await sql`
      INSERT INTO clip_ideas (source_production_item_id, batch_id, start_sec, end_sec, hook, angle, rationale, generated_by, target_format)
      VALUES (${pillarId}, gen_random_uuid(), 10, 16, 'Cold email still works', 'e2e', 'e2e', 'e2e', 'Repackage Section w/ Hook')
      RETURNING id`;
    await sql`
      UPDATE production_items SET status = 'Idea', source_clip_idea_id = ${idea.id}, pillar_content_item_id = ${pillarId},
        format = 'Repackage Section w/ Hook'
      WHERE id = ${(await item.json()).id}`;

    const saved: { doc: { sections: { startSec: number }[] } }[] = [];
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
          clipIdea: { id: idea.id, status: "suggested", hook: "Cold email still works", angle: "", rationale: "", startSec: 10, endSec: 16, targetFormat: "Repackage Section w/ Hook", acceptedProductionItemId: null },
          brand: "starter-story",
          formatLook: null,
          edit: { id: `edit-${idea.id}`, revision: 1, doc: createDefaultDoc({ startSec: 10, endSec: 16, hook: "Cold email still works" }) },
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
          supportingMoments: older ? [] : moments,
          stitchPending: older,
        },
      });
    });

    const stitchCalls: string[] = [];
    let ready = false;
    await page.route(/\/api\/clip-ideas\/[^/]+\/editor\/stitch$/, async (route) => {
      stitchCalls.push(route.request().method());
      await route.fulfill({ json: ready ? { pending: false, moments } : { pending: true, moments: [] } });
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

    const strip = dialog.getByTestId("stitch-suggestions");
    if (older) {
      await expect.poll(() => stitchCalls[0]).toBe("POST");
      await expect(strip).toHaveCount(0);
      ready = true;
    }
    await expect(strip).toContainText("Lines to stitch in", { timeout: 15_000 });
    if (older && process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
    expect(stitchCalls.filter((m) => m === "POST")).toHaveLength(older ? 1 : 0);
    await expect(strip.getByRole("button", { name: "Add" })).toHaveCount(2);
    await page.screenshot({ path: ".playwright-mcp/screenshots/clip-stitch-before.png" });

    // Payoff first, then setup: the order they are added in doesn't matter.
    await strip.getByRole("listitem").filter({ hasText: "Payoff" }).getByRole("button", { name: "Add" }).click();
    await strip.getByRole("listitem").filter({ hasText: "Setup" }).getByRole("button", { name: "Add" }).click();
    await expect(strip.getByRole("button", { name: "Add" })).toHaveCount(0);
    await expect(strip.getByText("Added")).toHaveCount(2);
    await page.screenshot({ path: ".playwright-mcp/screenshots/clip-stitch-after.png" });

    await expect.poll(() => saved.at(-1)?.doc.sections.map((s) => s.startSec), { timeout: 15_000 }).toEqual([2, 10, 40]);

    // Undo brings the button back.
    await page.keyboard.press("Meta+z");
    await expect(strip.getByRole("button", { name: "Add" })).toHaveCount(1);
  } finally {
    await sql.end();
  }
}
