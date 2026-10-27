import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { fallbackIntroRange, numberedTranscript, pickPostClip, rangeFromLines, type PostClipSegment } from "./pick-post-clip";

const segs: PostClipSegment[] = Array.from({ length: 40 }, (_, i) => ({ startSec: i * 10, endSec: i * 10 + 9.5, text: `line ${i}` }));

function fakeClient(input: unknown): Anthropic {
  return {
    messages: { create: async () => ({ content: [{ type: "tool_use", name: "return_clip", id: "t", input }] }) },
  } as unknown as Anthropic;
}

describe("fallbackIntroRange", () => {
  it("ends on the first line boundary past ~40s", () => {
    expect(fallbackIntroRange(segs)).toEqual({ startSec: 0, endSec: 49.5 });
  });
  it("never runs past 90s even when one line is huge", () => {
    const long = [{ startSec: 0, endSec: 20, text: "a" }, { startSec: 20, endSec: 200, text: "b" }];
    expect(fallbackIntroRange(long)).toEqual({ startSec: 0, endSec: 20 });
  });
  it("is null with no transcript", () => {
    expect(fallbackIntroRange([])).toBeNull();
  });
});

describe("numberedTranscript", () => {
  it("stops at the budget but always shows at least one line", () => {
    expect(numberedTranscript(segs, 40).count).toBe(2);
    expect(numberedTranscript(segs, 1).count).toBe(1);
  });
});

describe("rangeFromLines", () => {
  it("maps inclusive line numbers to the source range", () => {
    expect(rangeFromLines(segs, 40, 2, 5)).toEqual({ startSec: 20, endSec: 59.5 });
  });
  it("rejects lines the model never saw, reversed ranges and non-integers", () => {
    expect(rangeFromLines(segs, 10, 2, 12)).toBeNull();
    expect(rangeFromLines(segs, 40, 5, 2)).toBeNull();
    expect(rangeFromLines(segs, 40, "1", 3)).toBeNull();
  });
});

describe("pickPostClip", () => {
  const base = { formatName: "Share The BIG IDEA (w/ video Intro)", skill: "Clip out the intro and only the intro.", sourceTitle: "Title", segments: segs, durationSec: 400 };

  it("returns the model's lines as a clip", async () => {
    const r = await pickPostClip({ ...base, client: fakeClient({ whole_video: false, first_line: 0, last_line: 3, hook: "He built 17 apps", rationale: "The intro" }) });
    expect(r).toEqual({ kind: "clip", pick: expect.objectContaining({ startSec: 0, endSec: 39.5, hook: "He built 17 apps", source: "llm" }) });
  });

  it("says so when the Skill posts the whole video", async () => {
    const r = await pickPostClip({ ...base, client: fakeClient({ whole_video: true, first_line: 0, last_line: 0, hook: "x", rationale: "full video" }) });
    expect(r).toEqual({ kind: "whole_video", rationale: "full video" });
  });

  it("falls back to the opening when the range is unusable or the call fails", async () => {
    const bad = await pickPostClip({ ...base, client: fakeClient({ whole_video: false, first_line: 9, last_line: 2, hook: "", rationale: "" }) });
    expect(bad).toEqual({ kind: "clip", pick: expect.objectContaining({ startSec: 0, endSec: 49.5, source: "fallback" }) });
    const failing = { messages: { create: async () => { throw new Error("down"); } } } as unknown as Anthropic;
    const failed = await pickPostClip({ ...base, client: failing });
    expect(failed?.kind === "clip" && failed.pick.source).toBe("fallback");
  });

  it("never turns a short into a whole-video post, and asks for a short", async () => {
    let system = "";
    const client = {
      messages: {
        create: async (req: { system: string }) => {
          system = req.system;
          return { content: [{ type: "tool_use", name: "return_clip", id: "t", input: { whole_video: true, first_line: 4, last_line: 8, hook: "She sold it for $2M", rationale: "r" } }] };
        },
      },
    } as unknown as Anthropic;
    let user = "";
    const spy = { messages: { create: async (req: { system: string; messages: { content: string }[] }) => ((user = req.messages[0].content), client.messages.create(req as never)) } } as unknown as Anthropic;
    const r = await pickPostClip({ ...base, destination: "short", angle: "the part about his SEO playbook", client: spy });
    expect(system).toMatch(/vertical short-form/);
    expect(user).toContain("THE EDITOR'S ANGLE");
    expect(user).toContain("the part about his SEO playbook");
    expect(r).toEqual({ kind: "clip", pick: expect.objectContaining({ startSec: 40, endSec: 89.5, hook: "She sold it for $2M" }) });
  });
});
