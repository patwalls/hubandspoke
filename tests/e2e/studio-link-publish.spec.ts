import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Editors hand Shorts back as a YouTube Studio link; the live Short has the
// same video id. The publish boxes (In Production peek, the post page's
// Publish dialog) offer that public link in one click.
test("a Short handed back as a Studio link offers its live link when publishing", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E StudioLink ${Date.now()}`;
  try {
    const [editor] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`editor-sl-${Date.now()}@local.test`}, 'Noa Editor')
      RETURNING id`;
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `${tag} short`,
        platform: ["youtube"],
        postType: "youtube_shorts",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    await sql`UPDATE production_items SET status = 'Review', published_link = NULL WHERE id = ${id}`;
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${id}, ${editor.id}, 'status_change',
        ${sql.json({ type: "status_change", from: "Assigned", to: "Review" })}, now() - interval '1 hour')`;
    await sql`
      INSERT INTO content_comments (content_item_id, user_id, body, created_at)
      VALUES (${id}, ${editor.id},
        ${'<p>Review &amp; publish. <a href="https://studio.youtube.com/video/e2eVid_0-Ab/edit">https://studio.youtube.com/video/e2eVid_0-Ab/edit</a></p>'},
        now() - interval '58 minutes')`;

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });

    // In Production peek: the offer fills the box; nothing is saved until Mark published.
    await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
    const row = page.locator(`[data-production-row="${id}"]`);
    await row.hover();
    await row.getByRole("button", { name: /^(Peek|Quick review)$/ }).click();
    const box = page.getByTestId("production-peek-publish");
    const offer = box.getByTestId("publish-studio-link");
    await expect(offer).toContainText("From Noa's YouTube Studio link");
    // The peek shows the comment as written, not "Review &amp; publish."
    await expect(page.getByText("Review & publish.", { exact: false })).toBeVisible();
    await expect(page.getByText("&amp;", { exact: false })).toHaveCount(0);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
    await offer.getByRole("button", { name: "Use youtube.com/shorts/e2eVid_0-Ab" }).click();
    await expect(box.getByRole("textbox")).toHaveValue("https://youtube.com/shorts/e2eVid_0-Ab");
    await expect(offer).toHaveCount(0);
    const [still] = await sql`SELECT status FROM production_items WHERE id = ${id}`;
    expect(still.status).toBe("Review");

    // Post page: the Publish dialog makes the same offer, and Publish saves it.
    await page.goto(`/starter-story/content/${id}`);
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    await dialog.getByRole("button", { name: "Use youtube.com/shorts/e2eVid_0-Ab" }).click();
    await expect(dialog.getByLabel("Published link")).toHaveValue("https://youtube.com/shorts/e2eVid_0-Ab");
    await dialog.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(dialog).toBeHidden();
    const [row2] = await sql`SELECT status, published_link FROM production_items WHERE id = ${id}`;
    expect(row2.status).toBe("Published");
    expect(row2.published_link).toBe("https://youtube.com/shorts/e2eVid_0-Ab");
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});
