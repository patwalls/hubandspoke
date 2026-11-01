import { test, expect } from "@playwright/test";

// Monthly security hygiene (security FINDINGS S-168 / S-169 / S-171).
test.describe("security hygiene", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("every response carries the browser security headers and no X-Powered-By", async ({ request }) => {
    const res = await request.get("/login");
    const h = res.headers();
    expect(h["strict-transport-security"]).toContain("max-age=31536000");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("an API path ending in .png still needs a session", async ({ request }) => {
    const res = await request.get("/api/production-items/x.png");
    expect(res.status()).toBe(401);
  });

  test("after 10 failed sign-ins the form says to wait instead of 'invalid'", async ({ page }) => {
    const email = `nobody-${Date.now()}@local.test`;
    await page.goto("/login");
    for (let i = 0; i < 10; i++) {
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(`wrong-${i}`);
      await page.getByRole("button", { name: /sign in/i }).click();
      await expect(page.getByText("Invalid email or password")).toBeVisible();
    }
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/Too many sign-in attempts/)).toBeVisible();
  });
});
