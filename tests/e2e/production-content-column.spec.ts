import { test, expect } from "@playwright/test";

/**
 * Regression: the production pipeline table is `table-fixed` with fixed widths
 * on every column except "Content" (160+240+220+100+90 = 810px fixed). At
 * narrow viewports the only flexible column — Content — collapsed to width:0
 * and its contents (a non-shrinkable SourceBadge + title) spilled over the
 * adjacent Format column, rendering as overlapping/garbled text.
 *
 * The fix gives the table a `min-w` floor so Content keeps a usable width and
 * the wrapper's `overflow-x-auto` scrolls horizontally instead of collapsing.
 * This guards against the column collapsing again.
 */
test("Content column does not collapse / overlap at a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/starter-story/production", { waitUntil: "networkidle" });
  await page.waitForSelector("table tbody tr", { timeout: 30_000 });

  const metrics = await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return null;
    const headers = Array.from(table.querySelectorAll("thead th"));
    const contentIdx = headers.findIndex(
      (th) => (th.textContent || "").trim().toLowerCase().startsWith("content"),
    );
    if (contentIdx < 0) return null;
    const firstRow = table.querySelector("tbody tr");
    const cell = firstRow?.querySelectorAll("td")[contentIdx] as
      | HTMLElement
      | undefined;
    if (!cell) return null;
    const inner = cell.querySelector("div") as HTMLElement | null;
    return {
      cellWidth: cell.getBoundingClientRect().width,
      innerScrollW: inner?.scrollWidth ?? 0,
      innerClientW: inner?.clientWidth ?? 0,
    };
  });

  expect(metrics, "production table with rows should be present").not.toBeNull();
  // Column must not collapse — needs room for the source badge + a title.
  expect(metrics!.cellWidth).toBeGreaterThan(150);
  // Inner content must fit within the cell (truncates) rather than overflow
  // into the neighbouring column. Allow a 2px rounding tolerance.
  expect(metrics!.innerScrollW).toBeLessThanOrEqual(metrics!.innerClientW + 2);
});
