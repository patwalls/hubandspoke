import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { createDefaultDoc } from "../../src/lib/clip-editor/doc";
import { carrySiblingFixes } from "../../src/lib/clip-editor/carry-fixes";

// Fix a name once per video: a clip opened for the first time starts with
// the spellings teammates fixed in other clips of the same video, and says
// so in one quiet line above the transcript. The e2e DB has no archived
// videos (and no S3 to presign them): the idea is seeded into the DB, the
// flag and the editor session are served from the test — the session's doc
// is built with the real carrySiblingFixes.

test.use({ viewport: { width: 1600, height: 1000 } });
test.setTimeout(120_000);

const said = "so we use chat gpt and rourke every day and chat gpt writes the copy while rourke builds the app".split(" ");
const words = said.map((text, i) => ({ index: i, text, startSec: 10 + i * 0.5, endSec: 10 + i * 0.5 + 0.45 }));

type Page = import("@playwright/test").Page;
type Built = { doc: unknown; carriedFixes: string[]; offeredFixes: { names: string[]; wordEdits: Record<string, string> } | null };

// Seeds a pillar + clip idea, serves the editor session built by `build`,
// opens the clip from the queue and hands the dialog to `check`.
async function openClip(page: Page, build: () => Built, check: (dialog: ReturnType<Page["getByRole"]>) => Promise<void>) {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const editorUserId = (await (await page.request.get("/api/auth/session")).json())?.user?.id;
    const pillar = await page.request.post("/api/production-items", {
      data: { title: `E2E pillar ${stamp}`, platform: ["youtube_long"], postType: "youtube_long", publishedDate: "2026-10-20", brand: "starter-story", editorUserId },
    });
    expect(pillar.ok(), await pillar.text()).toBeTruthy();
    const pillarId = (await pillar.json()).id as string;
    const title = `E2E carried ${stamp}`;
    const item = await page.request.post("/api/production-items", {
      data: { title, platform: ["tiktok"], postType: "tiktok", publishedDate: "2026-10-20", brand: "starter-story", editorUserId },
    });
    expect(item.ok(), await item.text()).toBeTruthy();
    const [idea] = await sql`
      INSERT INTO clip_ideas (source_production_item_id, batch_id, start_sec, end_sec, hook, angle, rationale, generated_by, target_format)
      VALUES (${pillarId}, gen_random_uuid(), 10, 20, 'We built it with two tools', 'e2e', 'e2e', 'e2e', 'Repackage Section w/ Hook')
      RETURNING id`;
    await sql`
      UPDATE production_items SET status = 'Idea', source_clip_idea_id = ${idea.id}, pillar_content_item_id = ${pillarId},
        format = 'Repackage Section w/ Hook'
      WHERE id = ${(await item.json()).id}`;

    const built = build();

    await page.route(/\/api\/feature-flags$/, async (route) => {
      const json = await (await route.fetch()).json();
      await route.fulfill({ json: { ...json, flags: { ...json.flags, clipEditor: true } } });
    });
    await page.route(/\/api\/clip-ideas\/[^/]+\/editor$/, async (route) => {
      if (route.request().method() !== "GET") return route.fulfill({ json: { revision: 2 } });
      await route.fulfill({
        json: {
          clipIdea: { id: idea.id, status: "suggested", hook: "We built it with two tools", angle: "", rationale: "", startSec: 10, endSec: 20, targetFormat: "Repackage Section w/ Hook", acceptedProductionItemId: null },
          brand: "starter-story",
          formatLook: null,
          edit: { id: `edit-${idea.id}`, revision: 1, doc: built.doc },
          imageUrls: {},
          mediaUrls: {},
          source: { productionItemId: pillarId, title: "E2E pillar", videoUrl: "/e2e-no-video.mp4", durationSec: 60 },
          words,
          carriedFixes: built.carriedFixes,
          offeredFixes: built.offeredFixes,
          speakers: null,
          wordsSynthetic: false,
          latestRender: null,
          post: null,
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
    await check(dialog);
  } finally {
    await sql.end();
  }
}

// Another clip of this video fixed "chat gpt" and "rourke" (at 11 s / 12 s).
const sibling = { ...createDefaultDoc({ startSec: 10, endSec: 14, hook: "" }), wordEdits: { "11500": "ChatGPT", "12000": "", "13000": "Rork" } };
const blank = () => createDefaultDoc({ startSec: 10, endSec: 20, hook: "We built it with two tools" });

test("a new clip starts with the spelling fixed in other clips of the same video", async ({ page }) => {
  await openClip(
    page,
    () => {
      const carried = carrySiblingFixes(blank(), words, [sibling]);
      expect(carried.carried.sort()).toEqual(["ChatGPT", "Rork"]);
      return { doc: carried.doc, carriedFixes: carried.carried, offeredFixes: null };
    },
    async (dialog) => {
    const note = dialog.getByTestId("carried-fixes");
    await expect(note).toHaveText(/other clips: (ChatGPT, Rork|Rork, ChatGPT)/);
    // The transcript reads the fixed spelling.
    await expect(dialog.getByText("ChatGPT", { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText("rourke", { exact: true })).toHaveCount(0);
    },
  );
});

test("a clip opened before gets the other clips' fixes as one click, keeping its own", async ({ page }) => {
  // This clip was opened earlier and already spells the second name its own way.
  const worked = { ...blank(), wordEdits: { "18000": "Rourk" } };
  const saved: unknown[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && /\/api\/clip-ideas\/[^/]+\/editor$/.test(r.url())) saved.push(r.postDataJSON());
  });
  await openClip(
    page,
    () => {
      const offer = carrySiblingFixes(worked, words, [sibling]);
      return { doc: worked, carriedFixes: [], offeredFixes: { names: offer.carried, wordEdits: offer.added } };
    },
    async (dialog) => {
      const line = dialog.getByTestId("offered-fixes");
      await expect(line).toContainText("Other clips of this video spell:");
      // Nothing changed on its own: the transcript still says what was said.
      await expect(dialog.getByText("chat", { exact: true }).first()).toBeVisible();
      if (process.env.E2E_SHOT) await dialog.page().screenshot({ path: process.env.E2E_SHOT });
      await line.getByRole("button", { name: /Apply/ }).click();
      await expect(line).toContainText("Spelling from this video\u2019s other clips:");
      await expect(line.getByRole("button")).toHaveCount(0);
      await expect(dialog.getByText("ChatGPT", { exact: true }).first()).toBeVisible();
      // Their own spelling survived.
      await expect(dialog.getByText("Rourk", { exact: true }).first()).toBeVisible();
      await expect.poll(() => saved.length, { timeout: 15_000 }).toBeGreaterThan(0);
      const last = saved[saved.length - 1] as { doc: { wordEdits: Record<string, string> } };
      expect(last.doc.wordEdits["18000"]).toBe("Rourk");
      expect(last.doc.wordEdits["11500"]).toBe("ChatGPT");
    },
  );
});
