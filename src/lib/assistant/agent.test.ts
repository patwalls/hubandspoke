import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

vi.mock("@/lib/assistant/tools", () => ({
  ASSISTANT_TOOLS: [{ name: "search_help", description: "d", input_schema: { type: "object", properties: {} } }],
  runAssistantTool: vi.fn(async () => ({ text: '{"academy_videos":[]}', ok: true })),
  toolStatus: () => "Searching the help…",
}));

import { runAssistant, trimHistory, type AssistantEvent } from "./agent";
import { runAssistantTool } from "@/lib/assistant/tools";

/** A fake Anthropic client that plays back scripted turns. */
function fakeClient(turns: Array<{ text?: string; tool?: { name: string; input: object } }>) {
  const calls: unknown[] = [];
  let i = 0;
  const client = {
    messages: {
      stream: (params: unknown) => {
        calls.push(params);
        const turn = turns[i++];
        const handlers: Array<(t: string) => void> = [];
        return {
          on: (_e: "text", cb: (t: string) => void) => handlers.push(cb),
          finalMessage: async () => {
            if (turn.text) handlers.forEach((h) => h(turn.text!));
            const content: unknown[] = [];
            if (turn.text) content.push({ type: "text", text: turn.text });
            if (turn.tool) content.push({ type: "tool_use", id: `t${i}`, name: turn.tool.name, input: turn.tool.input });
            return {
              content,
              stop_reason: turn.tool ? "tool_use" : "end_turn",
              usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
            };
          },
        };
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

describe("runAssistant", () => {
  it("runs tools, then streams the answer, and totals usage", async () => {
    const { client, calls } = fakeClient([
      { tool: { name: "search_help", input: { query: "goals" } } },
      { text: "Go to your brand → **Accounts → Goals**." },
    ]);
    const events: AssistantEvent[] = [];
    const out = await runAssistant([{ role: "user", content: "How do I set goals?" }], { userId: "u", baseUrl: "https://x" }, (e) => events.push(e), client);

    expect(runAssistantTool).toHaveBeenCalledWith("search_help", { query: "goals" }, expect.objectContaining({ userId: "u" }));
    expect(events).toContainEqual({ type: "status", text: "Searching the help…" });
    expect(out.answer).toBe("Go to your brand → **Accounts → Goals**.");
    expect(out.toolCalls).toEqual([expect.objectContaining({ name: "search_help", ok: true })]);
    expect(out.inputTokens).toBe(200);
    expect(out.cacheReadTokens).toBe(100);
    expect(calls).toHaveLength(2);
  });

  it("stops offering tools after the round limit so it always answers", async () => {
    const tool = { tool: { name: "search_help", input: { query: "x" } } };
    const { client, calls } = fakeClient([tool, tool, tool, tool, tool, tool, { text: "Best answer I have." }]);
    const out = await runAssistant([{ role: "user", content: "?" }], { userId: "u", baseUrl: "https://x" }, () => {}, client);
    expect(out.answer).toBe("Best answer I have.");
    expect((calls[calls.length - 1] as { tool_choice?: unknown }).tool_choice).toEqual({ type: "none" });
  });
});

describe("trimHistory", () => {
  it("drops a leading assistant turn and empty turns, and merges same-role repeats", () => {
    expect(
      trimHistory([
        { role: "assistant", content: "hi" },
        { role: "user", content: "q1" },
        { role: "user", content: "q1 again" },
        { role: "assistant", content: " " },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ]).map((m) => `${m.role}:${m.content}`),
    ).toEqual(["user:q1\n\nq1 again", "assistant:a1", "user:q2"]);
  });
});
