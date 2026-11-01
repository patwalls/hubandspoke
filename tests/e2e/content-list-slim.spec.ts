import { test, expect } from "@playwright/test";
import postgres from "postgres";

// content-list-fast M2: each Content list row ships ONE resolved cover
// (`posterUrl`) and none of its sources — no thumbnail, no presigned video
// URL, no S3 keys, no hook. The row still shows its cover image.
test("Content list rows carry one cover and none of its sources", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  const cover =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#6366f1"/></svg>',
    );
  const withCover = `E2E slim cover ${stamp}`;
  const withVideo = `E2E slim video ${stamp}`;
  try {
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO accounts (brand_id, platform, handle)
      SELECT id, 'youtube', ${`e2e_slim_${stamp}`} FROM brands WHERE slug = 'starter-story'
      RETURNING id`;
    await sql`
      INSERT INTO production_items (title, brand, account_id, post_type, status, views, hook,
                                    thumbnail, media_s3_key, media_content_type, published_date, published_at)
      VALUES (${withCover}, 'starter-story', ${account.id}, 'youtube_shorts', 'Published', 1200, 'A hook',
              ${cover}, NULL, NULL, current_date - 2, now() - interval '2 days'),
             (${withVideo}, 'starter-story', ${account.id}, 'youtube_shorts', 'Published', 900, 'Another hook',
              ${cover}, ${`e2e/${stamp}.mp4`}, 'video/mp4', current_date - 1, now() - interval '1 day')`;

    // A range only this run asks for: the report is cached per params
    // (unstable_cache, which next dev keeps on disk between runs and serves
    // stale once), and the boot warmer fills the default range early.
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const start = day(-17);
    const end = day(1 + (stamp % 600));
    const reportPromise = page.waitForResponse(
      (r) => r.url().includes("/api/reports/content?") && r.url().includes(`endDate=${end}`),
    );
    await page.goto(`/starter-story/content?startDate=${start}&endDate=${end}`);
    const report = await (await reportPromise).json();
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});

    const rows = (report.items as Record<string, unknown>[]).filter((it) =>
      String(it.title).includes(String(stamp)),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.posterUrl).toBe(cover);
      for (const k of ["thumbnail", "mediaUrl", "mediaS3Key", "posterS3Key", "hook"]) {
        expect(row).not.toHaveProperty(k);
      }
    }

    const coverRow = page.locator("tr", { hasText: withCover });
    await expect(coverRow).toBeVisible({ timeout: 15_000 });
    await expect(coverRow.locator("img")).toHaveAttribute("src", cover);

    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    await sql`DELETE FROM production_items WHERE title LIKE ${`E2E slim % ${stamp}`}`;
    await sql`DELETE FROM accounts WHERE handle = ${`e2e_slim_${stamp}`}`;
    await sql.end();
  }
});
