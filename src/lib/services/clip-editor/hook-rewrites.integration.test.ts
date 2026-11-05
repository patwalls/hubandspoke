/**
 * hooks-learn M1: the hook writer gets the brand + format's edited clips
 * whose shipped words differ from the AI hook — not untouched drafts
 * (revision 1), not other formats, not other brands.
 */
import { describe, expect, it } from "vitest";
import { createDefaultDoc } from "@/lib/clip-editor/doc";
import { createTestClipEdit, createTestClipIdea, createTestProductionItem } from "@/test/factories";
import { loadHookRewrites } from "./hook-rewrites";

const FORMAT = `vitest hooks-learn ${Date.now()}`;
const AI = "A long AI hook sentence that the editor will not keep on screen";

async function clipWith(opts: { brand?: string; format?: string; shipped: string; revision: number }) {
  const item = await createTestProductionItem({ brand: opts.brand ?? "starter-story" });
  const idea = await createTestClipIdea({ sourceProductionItemId: item.id, hook: AI, targetFormat: opts.format ?? FORMAT });
  await createTestClipEdit({ clipIdeaId: idea.id, revision: opts.revision, doc: createDefaultDoc({ startSec: 0, endSec: 30, hook: opts.shipped }) });
}

describe("loadHookRewrites", () => {
  it("pairs the AI hook with what edited clips of this brand + format shipped", async () => {
    await clipWith({ shipped: "We started cold calling ourselves.", revision: 3 });
    await clipWith({ shipped: AI, revision: 2 }); // kept the AI's words
    await clipWith({ shipped: "Never saved past the first draft", revision: 1 });
    await clipWith({ shipped: "Another format's line", revision: 2, format: `${FORMAT} other` });
    await clipWith({ shipped: "Another brand's line", revision: 2, brand: "futurepedia" });
    expect(await loadHookRewrites({ brand: "starter-story", formatName: FORMAT })).toEqual([
      { ai: AI, shipped: "We started cold calling ourselves." },
    ]);
  });
});
