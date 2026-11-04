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

type El = { id: string; type: string; name?: string; slot?: { kind: string } | null; spans?: { text: string }[]; style?: { sizePx: number }; y: number };
type Doc = { pages: { elements: El[] }[] };

// design-edits M2: the format page's design template says, in one quiet
// line, which AI-filled element editors keep changing, and opens to one row
// per element. Designs are seeded straight into design_docs — drafting needs
// an LLM key the e2e box doesn't have.
test("format page says what editors change in the design template", async ({ page }) => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const name = `E2E Design Edits ${Date.now()}`;
    const [format] = await sql`
      INSERT INTO formats (name, brand, instructions) VALUES (${name}, 'starter-story', 'plain') RETURNING id`;
    const created = await page.request.post(`/api/formats/${format.id}/design-template`, { data: { preset: "tmz" } });
    expect(created.ok()).toBeTruthy();
    const { template } = (await (await page.request.get(`/api/formats/${format.id}/design-template`)).json()) as { template: { doc: Doc } };
    const aiText = (d: Doc) => d.pages.flatMap((p) => p.elements).filter((e) => e.slot?.kind === "ai" && Array.isArray(e.spans));
    expect(aiText(template.doc).length).toBeGreaterThan(0);

    // Four designs: the AI's words in every slot; editors rewrote the first
    // AI text element on three of them. The last one kept its draft and was
    // also made smaller (a look change only a kept draft can show).
    for (let i = 0; i < 4; i++) {
      const draft = structuredClone(template.doc);
      const values = aiText(draft).map((e, j) => {
        const text = `AI words ${i}.${j}`;
        e.spans = [{ text }];
        return { key: e.id, text };
      });
      const final = structuredClone(draft);
      if (i < 3) aiText(final)[0].spans = [{ text: `Editor words ${i}` }];
      if (i === 3) {
        const el = aiText(final)[0];
        if (el.style) el.style.sizePx -= 8;
        el.y += 40;
      }
      const [item] = await sql`
        INSERT INTO production_items (title, brand, format, status)
        VALUES (${`${name} post ${i}`}, 'starter-story', ${name}, 'Assigned') RETURNING id`;
      await sql`
        INSERT INTO design_docs (production_item_id, doc, generated_doc, brief)
        VALUES (${item.id}, ${sql.json(final)}, ${i === 3 ? sql.json(draft) : null}, ${sql.json({ values })})`;
    }
    const headline = aiText(template.doc)[0].name || "text";

    await page.goto(`/starter-story/formats/${format.id}`);
    await dismissWhatsNew(page);
    const line = page.getByTestId("design-template-edits");
    await expect(line).toBeVisible();
    await expect(line).toContainText(`Editors change: ${headline} words rewritten on 3 of 4 posts`);
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

    await line.getByRole("button").click();
    await expect(line.getByRole("listitem").first()).toContainText(`${headline}: words rewritten on 3 of 4 · moved on 1 of 1`);
    await expect(line.getByRole("listitem").first()).toContainText("restyled on 1 of 1");

    // The open/closed choice is remembered in this browser.
    await page.reload();
    await expect(page.getByTestId("design-template-edits").getByRole("listitem").first()).toBeVisible();
  } finally {
    await sql.end();
  }
});
