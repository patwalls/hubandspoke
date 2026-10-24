import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The moment a post leaves your plate on its content page (here: you move it
// to Review on a brand you don't approve), a card offers the next post waiting
// on you, so you don't go back to a list to find it.
test("sending a post on offers the next one waiting on you", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
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
    const current = `E2E next-card current ${stamp}`;
    const next = `E2E next-card next ${stamp}`;
    const currentId = await create(current, "3 hours");
    const nextId = await create(next, "2 hours");

    await page.goto(`/starter-story/content/${currentId}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(popup).toBeHidden();

    // Opening a post that's waiting on you shows no card, only the link.
    await expect(page.getByTestId("up-next")).toContainText(next);
    await expect(page.getByTestId("up-next-card")).toHaveCount(0);

    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "Review" }).click();

    const card = page.getByTestId("up-next-card");
    await expect(card).toContainText("Next waiting on you");
    await expect(card).toContainText(next);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    await card.getByRole("link", { name: /Open next/ }).click();
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${nextId}$`));
    // The card doesn't follow you: this post is still waiting on you.
    await expect(page.getByTestId("up-next-card")).toHaveCount(0);
  } finally {
    await sql.end();
  }
});
