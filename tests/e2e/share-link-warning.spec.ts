import { test, expect } from "@playwright/test";
import postgres from "postgres";

// A Facebook "Share → Copy link" URL (facebook.com/share/p/…) saves fine but
// never brings back views. The Publish dialog says so; the first Publish
// only warns, a second one keeps the link anyway.
test("publish dialog warns on a Facebook share link, second Publish keeps it", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E facebook post ${stamp}`,
        platform: ["facebook_post"],
        postType: "facebook_post",
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
    const publish = dialog.getByRole("button", { name: "Publish", exact: true });

    // A post's own link: no warning.
    await box.fill(`https://www.facebook.com/reel/${stamp}/`);
    await expect(dialog.getByTestId("publish-link-share-warning")).toHaveCount(0);

    // The share link: warned, Publish still enabled, first press only warns.
    await box.fill("https://www.facebook.com/share/p/14utCXSMshb/");
    const warning = dialog.getByTestId("publish-link-share-warning");
    await expect(warning).toContainText("won't bring back views");
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(warning).toContainText("Save again to use it anyway");
    await expect(dialog).toBeVisible();
    const [mid] = await sql`SELECT status, published_link FROM production_items WHERE id = ${id}`;
    expect(mid.status).toBe("Ready To Publish");
    expect(mid.published_link).toBeNull();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    // Second press keeps it.
    await publish.click();
    await expect(dialog).toBeHidden();
    const [after] = await sql`SELECT status, published_link FROM production_items WHERE id = ${id}`;
    expect(after.status).toBe("Published");
    expect(after.published_link).toBe("https://www.facebook.com/share/p/14utCXSMshb/");
  } finally {
    await sql.end();
  }
});
