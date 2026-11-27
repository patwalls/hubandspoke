import { test, expect } from "@playwright/test";
import postgres from "postgres";
import type { Page } from "@playwright/test";

async function dismissWhatsNew(page: Page) {
  await page.waitForLoadState("networkidle");
  const popup = page.getByRole("dialog", { name: "What's new" });
  if (await popup.isVisible()) {
    await popup.getByRole("button", { name: "Got it" }).click();
    await expect(popup).toBeHidden();
  }
}

type Span = { text: string; bold?: boolean; color?: string };
type El = { id: string; type: string; name?: string; slot?: { kind: string } | null; spans?: Span[] };
type Doc = { pages: { elements: El[] }[] };

test.use({ viewport: { width: 1600, height: 1000 } });

// designs-right-first-export M2: editors bolded the DM keyword by hand on
// nearly every CTA they exported. A keyword attached to the post now fills
// the CTA bold, quotes and all. The design is seeded straight into
// design_docs (drafting needs an LLM key the e2e box doesn't have) with the
// CTA page only; opening the editor fills the attached keyword.
test("the DM keyword in a design's CTA comes out bold", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const name = `E2E CTA Bold ${Date.now()}`;
    const [format] = await sql`
      INSERT INTO formats (name, brand, instructions) VALUES (${name}, 'starter-story', 'plain') RETURNING id`;
    const created = await page.request.post(`/api/formats/${format.id}/design-template`, { data: { preset: "playbook" } });
    expect(created.ok()).toBeTruthy();
    const { template } = (await (await page.request.get(`/api/formats/${format.id}/design-template`)).json()) as { template: { doc: Doc } };
    const ctaPage = template.doc.pages.find((p) => p.elements.some((e) => e.slot?.kind === "dmKeyword"));
    expect(ctaPage).toBeTruthy();
    const doc = { ...template.doc, pages: [ctaPage!] };

    const [item] = await sql`
      INSERT INTO production_items (title, brand, format, status, short_link_slug)
      VALUES (${`${name} post`}, 'starter-story', ${name}, 'Assigned', 'bootstrap') RETURNING id`;
    await sql`INSERT INTO design_docs (production_item_id, doc) VALUES (${item.id}, ${sql.json(doc)})`;

    await page.goto(`/starter-story/queue/repurposed?item=${item.id}`);
    await dismissWhatsNew(page);
    const stage = page.locator(".shadow-xl.ring-1").first();
    const word = stage.getByText('"BOOTSTRAP"', { exact: true });
    await expect(word).toBeVisible({ timeout: 30_000 });
    const weight = async (l: ReturnType<Page["locator"]>) => Number(await l.evaluate((n) => getComputedStyle(n).fontWeight));
    const plain = stage.getByText("comment", { exact: true });
    expect(await weight(word)).toBeGreaterThan(await weight(plain));

    const [saved] = await sql`SELECT doc FROM design_docs WHERE production_item_id = ${item.id}`;
    const cta = (saved.doc as Doc).pages.flatMap((p) => p.elements).find((e) => e.slot?.kind === "dmKeyword")!;
    expect(cta.spans).toContainEqual({ text: '"BOOTSTRAP"', bold: true });
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT });
  } finally {
    await sql.end();
  }
});
