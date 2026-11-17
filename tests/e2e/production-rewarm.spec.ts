import { test, expect } from "@playwright/test";
import postgres from "postgres";

// After an edit expires the production report, the dyno re-warms In
// Production's key a few seconds later (src/lib/report-rewarm.ts). The list
// must still show the edit — the re-warm can never serve the pre-edit report.

test("In Production shows a post right after it was created, with the re-warm in between", async ({ page }) => {
  test.setTimeout(90_000);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Rewarm ${Date.now()}`;
  const ids: string[] = [];
  try {
    // The warm endpoint stays closed without the secret, scoped or not.
    const closed = await page.request.get("/api/warm?only=production");
    expect(closed.status()).toBe(401);

    await page.goto("/starter-story/production");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});

    const res = await page.request.post("/api/production-items", {
      data: {
        title: `${tag} fresh post`,
        platform: ["linkedin"],
        postType: "linkedin",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    ids.push(id);
    await sql`UPDATE production_items SET status = 'Review' WHERE id = ${id}`;
    // Move it through the app so the report is invalidated (and re-warmed)
    // after the row changed.
    const move = await page.request.put("/api/production-items", {
      data: { id, status: "Ready To Publish" },
    });
    expect(move.ok(), await move.text()).toBeTruthy();
    await page.waitForTimeout(6_000); // past the 4 s re-warm delay

    await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});
    const row = page.locator(`[data-production-row="${id}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });

    await page.goto("/starter-story/production");
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});
    await expect(page.locator(`[data-production-row="${id}"]`)).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // (the shot is taken by the last test)
  } finally {
    if (ids.length) await sql`DELETE FROM production_items WHERE id IN ${sql(ids)}`;
    await sql.end();
  }
});

// Since 2026-11-16 an edit expires only its own brand's report (and /all's),
// not every brand's (src/lib/production-report-tags.ts). The edited brand and
// /all must still show the edit on the very next read — no waiting for the
// re-warm, no 60 s staleness.
test("an edit shows on its brand's report and /all's on the next read, even with both cached", async ({ page }) => {
  test.setTimeout(90_000);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Brand Expiry ${Date.now()}`;
  const ids: string[] = [];
  type Report = { items: { id: string; status: string | null }[] };
  const statusIn = async (brand: string, id: string) => {
    const res = await page.request.get(`/api/reports/production?brand=${brand}&excludeIdea=true`);
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as Report).items.find((i) => i.id === id)?.status ?? null;
  };
  try {
    // The scoped warm stays closed without the secret too.
    const closed = await page.request.get("/api/warm?only=production&brands=starter-story");
    expect(closed.status()).toBe(401);

    const res = await page.request.post("/api/production-items", {
      data: {
        title: `${tag} post`,
        platform: ["linkedin"],
        postType: "linkedin",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    ids.push(id);
    await sql`UPDATE production_items SET status = 'Review' WHERE id = ${id}`;
    // Expire through the app once more (the SQL write above didn't), then
    // cache both reports with the post in Review.
    const touch = await page.request.put("/api/production-items", { data: { id, title: `${tag} post` } });
    expect(touch.ok(), await touch.text()).toBeTruthy();
    expect(await statusIn("starter-story", id)).toBe("Review");
    expect(await statusIn("all", id)).toBe("Review");

    const move = await page.request.put("/api/production-items", {
      data: { id, status: "Ready To Publish" },
    });
    expect(move.ok(), await move.text()).toBeTruthy();
    // Straight away — before the 4 s re-warm.
    expect(await statusIn("starter-story", id)).toBe("Ready To Publish");
    expect(await statusIn("all", id)).toBe("Ready To Publish");

    // And the page people open shows it.
    await page.goto(`/starter-story/production?q=${encodeURIComponent(tag)}`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(page.locator(`[data-production-row="${id}"]`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Ready To Publish").first()).toBeVisible();
  } finally {
    if (ids.length) await sql`DELETE FROM production_items WHERE id IN ${sql(ids)}`;
    await sql.end();
  }
});

// M2: the other write routes (duplicate, cross-post, repost, new post, …)
// also expire only their brand (src/app/api/report-invalidation-brands.test.ts).
// A post they create must still show on its brand's and /all's next read.
test("a duplicated post shows on its brand's report and /all's on the next read", async ({ page }) => {
  test.setTimeout(90_000);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Dup Expiry ${Date.now()}`;
  const ids: string[] = [];
  type Report = { items: { id: string; status: string | null }[] };
  const has = async (brand: string, id: string) => {
    const res = await page.request.get(`/api/reports/production?brand=${brand}`);
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as Report).items.some((i) => i.id === id);
  };
  try {
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `${tag} post`,
        platform: ["linkedin"],
        postType: "linkedin",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    ids.push(id);
    await sql`UPDATE production_items SET status = 'Review' WHERE id = ${id}`;
    const touch = await page.request.put("/api/production-items", { data: { id, title: `${tag} post` } });
    expect(touch.ok(), await touch.text()).toBeTruthy();
    // Cache both reports with the source in them.
    expect(await has("starter-story", id)).toBe(true);
    expect(await has("all", id)).toBe(true);

    const dup = await page.request.post(`/api/production-items/${id}/duplicate`);
    expect(dup.ok(), await dup.text()).toBeTruthy();
    const dupId = (await dup.json()).id as string;
    ids.push(dupId);
    // Straight away — before the 4 s re-warm.
    expect(await has("starter-story", dupId)).toBe(true);
    expect(await has("all", dupId)).toBe(true);

    await page.goto(`/starter-story/production`);
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(page.locator(`[data-production-row="${id}"]`)).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // (the shot is taken by the last test)
  } finally {
    if (ids.length) await sql`DELETE FROM production_items WHERE id IN ${sql(ids)}`;
    await sql.end();
  }
});

