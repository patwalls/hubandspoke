import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Formats tab → Add format → Instagram → Clip: the dialog only asks for
// name, pillar, account; the format it creates is wired as a clippable
// Reel (clip target + aspect + channel) without the user touching a
// toggle, and the detail page says what to do next.
test("Add format → Instagram clip creates a working Reel format", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const name = `E2E add-format reel ${Date.now()}`;
  try {
    await page.goto("/starter-story/formats");
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByRole("button", { name: "Got it" }).click({ timeout: 5_000 }).catch(() => {});

    await page.getByTestId("add-format").click();
    await page.getByTestId("add-format-instagram").click();
    await expect(page.getByTestId("add-format-type-instagram_clip")).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("add-format-name").fill(name);
    const parent = page.getByTestId("add-format-parent");
    const firstPillar = await parent.locator("option").nth(1).getAttribute("value");
    await parent.selectOption(firstPillar!);
    // Pick the first account unless it's the only one (then it's pre-picked).
    const radios = page.getByTestId("add-format-account").locator("input[type=radio]");
    if ((await radios.count()) > 1) await radios.first().check();
    await page.getByTestId("add-format-create").click();

    await expect(page.getByTestId("format-created-banner")).toBeVisible({ timeout: 15_000 });
    const [row] = await sql`
      SELECT is_clippable_format, clip_target_post_type, clip_aspect_ratio, parent_format_id
      FROM formats WHERE brand = 'starter-story' AND name = ${name}`;
    expect(row.is_clippable_format).toBe(true);
    expect(row.clip_target_post_type).toBe("instagram_reel");
    expect(row.clip_aspect_ratio).toBe("9:16");
    expect(row.parent_format_id).toBe(firstPillar);
  } finally {
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("add-format-draft:")).forEach((k) => localStorage.removeItem(k))).catch(() => {});
    await sql`DELETE FROM formats WHERE brand = 'starter-story' AND name = ${name}`;
    await sql.end();
  }
});
