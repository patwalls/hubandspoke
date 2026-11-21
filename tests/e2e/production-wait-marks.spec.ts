import { test, expect } from "@playwright/test";

// In Production records how long someone waited for the list when nothing
// was on screen yet (`production:wait:<bucket>`), and nothing when the tab's
// remembered list shows at once. The production-instant project reads these
// marks; GlitchTip's transaction groups can't say how long people wait now.
test("In Production records the wait for a cold list, not for a remembered one", async ({ page }) => {
  const marks: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/usage")) {
      try {
        const mark = (req.postDataJSON() as { mark?: string }).mark;
        if (mark) marks.push(mark);
      } catch {
        // a route view, not a mark
      }
    }
  });
  const waits = () => marks.filter((m) => m.startsWith("production:wait:"));

  // The report takes ~1.5 s, so the first open lands in the 1-3 s bucket.
  await page.route("**/api/reports/production?**", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  await page.goto("/starter-story/production");
  const popup = page.getByRole("dialog", { name: "What's new" });
  await popup.getByRole("button", { name: "Got it" }).click({ timeout: 15_000 }).catch(() => {});
  await expect(popup).toBeHidden();
  await expect(page.getByText("Loading production pipeline…")).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(waits, { timeout: 10_000 }).toEqual(["production:wait:1-3s"]);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

  // Away and back client-side: the remembered list shows at once — that's
  // `production:list-instant`, not a wait.
  await page.getByRole("link", { name: "Dashboard", exact: true }).first().click();
  await page.waitForURL((url) => !url.pathname.endsWith("/production"));
  await page.goBack();
  await page.waitForURL(/\/starter-story\/production/);
  await expect.poll(() => marks.includes("production:list-instant"), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(2500);
  expect(waits()).toEqual(["production:wait:1-3s"]);
});
