import { test, expect, type Page } from "@playwright/test";

// A note pinned to a moment of the video: play/scrub the preview, "Pin to
// 0:12", post, and the note carries a 0:12 chip that jumps the player back
// there — also after a reload. The e2e DB has no media and no S3, so the
// test drops a stand-in <video> into the page's player area; the comment box,
// the API and the stored column are the real app.

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

const playerTime = (page: Page) =>
  page.evaluate(() => (document.getElementById("e2e-player") as HTMLVideoElement).currentTime);

test("a comment pinned to the playhead seeks the player back there", async ({ page }) => {
  const res = await page.request.post("/api/production-items", {
    data: {
      title: `E2E review note ${Date.now()}`,
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

  // No video played yet → no pin offered.
  await expect(page.getByTestId("comment-timecode-pin")).toHaveCount(0);

  await injectPlayer(page, 12.4);
  const pin = page.getByTestId("comment-timecode-pin");
  await expect(pin).toHaveText(/Pin to 0:12/);
  await pin.click();
  await expect(page.getByTestId("comment-timecode-pinned")).toHaveText(/at 0:12/);

  const box = page.locator(".ProseMirror").last();
  await box.click();
  await page.keyboard.type("Cut the pause before he says the number");
  // Wait for the real POST: the chip shows optimistically, and a reload
  // before the (first-compile, slow in dev) route answers would abort it.
  const posted = page.waitForResponse(
    (r) => r.url().endsWith(`/api/production-items/${id}/comments`) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Post comment" }).click();
  const postRes = await posted;
  expect(postRes.status()).toBe(201);
  expect((await postRes.json()).comment.atSeconds).toBeCloseTo(12.4, 1);

  const chip = page.getByTestId("comment-timecode-chip");
  await expect(chip).toHaveText("0:12");
  await expect(page.getByTestId("comment-timecode-pinned")).toHaveCount(0);
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

  // Click the chip → the player jumps back to the note's moment.
  await page.evaluate(() => {
    (document.getElementById("e2e-player") as HTMLVideoElement).currentTime = 40;
  });
  await chip.click();
  expect(await playerTime(page)).toBeCloseTo(12.4, 1);

  // Stored, not just optimistic: the chip survives a reload.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("comment-timecode-chip")).toHaveText("0:12");
});
