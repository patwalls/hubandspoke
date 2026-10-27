import { test, expect } from "@playwright/test";
import { createDefaultDoc } from "../../src/lib/clip-editor/doc";

// A clip rendered by the in-app editor shows "Edit clip" beside its
// "Clip rendered" chip on the content page, and it opens the editor. The e2e
// DB has no renders and no S3: the render status and the editor session are
// served from the test; the item and the page are the real app.

test.use({ viewport: { width: 1600, height: 1000 } });

const IDEA_ID = "00000000-0000-4000-8000-00000000e11c";

test("Edit clip opens the clip editor from the content page", async ({ page }) => {
  const res = await page.request.post("/api/production-items", {
    data: {
      title: `E2E rendered clip ${Date.now()}`,
      platform: ["tiktok"],
      postType: "tiktok",
      publishedDate: new Date().toISOString().slice(0, 10),
      brand: "starter-story",
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const id = (await res.json()).id as string;

  await page.route(/\/api\/production-items\/[^/]+\/clip-render-status$/, (route) =>
    route.fulfill({
      json: {
        render: {
          id: "r1",
          clipEditId: "e1",
          productionItemId: id,
          state: "done",
          progress: 100,
          error: null,
          durationSec: 32,
          renderSeconds: 41,
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
        clipIdeaId: IDEA_ID,
        canEdit: true,
      },
    }),
  );
  await page.route(/\/api\/clip-ideas\/[^/]+\/editor$/, (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ json: { revision: 2 } });
    const hook = "Bro built a SaaS for his dad";
    return route.fulfill({
      json: {
        clipIdea: { id: IDEA_ID, status: "accepted", hook, angle: "", rationale: "", startSec: 10, endSec: 26, targetFormat: null, acceptedProductionItemId: id },
        brand: "starter-story",
        formatLook: null,
        edit: { id: "e1", revision: 1, doc: createDefaultDoc({ startSec: 10, endSec: 26, hook }) },
        imageUrls: {},
        mediaUrls: {},
        source: { productionItemId: "00000000-0000-4000-8000-0000000000c1", title: "E2E pillar", videoUrl: "/e2e-no-video.mp4", durationSec: 60 },
        words: Array.from({ length: 40 }, (_, i) => ({ index: i, text: "word", startSec: 10 + i * 0.4, endSec: 10 + i * 0.4 + 0.35 })),
        speakers: null,
        wordsSynthetic: false,
        latestRender: null,
        post: null,
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

  await expect(page.getByText("Clip rendered", { exact: true })).toBeVisible();
  const edit = page.getByRole("button", { name: "Edit clip", exact: true });
  await expect(edit).toBeVisible();
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

  await edit.click();
  await expect(page.getByRole("dialog").filter({ hasText: /The (Clip|Post)/ }).first()).toBeVisible();
});
