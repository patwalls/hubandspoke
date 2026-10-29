import { describe, expect, it } from "vitest";
import {
  createTestContentDraft,
  createTestFormat,
  createTestProductionItem,
} from "@/test/factories";
import { loadEditorRewrites } from "./editor-rewrites";

const AI = "draft-algo:v1.7:test:v16";

async function rewrittenItem(opts: {
  format: string;
  status?: string;
  draft: string;
  edited: string;
}) {
  const item = await createTestProductionItem({ format: opts.format, status: opts.status });
  await createTestContentDraft({
    productionItemId: item.id,
    version: 1,
    isCurrent: false,
    generatedBy: AI,
    content: { caption: opts.draft },
  });
  await createTestContentDraft({
    productionItemId: item.id,
    version: 2,
    isCurrent: true,
    generatedBy: "user:edit",
    content: { caption: opts.edited },
  });
  return item;
}

describe("loadEditorRewrites", () => {
  it("pairs the last AI draft with the editor's published version, same brand + format only", async () => {
    const fmt = await createTestFormat();
    const other = await createTestFormat();
    const item = await rewrittenItem({
      format: fmt.name,
      draft: "Ruben, who built X, says:",
      edited: "This dude Ruben who built X says:",
    });
    await rewrittenItem({ format: other.name, draft: "other draft", edited: "other edit" });

    const out = await loadEditorRewrites({
      brand: item.brand,
      format: fmt.name,
      excludeId: "00000000-0000-0000-0000-000000000000",
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      field: "caption",
      draft: "Ruben, who built X, says:",
      edited: "This dude Ruben who built X says:",
    });
  });

  it("skips items that never reached Published, the item being drafted, and saves with no real change", async () => {
    const fmt = await createTestFormat();
    await rewrittenItem({ format: fmt.name, status: "Review", draft: "a", edited: "b" });
    await rewrittenItem({ format: fmt.name, draft: "same text", edited: "same  text " });
    const self = await rewrittenItem({ format: fmt.name, draft: "c", edited: "d" });

    const out = await loadEditorRewrites({ brand: self.brand, format: fmt.name, excludeId: self.id });
    expect(out).toEqual([]);
  });

  it("ignores items whose current draft is still the AI's (nothing was rewritten)", async () => {
    const fmt = await createTestFormat();
    const item = await createTestProductionItem({ format: fmt.name });
    await createTestContentDraft({
      productionItemId: item.id,
      generatedBy: AI,
      content: { caption: "kept as drafted" },
    });
    const out = await loadEditorRewrites({ brand: item.brand, format: fmt.name, excludeId: "00000000-0000-0000-0000-000000000000" });
    expect(out).toEqual([]);
  });
});
