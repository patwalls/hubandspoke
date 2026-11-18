/**
 * clip-trim M1: the clip writer learns from this brand + format's edited
 * clips' cuts against their AI window — not untouched drafts (revision 1),
 * not other formats or brands.
 */
import { describe, expect, it } from "vitest";
import { createDefaultDoc } from "@/lib/clip-editor/doc";
import { createTestClipEdit, createTestClipIdea, createTestProductionItem, createTestTranscript } from "@/test/factories";
import { loadTrimHabits } from "./trim-habits";

const FORMAT = `vitest clip-trim ${Date.now()}`;

async function clipWith(opts: { brand?: string; format?: string; headCutSec: number; tailCutSec?: number; revision: number; transcript?: boolean }) {
  const item = await createTestProductionItem({ brand: opts.brand ?? "starter-story" });
  if (opts.transcript) {
    const words = Array.from({ length: 30 }, (_, i) => ({ word: `w${100 + i * 2}.`, startSec: 100 + i * 2, endSec: 101 + i * 2 }));
    await createTestTranscript({ productionItemId: item.id, segments: [{ startSec: 100, endSec: 160, text: words.map((w) => w.word).join(" ") }], words });
  }
  const idea = await createTestClipIdea({ sourceProductionItemId: item.id, targetFormat: opts.format ?? FORMAT, startSec: 100, endSec: 160 });
  const doc = createDefaultDoc({ startSec: 100, endSec: 160, hook: "h" });
  if (opts.headCutSec > 0) doc.sections.find((s) => s.role === "body")!.removals.push({ startSec: 100, endSec: 100 + opts.headCutSec, reason: "manual" });
  if (opts.tailCutSec) doc.sections.find((s) => s.role === "body")!.removals.push({ startSec: 160 - opts.tailCutSec, endSec: 160, reason: "manual" });
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

  it("withEndings (the writer, clip-trim M3) quotes where the AI ended vs where the editor ended; other callers don't load transcripts", async () => {
    const format = `${FORMAT} endings`;
    for (let i = 0; i < 5; i++) await clipWith({ format, headCutSec: 0, tailCutSec: 10, revision: 2, transcript: i < 3 });
    const plain = await loadTrimHabits({ brand: "starter-story", formatName: format });
    expect(plain?.tailCut).toBe(5);
    expect(plain?.endings).toBeUndefined();
    const withEndings = await loadTrimHabits({ brand: "starter-story", formatName: format, withEndings: true });
    expect(withEndings?.endings).toHaveLength(3); // two sources have no transcript
    expect(withEndings?.endings?.[0]).toMatchObject({ cutSec: 10 });
    expect(withEndings?.endings?.[0].aiEnd.endsWith("w158.")).toBe(true);
    expect(withEndings?.endings?.[0].editorEnd.endsWith("w148.")).toBe(true);
  });
});
