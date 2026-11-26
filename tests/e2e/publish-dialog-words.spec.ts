import { test, expect } from "@playwright/test";
import postgres from "postgres";

test.use({ video: process.env.E2E_VIDEO === "1" ? "retain-on-failure" : "off" });

// The Publish dialog on a LinkedIn post: the link box shows a LinkedIn link
// (it used to say "https://x.com/…" on every post) and the date line is
// plain words, not a note about server timestamps.
test("publish dialog speaks the post's platform", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E LinkedIn post ${stamp}`,
        platform: ["linkedin"],
        postType: "linkedin",
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
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    const box = dialog.getByLabel("Published link");
    await expect(box).toHaveAttribute("placeholder", "https://linkedin.com/feed/update/…");
    await expect(dialog).toContainText("Change it if the post went live on another day.");
    await expect(dialog).not.toContainText("publishedAt");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
  } finally {
    await sql.end();
  }
});
