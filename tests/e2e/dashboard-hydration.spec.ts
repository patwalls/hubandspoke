import { test, expect } from "@playwright/test";

/**
 * The dashboards must hydrate cleanly when the browser's date differs from
 * the server's. Prod renders in UTC; at 9pm Pacific it's already tomorrow
 * there, and a "today" computed in render made React throw #418 on /:brand
 * (GlitchTip HUBANDSPOKE-5, 2026-11-06). Run the dev server with TZ=UTC to
 * match prod; the browser takes whichever far-off timezone is on a different
 * calendar day from UTC right now (+14 or -11 between them cover every hour).
 */
const utcHour = new Date().getUTCHours();
const timezoneId = utcHour >= 10 ? "Pacific/Kiritimati" : "Pacific/Pago_Pago";

test.use({ timezoneId, locale: "de-DE" });

const pages: Array<{ path: string; ready?: string }> = [
  { path: "/matg", ready: "Date range" },
  { path: "/starter-story", ready: "Date range" },
  { path: "/starter-story/content", ready: "Date range" },
  // Timestamps from server props, formatted in render (HUBANDSPOKE-6).
  { path: "/starter-story/accounts" },
  { path: "/starter-story/accounts/brand-assets" },
  { path: "/starter-story/scheduled" },
  { path: "/settings/links" },
  { path: "/settings/sync-errors" },
  // The All tab paints its rows from server props (HUBANDSPOKE-8).
  { path: "/starter-story/queue", ready: "Queue" },
  { path: "/all/queue", ready: "Queue" },
];

for (const { path, ready } of pages) {
  test(`${path} hydrates without a mismatch in ${timezoneId}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(path);
    await expect(page).not.toHaveURL(/\/login/);
    if (ready) await expect(page.getByText(ready).first()).toBeVisible();
    // Give the post-hydration re-render a beat to surface any recoverable error.
    await page.waitForTimeout(1500);

    expect(errors.filter((e) => /hydrat|#418|did not match/i.test(e))).toEqual([]);
  });
}

/**
 * Hydrating a day after the server rendered (GlitchTip issue 78,
 * /:brand/content, 2026-11-17): a background tab Chrome froze before React
 * hydrated woke up the next day. The browser's clock is set a day ahead of
 * the server's here; a range the server labels "Today" must still hydrate as
 * "Today", because useToday() hydrates from the server's date, not the clock.
 */
test.describe("hydrating a day after the server render", () => {
  test.use({ timezoneId: "America/Chicago", locale: "en-US" });

  for (const path of ["/starter-story", "/starter-story/content", "/matg"]) {
    test(`${path} with a server-side "Today" range`, async ({ page }) => {
      const now = new Date();
      const serverToday = now.toISOString().slice(0, 10);
      const tomorrow = new Date(Date.parse(serverToday) + 86_400_000).toISOString().slice(0, 10);
      await page.clock.setFixedTime(now.getTime() + 26 * 3_600_000);

      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      page.on("pageerror", (err) => errors.push(err.message));

      await page.goto(`${path}?startDate=${serverToday}&endDate=${tomorrow}`);
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.getByText("Date range").first()).toBeVisible();
      await page.waitForTimeout(1500);

      expect(errors.filter((e) => /hydrat|#418|did not match/i.test(e))).toEqual([]);
    });
  }
});
