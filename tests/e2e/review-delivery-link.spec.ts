import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Editors hand work back with a link in a comment (the upload in YouTube
// Studio, the Canva design). A Review row on the In Production list shows
// that link, so the reviewer opens the work straight from the list — and the
// post page shows it beside the status.
test("a Review row and its post page show the link the work was handed back with", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id as string;
    expect(me).toBeTruthy();

    const [editor] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`editor-dl-${stamp}@local.test`}, 'Noa Editor')
      RETURNING id`;

    const create = async (title: string, status: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: ["tiktok"],
          postType: "tiktok",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
          editorUserId: me,
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      const id = (await res.json()).id as string;
      await sql`UPDATE production_items SET status = ${status} WHERE id = ${id}`;
      return id;
    };

    const reviewId = await create(`E2E delivered ${stamp}`, "Review");
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${reviewId}, ${editor.id}, 'status_change',
        ${sql.json({ type: "status_change", from: "Assigned", to: "Review" })}, now() - interval '1 hour')`;
    await sql`
      INSERT INTO content_comments (content_item_id, user_id, body, created_at)
      VALUES (${reviewId}, ${editor.id},
        ${'<p>review &amp; publish <a href="https://studio.youtube.com/video/e2eVid/edit" target="_blank">https://studio.youtube.com/video/e2eVid/edit</a></p>'},
        now() - interval '58 minutes')`;

    // An Assigned post with a link comment gets no chip (only Review rows).
    const assignedId = await create(`E2E assigned ${stamp}`, "Assigned");
    await sql`
      INSERT INTO content_comments (content_item_id, user_id, body)
      VALUES (${assignedId}, ${editor.id}, ${'<p><a href="https://canva.link/e2e">draft</a></p>'})`;

    // One more write through the app so the 60 s report cache is dropped
    // after the rows above changed underneath it.
    await create(`E2E cache bust ${stamp}`, "Assigned");

    const report = await page.request.get("/api/reports/production?brand=starter-story");
    const reportText = await report.text();
    expect(report.ok(), reportText.slice(0, 500)).toBeTruthy();
    expect(reportText, reportText.slice(0, 800)).toContain("studio.youtube.com/video/e2eVid");

    await page.goto(`/starter-story/production`);
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }

    const reviewRow = page.locator(`[data-production-row="${reviewId}"]`);
    const chip = reviewRow.getByTestId("delivery-link");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText("YouTube Studio");
    await expect(chip).toHaveAttribute("href", "https://studio.youtube.com/video/e2eVid/edit");
    await expect(chip).toHaveAttribute("target", "_blank");

    const assignedRow = page.locator(`[data-production-row="${assignedId}"]`);
    await expect(assignedRow).toBeVisible();
    await expect(assignedRow.getByTestId("delivery-link")).toHaveCount(0);

    // The post page shows the same link beside the status while it's in
    // Review; an Assigned post shows none.
    const apiRes = await page.request.get(`/api/production-items/${reviewId}/delivery-link`);
    expect(apiRes.ok(), await apiRes.text()).toBeTruthy();
    expect((await apiRes.json()).link?.label).toBe("YouTube Studio");

    await page.goto(`/starter-story/content/${assignedId}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("combobox", { name: "Status" })).toBeVisible();
    await expect(page.getByTestId("post-delivery-link")).toHaveCount(0);

    await page.goto(`/starter-story/content/${reviewId}`);
    await page.waitForLoadState("networkidle");
    const postChip = page.getByTestId("post-delivery-link");
    await expect(postChip).toBeVisible();
    await expect(postChip).toHaveText("YouTube Studio");
    await expect(postChip).toHaveAttribute("href", "https://studio.youtube.com/video/e2eVid/edit");
    await expect(postChip).toHaveAttribute("title", "Noa's link from the comments");

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: false });
  } finally {
    await sql.end();
  }
});
