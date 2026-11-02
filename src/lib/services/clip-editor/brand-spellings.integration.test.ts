/**
 * fix-names-once M3: a name fixed in clips of two different videos of a brand
 * is learned as the brand's spelling, read against each video's OWN
 * transcript; one video's fix alone is not.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDefaultDoc } from "@/lib/clip-editor/doc";
import {
  createTestClipEdit,
  createTestClipIdea,
  createTestProductionItem,
  createTestTranscript,
} from "@/test/factories";
import { clearBrandSpellingsCache, loadBrandSpellings } from "./brand-spellings";

const docWith = (wordEdits: Record<string, string>) => ({
  ...createDefaultDoc({ startSec: 0, endSec: 30, hook: "vitest" }),
  wordEdits,
});

// A video whose transcript says `texts`, one word per second.
async function video(texts: string[]) {
  const item = await createTestProductionItem({ brand: "starter-story" });
  await createTestTranscript({
    productionItemId: item.id,
    segments: [{ startSec: 0, endSec: texts.length, text: texts.join(" ") }],
    words: texts.map((word, i) => ({ word, startSec: i, endSec: i + 0.8 })),
  });
  return item;
}

describe("loadBrandSpellings", () => {
  beforeEach(() => clearBrandSpellingsCache());

  it("learns a name fixed in two videos of the brand, not one fixed in a single video", async () => {
    // The made-up word sits at a different time in each video: matching is by
    // what each video's own transcript says there.
    const a = await video(["we", "use", "zorbleq", "daily"]);
    const b = await video(["zorbleq", "is", "how", "we", "quuxly", "ship"]);
    const ideaA = await createTestClipIdea({ sourceProductionItemId: a.id });
    const ideaB = await createTestClipIdea({ sourceProductionItemId: b.id });
    await createTestClipEdit({ clipIdeaId: ideaA.id, doc: docWith({ "2000": "Zorblek" }) });
    await createTestClipEdit({ clipIdeaId: ideaB.id, doc: docWith({ "0": "Zorblek", "4000": "Quuxlee" }) });

    const spellings = await loadBrandSpellings("starter-story");
    expect(spellings).toContainEqual({ said: "zorbleq", replacement: "Zorblek", videos: 2 });
    expect(spellings.find((s) => s.said === "quuxly")).toBeUndefined();
  });
});
