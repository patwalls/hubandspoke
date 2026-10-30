import { describe, expect, it } from "vitest";
import {
  learnedFromEdits,
  pickRewrite,
  renderEditorRewrites,
  rewriteOrigin,
} from "./editor-rewrites";

describe("pickRewrite", () => {
  it("returns the body field the editor rewrote", () => {
    const out = pickRewrite(
      { caption: "Bro's Excel website made $30K.", cta: "Link below" },
      { caption: "Bro's website made $30K.", cta: "Link below" },
    );
    expect(out).toEqual({
      field: "caption",
      draft: "Bro's Excel website made $30K.",
      edited: "Bro's website made $30K.",
    });
  });

  it("ignores a save that only changed whitespace — not an editorial change", () => {
    expect(
      pickRewrite({ caption: "Line one.\n\nLine two." }, { caption: "Line one.\nLine two.  " }),
    ).toBeNull();
  });

  it("ignores an edit that only touched the CTA (not a body field)", () => {
    expect(
      pickRewrite({ tweet: "Same tweet", cta: "old" }, { tweet: "Same tweet", cta: "new" }),
    ).toBeNull();
  });

  it("skips an unchanged caption and picks the changed tweet", () => {
    const out = pickRewrite({ caption: "a", tweet: "draft tweet" }, { caption: "a", tweet: "edited tweet" });
    expect(out?.field).toBe("tweet");
  });

  it("skips fields missing on either side (an emptied field isn't a rewrite to learn from)", () => {
    expect(pickRewrite({ caption: "draft" }, { caption: "" })).toBeNull();
    expect(pickRewrite(null, { caption: "x" })).toBeNull();
  });

  it("clips very long bodies so a slideshow doesn't flood the prompt", () => {
    const out = pickRewrite({ body: "a".repeat(5000) }, { body: "b".repeat(5000) });
    expect(out!.draft.length).toBeLessThanOrEqual(1201);
    expect(out!.draft.endsWith("…")).toBe(true);
  });
});

describe("rewriteOrigin", () => {
  it("an AI draft and a copied source caption both teach; a human save or CTA regen doesn't", () => {
    expect(rewriteOrigin("draft-algo:v1.7:claude-opus-5-5:v16", { caption: "x" })).toBe("ai");
    expect(rewriteOrigin("copy:source", { caption: "He built 4 apps." })).toBe("copy");
    expect(rewriteOrigin("copy:source:reseed", { caption: "He built 4 apps." })).toBe("copy");
    expect(rewriteOrigin("user:edit", { caption: "x" })).toBeNull();
    expect(rewriteOrigin("regen-cta", { body: "x", cta: "y" })).toBeNull();
    expect(rewriteOrigin(null, { caption: "x" })).toBeNull();
  });

  it("skips a copy that was the clip-idea notes block — editors replaced it, not edited it", () => {
    const notes = "Source: How to Earn Respect in Sales\nTimestamp: 02:46–03:15 (29s)\n\nAngle: …";
    expect(rewriteOrigin("copy:source", { caption: notes })).toBeNull();
  });
});

describe("renderEditorRewrites", () => {
  it("returns null with no pairs (caller omits the block)", () => {
    expect(renderEditorRewrites([], "X Quotables")).toBeNull();
  });

  it("shows each pair as DRAFT then EDITOR PUBLISHED, with format in the header", () => {
    const out = renderEditorRewrites(
      [
        { field: "tweet", draft: "Ruben says:", edited: "This dude Ruben says:", editedAt: "2026-10-28" },
        { field: "caption", draft: "d2", edited: "e2", editedAt: null },
      ],
      "X Quotables",
    )!;
    expect(out).toContain("## WHAT EDITORS CHANGED");
    expect(out).toContain('"X Quotables"');
    expect(out).toContain("--- rewrite 1 (2026-10-28), field: tweet ---");
    expect(out).toContain("DRAFT:\nRuben says:\n\nEDITOR PUBLISHED:\nThis dude Ruben says:");
    expect(out).toContain("--- rewrite 2, field: caption ---");
  });

  it("labels a cross-post's starting text as a copied caption, not the agent's draft", () => {
    const out = renderEditorRewrites(
      [
        { field: "caption", origin: "copy", draft: "He doesn't chase ideas.", edited: "Will doesn't chase ideas.", editedAt: null },
        { field: "caption", origin: "ai", draft: "d", edited: "e", editedAt: null },
      ],
      "Repackage Section w/ Hook",
    )!;
    expect(out).toContain("COPIED CAPTION:\nHe doesn't chase ideas.\n\nEDITOR PUBLISHED:\nWill doesn't chase ideas.");
    expect(out).toContain("--- rewrite 2, field: caption ---\nDRAFT:\nd");
  });

  it("tells the agent to copy the kind of change, not the topics", () => {
    const out = renderEditorRewrites([{ field: "caption", draft: "a", edited: "b", editedAt: null }], null)!;
    expect(out).toContain("only the kind of change");
  });
});

describe("learnedFromEdits", () => {
  it("is true only for Draft Algorithm runs at v16 or later", () => {
    expect(learnedFromEdits("draft-algo:v1.7:claude-opus-5-5:v16")).toBe(true);
    expect(learnedFromEdits("draft-algo:v1.7:claude-opus-5-5:v17")).toBe(true);
    expect(learnedFromEdits("draft-algo:v1.7:claude-opus-5-5:v15")).toBe(false);
    // the algo version (v1.7) is not the prompt version
    expect(learnedFromEdits("draft-algo:v1.7")).toBe(false);
    expect(learnedFromEdits("regen-cta:v2:claude-opus-5-5")).toBe(false);
    expect(learnedFromEdits("copy:source")).toBe(false);
    expect(learnedFromEdits("user:edit")).toBe(false);
    expect(learnedFromEdits(null)).toBe(false);
  });
});
