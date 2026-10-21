import { test, expect } from "@playwright/test";

// The Publish screen: Ready To Publish posts with a link box on each row.
// Paste the live link + Enter marks the post Published; a link from another
// platform is caught on the row before it's saved.
test("publish screen marks a post published from a pasted link", async ({ page }) => {
  const stamp = Date.now();
  const titles = [`E2E publish tiktok ${stamp}`, `E2E publish linkedin ${stamp}`];
  const postTypes = ["tiktok", "linkedin"];
  // The throwaway DB has no default editor, so name ourselves.
  const session = await (await page.request.get("/api/auth/session")).json();
  const editorUserId = session?.user?.id;
  expect(editorUserId).toBeTruthy();
  for (let i = 0; i < titles.length; i++) {
    const created = await page.request.post("/api/production-items", {
      data: {
        title: titles[i],
        platform: [postTypes[i]],
        postType: postTypes[i],
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
        editorUserId,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { id } = await created.json();
    const moved = await page.request.put("/api/production-items", {
      data: { id, status: "Ready To Publish" },
    });
    expect(moved.ok(), await moved.text()).toBeTruthy();
  }

  await page.goto("/starter-story/publish");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible().catch(() => false)) {
    await popup.getByRole("button", { name: "Got it" }).click();
  }
  await expect(page.getByRole("heading", { name: "Publish" })).toBeVisible();

  const tiktokRow = page.getByTestId("publish-row").filter({ hasText: titles[0] });
  const linkedinRow = page.getByTestId("publish-row").filter({ hasText: titles[1] });
  await expect(tiktokRow).toBeVisible();

  // Wrong platform: the row warns and nothing is saved.
  const tiktokInput = tiktokRow.getByRole("textbox");
  await tiktokInput.fill("https://www.instagram.com/p/abc123/");
  await tiktokInput.press("Enter");
  await expect(tiktokRow.getByText(/instagram URL/)).toBeVisible();
  await expect(tiktokRow.getByRole("link", { name: /Published/ })).toHaveCount(0);

  // Right link: Enter publishes the row.
  await tiktokInput.fill(`https://www.tiktok.com/@starterstory/video/${stamp}`);
  await tiktokInput.press("Enter");
  await expect(tiktokRow.getByRole("link", { name: /Published/ })).toBeVisible();

  // Leave the second row mid-mistake so the screenshot shows both states.
  await linkedinRow.getByRole("textbox").fill("https://x.com/starterstory/status/1");
  await expect(linkedinRow.getByText(/x URL/)).toBeVisible();

  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
});
