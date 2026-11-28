import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";

// Cross-posting from the post page's Cross-post tab is instant too
// (cross-post-instant M5): the picked channel turns "Creating…" at once and
// the rest of the panel stays usable while the create runs; a failed create
// comes back ticked so a retry is one click.
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
  await account("threads");
  const title = `E2E tab instant ${stamp}`;
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
    SET status = 'Published', format = ${`E2E Tab Instant ${stamp}`}, account_id = ${ig}, views = 5000,
        published_at = now() - interval '2 hours', enrichment_completed_at = now(),
        descript_composition_id = ${`e2e-${stamp}`}
    WHERE id = ${sourceId}`;
  return { stamp, title, sourceId, meName: (session?.user?.name as string | undefined) || "E2E" };
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

test("a picked channel turns Creating… at once and the panel stays usable", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const { stamp, title, sourceId, meName } = await seedCandidate(page, sql);
    await dismissWhatsNew(page);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/production-items/*/cross-post", async (route) => {
      await held;
      await route.continue();
    });

    await page.goto(`/starter-story/content/${sourceId}?tab=cross-post`);
    await pickTargetAndEditor(page, stamp, meName);
    await page.getByRole("button", { name: "Cross-post 1 selected" }).click();

    // While the create is held: the channel says Creating…, the button is free,
    // and another channel can still be ticked.
    await expect(page.getByTestId("cross-post-creating")).toBeVisible({ timeout: 2_000 });
    await expect(page.getByRole("button", { name: "Cross-posting…" })).toHaveCount(0);
    const threads = page.getByRole("checkbox", { name: new RegExp(`e2e_threads_${stamp}`) });
    await expect(threads).toBeEnabled();
    if (process.env.E2E_SHOT) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    }

    release();
    await expect(page.getByText(/Created an Assigned cross-post draft on @e2e_tiktok_/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("cross-post-creating")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: new RegExp(`e2e_tiktok_${stamp}`) })).toBeDisabled();
    const [made] = await sql`
      SELECT count(*)::int AS n FROM production_items
      WHERE source_type = 'cross_post' AND title = ${title}`;
    expect(made.n).toBe(1);
  } finally {
    await sql.end();
  }
});

test("a create that fails outright comes back ticked for a one-click retry", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const { stamp, sourceId, meName } = await seedCandidate(page, sql);
    await dismissWhatsNew(page);
    await page.route("**/api/production-items/*/cross-post", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }),
    );

    await page.goto(`/starter-story/content/${sourceId}?tab=cross-post`);
    await pickTargetAndEditor(page, stamp, meName);
    await page.getByRole("button", { name: "Cross-post 1 selected" }).click();

    await expect(page.getByText("Failed to cross-post (1 target).")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("checkbox", { name: new RegExp(`e2e_tiktok_${stamp}`) })).toBeChecked();
    await expect(page.getByRole("button", { name: "Cross-post 1 selected" })).toBeEnabled();
  } finally {
    await sql.end();
  }
});
