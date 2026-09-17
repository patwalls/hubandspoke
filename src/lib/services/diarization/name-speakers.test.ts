import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildNamingEvidence, nameSpeakers, type NameSpeakersInput } from "./name-speakers";

const input = (client: Anthropic): NameSpeakersInput => ({
  title: "I left my tech job to build this app ($13K/month)",
  description: null,
  channelName: "Starter Story",
  authorName: "Pat Walls",
  speakers: [
    { id: "S1", talkSharePct: 55, samples: ["My revenue jumped from roughly $1,000 a month"] },
    { id: "S2", talkSharePct: 45, samples: ["This is Ken. He spent most of his career at big tech."] },
  ],
  opening: "S1: My revenue jumped... S2: This is Ken.",
  client,
});

const reply = (speakers: unknown[]): Anthropic =>
  ({ messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "tool_use", name: "name_speakers", input: { speakers } }] }) } }) as unknown as Anthropic;

describe("nameSpeakers", () => {
  it("applies a name only at high confidence, but keeps the role at any confidence", async () => {
    const r = await nameSpeakers(input(reply([
      { id: "S1", name: "Ken", role: "guest", confidence: "high", evidence: "narrator introduces him" },
      { id: "S2", name: "Pat Walls", role: "narrator", confidence: "medium", evidence: "channel owner" },
    ])));
    expect(r).toEqual({ ok: true, speakers: [
      { id: "S1", name: "Ken", role: "guest" },
      { id: "S2", name: null, role: "narrator" },
    ] });
  });

  it("drops ids it wasn't asked about, duplicates, and invalid roles", async () => {
    const r = await nameSpeakers(input(reply([
      { id: "S9", name: "Ghost", role: "guest", confidence: "high" },
      { id: "S1", name: "Ken", role: "founder", confidence: "high" },
      { id: "S1", name: "Someone Else", role: "guest", confidence: "high" },
    ])));
    expect(r).toEqual({ ok: true, speakers: [{ id: "S1", name: "Ken", role: "unknown" }] });
  });

  it("trusts neither when two voices are given the same name", async () => {
    const r = await nameSpeakers(input(reply([
      { id: "S1", name: "Ken", role: "guest", confidence: "high" },
      { id: "S2", name: "ken", role: "host", confidence: "high" },
    ])));
    expect(r.ok && r.speakers.map((s) => s.name)).toEqual([null, null]);
  });

  it("fails soft on a thrown call or a text-only reply", async () => {
    const throwing = { messages: { create: vi.fn().mockRejectedValue(new Error("529")) } } as unknown as Anthropic;
    expect(await nameSpeakers(input(throwing))).toMatchObject({ ok: false, failure: { reason: "llm-error" } });
    const chatty = { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "S1 is Ken" }] }) } } as unknown as Anthropic;
    expect(await nameSpeakers(input(chatty))).toEqual({ ok: false, failure: { reason: "llm-no-tool-call" } });
  });

  it("gives the model the channel owner, talk share, and the opening", () => {
    const text = buildNamingEvidence(input({} as Anthropic));
    expect(text).toContain("Starter Story — run by Pat Walls");
    expect(text).toContain("### S2 — 45% of the talking");
    expect(text).toContain("## OPENING OF THE RECORDING");
  });
});
