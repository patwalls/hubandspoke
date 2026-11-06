/**
 * clip-trim M1: the clip writer learns from this brand + format's edited
 * clips' cuts against their AI window — not untouched drafts (revision 1),
 * not other formats or brands.
 */
import { describe, expect, it } from "vitest";
import { createDefaultDoc } from "@/lib/clip-editor/doc";
import { createTestClipEdit, createTestClipIdea, createTestProductionItem } from "@/test/factories";
import { loadTrimHabits } from "./trim-habits";

const FORMAT = `vitest clip-trim ${Date.now()}`;

async function clipWith(opts: { brand?: string; format?: string; headCutSec: number; revision: number }) {
  const item = await createTestProductionItem({ brand: opts.brand ?? "starter-story" });
  const idea = await createTestClipIdea({ sourceProductionItemId: item.id, targetFormat: opts.format ?? FORMAT, startSec: 100, endSec: 160 });
  const doc = createDefaultDoc({ startSec: 100, endSec: 160, hook: "h" });
  if (opts.headCutSec > 0) doc.sections.find((s) => s.role === "body")!.removals.push({ startSec: 100, endSec: 100 + opts.headCutSec, reason: "manual" });
  await createTestClipEdit({ clipIdeaId: idea.id, revision: opts.revision, doc });
}

describe("loadTrimHabits", () => {
  it("summarizes this brand + format's edited clips against the idea's window", async () => {
    for (const s of [20, 20, 30, 0, 0]) await clipWith({ headCutSec: s, revision: 2 });
    await clipWith({ headCutSec: 40, revision: 1 }); // never saved past the first draft
    await clipWith({ headCutSec: 40, revision: 2, format: `${FORMAT} other` });
    await clipWith({ headCutSec: 40, revision: 2, brand: "futurepedia" });
    expect(await loadTrimHabits({ brand: "starter-story", formatName: FORMAT })).toEqual({
      clips: 5,
      headCut: 3,
      medianHeadSec: 20,
      tailCut: 0,
      medianTailSec: 0,
    });
  });
});
