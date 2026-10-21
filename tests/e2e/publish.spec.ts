import { test, expect } from "@playwright/test";
import postgres from "postgres";

// The Publish screen: Ready To Publish posts with a link box on each row.
// Paste the live link + Enter marks the post Published; a link from another
// platform is caught on the row before it's saved.
test("publish screen marks a post published from a pasted link", async ({ page }) => {
  const stamp = Date.now();
  const titles = [`E2E publish tiktok ${stamp}`, `E2E publish linkedin ${stamp}`];
  const postTypes = ["tiktok", "linkedin"];
  // The throwaway DB has no default editor, so name ourselves.
  const session = await (await page.request.get("/api/auth/session")).json();
  const editorUserId = session?.user?.id;
  expect(editorUserId).toBeTruthy();
  for (let i = 0; i < titles.length; i++) {
    const created = await page.request.post("/api/production-items", {
      data: {
        title: titles[i],
        platform: [postTypes[i]],
        postType: postTypes[i],
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
        editorUserId,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { id } = await created.json();
    const moved = await page.request.put("/api/production-items", {
      data: { id, status: "Ready To Publish" },
    });
    expect(moved.ok(), await moved.text()).toBeTruthy();
  }

  await page.goto("/starter-story/publish");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible().catch(() => false)) {
    await popup.getByRole("button", { name: "Got it" }).click();
  }
  await expect(page.getByRole("heading", { name: "Publish" })).toBeVisible();

  const tiktokRow = page.getByTestId("publish-row").filter({ hasText: titles[0] });
  const linkedinRow = page.getByTestId("publish-row").filter({ hasText: titles[1] });
  await expect(tiktokRow).toBeVisible();

  // Wrong platform: the row warns and nothing is saved.
  const tiktokInput = tiktokRow.getByRole("textbox");
  await tiktokInput.fill("https://www.instagram.com/p/abc123/");
  await tiktokInput.press("Enter");
  await expect(tiktokRow.getByText(/instagram URL/)).toBeVisible();
  await expect(tiktokRow.getByRole("link", { name: /Published/ })).toHaveCount(0);

  // Right link: Enter publishes the row.
  await tiktokInput.fill(`https://www.tiktok.com/@starterstory/video/${stamp}`);
  await tiktokInput.press("Enter");
  await expect(tiktokRow.getByRole("link", { name: /Published/ })).toBeVisible();

  // Leave the second row mid-mistake so the screenshot shows both states.
  await linkedinRow.getByRole("textbox").fill("https://x.com/starterstory/status/1");
  await expect(linkedinRow.getByText(/x URL/)).toBeVisible();

  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
});

// Grouped by pillar, with the post kit and the live-post suggestion on the row.
// The suggestion is what the hourly publish-live-sweep writes; seeded straight
// into the DB here (along with a caption, which no API sets) since the sweep
// needs synced posts and an LLM.
test("publish screen groups a pillar's posts, copies the caption, confirms a live post", async ({
  page,
  context,
}) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const stamp = Date.now();
    const session = await (await page.request.get("/api/auth/session")).json();
    const editorUserId = session?.user?.id;
    const create = async (title: string, postType: string) => {
      const res = await page.request.post("/api/production-items", {
        data: {
          title,
          platform: [postType],
          postType,
          publishedDate: new Date().toISOString().slice(0, 10),
          brand: "starter-story",
          editorUserId,
        },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return (await res.json()).id as string;
    };
    const pillarTitle = `E2E pillar ${stamp}`;
    const pillarId = await create(pillarTitle, "youtube_long");
    const tiktokId = await create(`E2E grouped tiktok ${stamp}`, "tiktok");
    const linkedinId = await create(`E2E grouped linkedin ${stamp}`, "linkedin");
    for (const id of [tiktokId, linkedinId]) {
      const moved = await page.request.put("/api/production-items", {
        data: { id, status: "Ready To Publish", pillarContentItemId: pillarId },
      });
      expect(moved.ok(), await moved.text()).toBeTruthy();
    }
    const caption = `Caption for the tiktok ${stamp}`;
    await sql`UPDATE production_items SET content_body = ${caption} WHERE id = ${tiktokId}`;
    const liveLink = `https://www.linkedin.com/posts/starterstory_${stamp}`;
    const [synced] = await sql`
      INSERT INTO production_items (title, brand, status, post_type, platform, published_link,
        published_at, published_date, source_type, created_via, content_body, editor_user_id)
      VALUES ('synced linkedin', 'starter-story', 'Published', 'linkedin', '["linkedin"]'::jsonb,
        ${liveLink}, now(), current_date, 'original', 'sync:account-content',
        ${`The live linkedin post ${stamp}`}, ${editorUserId})
      RETURNING id`;
    await sql`
      INSERT INTO scheduled_match_suggestions (scheduled_item_id, candidate_item_id, score, reason, status)
      VALUES (${linkedinId}, ${synced.id}, 72, 'e2e', 'pending')`;

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/starter-story/publish");
    const popup = page.getByRole("dialog", { name: "What's new" });
    if (await popup.isVisible().catch(() => false)) {
      await popup.getByRole("button", { name: "Got it" }).click();
    }

    const group = page.getByTestId("publish-group").filter({ hasText: pillarTitle });
    await expect(group.getByTestId("publish-row")).toHaveCount(2);
    await expect(group.getByText("2 of 2 left")).toBeVisible();
    const badge = page.getByTestId("publish-ready-count");
    await expect(badge).toBeVisible();
    const before = Number(await badge.textContent());

    const tiktokRow = group.getByTestId("publish-row").filter({ hasText: "tiktok" });
    await tiktokRow.getByRole("button", { name: "Copy caption" }).click();
    await expect(tiktokRow.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(caption);

    const linkedinRow = group.getByTestId("publish-row").filter({ hasText: "linkedin" });
    const live = linkedinRow.getByTestId("publish-live-match");
    await expect(live).toContainText(`The live linkedin post ${stamp}`);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    await live.getByRole("button", { name: "That's it" }).click();
    await expect(linkedinRow.getByRole("link", { name: /Published/ })).toHaveAttribute("href", liveLink);
    await expect(group.getByText("1 of 2 left")).toBeVisible();
    await expect(badge).toHaveText(String(before - 1));
  } finally {
    await sql.end();
  }
});
