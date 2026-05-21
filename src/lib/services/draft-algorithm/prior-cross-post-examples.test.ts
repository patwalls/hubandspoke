import { describe, expect, it } from "vitest";
import { renderPriorCrossPostExamples } from "./prior-cross-post-examples";

describe("renderPriorCrossPostExamples", () => {
  it("returns null when there are no examples (caller omits the block)", () => {
    expect(renderPriorCrossPostExamples([], "threads", "x")).toBeNull();
  });

  it("renders direction in the header and SOURCE/ADAPTED TO sections per pair", () => {
    const out = renderPriorCrossPostExamples(
      [
        {
          sourceText: "Source body.",
          targetText: "Adapted body.",
          targetPublishedAt: "2026-05-01",
        },
      ],
      "threads",
      "x",
    );
    expect(out).toContain("## PRIOR CROSS-POST EXAMPLES");
    expect(out).toContain("threads → x");
    expect(out).toContain("SOURCE (threads):\nSource body.");
    expect(out).toContain("ADAPTED TO (x):\nAdapted body.");
    expect(out).toContain("(2026-05-01)");
  });

  it("calls out the HARD-OVERRIDE on rewrite aggressiveness so the agent calibrates", () => {
    // The agent's past-caption exemplars otherwise dominate. The whole
    // point of this block is that real prior pairs trump exemplars on
    // the *how much to rewrite* question. If this header softens, the
    // agent will fall back to expansion when the team's own history
    // says "near-verbatim."
    const out = renderPriorCrossPostExamples(
      [
        { sourceText: "a", targetText: "b", targetPublishedAt: null },
      ],
      "threads",
      "x",
    );
    expect(out).toContain("HARD-OVERRIDE");
    expect(out).toContain("past-caption exemplars");
  });

  it("includes one pair-block per example with a numeric header", () => {
    const out = renderPriorCrossPostExamples(
      [
        { sourceText: "s1", targetText: "t1", targetPublishedAt: null },
        { sourceText: "s2", targetText: "t2", targetPublishedAt: null },
      ],
      "threads",
      "x",
    );
    expect(out).toContain("--- pair 1 ---");
    expect(out).toContain("--- pair 2 ---");
  });
});
