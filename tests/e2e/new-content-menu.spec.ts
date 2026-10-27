import { test, expect } from "@playwright/test";

/**
 * The nav's New menu (flag `newsletterDrafter`): every kind is live; a post's
 * dialog is titled with the brand and puts the pillar video (previewed) above
 * the format; a LinkedIn post made from it lands on its own page with the
 * angle kept; and the newsletter dialog asks for the Angle on its own row,
 * between the pillar content and the send date, starting on One piece; its
 * pillar dropdown shows each video's thumbnail and views, with the picked
 * one embedded under it.
 *
 * Writes one LinkedIn post (status Assigned, created via new-menu) and one
 * Instagram design post to the local DB per run.
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
  test.skip(((await pillar.getAttribute("data-value")) ?? "") === "", "no transcribed pillar video for starter-story in the last 120 days");
  // The brand is in the title (no Brand field); pillar content comes first,
  // with the video right under it to watch, then the format.
  await expect(page.getByRole("dialog").getByRole("heading")).toHaveText("New Starter Story LinkedIn post");
  await expect(page.getByTestId("new-post-change-brand")).toBeVisible();
  const above = async (a: string, b: string) =>
    (await page.getByTestId(a).boundingBox())!.y < (await page.getByTestId(b).boundingBox())!.y;
  expect(await above("new-post-pillar", "new-post-format")).toBe(true);
  await expect(page.getByTestId("new-post-pillar-preview")).toHaveAttribute("src", /youtube-nocookie\.com\/embed\/[\w-]{11}/);
  expect(await above("new-post-pillar-preview", "new-post-format")).toBe(true);
  await page.getByRole("dialog").screenshot({ path: ".playwright-mcp/screenshots/new-post-dialog.png" });
  await page.getByTestId("new-content-angle").fill("Lead with the first step of the playbook");
  await page.getByTestId("new-post-create").click();
  await page.waitForURL(/\/starter-story\/content\/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(page.getByText("new-menu")).toBeVisible({ timeout: 15_000 });

  const id = page.url().split("/content/")[1].split(/[?#]/)[0];
  const item = await (await page.request.get(`/api/production-items/${id}`)).json();
  expect(item.item?.angle ?? item.angle).toBe("Lead with the first step of the playbook");
});

test("an Instagram post that opens in the design editor puts it in the URL, and a reload reopens it", async ({ page }) => {
  const { flags } = await (await page.request.get("/api/feature-flags")).json();
  test.skip(flags.designEditor !== true, "e2e user does not have the designEditor flag");
  const opts = await (await page.request.get("/api/new-post?brand=starter-story&kind=instagram_post")).json();
  const fmt = (opts.formats as Array<{ id: string; editor: string }>).find((f) => f.editor === "design");
  const pillar = (opts.pillars as Array<{ id: string; hasTranscript: boolean }>).find((p) => p.hasTranscript);
  test.skip(!fmt || !pillar, "no templated Instagram format or transcribed pillar for starter-story");

  await page.goto("/starter-story");
  await page.getByTestId("new-content").click();
  await page.getByTestId("new-content-instagram_post").click();
  await page.getByTestId("new-post-format").selectOption(fmt!.id);
  await page.getByTestId("new-post-pillar").click();
  await page.locator(`[data-testid="pillar-option"][data-id="${pillar!.id}"]`).click();
  await page.getByTestId("new-post-create").click();
  // Like the queue's own: the Repurposed queue with ?item=<the post>.
  await page.waitForURL(/\/starter-story\/queue\/repurposed\?item=[0-9a-f-]{36}/, { timeout: 30_000 });
  const opened = page.getByText("Editor beta").or(page.getByText("Drafting your post…"));
  await expect(opened.first()).toBeVisible({ timeout: 30_000 });
  const url = page.url();
  await page.reload();
  expect(page.url()).toBe(url);
  await expect(opened.first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(1); // one editor, not two
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

test("newsletter: a roundup format starts on One piece, not Roundup", async ({ page }) => {
  await page.goto("/starter-story");
  await page.getByTestId("new-content").click();
  await page.getByTestId("new-content-newsletter").click();
  const toggle = page.getByRole("radiogroup", { name: "What the issue is about" });
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(toggle.getByRole("radio", { name: "One piece" })).toHaveAttribute("aria-checked", "true");
  await expect(toggle.getByRole("radio", { name: "Roundup" })).toHaveAttribute("aria-checked", "false");
});

test("newsletter: the pillar dropdown shows thumbnails + views, and the picked video plays under it", async ({ page }) => {
  await page.goto("/starter-story");
  await page.getByTestId("new-content").click();
  await page.getByTestId("new-content-newsletter").click();
  const pillar = page.getByTestId("newsletter-pillar");
  await expect(pillar).toBeVisible({ timeout: 15_000 });
  test.skip(((await pillar.getAttribute("data-value")) ?? "") === "", "no transcribed Starter Story video locally");
  const preview = page.getByTestId("newsletter-pillar-preview");
  await expect(preview).toHaveAttribute("src", /youtube-nocookie\.com\/embed\/[\w-]{11}/);
  const first = await preview.getAttribute("src");

  await pillar.click();
  const options = page.getByTestId("pillar-option");
  await expect(options.first()).toBeVisible();
  await expect(options.first().locator("img")).toHaveAttribute("src", /i\.ytimg\.com\/vi\/[\w-]{11}\//);
  await expect(options.first()).toContainText(/views/);
  await page.screenshot({ path: ".playwright-mcp/screenshots/newsletter-pillar-dropdown.png" });
  // Another video swaps the embed.
  const other = page.locator('[data-testid="pillar-option"][aria-selected="false"]:enabled').first();
  test.skip((await other.count()) === 0, "only one pickable video locally");
  const otherId = await other.getAttribute("data-id");
  await other.click();
  await expect(pillar).toHaveAttribute("data-value", otherId!);
  await expect(preview).not.toHaveAttribute("src", first!);
  await expect(page.getByTestId("newsletter-pillar-list")).toBeHidden();
  await page.screenshot({ path: ".playwright-mcp/screenshots/newsletter-pillar-picked.png" });
});
