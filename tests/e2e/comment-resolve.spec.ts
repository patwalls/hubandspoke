import { test, expect, type Page } from "@playwright/test";

// Review notes can be checked off: two notes pinned to the video show
// "2 open notes" in the Activity header; Mark done on one drops it to
// "1 open note", dims the note and shows "Done · <name>" — also after a
// reload. Stand-in <video> as in comment-timecode.spec.ts (no media in e2e).

test.use({ viewport: { width: 1600, height: 1000 } });

async function injectPlayer(page: Page, at: number) {
  await page.evaluate((start) => {
    const host = document.querySelector("[data-review-player]");
    if (!host) throw new Error("no [data-review-player] on the page");
    const v = document.createElement("video");
    v.id = "e2e-player";
    v.style.cssText = "width:240px;height:426px;background:#111;display:block";
    let t = start;
    let paused = true;
    Object.defineProperties(v, {
      currentTime: { get: () => t, set: (x: number) => { t = x; } },
      paused: { get: () => paused },
      readyState: { get: () => 4 },
    });
    v.play = async () => { paused = false; };
    v.pause = () => { paused = true; };
    host.prepend(v);
  }, at);
}

async function postPinned(page: Page, id: string, at: number, text: string) {
  await page.evaluate((t) => {
    (document.getElementById("e2e-player") as HTMLVideoElement).currentTime = t;
  }, at);
  await page.getByTestId("comment-timecode-pin").click();
  await page.locator(".ProseMirror").last().click();
  await page.keyboard.type(text);
  const posted = page.waitForResponse(
    (r) => r.url().endsWith(`/api/production-items/${id}/comments`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Post comment" }).click();
  expect((await posted).status()).toBe(201);
}

test("marking a pinned note done takes it off the open count", async ({ page }) => {
  const res = await page.request.post("/api/production-items", {
    data: {
      title: `E2E resolve note ${Date.now()}`,
      platform: ["tiktok"],
      postType: "tiktok",
      publishedDate: new Date().toISOString().slice(0, 10),
      brand: "starter-story",
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const id = (await res.json()).id as string;

  await page.goto(`/starter-story/content/${id}`);
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
  await expect(page.getByTestId("open-notes-count")).toHaveCount(0);

  await injectPlayer(page, 4);
  await postPinned(page, id, 4.2, "Open on the product shot, not the intro");
  await postPinned(page, id, 31, "Captions overlap the logo here");
  await expect(page.getByTestId("open-notes-count")).toHaveText("2 open notes");

  const first = page.getByTestId("comment-row").filter({ hasText: "product shot" });
  const resolved = page.waitForResponse((r) => r.url().includes("/resolve"));
  await first.getByRole("button", { name: "Mark done" }).click();
  expect((await resolved).status()).toBe(200);
  await expect(page.getByTestId("open-notes-count")).toHaveText("1 open note");
  await expect(first.getByTestId("comment-resolved")).toContainText("Done");
  if (process.env.E2E_SHOT) {
    await page.getByTestId("open-notes-count").scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.E2E_SHOT });
  }

  // Stored: still done after a reload, and Reopen puts it back.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("open-notes-count")).toHaveText("1 open note");
  const again = page.getByTestId("comment-row").filter({ hasText: "product shot" });
  await expect(again.getByTestId("comment-resolved")).toBeVisible();
  await again.hover();
  await again.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByTestId("open-notes-count")).toHaveText("2 open notes");
});
