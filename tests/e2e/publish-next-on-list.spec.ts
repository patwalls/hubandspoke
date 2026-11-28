import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// publish-one-trip M7. A publisher who goes back to In Production after every
// "Then open next" landing (and reopens the post from there) stops being
// sent to the post: after two quick returns in a row, Publish lands on the
// list with the next post's row marked and under the cursor, and Enter opens
// it. The dialog says so, with a way back.
test("after two quick returns to the list, Publish lands there with the next row marked", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    await sql`UPDATE production_items SET status = 'Killed' WHERE editor_user_id = ${me} AND status IN ('Assigned', 'Ready To Publish', 'Review')`;
    const create = async (title: string, postType: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: [postType],
          postType,
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
          editorUserId: me,
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const title = `E2E next on list ${stamp}`;
    const sourceId = await create(title, "instagram_reel");
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${sourceId}`;
    const crossPost = async (postType: string, age: string) => {
      const id = await create(title, postType);
      await sql`UPDATE production_items SET status = 'Ready To Publish', source_type = 'cross_post', reposted_from_item_id = ${sourceId}, updated_at = now() - ${age}::interval WHERE id = ${id}`;
      return id;
    };
    const ids = [
      await crossPost("linkedin", "4 hours"),
      await crossPost("threads", "3 hours"),
      await crossPost("x", "2 hours"),
      await crossPost("facebook_post", "1 hour"),
    ];

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    const publish = async (p: Page, n: number) => {
      await p.getByRole("button", { name: "Publish or Schedule" }).first().click();
      await expect(dialog.getByTestId("publish-open-next")).toBeVisible();
      await dialog.locator("#publish-link").fill(`https://www.linkedin.com/feed/update/e2e-next-list-${stamp}-${n}`);
    };

    // Two landings, each followed straight away by a trip back to the list.
    // (Which sibling comes next is open-next's business; follow it.)
    const left = new Set(ids);
    const landedOn = async (from: string) => {
      await expect(page).not.toHaveURL(new RegExp(`/content/${from}$`));
      await expect(page).toHaveURL(/\/starter-story\/content\/[0-9a-f-]{36}$/);
      return page.url().split("/").pop()!;
    };
    let current = ids[0];
    await page.goto("/starter-story/production");
    await page.locator(`[data-production-row="${current}"] a[data-row-open]`).click();
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${current}$`));
    for (let n = 0; n < 2; n++) {
      await publish(page, n);
      await expect(dialog.getByTestId("publish-open-next")).toContainText("Then open");
      await dialog.locator("#publish-link").press("Enter");
      left.delete(current);
      current = await landedOn(current);
      expect(left.has(current)).toBe(true);
      // …and the post opened again from its row, as they do.
      await page.goto("/starter-story/production");
      await page.locator(`[data-production-row="${current}"] a[data-row-open]`).click();
      await expect(page).toHaveURL(new RegExp(`/starter-story/content/${current}$`));
    }
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("hs:publish-open-next-habit") ?? "{}").bounces)).toBe(2);

    // Third Publish: the dialog says the next one is marked on the list…
    await publish(page, 2);
    await expect(dialog.getByTestId("publish-open-next")).toContainText("Then mark it on In Production");
    await expect(dialog.getByTestId("publish-open-next-post-instead")).toBeVisible();
    await dialog.locator("#publish-link").press("Enter");
    left.delete(current);
    const [last] = [...left];

    // …and lands there: the last sibling's row marked Next, under the cursor.
    await expect(page).toHaveURL(/\/starter-story\/production/);
    const next = page.getByTestId("production-next-row");
    await expect(next).toHaveCount(1);
    await expect(next).toHaveAttribute("data-production-row", last);
    await expect(next).toHaveAttribute("data-focused", "");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    // Enter opens it.
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${last}$`));

  } finally {
    await sql.end();
  }
});

test("'open the post instead' sends Publish to the next post again", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    await sql`UPDATE production_items SET status = 'Killed' WHERE editor_user_id = ${me} AND status IN ('Assigned', 'Ready To Publish', 'Review')`;
    const create = async (postType: string) => {
      const res = await page.request.post("/api/production-items", {
        data: { title: `E2E post instead ${stamp}`, platform: [postType], postType, publishedDate: new Date().toISOString().slice(0, 10), brand: "starter-story", editorUserId: me },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const sourceId = await create("instagram_reel");
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${sourceId}`;
    const a = await create("linkedin");
    const b = await create("threads");
    await sql`UPDATE production_items SET status = 'Ready To Publish', source_type = 'cross_post', reposted_from_item_id = ${sourceId}, updated_at = now() - interval '2 hours' WHERE id = ${a}`;
    await sql`UPDATE production_items SET status = 'Ready To Publish', source_type = 'cross_post', reposted_from_item_id = ${sourceId}, updated_at = now() - interval '1 hour' WHERE id = ${b}`;

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${a}`);
    await page.evaluate(() => localStorage.setItem("hs:publish-open-next-habit", JSON.stringify({ bounces: 2, pending: false })));
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    await expect(dialog.getByTestId("publish-open-next")).toContainText("Then mark it on In Production");
    await dialog.getByTestId("publish-open-next-post-instead").click();
    await expect(dialog.getByTestId("publish-open-next")).toContainText("Then open this post's next platform");
    // The checkbox didn't flip with the click.
    await expect(dialog.getByTestId("publish-open-next").getByRole("checkbox")).toBeChecked();
    await dialog.locator("#publish-link").fill(`https://www.linkedin.com/feed/update/e2e-post-instead-${stamp}`);
    await dialog.locator("#publish-link").press("Enter");
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${b}$`));
  } finally {
    await sql.end();
  }
});
