import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { createDefaultDoc } from "../../src/lib/clip-editor/doc";

// Previous / Next in the clip editor: on the queue, the editor's header says
// "2 of 3" and its arrows move to the neighbouring clip idea without closing
// and reopening. The e2e DB has no archived videos or clip ideas (and no S3
// to presign them): the ideas are seeded into the DB, the flag and the editor
// session are served from the test; everything else is the real app.

test.use({ viewport: { width: 1600, height: 1000 } });
test.setTimeout(120_000);

type Idea = { id: string; hook: string; title: string };

// Three clip ideas on the queue, seeded straight into the DB: a pillar, a
// clip_ideas row each, and the Idea-status item that carries it.
async function seedIdeas(page: Page, sql: postgres.Sql): Promise<Idea[]> {
  const stamp = Date.now();
  const editorUserId = (await (await page.request.get("/api/auth/session")).json())?.user?.id;
  expect(editorUserId).toBeTruthy();
  const res = await page.request.post("/api/production-items", {
    data: { title: `E2E pillar ${stamp}`, platform: ["youtube_long"], postType: "youtube_long", publishedDate: "2026-10-20", brand: "starter-story", editorUserId },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const pillarId = (await res.json()).id as string;
  const ideas: Idea[] = [];
  for (const [i, hook] of ["Bro built a SaaS for his dad", "She quit Meta for a $30K/month app", "Two men controlled the diamond market"].entries()) {
    const title = `E2E idea ${i + 1} ${stamp}`;
    const item = await page.request.post("/api/production-items", {
      data: { title, platform: ["tiktok"], postType: "tiktok", publishedDate: "2026-10-20", brand: "starter-story", editorUserId },
    });
    expect(item.ok(), await item.text()).toBeTruthy();
    const itemId = (await item.json()).id as string;
    const [idea] = await sql`
      INSERT INTO clip_ideas (source_production_item_id, batch_id, start_sec, end_sec, hook, angle, rationale, generated_by, target_format)
      VALUES (${pillarId}, gen_random_uuid(), 10, 26, ${hook}, 'e2e', 'e2e', 'e2e', 'Repackage Section w/ Hook')
      RETURNING id`;
    await sql`
      UPDATE production_items SET status = 'Idea', source_clip_idea_id = ${idea.id}, pillar_content_item_id = ${pillarId},
        format = 'Repackage Section w/ Hook'
      WHERE id = ${itemId}`;
    ideas.push({ id: idea.id, hook, title });
  }
  return ideas;
}

function session(idea: Idea) {
  const words = Array.from({ length: 40 }, (_, i) => ({
    index: i,
    text: ["so", "we", "built", "it", "in", "a", "weekend"][i % 7],
    startSec: 10 + i * 0.4,
    endSec: 10 + i * 0.4 + 0.35,
  }));
  return {
    clipIdea: {
      id: idea.id,
      status: "suggested",
      hook: idea.hook,
      angle: "",
      rationale: "",
      startSec: 10,
      endSec: 26,
      targetFormat: "Repackage Section w/ Hook",
      acceptedProductionItemId: null,
    },
    brand: "starter-story",
    formatLook: null,
    edit: { id: `edit-${idea.id}`, revision: 1, doc: createDefaultDoc({ startSec: 10, endSec: 26, hook: idea.hook }) },
    imageUrls: {},
    mediaUrls: {},
    source: { productionItemId: "00000000-0000-4000-8000-0000000000c1", title: "E2E pillar", videoUrl: "/e2e-no-video.mp4", durationSec: 60 },
    words,
    speakers: null,
    wordsSynthetic: false,
    latestRender: null,
    post: null,
  };
}

// The flag, and the editor session (it presigns the source video from S3,
// which the e2e environment doesn't have).
async function serveEditor(page: Page, ideas: Idea[]) {
  await page.route(/\/api\/feature-flags$/, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    await route.fulfill({ json: { ...json, flags: { ...json.flags, clipEditor: true } } });
  });
  await page.route(/\/api\/clip-ideas\/[^/]+\/editor$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    const idea = ideas.find((x) => x.id === id);
    if (!idea) return route.fulfill({ status: 404, json: { error: "not found" } });
    // Autosave PUTs: accept them so the editor stays happy.
    if (route.request().method() !== "GET") return route.fulfill({ json: { revision: 2 } });
    await route.fulfill({ json: session(idea) });
  });
}

test("the clip editor's arrows move between the queue's clip ideas", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const ideas = await seedIdeas(page, sql);
    await serveEditor(page, ideas);
    await page.goto("/starter-story/queue");
    const popup = page.getByRole("dialog", { name: "What's new" });
    // This feature's own What's new card pops up after the page settles.
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});

    // The table's order (whatever its sort) is the order the arrows walk.
    const titles = ideas.map((i) => i.title);
    await expect(page.getByRole("button", { name: titles[0] })).toBeVisible({ timeout: 30_000 });
    const shown = (await page.locator("tbody tr").allInnerTexts())
      .map((row) => titles.find((t) => row.includes(t)))
      .filter((t): t is string => !!t);
    expect(shown).toHaveLength(3);
    const byTitle = (t: string) => ideas.find((i) => i.title === t)!;
    const [first, middle, last] = shown.map(byTitle);

    await page.getByRole("button", { name: middle.title }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Editor beta")).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText("2 of 3")).toBeVisible();
    expect(page.url()).toContain(`clip=${middle.id}`);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await dialog.getByRole("button", { name: "Next idea" }).click();
    await expect(dialog.getByText("3 of 3")).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole("button", { name: "Next idea" })).toBeDisabled();
    expect(page.url()).toContain(`clip=${last.id}`);

    await dialog.getByRole("button", { name: "Previous idea" }).click();
    await expect(dialog.getByText("2 of 3")).toBeVisible({ timeout: 20_000 });
    // `[` does the same as the Previous arrow (Frame.io's keys).
    await page.keyboard.press("[");
    await expect(dialog.getByText("1 of 3")).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole("button", { name: "Previous idea" })).toBeDisabled();
    expect(page.url()).toContain(`clip=${first.id}`);

    // Closing goes back to the queue.
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => page.url()).not.toContain("clip=");
  } finally {
    await sql.end();
  }
});
