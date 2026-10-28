import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Answering a post in Review from the morning email (idea c3c5fb): the email
// preview carries Approve / Already posted / Not this one links, each opens
// /my-work/answer/[id] with that answer picked, and one tap saves it. A post
// sent to review by someone else is seeded, plus approval history so it's on
// my To review.
test("answer posts in Review from the morning email's links", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const stamp = Date.now();
  try {
    const session = await (await page.request.get("/api/auth/session")).json();
    const me = session?.user?.id;
    expect(me).toBeTruthy();
    const [sender] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name) VALUES (${`e2e-answer-${stamp}@local.test`}, 'Evgeny Sender')
      RETURNING id`;
    const create = async (title: string, status: string) => {
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
      await sql`UPDATE production_items SET status = ${status} WHERE id = ${id}`;
      return id;
    };
    const sentToReview = async (id: string) =>
      sql`
        INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
        VALUES (${id}, ${sender.id}, 'status_change',
          ${sql.json({ type: "status_change", from: "Assigned", to: "Review" })}, now() - interval '9 days')`;

    const approve = `E2E answer approve ${stamp}`;
    const posted = `E2E answer posted ${stamp}`;
    const pass = `E2E answer pass ${stamp}`;
    const approveId = await create(approve, "Review");
    const postedId = await create(posted, "Review");
    const passId = await create(pass, "Review");
    for (const id of [approveId, postedId, passId]) await sentToReview(id);
    const pastId = await create(`E2E answer past ${stamp}`, "Published");
    await sql`
      INSERT INTO content_events (content_item_id, user_id, event_type, payload, created_at)
      VALUES (${pastId}, ${me}, 'status_change',
        ${sql.json({ type: "status_change", from: "Review", to: "Ready To Publish" })}, now() - interval '7 days')`;

    // The email preview carries the answer links and the wait.
    await page.goto("/my-work/email");
    const preview = page.locator("[data-digest-preview]");
    await expect(preview).toContainText(/to review \(oldest \d+ days\)/);
    // The email lists five, and other specs' leftovers can fill them, so any
    // To review line will do: it carries all three answers. (Which rows and
    // links: digest.test.ts.)
    const first = await preview.locator('a[href*="/my-work/answer/"]').first().getAttribute("href");
    const firstId = first!.split("/my-work/answer/")[1].split("?")[0];
    await expect(preview.locator(`a[href$="/my-work/answer/${firstId}?a=approve"]`)).toHaveText("Approve");
    await expect(preview.locator(`a[href$="/my-work/answer/${firstId}?a=posted"]`)).toHaveText("Already posted");
    await expect(preview.locator(`a[href$="/my-work/answer/${firstId}?a=pass"]`)).toHaveText("Not this one");

    const dismissWhatsNew = async () => {
      const popup = page.getByRole("dialog", { name: "What's new" });
      await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});
    };

    // Approve: opening the link changes nothing until the tap; then it goes
    // back to whoever sent it.
    await page.goto(`/my-work/answer/${approveId}?a=approve`);
    await dismissWhatsNew();
    await expect(page.getByText("waiting 9 days")).toBeVisible();
    await expect(page.getByRole("radio", { name: "Approve" })).toHaveAttribute("aria-checked", "true");
    const [untouched] = await sql<{ status: string }[]>`SELECT status FROM production_items WHERE id = ${approveId}`;
    expect(untouched.status).toBe("Review");
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
    await page.getByRole("button", { name: "Approve → Evgeny" }).click();
    await expect(page.locator("[data-answer-done]")).toContainText("Ready To Publish · back to Evgeny");

    // Already posted, with the link.
    await page.goto(`/my-work/answer/${postedId}?a=posted`);
    await dismissWhatsNew();
    await page.getByRole("textbox", { name: "Link to the post" }).fill("https://www.tiktok.com/@starterstory/video/7700000000000000001");
    await page.getByRole("button", { name: "Mark posted" }).click();
    await expect(page.locator("[data-answer-done]")).toContainText("Published");

    // Not this one, with the reason (the kill rule needs one).
    await page.goto(`/my-work/answer/${passId}?a=pass`);
    await dismissWhatsNew();
    await page.getByRole("textbox", { name: "Why not" }).fill("Off-brand for us");
    await page.getByRole("button", { name: "Don't post it" }).click();
    await expect(page.locator("[data-answer-done]")).toContainText("Killed");

    const rows = await sql<{ id: string; status: string; editor: string | null; link: string | null }[]>`
      SELECT id, status, editor_user_id AS editor, published_link AS link
        FROM production_items WHERE id IN (${approveId}, ${postedId}, ${passId})`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[approveId]).toMatchObject({ status: "Ready To Publish", editor: sender.id });
    expect(byId[postedId]).toMatchObject({ status: "Published" });
    expect(byId[postedId].link).toContain("tiktok.com");
    expect(byId[passId]).toMatchObject({ status: "Killed" });
    const [killed] = await sql<{ reason: string }[]>`
      SELECT payload->>'reason' AS reason FROM content_events
       WHERE content_item_id = ${passId} AND event_type = 'killed' ORDER BY created_at DESC LIMIT 1`;
    expect(killed.reason).toBe("Off-brand for us");

    // A stale link (already answered) says so instead of offering the buttons.
    await page.goto(`/my-work/answer/${approveId}?a=approve`);
    await expect(page.locator("[data-answer-closed]")).toContainText("Ready To Publish");
  } finally {
    // Leftover Review posts would crowd other specs' morning-email top five.
    await sql`UPDATE production_items SET deleted_at = now() WHERE title LIKE ${`E2E answer % ${stamp}`}`;
    await sql.end();
  }
});

// Logged out, the email link goes through the login and lands back on the
// answer page, not on the home page.
test.describe("logged out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("an email link survives the login", async ({ page }) => {
    const target = "/my-work/email?from=email";
    await page.goto(target);
    await expect(page).toHaveURL(/\/login\?next=%2Fmy-work%2Femail%3Ffrom%3Demail$/);
    await page.waitForLoadState("networkidle");
    await page.getByLabel(/email/i).fill(process.env.E2E_TEST_USER_EMAIL!);
    await page.getByLabel(/password/i).fill(process.env.E2E_TEST_USER_PASSWORD!);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(new RegExp(`${target.replace("?", "\\?")}$`), { timeout: 15_000 });
  });
});