// M3 (2026-11-17): the re-warm rebuilds the queue's key (excludeIdea=false)
// too, and the view history / format odds behind both keys are memoized per
// dyno. Neither may hold back an edit: after an edit and the re-warm, the
// queue's key and In Production's both show the new status, and the queue
// page still renders.
test("after an edit and the re-warm, the queue's report and In Production's both show it", async ({ page }) => {
  test.setTimeout(90_000);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const tag = `E2E Queue Rewarm ${Date.now()}`;
  const ids: string[] = [];
  type Report = { items: { id: string; status: string | null }[] };
  const statusIn = async (query: string, id: string) => {
    const res = await page.request.get(`/api/reports/production?brand=starter-story${query}`);
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as Report).items.find((i) => i.id === id)?.status ?? null;
  };
  try {
    const res = await page.request.post("/api/production-items", {
      data: {
        title: `${tag} post`,
        platform: ["linkedin"],
        postType: "linkedin",
        publishedDate: new Date().toISOString().slice(0, 10),
        brand: "starter-story",
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const id = (await res.json()).id as string;
    ids.push(id);
    await sql`UPDATE production_items SET status = 'Review' WHERE id = ${id}`;
    const touch = await page.request.put("/api/production-items", { data: { id, title: `${tag} post` } });
    expect(touch.ok(), await touch.text()).toBeTruthy();
    // Cache both keys with the post in Review.
    expect(await statusIn("", id)).toBe("Review");
    expect(await statusIn("&excludeIdea=true", id)).toBe("Review");

    const move = await page.request.put("/api/production-items", {
      data: { id, status: "Ready To Publish" },
    });
    expect(move.ok(), await move.text()).toBeTruthy();
    await page.waitForTimeout(6_000); // past the 4 s re-warm delay
    expect(await statusIn("", id)).toBe("Ready To Publish");
    expect(await statusIn("&excludeIdea=true", id)).toBe("Ready To Publish");

    await page.goto("/starter-story/queue");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
    await expect(page.getByText("Loading...")).toHaveCount(0, { timeout: 20_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
  } finally {
    if (ids.length) await sql`DELETE FROM production_items WHERE id IN ${sql(ids)}`;
    await sql.end();
  }
});
