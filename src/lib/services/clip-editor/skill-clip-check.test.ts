import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { classifySkill, skillHash } from "./skill-clip-check";

function fakeClient(input: unknown): Anthropic {
  return {
    messages: { create: vi.fn(async () => ({ content: [{ type: "tool_use", name: "return_verdict", id: "t", input }] })) },
  } as unknown as Anthropic;
}

describe("classifySkill", () => {
  it("returns the model's verdict", async () => {
    const out = await classifySkill({ formatName: "Big Idea", skill: "Clip the intro.", client: fakeClient({ verdict: "clip", reason: " Cuts the intro. " }) });
    expect(out).toEqual({ verdict: "clip", reason: "Cuts the intro." });
  });

  it("an empty Skill is 'none' without a model call", async () => {
    const client = fakeClient({});
    expect(await classifySkill({ formatName: "X", skill: "  ", client })).toMatchObject({ verdict: "none" });
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("an unusable answer or a failed call is null, so nothing is saved", async () => {
    expect(await classifySkill({ formatName: "X", skill: "s", client: fakeClient({ verdict: "maybe" }) })).toBeNull();
    const failing = { messages: { create: async () => { throw new Error("down"); } } } as unknown as Anthropic;
    expect(await classifySkill({ formatName: "X", skill: "s", client: failing })).toBeNull();
  });
});

describe("skillHash", () => {
  it("changes when the Skill does, ignores surrounding whitespace", () => {
    expect(skillHash("Clip the intro.")).toBe(skillHash("  Clip the intro.\n"));
    expect(skillHash("Clip the intro.")).not.toBe(skillHash("Post the whole video."));
  });
});
