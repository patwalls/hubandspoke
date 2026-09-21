import { test, expect } from "@playwright/test";

/**
 * Clip editor (feature-flagged `clipEditor`) — the queue's clip modal.
 *
 * Guards BOTH sides of the flag, because the promise of the flag is "nothing
 * changes for anyone else":
 *   - flag off → the classic triage dialog, with its Create ▾ dropdown
 *   - flag on  → the in-app editor; cutting a word adds a cut, undo removes it;
 *                highlighting words offers Remove / Add to clip at the highlight
 *
 * Which side runs depends on the signed-in e2e user. To exercise the editor
 * locally, start the dev server with
 *   FEATURE_CLIP_EDITOR_EMAILS=e2e@local.test
 * and S3 credentials in the environment (the editor presigns the source
 * video; without them it correctly falls back to the classic dialog, and the
 * editor half of this spec skips).
 *
 * Idempotent: the one edit it makes is undone before it finishes, and it
 * never exports. (Opening the editor does enqueue the post draft for the
 * idea's item — that is the product behaviour, and a no-op once written.)
 */

test.use({ viewport: { width: 1600, height: 1000 } });

// The clippable-format tab from the original request. Its slug is derived
// from the format name, so a rename moves this URL (the spec then fails on
// navigation, loudly, rather than passing vacuously).
const QUEUE = "/starter-story/queue/repackage-section-w-hook";

async function openFirstClipIdea(page: import("@playwright/test").Page) {
  await page.goto(QUEUE);
  // The row's title is the button that opens the clip dialog.
  await page.locator("tbody tr").first().locator("td button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
}

test("flag off → classic clip dialog is unchanged", async ({ page }) => {
  const { flags } = await (await page.request.get("/api/feature-flags")).json();
  test.skip(flags.clipEditor === true, "e2e user has the clipEditor flag");

  await openFirstClipIdea(page);
  await expect(page.getByRole("button", { name: /^Create/ })).toBeVisible();
  await expect(page.getByText("Editor beta")).toHaveCount(0);
  // And the editor's API is invisible to this user.
  const res = await page.request.get("/api/clip-ideas/00000000-0000-0000-0000-000000000000/editor");
  expect(res.status()).toBe(404);
});

test("flag on → editor opens; cutting a word is undoable and autosaves", async ({ page }) => {
  const { flags } = await (await page.request.get("/api/feature-flags")).json();
  test.skip(flags.clipEditor !== true, "e2e user does not have the clipEditor flag");

  await openFirstClipIdea(page);
  const opened = await page
    .getByText("Editor beta")
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!opened, "editor fell back to the classic dialog (no S3 credentials / no transcript)");

  await expect(page.getByRole("button", { name: /Export clip|Re-export clip/ })).toBeVisible();
  const cuts = async () =>
    Number(((await page.getByText(/^\d+ cuts?$/).textContent()) ?? "0").split(" ")[0]);
  const before = await cuts();

  // A kept word well inside the clip (not the first/last, which would trim
  // rather than cut).
  await page.locator("[data-pos].text-foreground").nth(6).click();
  await page.keyboard.press("Backspace");
  await expect.poll(cuts).toBe(before + 1);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(cuts).toBe(before);
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible({ timeout: 10_000 });
  // The open editor is in the URL, so a reload lands back in it.
  expect(page.url()).toContain("clip=");

  // Highlighting words surfaces the action AT the highlight: Remove for
  // words in the clip, Add to clip for the (dim) rest of the video.
  await page.locator("[data-pos].text-foreground").nth(6).click();
  const toolbar = page.getByRole("toolbar", { name: "Selected words" });
  await expect(toolbar.getByRole("button", { name: "Remove" })).toBeVisible();
  // The transcript is the WHOLE source, so word 0 exists even when the clip
  // starts minutes in.
  const firstWord = page.locator("[data-pos='0']");
  await firstWord.scrollIntoViewIfNeeded();
  if (await firstWord.evaluate((el) => !el.classList.contains("text-foreground"))) {
    await firstWord.click();
    await expect(toolbar.getByRole("button", { name: "Add to clip" })).toBeVisible();
  }

  // Clicking a word that ISN'T in the edit auditions the raw source, and says
  // so — it must never look like the clip is playing.
  const dim = page.locator("[data-pos]:not(.text-foreground):not(.line-through)").first();
  await dim.scrollIntoViewIfNeeded();
  await dim.click();
  await expect(page.getByText("Previewing source · not in your clip")).toBeVisible();
  await page.getByRole("button", { name: "Back to clip" }).click();
  await expect(page.getByText("Previewing source · not in your clip")).toBeHidden();

  // Adding things on the stage: + Text makes a layer with its own panel,
  // arrows nudge it, and its panel's bin takes it away again.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Text 1" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "Remove text 1" }).click();
  await expect(page.getByRole("heading", { name: "Text 1" })).toHaveCount(0);
  // + Logo opens the brand's library (upload + wordmarks + account avatars)
  await page.getByRole("button", { name: "Logo", exact: true }).click();
  await expect(page.getByText("Upload a logo for this brand")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Upload a logo for this brand")).toBeHidden();
  await expect(page.getByText("Editor beta")).toBeVisible(); // Escape closed the picker, not the editor

  // The Post tab: the clip's post copy next to the stage. Opening the editor
  // starts the draft, so the pane is either still writing or shows the
  // platform mock; either way the transcript gives way to it and comes back.
  await page.getByRole("tab", { name: /^Post/ }).click();
  await expect(page.getByRole("heading", { name: "Post" })).toBeVisible();
  await expect(page.getByText(/Writing the post from this clip|How this will look on|No post yet/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Transcript" })).toBeHidden();
  await page.getByRole("tab", { name: "Clip" }).click();
  await expect(page.getByRole("heading", { name: "Transcript" })).toBeVisible();

  // (the dialog's own ✕ is also named "Close" — take the footer button)
  await page.getByRole("button", { name: /Save draft & close|^Close$/ }).last().click();
  await expect(page.getByText("Editor beta")).toBeHidden();
  expect(page.url()).not.toContain("clip=");
});
