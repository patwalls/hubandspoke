/**
 * Fix a name once per video: the sibling docs a new clip edit carries its
 * spelling fixes from are the OTHER clips cut from the same source, newest
 * last — never this clip, never another video's clips.
 */
import { describe, it, expect } from "vitest";
import { createDefaultDoc } from "@/lib/clip-editor/doc";
import { createTestClipEdit, createTestClipIdea, createTestProductionItem } from "@/test/factories";
import { loadSiblingDocs } from "./session";

const docWith = (wordEdits: Record<string, string>) => ({
  ...createDefaultDoc({ startSec: 0, endSec: 30, hook: "vitest" }),
  wordEdits,
});

describe("loadSiblingDocs", () => {
  it("returns the other clips of this source only, oldest edit first", async () => {
    const source = await createTestProductionItem({});
    const other = await createTestProductionItem({});
    const self = await createTestClipIdea({ sourceProductionItemId: source.id });
    const first = await createTestClipIdea({ sourceProductionItemId: source.id });
    const second = await createTestClipIdea({ sourceProductionItemId: source.id });
    const elsewhere = await createTestClipIdea({ sourceProductionItemId: other.id });

    await createTestClipEdit({ clipIdeaId: self.id, doc: docWith({ "1000": "Self" }) });
    await createTestClipEdit({ clipIdeaId: first.id, doc: docWith({ "1000": "Rourk" }) });
    await createTestClipEdit({ clipIdeaId: second.id, doc: docWith({ "1000": "Rork" }) });
    await createTestClipEdit({ clipIdeaId: elsewhere.id, doc: docWith({ "1000": "Other" }) });

    const docs = await loadSiblingDocs(source.id, self.id);
    expect(docs.map((d) => d.wordEdits["1000"])).toEqual(["Rourk", "Rork"]);
  });
});
