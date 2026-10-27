import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Moving a Published post back to another status asks first, naming its
// platform, because a same-titled cross-post is easy to open by mistake.
// Cancel keeps it Published; OK moves it.
test("moving a Published post back asks first", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `E2E leave published ${Date.now()}`,
        platform: ["youtube"],
        postType: "youtube_long",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${id}`;

    await page.goto(`/starter-story/content/${id}`);
    await page.waitForLoadState("networkidle");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible()) {
      await popup.getByRole("button", { name: "Got it" }).click();
      await expect(popup).toBeHidden();
    }

    const chip = page.getByRole("combobox", { name: "Status" });
    await expect(chip).toContainText("Published");

    const asked: string[] = [];
    page.once("dialog", (d) => {
      asked.push(d.message());
      void d.dismiss();
    });
    await chip.click();
    await page.getByRole("option", { name: "Review" }).click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toBe("This YouTube post is already Published. Move it back to Review?");
    await expect(chip).toContainText("Published");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
    const [kept] = await sql<{ status: string }[]>`SELECT status FROM production_items WHERE id = ${id}`;
    expect(kept.status).toBe("Published");

    page.once("dialog", (d) => void d.accept());
    await chip.click();
    await page.getByRole("option", { name: "Review" }).click();
    await expect(chip).toContainText("Review");
    await expect
      .poll(async () => (await sql<{ status: string }[]>`SELECT status FROM production_items WHERE id = ${id}`)[0].status)
      .toBe("Review");
  } finally {
    await sql.end();
  }
});
