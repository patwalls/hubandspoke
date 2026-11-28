import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// Cross-posting from the queue is instant (cross-post-instant M4): the dialog
// closes and the row leaves the moment "Cross-post N selected" is clicked,
// while the creates run behind. A refusal from the readiness gate brings the
// row back with the dialog reopened on the "I'll do it manually" banner.
async function seedCandidate(page: Page, sql: postgres.Sql) {
  const stamp = Date.now();
  const session = await (await page.request.get("/api/auth/session")).json();
  const editorUserId = session?.user?.id as string;
  expect(editorUserId).toBeTruthy();
  const account = async (platform: string) => {
    const [row] = await sql`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, ${platform}, ${`e2e_${platform}_${stamp}`} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;
    return row.id as string;
  };
  const ig = await account("instagram");
  await account("tiktok");
  const title = `E2E instant ${stamp}`;
  const res = await page.request.post("/api/production-items", {
    data: {
      title,
      platform: ["instagram_reel"],
      postType: "instagram_reel",
      publishedDate: new Date().toISOString().slice(0, 10),
      brand: "starter-story",
      editorUserId,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const sourceId = (await res.json()).id as string;
  await sql`
    UPDATE production_items
    SET status = 'Published', format = ${`E2E Instant ${stamp}`}, account_id = ${ig}, views = 5000,
        published_at = now() - interval '2 hours', enrichment_completed_at = now(),
        descript_composition_id = ${`e2e-${stamp}`}
    WHERE id = ${sourceId}`;
  return { stamp, title, meName: (session?.user?.name as string | undefined) || "E2E" };
}

async function pickTargetAndEditor(page: Page, stamp: number, meName: string) {
  await page.getByRole("checkbox", { name: new RegExp(`e2e_tiktok_${stamp}`) }).check();
  const assignTo = page.getByText("Assign to", { exact: true }).locator("..");
  await assignTo.getByLabel("Assignee").click();
  const esc = meName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.getByRole("option", { name: new RegExp(esc) }).first().click();
}

function dismissWhatsNew(page: Page) {
  const popup = page.getByRole("dialog", { name: "What's new" });
  return page.addLocatorHandler(popup, async () => {
    await popup.getByRole("button", { name: "Got it" }).click();
  });
}

test("the row leaves the moment Cross-post is clicked; the create finishes behind", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const { stamp, title, meName } = await seedCandidate(page, sql);
    await dismissWhatsNew(page);
    // Hold the create for 3 s — the old submit kept the dialog open this long.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/production-items/*/cross-post", async (route) => {
      await held;
      await route.continue();
    });

    await page.goto("/starter-story/queue/cross-post");
    const row = page.getByRole("row").filter({ hasText: title });
    await row.getByRole("button", { name: title }).click();
    await pickTargetAndEditor(page, stamp, meName);
    await page.getByRole("button", { name: "Cross-post 1 selected" }).click();

    // While the create is still held: dialog closed, row gone, spinner toast.
    await expect(page.getByRole("dialog", { name: title })).toBeHidden({ timeout: 2_000 });
    await expect(row).toBeHidden();
    await expect(page.getByText("Cross-posting to 1 channel…")).toBeVisible();
    if (process.env.E2E_SHOT) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    }

    release();
    await expect(page.getByText(/Created an Assigned cross-post draft on @e2e_tiktok_/)).toBeVisible({ timeout: 15_000 });
    const [made] = await sql`
      SELECT count(*)::int AS n FROM production_items
      WHERE source_type = 'cross_post' AND title = ${title}`;
    expect(made.n).toBe(1);
    // Refetched list: the source was dismissed from the queue for real.
    await page.reload();
    await expect(page.getByRole("row").filter({ hasText: title })).toHaveCount(0);
  } finally {
    await sql.end();
  }
});

test("a refused target brings the row back with the manual-retry banner", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const { stamp, title, meName } = await seedCandidate(page, sql);
    await dismissWhatsNew(page);
    await page.route("**/api/production-items/*/cross-post", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Cross-post needs the source's media.", reason: "needs_source_media" }),
      }),
    );

    await page.goto("/starter-story/queue/cross-post");
    const row = page.getByRole("row").filter({ hasText: title });
    await row.getByRole("button", { name: title }).click();
    await pickTargetAndEditor(page, stamp, meName);
    await page.getByRole("button", { name: "Cross-post 1 selected" }).click();

    await expect(page.getByRole("button", { name: "I'll do it manually (1)" })).toBeVisible({ timeout: 10_000 });
    // Behind the reopened dialog the row is back in the list (not dismissed).
    await page.keyboard.press("Escape");
    await expect(row).toBeVisible();
  } finally {
    await sql.end();
  }
});
