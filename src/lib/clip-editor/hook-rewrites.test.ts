import { describe, expect, it } from "vitest";
import { createDefaultDoc, createTextLayer, type ClipEditDoc, type TextLayer } from "./doc";
import { collectHookRewrites, hookKey, hookRewrite, hookRewritesBlock, shippedHookLine } from "./hook-rewrites";

const AI = "Instead of building, he spent 60 to 70 percent of his week on the sales floor watching his team";
const clip = (hook = AI): ClipEditDoc => structuredClone(createDefaultDoc({ startSec: 0, endSec: 30, hook }));
const hookOf = (d: ClipEditDoc) => d.layers.find((l): l is TextLayer => l.type === "text" && l.role === "hook")!;
const withOwnText = (d: ClipEditDoc, text: string, yPct?: number) => {
  const l = createTextLayer({ text, canvas: d.canvas });
  if (yPct != null) l.yPct = yPct;
  d.layers.push(l);
  return d;
};

describe("hookRewrite (what the editor shipped instead of the AI hook)", () => {
  it("an untouched clip, or one where the editor only tidied emoji, spaces and punctuation, is not a rewrite", () => {
    expect(hookRewrite(AI, clip())).toBeNull();
    const tidied = clip("Bro built an app that won't let you fake your workouts...🤯");
    hookOf(tidied).text = "Bro built an app that won't let you fake your workouts ";
    expect(hookRewrite("Bro built an app that won't let you fake your workouts...🤯", tidied)).toBeNull();
  });

  it("a hook cut down in place is a rewrite", () => {
    const d = clip("Four AI models, one ad, one clear winner. Here's which one gets the tiny label text right.");
    hookOf(d).text = "Four AI models, one ad, one clear winner.";
    expect(hookRewrite("Four AI models, one ad, one clear winner. Here's which one gets the tiny label text right.", d)).toEqual({
      ai: "Four AI models, one ad, one clear winner. Here's which one gets the tiny label text right.",
      shipped: "Four AI models, one ad, one clear winner.",
    });
  });

  it("hook hidden + own text: the editor's lines are what shipped, top to bottom, each once", () => {
    const d = clip();
    hookOf(d).visible = false;
    withOwnText(d, "comment 'atlas' for the list", 80);
    withOwnText(d, "We started cold calling ourselves.", 10);
    withOwnText(d, "We started cold calling ourselves.", 12); // a duplicate box
    expect(shippedHookLine(d)).toBe("We started cold calling ourselves. / comment 'atlas' for the list");
    expect(hookRewrite(AI, d)?.shipped).toBe("We started cold calling ourselves. / comment 'atlas' for the list");
  });

  it("hook hidden with no words on screen teaches nothing; no AI hook teaches nothing", () => {
    const d = clip();
    hookOf(d).visible = false;
    expect(hookRewrite(AI, d)).toBeNull();
    const e = withOwnText(clip(), "Some line");
    expect(hookRewrite(null, e)).toBeNull();
  });
});

describe("collectHookRewrites + hookRewritesBlock", () => {
  it("keeps one pair per shipped line, newest first, capped", () => {
    const rows = ["Line one", "line one!", "Line two", "Line three"].map((t) => {
      const d = clip();
      hookOf(d).text = t;
      return { aiHook: AI, doc: d };
    });
    expect(collectHookRewrites(rows, 2).map((p) => p.shipped)).toEqual(["Line one", "Line two"]);
  });

  it("no pairs → no block; pairs → both sides quoted", () => {
    expect(hookRewritesBlock([])).toBeNull();
    const b = hookRewritesBlock([{ ai: AI, shipped: "We started cold calling ourselves." }])!;
    expect(b).toContain(`AI wrote: "${AI}"`);
    expect(b).toContain('Editor shipped: "We started cold calling ourselves."');
  });

  it("hookKey folds case, emoji and punctuation only", () => {
    expect(hookKey("Bro's app…🤯 ")).toBe(hookKey("bro s app"));
    expect(hookKey("Line one")).not.toBe(hookKey("Line two"));
  });
});
