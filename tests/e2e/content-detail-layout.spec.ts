import { test, expect } from "@playwright/test";

/**
 * Verifies the content-detail metadata card cleanup:
 *  - Title is editable inline at the top (pencil + Input swap, Esc reverts).
 *  - Default rows are Editor / Status / Format only.
 *  - "See more fields" reveals Account / Source type (and Pillar content).
 *  - There is exactly one Title heading on the page (no duplicate from a
 *    stray block left behind during the refactor).
 *
 * Targets the same item the team uses as a fixture — pre-publish IG Reel —
 * but the spec only asserts surface behavior, not data values.
 */

const ITEM_PATH = "/starter-story/content/56e0696b-6342-4a78-ba1b-656ef19af4a2";

test.describe("content detail metadata card", () => {
  test("title appears once with edit affordance", async ({ page }) => {
    await page.goto(ITEM_PATH);
    await expect(page.getByRole("link", { name: /^← content$/i })).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /edit title/i })).toBeAttached();
  });

  test("default rows are Editor / Status / Format only", async ({ page }) => {
    await page.goto(ITEM_PATH);
    const card = page.locator("text=Editor").first().locator("xpath=ancestor::*[contains(@class, 'rounded-lg')][1]");
    await expect(card.getByText("Editor", { exact: true })).toBeVisible();
    await expect(card.getByText("Status", { exact: true })).toBeVisible();
    await expect(card.getByText("Format", { exact: true })).toBeVisible();
    await expect(card.getByText("Account", { exact: true })).toHaveCount(0);
    await expect(card.getByText("Source type", { exact: true })).toHaveCount(0);
    await expect(card.getByText("Pillar content", { exact: true })).toHaveCount(0);
  });

  test("See more fields reveals hidden rows", async ({ page }) => {
    await page.goto(ITEM_PATH);
    const toggle = page.getByRole("button", { name: /see more fields/i });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByText("Account", { exact: true })).toBeVisible();
    await expect(page.getByText("Source type", { exact: true })).toBeVisible();
    await expect(page.getByText("Pillar content", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /hide extra fields/i })).toBeVisible();
  });

  test("pencil swaps heading for input; Esc reverts", async ({ page }) => {
    await page.goto(ITEM_PATH);
    const heading = page.locator("h1");
    const original = (await heading.textContent())?.trim() ?? "";
    await page.getByRole("button", { name: /edit title/i }).click();
    const input = page.getByRole("textbox", { name: /^title$/i });
    await expect(input).toBeFocused();
    await input.fill("___ROLLBACK_PROBE___");
    await input.press("Escape");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("h1")).toHaveText(original);
  });
});
