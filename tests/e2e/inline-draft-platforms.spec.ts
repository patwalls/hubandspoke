import { test, expect } from "@playwright/test";

/**
 * Verifies that the inline drafting surface renders for every wired
 * post type — not just IG / X. Each row is a real production_item id
 * the team can re-pin if it's deleted; targets are picked from the
 * recently-edited content list rather than fixtures so the tests
 * mirror what an editor sees today.
 *
 * Layout invariants checked:
 *   - The "Preview" tab is HIDDEN (inline drafting collapses Details +
 *     Preview into a single two-column layout).
 *   - The "Details" tab is selected by default.
 *   - The simulator's editable caption / body field is reachable
 *     (DraftMediaDropZone + CaptionPanel both rendered).
 */
// Pre-publish LinkedIn item the user pointed at. If this gets deleted,
// pick another `Ready To Publish` LinkedIn item from the queue.
const LINKEDIN_ITEM_ID = "3f6c4370-6dc6-4b8c-af73-4d676668bfd4";

test("LinkedIn pre-publish item renders the inline drafting surface", async ({
  page,
}) => {
  await page.goto(`/starter-story/content/${LINKEDIN_ITEM_ID}`);
  // Should NOT bounce to /login.
  await expect(page).not.toHaveURL(/\/login/);
  // Title row is visible (Pat's metadata-card refactor swapped <h1> for an
  // inline-editable Input — assert via the back-to-content link instead,
  // which is stable).
  await expect(page.getByRole("link", { name: /^← content$/i })).toBeVisible();
  // Inline-drafting items hide the standalone Preview tab.
  await expect(page.getByRole("tab", { name: /^preview$/i })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^details$/i })).toBeVisible();

  // The "CAPTION" label was wrong for LinkedIn — must be gone. The
  // textarea has a LinkedIn-appropriate placeholder instead.
  await expect(page.getByText("CAPTION", { exact: true })).toHaveCount(0);
  await expect(
    page.getByPlaceholder(/what do you want to talk about/i),
  ).toBeVisible();

  // The "Add photo or video" affordance must be visible — even though
  // this draft has no media yet. Earlier we conditionally rendered the
  // dropzone only when media existed, leaving a catch-22.
  await expect(
    page.getByRole("button", { name: /^add photo or video$/i }),
  ).toBeVisible();

  // Legacy LI action rail is gone.
  await expect(page.getByRole("button", { name: /^like$/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^repost$/i })).toHaveCount(0);

  // Layout regression guard (2026-05-08): LinkedIn must stack body-above-
  // media, never side-by-side. Earlier the simulator put media on the left
  // at max-w-[400px] and the body collapsed to ~80px in the half-width
  // preview card. The "Add photo or video" button lives below the
  // CaptionPanel; assert that the textarea sits before the button in the
  // document order — which is only true in the stacked layout.
  const bodyTextarea = page.getByPlaceholder(
    /what do you want to talk about/i,
  );
  const addButton = page.getByRole("button", {
    name: /^add photo or video$/i,
  });
  const addHandle = await addButton.elementHandle();
  expect(addHandle).not.toBeNull();
  const order = await bodyTextarea.evaluate((el, other) => {
    return el.compareDocumentPosition(other) &
      Node.DOCUMENT_POSITION_FOLLOWING
      ? "before"
      : "after";
  }, addHandle as NonNullable<typeof addHandle>);
  expect(order).toBe("before");
});
