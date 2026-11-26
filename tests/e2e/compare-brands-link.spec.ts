import { test, expect, type Page } from "@playwright/test";

// brands-at-a-glance M2: a brand dashboard offers "Compare every brand's week"
// only once this browser has opened 3+ different brand dashboards inside an
// hour; the link opens /all with "Brands this week" already expanded. The e2e
// DB has one brand, so the two earlier brand opens are seeded into the same
// localStorage list the dashboard keeps.

async function dismissWhatsNew(page: Page) {
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
}

test("a single brand dashboard stays as it was — no compare link", async ({ page }) => {
  await page.goto("/starter-story");
  await page.waitForLoadState("networkidle");
  await dismissWhatsNew(page);
  await expect(page.getByRole("heading", { name: "Content Command Center" })).toBeVisible();
  await expect(page.getByTestId("compare-brands-link")).toHaveCount(0);
});

test("the third brand dashboard in an hour offers /all, opened", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("e2e-seeded")) return;
    sessionStorage.setItem("e2e-seeded", "1");
    const now = Date.now();
    localStorage.setItem(
      "hs:brand-visits",
      JSON.stringify([
        { slug: "matg", at: now - 4 * 60 * 1000 },
        { slug: "futurepedia", at: now - 2 * 60 * 1000 },
      ]),
    );
    localStorage.setItem("hs:brand-pace-open", "0");
  });
  const marks: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/usage") && r.method() === "POST") {
      const m = (r.postDataJSON() as { mark?: string } | null)?.mark;
      if (m) marks.push(m);
    }
  });

  await page.goto("/starter-story");
  await page.waitForLoadState("networkidle");
  await dismissWhatsNew(page);
  const link = page.getByTestId("compare-brands-link");
  await expect(link).toBeVisible();
  await expect(link).toHaveText(/Compare every brand.s week/);
  await expect.poll(() => marks).toContain("dashboard:compare-brands:shown");
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

  await link.click();
  await expect(page).toHaveURL(/\/all$/);
  await expect.poll(() => marks).toContain("dashboard:compare-brands:open");
  await expect(page.getByTestId("brand-pace-strip")).toBeVisible();
  await expect(page.getByTestId("brand-pace-row").first()).toBeVisible();
  // /all is where the link leads — it never shows the link itself.
  await expect(page.getByTestId("compare-brands-link")).toHaveCount(0);
});
