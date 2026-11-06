import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

vi.mock("@/lib/assistant/tools", () => ({
  ASSISTANT_TOOLS: [{ name: "search_help", description: "d", input_schema: { type: "object", properties: {} } }],
  runAssistantTool: vi.fn(async () => ({ text: '{"academy_videos":[]}', ok: true })),
  toolStatus: () => "Searching the help…",
}));

import { fallbackCardIds, runAssistant, trimHistory, type AssistantEvent } from "./agent";
import { runAssistantTool, type AssistantToolContext } from "@/lib/assistant/tools";

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

describe("auto cards when the model lists posts in prose", () => {
  // Fake tools: search_content reports its rows; show_content_cards emits a card block.
  function fakeTools() {
    vi.mocked(runAssistantTool).mockImplementation(async (name, args, ctx: AssistantToolContext) => {
      if (name === "search_content") {
        ctx.onSearch?.({ sort: "views", items: [{ id: "a", views: 10 }, { id: "b", views: 500 }] });
        return { text: "{}", ok: true };
      }
      if (name === "show_content_cards") {
        ctx.onCards?.({ kind: "content", heading: null, items: (args.ids as string[]).map((id) => ({ id }) as never) });
        return { text: "{}", ok: true };
      }
      return { text: "{}", ok: true };
    });
  }

  it("shows the searched posts as cards if it never called show_content_cards", async () => {
    fakeTools();
    const { client } = fakeClient([{ tool: { name: "search_content", input: { sort: "views" } } }, { text: "The Elon clip won." }]);
    const events: AssistantEvent[] = [];
    const out = await runAssistant([{ role: "user", content: "top bangers?" }], { userId: "u", baseUrl: "https://x" }, (e) => events.push(e), client);
    const cards = events.filter((e) => e.type === "cards");
    expect(cards).toHaveLength(1);
    expect(runAssistantTool).toHaveBeenLastCalledWith("show_content_cards", { ids: ["b", "a"] }, expect.anything());
    expect(out.toolCalls.map((c) => c.name)).toContain("show_content_cards:auto");
  });

  it("doesn't add cards when the model already showed them", async () => {
    fakeTools();
    const { client } = fakeClient([
      { tool: { name: "search_content", input: {} } },
      { tool: { name: "show_content_cards", input: { ids: ["a"] } } },
      { text: "Here they are." },
    ]);
    const events: AssistantEvent[] = [];
    const out = await runAssistant([{ role: "user", content: "?" }], { userId: "u", baseUrl: "https://x" }, (e) => events.push(e), client);
    expect(events.filter((e) => e.type === "cards")).toHaveLength(1);
    expect(out.toolCalls.map((c) => c.name)).not.toContain("show_content_cards:auto");
  });

  it("doesn't add cards when the search was only a step to something else (e.g. a transcript)", async () => {
    fakeTools();
    const { client } = fakeClient([
      { tool: { name: "search_content", input: {} } },
      { tool: { name: "get_transcript", input: { id: "a" } } },
      { text: "In that video he says…" },
    ]);
    const events: AssistantEvent[] = [];
    await runAssistant([{ role: "user", content: "?" }], { userId: "u", baseUrl: "https://x" }, (e) => events.push(e), client);
    expect(events.filter((e) => e.type === "cards")).toHaveLength(0);
  });
});

describe("fallbackCardIds", () => {
  it("merges several views searches into one ranking, without duplicates", () => {
    expect(
      fallbackCardIds([
        { sort: "views", items: [{ id: "reel", views: 1_090_000 }, { id: "dup", views: 300 }] },
        { sort: "views", items: [{ id: "short", views: 549_000 }, { id: "dup", views: 300 }, { id: "none", views: null }] },
      ]),
    ).toEqual(["reel", "short", "dup", "none"]);
  });

  it("keeps the returned order for non-views searches and caps the count", () => {
    const items = ["1", "2", "3", "4", "5", "6"].map((id) => ({ id, views: Number(id) }));
    expect(fallbackCardIds([{ sort: "published_at", items }])).toEqual(["1", "2", "3", "4", "5"]);
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
