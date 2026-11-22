import { test, expect } from "@playwright/test";
import postgres from "postgres";

// publish-one-trip M3. Publishers post Ready posts back to back, and after
// each Publish they went straight back to the In Production list (before any
// next card showed) to open the next one. The Publish dialog now names the
// next Ready post, and paste + Enter publishes and opens it.
test("paste + Enter on a Ready post publishes it and opens the next one", async ({ page }) => {
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
    const title = `E2E open next ${stamp}`;
    const sourceId = await create(title, "instagram_reel");
    await sql`UPDATE production_items SET status = 'Published' WHERE id = ${sourceId}`;
    const crossPost = async (postType: string, age: string) => {
      const id = await create(title, postType);
      await sql`UPDATE production_items SET status = 'Ready To Publish', source_type = 'cross_post', reposted_from_item_id = ${sourceId}, updated_at = now() - ${age}::interval WHERE id = ${id}`;
      return id;
    };
    const linkedinId = await crossPost("linkedin", "2 hours");
    const threadsId = await crossPost("threads", "1 hour");

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${linkedinId}`);
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    const offer = dialog.getByTestId("publish-open-next");
    await expect(offer).toContainText(`Then open this post's next platform: Threads · ${title}`);
    await expect(offer.getByRole("checkbox")).toBeChecked();
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await dialog.locator("#publish-link").fill(`https://www.linkedin.com/feed/update/e2e-next-${stamp}`);
    await dialog.locator("#publish-link").press("Enter");
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${threadsId}$`));
    const [row] = await sql`SELECT status FROM production_items WHERE id = ${linkedinId}`;
    expect(row.status).toBe("Published");
    await expect.poll(async () => {
      const [r] = await sql`SELECT count(*)::int AS n FROM usage_events WHERE screen = 'publish:open-next:same-post' AND user_id = ${me}`;
      return r.n as number;
    }).toBeGreaterThan(0);

    // Turned off, it stays off (per browser), and Publish stays on the page.
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    // Threads is the last one: nothing to open next.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("publish-open-next")).toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    await sql.end();
  }
});

test("the Open next box remembers being turned off", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    await sql`UPDATE production_items SET status = 'Killed' WHERE editor_user_id = ${me} AND status IN ('Assigned', 'Ready To Publish', 'Review')`;
    const ids: string[] = [];
    for (const age of ["2 hours", "1 hour"]) {
      const res = await page.request.post("/api/production-items", {
        data: {
          title: `E2E open next off ${stamp} ${age}`,
          platform: ["linkedin"],
          postType: "linkedin",
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
          editorUserId: me,
        },
      });
      const id = (await res.json()).id as string;
      await sql`UPDATE production_items SET status = 'Ready To Publish', updated_at = now() - ${age}::interval WHERE id = ${id}`;
      ids.push(id);
    }

    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.addLocatorHandler(popup, async () => {
      await popup.getByRole("button", { name: "Got it" }).click();
    });
    await page.goto(`/starter-story/content/${ids[0]}`);
    await page.getByRole("button", { name: "Publish or Schedule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Publish or Schedule" });
    const box = dialog.getByTestId("publish-open-next").getByRole("checkbox");
    await expect(dialog.getByTestId("publish-open-next")).toContainText("Then open the next Ready post:");
    await box.uncheck();
    await dialog.locator("#publish-link").fill(`https://www.linkedin.com/feed/update/e2e-off-${stamp}`);
    await dialog.locator("#publish-link").press("Enter");
    await expect(dialog).toBeHidden();
    // Stayed: the post page shows the card instead.
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${ids[0]}$`));

    await page.goto(`/starter-story/content/${ids[1]}`);
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem("hs:publish-open-next"))).toBe("off");
  } finally {
    await sql.end();
  }
});
