import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// Pasting a post link anywhere on a Ready To Publish item's page opens the
// Publish dialog with the link filled in, and Enter publishes. A paste into
// a text field stays that field's.
async function pasteOn(page: Page, selector: string, text: string) {
  await page.evaluate(
    ([sel, t]) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", t);
      const el = document.querySelector(sel) ?? document.body;
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [selector, text] as const,
  );
}

test("a link pasted on the page opens Publish pre-filled; Enter publishes", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E paste ${stamp}`,
        platform: ["instagram_reel"],
        postType: "instagram_reel",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    await sql`UPDATE production_items SET status = 'Ready To Publish' WHERE id = ${id}`;

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${id}`);
    await expect(page.getByRole("button", { name: "Publish or Schedule" }).first()).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    const link = `https://www.instagram.com/reel/e2e${stamp}/`;

    // Plain text and pastes into a field don't open anything.
    await pasteOn(page, "body", "not a link");
    const field = page.locator("textarea").first();
    if (await field.count()) await pasteOn(page, "textarea", link);
    await page.waitForTimeout(300);
    await expect(dialog).toBeHidden();

    // A link pasted on the page does.
    await pasteOn(page, "main", link);
    await expect(dialog).toBeVisible();
    const box = dialog.getByLabel("Published link");
    await expect(box).toHaveValue(link);
    await expect(box).toBeFocused();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await box.press("Enter");
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await sql`SELECT status, published_link FROM production_items WHERE id = ${id}`)[0])
      .toMatchObject({ status: "Published", published_link: link });
  } finally {
    await sql.end();
  }
});
