import { describe, it, expect } from "vitest";
import { createTestDesignDoc, createTestFormat, createTestProductionItem } from "@/test/factories";
import { buildPlaybookTemplate } from "@/lib/design-editor/playbook-template";
import type { DesignDoc, DesignTextElement } from "@/lib/design-editor/doc";
import { listSlots } from "@/lib/design-editor/template-fill";
import { loadSlotRewrites, loadTemplateEdits, MAX_REWRITES_PER_SLOT, MIN_DESIGNS } from "./template-edits";

const aiTexts = (d: DesignDoc) =>
  d.pages.flatMap((p) => p.elements).filter((e): e is DesignTextElement => e.type === "text" && e.slot?.kind === "ai");

async function design(format: string, opts: { rewrite: boolean; brief?: boolean; brand?: string }) {
  const doc = buildPlaybookTemplate();
  const values = aiTexts(doc).map((e) => ({ key: e.id, text: e.spans.map((s) => s.text).join("") }));
  if (opts.rewrite) aiTexts(doc)[0].spans = [{ text: "Rewritten by an editor" }];
  const item = await createTestProductionItem({ format, brand: opts.brand ?? "starter-story" });
  await createTestDesignDoc({ productionItemId: item.id, doc, brief: opts.brief === false ? null : { values } });
}

describe("loadTemplateEdits", () => {
  it("rolls up the format's designs of its own brand, skipping forks (no brief)", async () => {
    const fmt = await createTestFormat();
    await design(fmt.name, { rewrite: true });
    await design(fmt.name, { rewrite: true });
    await design(fmt.name, { rewrite: false });
    // A cross-post fork (no brief) and another brand's post never count.
    await design(fmt.name, { rewrite: true, brief: false });
    await design(fmt.name, { rewrite: true, brand: "my-first-million" });
    const out = await loadTemplateEdits("starter-story", fmt.name);
    expect(out?.posts).toBe(3);
    expect(out?.rows[0]).toMatchObject({ text: 2, posts: 3 });
  });

  it("says nothing below MIN_DESIGNS designs", async () => {
    const fmt = await createTestFormat();
    for (let i = 0; i < MIN_DESIGNS - 1; i++) await design(fmt.name, { rewrite: true });
    expect(await loadTemplateEdits("starter-story", fmt.name)).toBeNull();
  });
});

describe("loadSlotRewrites (design-edits M4)", () => {
  const places = listSlots(buildPlaybookTemplate());

  it("returns the format's own (AI → editor) pairs, never the post being filled or another brand's, capped per slot", async () => {
    const fmt = await createTestFormat();
    for (let i = 0; i < MAX_REWRITES_PER_SLOT + 1; i++) await design(fmt.name, { rewrite: true });
    await design(fmt.name, { rewrite: false });
    await design(fmt.name, { rewrite: true, brand: "my-first-million" });
    const self = await createTestProductionItem({ format: fmt.name, brand: "starter-story" });
    const doc = buildPlaybookTemplate();
    const values = aiTexts(doc).map((e) => ({ key: e.id, text: e.spans.map((s) => s.text).join("") }));
    aiTexts(doc)[0].spans = [{ text: "The post being filled" }];
    await createTestDesignDoc({ productionItemId: self.id, doc, brief: { values } });

    const out = await loadSlotRewrites({ brand: "starter-story", formatName: fmt.name, excludeItemId: self.id, places });
    expect(out).toHaveLength(MAX_REWRITES_PER_SLOT);
    expect(out.every((r) => r.edited === "Rewritten by an editor")).toBe(true);
  });

  it("nothing rewritten, nothing to teach", async () => {
    const fmt = await createTestFormat();
    await design(fmt.name, { rewrite: false });
    expect(await loadSlotRewrites({ brand: "starter-story", formatName: fmt.name, excludeItemId: null, places })).toEqual([]);
  });
});
