import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// production-run M2–M4: work the In Production list from the keyboard, peek a
// row without opening it, and after a status change on a post opened from the
// list, go straight to the next one in its group.

async function makeReviewPosts(page: Page, sql: postgres.Sql, tag: string): Promise<string[]> {
  const ids: string[] = [];
  for (const n of [1, 2, 3]) {
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `${tag} part ${n}`,
        platform: ["linkedin"],
        postType: "linkedin",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    ids.push((await res.json()).id as string);
  }
  // Oldest first, so the list (newest first) shows part 3, 2, 1.
  for (const [i, id] of ids.entries()) {
    await sql`UPDATE production_items SET status = 'Review', editor_user_id = NULL, created_at = now() - ${`${3 - i} minutes`}::interval WHERE id = ${id}`;
  }
  return ids;
}

async function openList(page: Page, tag: string) {
  await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
  const popup = page.getByRole("dialog", { name: "What's new" });
  await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
  await expect(popup).toBeHidden();
  await expect(page.locator("[data-production-row]")).toHaveCount(3);
}

test("j / k move over the list, Space peeks, Enter opens, and back lands on the row", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Keys ${Date.now()}`;
  try {
    const ids = await makeReviewPosts(page, sql, tag);
    const c = await page.request.post(`/api/production-items/${ids[1]}/comments`, {
      data: { body: "<p>Tighten the hook please</p>" },
    });
    expect(c.ok(), await c.text()).toBeTruthy();

    await openList(page, tag);
    const rows = page.locator("[data-production-row]");
    // On-screen order (the list's default order isn't ours to assume).
    const order = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-production-row")!));
    const title = (id: string) => `${tag} part ${ids.indexOf(id) + 1}`;
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await page.keyboard.press("j");
    await expect(rows.nth(0)).toHaveAttribute("data-focused", "");
    await page.keyboard.press("j");
    await expect(rows.nth(1)).toHaveAttribute("data-focused", "");
    await expect(rows.nth(0)).not.toHaveAttribute("data-focused", "");

    // Space peeks the focused row without leaving the list.
    await page.keyboard.press(" ");
    const peek = page.getByTestId("production-peek");
    await expect(page.getByTestId("production-peek-title")).toHaveText(title(order[1]));
    if (order[1] === ids[1]) await expect(peek).toContainText("Tighten the hook please");
    await expect(page).toHaveURL(/\/starter-story\/production/);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });

    // j steps the peek too; Esc closes it.
    await page.keyboard.press("j");
    await expect(page.getByTestId("production-peek-title")).toHaveText(title(order[2]));
    await page.keyboard.press("Escape");
    await expect(peek).toHaveCount(0);

    // Enter opens the focused row, with the run stepper (M1).
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${order[2]}$`));
    await expect(page.getByTestId("production-run-position")).toHaveText("Review · 3 of 3");

    // Step back one, then back to the list: the cursor is on that row.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("k");
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${order[1]}$`));
    await page.getByTestId("production-run").getByRole("link", { name: "← In Production" }).click();
    await expect(page).toHaveURL(/\/starter-story\/production/);
    await expect(page.locator(`[data-production-row="${order[1]}"]`)).toHaveAttribute("data-focused", "");

    // The row's eye button peeks with the mouse too.
    const first = page.locator(`[data-production-row="${order[0]}"]`);
    await first.hover();
    await first.getByRole("button", { name: "Peek" }).click();
    await expect(page.getByTestId("production-peek-title")).toHaveText(title(order[0]));
    await peek.getByRole("button", { name: /Open post/ }).click();
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${order[0]}$`));
    await expect(page.getByTestId("production-run-position")).toHaveText("Review · 1 of 3");
  } finally {
    // Left in Review, they'd sit on other specs' My Work.
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});

test("after a status change, the next post in the group is one key away", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E RunNext ${Date.now()}`;
  try {
    const ids = await makeReviewPosts(page, sql, tag);
    await openList(page, tag);
    const order = await page
      .locator("[data-production-row]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-production-row")!));
    const title = (id: string) => `${tag} part ${ids.indexOf(id) + 1}`;

    // Open the first row, approve it.
    await page.locator(`[data-production-row="${order[0]}"] a[data-row-open]`).click();
    await expect(page.getByTestId("production-run-position")).toHaveText("Review · 1 of 3");
    await page.getByRole("combobox", { name: "Status" }).click();
    await page.getByRole("option", { name: "Ready To Publish" }).click();

    const card = page.getByTestId("production-run-next-card");
    await expect(card).toContainText("Moved to Ready To Publish. Next in Review (2 left):");
    await expect(card).toContainText(title(order[1]));
    if (process.env.E2E_SHOT_CARD) await page.screenshot({ path: process.env.E2E_SHOT_CARD });

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("j");
    await expect(page).toHaveURL(new RegExp(`/starter-story/content/${order[1]}$`));
    // The approved post left the run: the group is two now.
    await expect(page.getByTestId("production-run-position")).toHaveText("Review · 1 of 2");
    await expect(card).toHaveCount(0);
  } finally {
    // Left in Review, they'd sit on other specs' My Work.
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});

// The list renders with fallback statuses, then swaps in the brand's own when
// /api/brand-statuses answers. Sections were keyed by status id ("fb-r" →
// uuid), so every row remounted mid-use: the keyboard cursor vanished and
// production-next-rows.spec flaked on a detached row. Same names, same rows.
test("rows survive the brand's statuses arriving after the list", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Keys stable ${Date.now()}`;
  try {
    await makeReviewPosts(page, sql, tag);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/brand-statuses**", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
    const rows = page.locator("[data-production-row]");
    await expect(rows).toHaveCount(3);
    await rows.first().evaluate((el) => ((el as HTMLElement & { _mark?: boolean })._mark = true));
    const statuses = page.waitForResponse("**/api/brand-statuses**");
    release();
    await statuses;
    await page.waitForTimeout(300);
    expect(await rows.first().evaluate((el) => (el as HTMLElement & { _mark?: boolean })._mark === true)).toBe(true);
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${tag + "%"}`;
    await sql.end();
  }
});
