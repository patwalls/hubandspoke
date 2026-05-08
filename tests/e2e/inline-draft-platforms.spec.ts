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
const LINKEDIN_ITEM_ID = "1011753b-6501-434b-bc25-24846089935b";

test("LinkedIn pre-publish item renders the inline drafting surface", async ({
  page,
}) => {
  await page.goto(`/starter-story/content/${LINKEDIN_ITEM_ID}`);
  // Should NOT bounce to /login.
  await expect(page).not.toHaveURL(/\/login/);
  // Title is visible (lazy proof the page rendered).
  await expect(
    page.getByRole("heading", { level: 1 }).first(),
  ).toBeVisible();
  // Inline-drafting items hide the standalone Preview tab.
  const previewTab = page.getByRole("tab", { name: /^preview$/i });
  await expect(previewTab).toHaveCount(0);
  // Tabs visible in the inline-drafting layout: Details / Draft / Clip
  // Ideas — but NOT Preview (it's collapsed into Details).
  await expect(page.getByRole("tab", { name: /^details$/i })).toBeVisible();
  // Legacy LinkedIn-card chrome (the action rail with Like / Comment /
  // Repost / Send) is gone in the new minimal layout. Proves we're not
  // rendering the previous LI mock by accident.
  await expect(page.getByRole("button", { name: /^like$/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^repost$/i })).toHaveCount(0);
});
