import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The content page's "Up next" link: on a post that's waiting on you, it
// points at the next one waiting (oldest first), and after you send this one
// on it's still there, so you go straight to the next post.
test("Up next on the content page goes to the next post waiting on you", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    // Nothing else of mine should be waiting, so the order is the test's own.
    await sql`UPDATE production_items SET status = 'Killed' WHERE editor_user_id = ${me} AND status IN ('Assigned', 'Ready To Publish', 'Review')`;
    const create = async (title: string, age: string) => {
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
      await sql`UPDATE production_items SET status = 'Assigned', updated_at = now() - ${age}::interval WHERE id = ${id}`;
      return id;
    };
    const current = `E2E up-next current ${stamp}`;
    const older = `E2E up-next older ${stamp}`;
    const newer = `E2E up-next newer ${stamp}`;
    const currentId = await create(current, "3 hours");
    const olderId = await create(older, "2 hours");
    await create(newer, "1 hour");

    await page.goto(`/starter-story/content/${currentId}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    const upNext = page.getByTestId("up-next");
    await expect(upNext).toContainText(older);
    await expect(upNext).toContainText("(2)");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await upNext.click();
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${olderId}$`));
    // On the older post, the first post is next: it's still Assigned and the
    // oldest-touched one waiting.
    await expect(page.getByTestId("up-next")).toContainText(current);
  } finally {
    await sql.end();
  }
});
