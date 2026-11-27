import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The post's Activity shows a publish once. Older rows that "changed status
// from Published to Published" (written by the live-post match before
// reconcilePublishChanges) are skipped; the real flip still renders.

test.use({ viewport: { width: 1600, height: 1000 } });

test("the post's Activity skips a status change to the same status", async ({ page }) => {
  const res = await page.request.post("/api/production-items", {
    data: {
      title: `E2E status once ${Date.now()}`,
      platform: ["tiktok"],
      postType: "tiktok",
      publishedDate: new Date().toISOString().slice(0, 10),
      brand: "starter-story",
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const id = (await res.json()).id as string;

  // Created Published → back to Ready To Publish → Published, then the same
  // status again (must not add a row): two real flips.
  for (const status of ["Ready To Publish", "Published", "Published"]) {
    const put = await page.request.put("/api/production-items", {
      data: { id, status },
    });
    expect(put.ok(), await put.text()).toBeTruthy();
  }

  // An old-style no-op row, as the live-post match used to write it.
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql`INSERT INTO content_events (content_item_id, event_type, payload)
      VALUES (${id}, 'status_change',
        ${sql.json({ type: "status_change", from: "Published", to: "Published" })})`;
  } finally {
    await sql.end();
  }

  await page.goto(`/starter-story/content/${id}`);
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }

  const flips = page.getByText(/changed\s+status/);
  await expect(flips.first()).toBeVisible();
  await expect(flips).toHaveCount(2);
  if (process.env.E2E_SHOT) {
    await flips.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.E2E_SHOT });
  }
});
