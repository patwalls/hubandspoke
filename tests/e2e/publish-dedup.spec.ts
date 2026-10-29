import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// Publishing a link stores its post id (the dedup key) like every other
// write. When the account sync already pulled the live post in as its own
// row, that row folds into the planned item instead of staying a duplicate
// with double-counted views; a post that lives on another account is refused.
test("publish folds the synced copy of the post into the planned item", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const create = async (p: Page, title: string) => {
      const res = await p.request.post("/api/production-items", {
        data: {
          title,
          platform: ["instagram_reel"],
          postType: "instagram_reel",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const account = async (handle: string) => {
      const [row] = await sql`
        INSERT INTO accounts (brand_id, platform, handle)
        SELECT id, 'instagram', ${handle} FROM brands WHERE slug = 'starter-story'
        RETURNING id`;
      return row.id as string;
    };
    const ours = await account(`e2e_ours_${stamp}`);
    const theirs = await account(`e2e_theirs_${stamp}`);

    // Same account: the sync got there first.
    const planned = await create(page, `E2E planned reel ${stamp}`);
    const synced = await create(page, `E2E synced reel ${stamp}`);
    const code = `e2eA${stamp}`;
    await sql`UPDATE production_items SET status = 'Ready To Publish', account_id = ${ours} WHERE id = ${planned}`;
    await sql`
      UPDATE production_items SET status = 'Published', account_id = ${ours}, views = 500,
        platform_content_id = ${code}, published_link = ${`https://www.instagram.com/reel/${code}/`}
      WHERE id = ${synced}`;

    const res = await page.request.post(`/api/production-items/${planned}/publish`, {
      data: { mode: "publish", link: `https://www.instagram.com/reel/${code}/?igsh=abc` },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const [kept] = await sql`SELECT status, platform_content_id, views FROM production_items WHERE id = ${planned}`;
    expect(kept.status).toBe("Published");
    expect(kept.platform_content_id).toBe(code);
    expect(Number(kept.views)).toBe(500);
    const [gone] = await sql`SELECT deleted_at FROM production_items WHERE id = ${synced}`;
    expect(gone.deleted_at).not.toBeNull();

    // Another account's post: refused from the Publish dialog, item untouched.
    const other = await create(page, `E2E other reel ${stamp}`);
    const mine = await create(page, `E2E my reel ${stamp}`);
    const otherCode = `e2eB${stamp}`;
    await sql`
      UPDATE production_items SET status = 'Published', account_id = ${theirs},
        platform_content_id = ${otherCode}, published_link = ${`https://www.instagram.com/reel/${otherCode}/`}
      WHERE id = ${other}`;
    await sql`UPDATE production_items SET status = 'Ready To Publish', account_id = ${ours} WHERE id = ${mine}`;

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${mine}`);
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    await dialog.getByLabel("Published link").fill(`https://www.instagram.com/reel/${otherCode}/`);
    await dialog.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText(`already tracked on @e2e_theirs_${stamp}`)).toBeVisible();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
    const [untouched] = await sql`SELECT status, published_link FROM production_items WHERE id = ${mine}`;
    expect(untouched.status).toBe("Ready To Publish");
    expect(untouched.published_link).toBeNull();
  } finally {
    await sql.end();
  }
});
