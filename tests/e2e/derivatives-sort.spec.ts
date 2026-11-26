import { test, expect } from "@playwright/test";
import postgres from "postgres";

test.use({ video: process.env.E2E_VIDEO === "1" ? "retain-on-failure" : "off" });

// A video's Derivatives tab: clicking "Views" puts the best-performing piece
// made from it on top, the choice survives a reload (per browser), and a
// second click goes back to the tab's usual order.
test("Derivatives tab sorts by views and remembers it", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const create = async (title: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: ["youtube"],
          postType: "youtube",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const pillarId = await create(`E2E sort pillar ${stamp}`);
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${pillarId}`;
    const small = await create(`E2E sort small clip ${stamp}`);
    const big = await create(`E2E sort big clip ${stamp}`);
    const idea = await create(`E2E sort idea ${stamp}`);
    const mid = await create(`E2E sort mid clip ${stamp}`);
    // created_at decides the tab's own order; space them so it is stable.
    const ordered: [string, number | null, string][] = [
      [small, 1200, "Published"],
      [big, 54000, "Published"],
      [idea, null, "Idea"],
      [mid, 9800, "Published"],
    ];
    for (const [i, [id, views, status]] of ordered.entries()) {
      await sql`UPDATE production_items
                   SET pillar_content_item_id = ${pillarId}, status = ${status}, views = ${views},
                       published_date = ${views == null ? null : new Date().toISOString().slice(0, 10)},
                       created_at = now() - make_interval(mins => ${10 - i})
                 WHERE id = ${id}`;
    }

    await page.goto(`/starter-story/content/${pillarId}?tab=derivatives`);
    await page.evaluate(() => window.localStorage.removeItem("derivatives:sort"));
    await page.reload();
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const rows = page.getByTestId("derivative-row");
    await expect(rows).toHaveCount(4);
    const firstTitle = () => rows.first().getByRole("link").first();
    const usualFirst = await firstTitle().textContent();

    await page.getByRole("button", { name: "Views" }).click();
    await expect(firstTitle()).toHaveText(`E2E sort big clip ${stamp}`);
    await expect(rows.nth(1).getByRole("link").first()).toHaveText(`E2E sort mid clip ${stamp}`);
    await expect(rows.last().getByRole("link").first()).toHaveText(`E2E sort idea ${stamp}`);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    // Remembered per browser.
    await page.reload();
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});
    await expect(firstTitle()).toHaveText(`E2E sort big clip ${stamp}`);

    // Second click: back to the usual order.
    await page.getByRole("button", { name: "Views" }).click();
    await expect(firstTitle()).toHaveText(usualFirst ?? "");
  } finally {
    await sql.end();
  }
});
