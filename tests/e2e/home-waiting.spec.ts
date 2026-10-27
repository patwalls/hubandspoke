import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The brand dashboard opens with "Waiting on you" when a post is: the count,
// the next post with an Open button, and a way into My Work.
test("the dashboard shows what's waiting on you and opens it", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    await sql`UPDATE production_items SET status = 'Killed' WHERE editor_user_id = ${me} AND status IN ('Assigned', 'Ready To Publish', 'Review')`;

    // Nothing waiting: no bar.
    await page.goto("/starter-story");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();
    await expect(page.getByTestId("home-waiting")).toHaveCount(0);

    const title = `E2E home waiting ${Date.now()}`;
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
    await sql`UPDATE production_items SET status = 'Assigned' WHERE id = ${id}`;

    await page.goto("/starter-story");
    const bar = page.getByTestId("home-waiting");
    await expect(bar).toContainText("Waiting on you");
    await expect(bar).toContainText("1 your turn");
    await expect(bar).toContainText(title);
    await expect(bar).toContainText("TikTok");
    await expect(bar.getByRole("link", { name: "See all" })).toHaveAttribute("href", "/my-work");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await bar.getByRole("link", { name: "Open" }).click();
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${id}$`));
  } finally {
    await sql.end();
  }
});
