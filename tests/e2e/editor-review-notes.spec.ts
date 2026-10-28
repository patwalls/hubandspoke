import { test, expect } from "@playwright/test";
import { createDefaultDoc } from "../../src/lib/clip-editor/doc";
import { addRemoval } from "../../src/lib/clip-editor/removals";

// Review notes on the clip editor's timeline (review-notes M3): notes pinned
// to the rendered clip show as pins on the editor's ruler, a pin opens the
// note, and Mark done checks it off for real (the comments and the resolve
// endpoint are the real app). The editor session is served from the test as
// in edit-clip-chip.spec.ts — no renders or S3 in the e2e DB.

test.use({ viewport: { width: 1600, height: 1000 } });

const IDEA_ID = "00000000-0000-4000-8000-00000000e12c";

test("review notes sit on the editor's timeline and can be marked done there", async ({ page }) => {
  const res = await page.request.post("/api/production-items", {
    data: {
      title: `E2E noted clip ${Date.now()}`,
      platform: ["tiktok"],
      postType: "tiktok",
      publishedDate: new Date().toISOString().slice(0, 10),
      brand: "starter-story",
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const id = (await res.json()).id as string;

  const notes: Array<{ id: string; atSeconds: number; body: string; authorName: string; createdAt: string }> = [];
  for (const [atSeconds, body] of [
    [3, "Cut the um here"],
    [9, "Caption covers his face"],
  ] as const) {
    const r = await page.request.post(`/api/production-items/${id}/comments`, { data: { body, atSeconds } });
    expect(r.ok(), await r.text()).toBeTruthy();
    const { comment: c } = (await r.json()) as { comment: { id: string } };
    notes.push({ id: c.id, atSeconds, body, authorName: "E2E Test", createdAt: new Date().toISOString() });
  }

  const hook = "Bro built a SaaS for his dad";
  const rendered = createDefaultDoc({ startSec: 10, endSec: 26, hook });
  // The draft has cut 2s before the second note since the render: its pin
  // must move 2s left, not sit where the render had it.
  const draft = createDefaultDoc({ startSec: 10, endSec: 26, hook });
  draft.sections[0] = addRemoval(draft.sections[0], { startSec: 15, endSec: 17 }, "manual");

  await page.route(/\/api\/production-items\/[^/]+\/clip-render-status$/, (route) =>
    route.fulfill({
      json: {
        render: {
          id: "r1", clipEditId: "e1", productionItemId: id, state: "done", progress: 100, error: null,
          durationSec: 16, renderSeconds: 20, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        },
        clipIdeaId: IDEA_ID,
        canEdit: true,
      },
    }),
  );
  await page.route(/\/api\/clip-ideas\/[^/]+\/editor$/, (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ json: { revision: 2 } });
    return route.fulfill({
      json: {
        clipIdea: { id: IDEA_ID, status: "accepted", hook, angle: "", rationale: "", startSec: 10, endSec: 26, targetFormat: null, acceptedProductionItemId: id },
        brand: "starter-story",
        formatLook: null,
        edit: { id: "e1", revision: 1, doc: draft },
        imageUrls: {},
        mediaUrls: {},
        source: { productionItemId: "00000000-0000-4000-8000-0000000000c1", title: "E2E pillar", videoUrl: "/e2e-no-video.mp4", durationSec: 60 },
        words: Array.from({ length: 40 }, (_, i) => ({ index: i, text: "word", startSec: 10 + i * 0.4, endSec: 10 + i * 0.4 + 0.35 })),
        speakers: null,
        wordsSynthetic: false,
        latestRender: null,
        post: null,
        reviewNotes: { notes, renderedDoc: rendered },
      },
    });
  });

  await page.goto(`/starter-story/content/${id}`);
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
  await page.getByRole("button", { name: "Edit clip", exact: true }).click();
  const editor = page.getByRole("dialog").filter({ hasText: /The (Clip|Post)/ }).first();
  await expect(editor).toBeVisible();

  await expect(editor.getByTestId("timeline-notes")).toHaveText("2 notes");
  await expect(editor.getByTestId("timeline-note-pin")).toHaveCount(2);
  await expect(editor.getByTestId("export-closes-notes")).toHaveText("Re-exporting marks 2 open notes done");

  // The second note (9s of the render) plays at 7s of the draft.
  await editor.getByTestId("timeline-note-pin").nth(1).click();
  const bar = editor.getByTestId("timeline-note");
  await expect(bar).toContainText("Caption covers his face");
  await expect(bar).toContainText("at 0:09");
  await expect(editor.getByText(/^0:07\.0 \/ 0:14\.0$/)).toBeVisible();
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

  const resolved = page.waitForResponse((r) => r.url().includes("/resolve") && r.request().method() === "POST");
  await bar.getByRole("button", { name: "Mark done" }).click();
  expect((await resolved).ok()).toBeTruthy();
  await expect(editor.getByTestId("timeline-notes")).toHaveText("1 note");
  await expect(editor.getByTestId("timeline-note-pin")).toHaveCount(1);

  // Checked off for real: the content page's Activity sees it done.
  const activity = await (await page.request.get(`/api/production-items/${id}/activity`)).json();
  const done = activity.items.find((i: { id: string }) => i.id === notes[1].id);
  expect(done.resolvedAt).not.toBeNull();
});
