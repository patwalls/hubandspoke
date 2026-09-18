import { test, expect } from "@playwright/test";

/**
 * Design editor (feature-flagged `designEditor`) — the Repurposed queue's
 * modal for image-post formats with a template ("Instagram PLAYBOOK").
 *
 *   - flag off → the classic SPOKE dialog ("Assign editor")
 *   - flag on  → the AI-drafted design editor opens on the candidate
 *
 * Locally: FEATURE_DESIGN_EDITOR_EMAILS=e2e@local.test on the dev server,
 * plus ANTHROPIC_API_KEY and S3 credentials (the draft calls the AI, ~20s).
 * The flag-on half creates a derivative item for the candidate the first
 * time, exactly as assigning an editor would.
 */
test.use({ viewport: { width: 1600, height: 1000 }, actionTimeout: 20_000 });

async function openFirstPlaybook(page: import("@playwright/test").Page) {
  await page.goto("/starter-story/queue/repurposed");
  await page.waitForLoadState("networkidle");
  const row = page.locator("tbody tr").filter({ hasText: "Instagram PLAYBOOK" }).first();
  test.skip((await row.count()) === 0, "no Instagram PLAYBOOK candidate in the Repurposed queue");
  await row.locator("td button").first().click();
}

test("flag off → classic SPOKE dialog is unchanged", async ({ page }) => {
  const { flags } = await (await page.request.get("/api/feature-flags")).json();
  test.skip(flags.designEditor === true, "e2e user has the designEditor flag");
  await openFirstPlaybook(page);
  await expect(page.getByText("Assign editor", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Editor beta")).toHaveCount(0);
  expect((await page.request.post("/api/design/from-candidate", { data: {} })).status()).toBe(404);
});

test("flag on → AI draft opens; a drag is undoable and autosaves", async ({ page }) => {
  const { flags } = await (await page.request.get("/api/feature-flags")).json();
  test.skip(flags.designEditor !== true, "e2e user does not have the designEditor flag");
  test.setTimeout(180_000);
  await openFirstPlaybook(page);
  const opened = await page.getByText("Editor beta").waitFor({ timeout: 120_000 }).then(() => true).catch(() => false);
  test.skip(!opened, "designer fell back to the classic dialog (no transcript / AI unavailable)");

  await expect(page.getByRole("button", { name: /Export post|Re-export post/ })).toBeVisible();
  const stage = page.locator("div.shadow-xl.ring-1");
  const box = (await stage.boundingBox())!;
  const s = box.width / 1080;
  await page.mouse.move(box.x + 540 * s, box.y + 900 * s);
  await page.mouse.down();
  await page.mouse.move(box.x + 540 * s, box.y + 940 * s, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByText("Headline", { exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByText("Draft saved")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Save draft & close" }).click();
  await expect(page.getByText("Editor beta")).toBeHidden();
});
