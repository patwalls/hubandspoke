import { test, expect } from "@playwright/test";

/**
 * The nav's New menu (flag `newsletterDrafter`): every kind is live, a
 * LinkedIn post made from it lands on its own page with the angle kept, and
 * the newsletter dialog asks for the Angle on its own row, between the
 * pillar content and the send date.
 *
 * Writes one LinkedIn post to the local DB (status Assigned, created via
 * new-menu) per run.
 */
test.use({ viewport: { width: 1400, height: 950 } });

test.beforeEach(async ({ page }) => {
  const { flags } = await (await page.request.get("/api/feature-flags")).json();
  test.skip(flags.newsletterDrafter !== true, "e2e user does not have the newsletterDrafter flag");
});

test("every kind is live; a LinkedIn post opens on its page with the angle kept", async ({ page }) => {
  await page.goto("/starter-story");
  await page.getByTestId("new-content").click();
  for (const kind of ["newsletter", "instagram_post", "instagram_reel", "youtube_short", "youtube_community", "x_post", "linkedin_post"]) {
    await expect(page.getByTestId(`new-content-${kind}`)).toBeEnabled();
  }
  await expect(page.getByText("Soon", { exact: true })).toHaveCount(0);

  await page.getByTestId("new-content-linkedin_post").click();
  await expect(page.getByTestId("new-post-format")).toBeVisible({ timeout: 15_000 });
  const pillar = page.getByTestId("new-post-pillar");
  test.skip((await pillar.locator("option:not([disabled])").count()) === 0 || (await pillar.inputValue()) === "", "no transcribed pillar video for starter-story in the last 120 days");
  await page.getByTestId("new-content-angle").fill("Lead with the first step of the playbook");
  await page.getByTestId("new-post-create").click();
  await page.waitForURL(/\/starter-story\/content\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByText("new-menu")).toBeVisible({ timeout: 15_000 });

  const id = page.url().split("/content/")[1].split(/[?#]/)[0];
  const item = await (await page.request.get(`/api/production-items/${id}`)).json();
  expect(item.item?.angle ?? item.angle).toBe("Lead with the first step of the playbook");
});

test("newsletter: the Angle row sits between pillar content and send date", async ({ page }) => {
  await page.goto("/starter-story");
  await page.getByTestId("new-content").click();
  await page.getByTestId("new-content-newsletter").click();
  const angle = page.getByTestId("new-content-angle");
  await expect(angle).toBeVisible({ timeout: 15_000 });
  const y = async (l: import("@playwright/test").Locator) => (await l.boundingBox())!.y;
  expect(await y(page.getByText("Pillar content", { exact: true }))).toBeLessThan(await y(angle));
  expect(await y(angle)).toBeLessThan(await y(page.getByText("Send date", { exact: true })));
});
