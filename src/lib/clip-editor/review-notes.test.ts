import { describe, it, expect } from "vitest";
import { createDefaultDoc } from "./doc";
import { compileRenderPlan } from "./plan";
import { addRemoval } from "./removals";
import { placeNoteOnDraft } from "./review-notes";

const doc = () => createDefaultDoc({ startSec: 100, endSec: 110, hook: "" });

describe("placeNoteOnDraft", () => {
  it("an unchanged draft keeps the note where it was left", () => {
    const plan = compileRenderPlan(doc(), []);
    expect(placeNoteOnDraft(plan, plan, 4)).toBeCloseTo(4);
  });

  it("follows the moment when the draft cut something before it", () => {
    const rendered = compileRenderPlan(doc(), []);
    const d = doc();
    d.sections[0] = addRemoval(d.sections[0], { startSec: 101, endSec: 103 }, "manual");
    // 6s into the render is source 106 — which now plays at 4s.
    expect(placeNoteOnDraft(rendered, compileRenderPlan(d, []), 6)).toBeCloseTo(4);
  });

  it("drops a note whose moment the draft cut out", () => {
    const rendered = compileRenderPlan(doc(), []);
    const d = doc();
    d.sections[0] = addRemoval(d.sections[0], { startSec: 105, endSec: 107 }, "manual");
    expect(placeNoteOnDraft(rendered, compileRenderPlan(d, []), 6)).toBeNull();
  });

  it("maps from the render's own timeline, not the draft's", () => {
    // The render had a cut the draft has since restored.
    const r = doc();
    r.sections[0] = addRemoval(r.sections[0], { startSec: 101, endSec: 103 }, "manual");
    const rendered = compileRenderPlan(r, []);
    const draft = compileRenderPlan(doc(), []);
    // 4s into that render was source 106 → 6s of the full draft.
    expect(placeNoteOnDraft(rendered, draft, 4)).toBeCloseTo(6);
  });

  it("follows a scene that moved", () => {
    const r = doc();
    r.sections = [
      { ...r.sections[0], id: "a", startSec: 100, endSec: 104 },
      { ...r.sections[0], id: "b", startSec: 200, endSec: 203 },
    ];
    const d = structuredClone(r);
    d.sections.reverse();
    // 5s into the render is 1s into scene b (source 201) — now the opener.
    expect(placeNoteOnDraft(compileRenderPlan(r, []), compileRenderPlan(d, []), 5)).toBeCloseTo(1);
  });

  it("with no editor render behind the video, takes the time as-is", () => {
    const draft = compileRenderPlan(doc(), []);
    expect(placeNoteOnDraft(null, draft, 3)).toBe(3);
    expect(placeNoteOnDraft(null, draft, 99)).toBe(10);
  });
});
