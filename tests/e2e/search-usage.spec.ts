import { test, expect } from "@playwright/test";

// ⌘K search records `search:open` when it opens and `search:pick` when
// something in it is picked, so the product loop can tell whether anyone uses it.
test("search records open and pick marks", async ({ page }) => {
  const marks: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/usage")) {
      try {
        const mark = (req.postDataJSON() as { mark?: string }).mark;
        if (mark) marks.push(mark);
      } catch {
        // not a mark
      }
    }
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }

  await page.getByRole("button", { name: "Open search (⌘K)" }).click();
  const input = page.getByPlaceholder("Search content, formats, or jump to a page…");
  await expect(input).toBeVisible();
  await expect.poll(() => marks.filter((m) => m === "search:open").length).toBe(1);

  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

  // Pick the first thing offered (a page shortcut on an empty DB).
  await page.keyboard.press("Enter");
  await expect(input).toBeHidden();
  await expect.poll(() => marks.includes("search:pick")).toBe(true);
});
