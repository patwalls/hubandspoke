import Anthropic from "@anthropic-ai/sdk";
import type { AssistantToolCall } from "@/lib/db/schema";
import { ASSISTANT_TOOLS, runAssistantTool, toolStatus, type AssistantToolContext } from "@/lib/assistant/tools";
import type { CardBlock } from "@/lib/assistant/cards";

/**
 * Hub & Spoke Assistant: answers "how does this work / how do I…" from the
 * product's own help (Academy + feature docs) and looks up the person's live
 * content through read-only tools. Streams events to the chat panel.
 */

export const ASSISTANT_MODEL = "claude-sonnet-5-5";
const MAX_TOOL_ROUNDS = 6;

export type AssistantEvent =
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "cards"; block: CardBlock }
  | { type: "done" }
  | { type: "error"; message: string };

export type ChatTurn = { role: "user" | "assistant"; content: string };

export interface AssistantRunResult {
  answer: string;
  toolCalls: AssistantToolCall[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

const SYSTEM = `You are the Hub & Spoke Assistant, built into Hub & Spoke — the content command center a team of media brands uses to turn long YouTube videos (hubs) into clips, posts and newsletters (spokes), move them through review, and publish them.

Who you help: editors, producers and publishers using the app. Most are not technical.

How to answer:
- For "how does X work", "how do I…", or "what does Y mean": call search_help first, and answer from what it returns. If an Academy video covers it, link it: [Video title](url).
- For questions about their actual content ("what's waiting for me?", "what did we publish on X?"): use the content tools. Link items with their app_url.
- For totals ("how many views did Starter Story get in the last 30 days?", "how many Shorts did we post this month?"): use content_totals — it returns the same numbers as the dashboard. Never add up search_content rows for a total. If a brand name is ambiguous, check list_brands for the slug.
- "Top" / "best" / "bangers" means highest views: use search_content with sort=views and the date range, filtering by post_type as asked (short-form = everything except youtube_long; run one search per platform if needed and pick the top overall).
- Explain in plain language, as steps when it's a how-to ("Go to your brand → Accounts → Goals"). Never mention code, file names, database tables, API routes, workers, or other internals that appear in the docs — translate them into what the person sees and clicks.
- You can't change anything — you only read. If they ask you to do something, tell them exactly where to do it in the app.
- If the help and the data don't answer it, say you're not sure and suggest asking Sam or checking the Academy. Never invent features, settings, buttons or numbers.
- Be brief: a few sentences or a short list. Use Markdown (bold, lists, links). Don't repeat the question.
- Showing data — the app draws it for you, Starter Story style:
  - Lists of posts (top posts, what's waiting, what we published): find them with search_content / my_work, then call show_content_cards with the ids in the order to show (max 10). The cards show thumbnail, linked title, platform, views, likes and date from the database. Your text is then ONE or TWO sentences of takeaway (what stands out, a pattern) — never re-list the posts, never a table.
  - Totals: content_totals shows a stats card automatically (big number, posts / clicks / leads, top accounts). Your text is the takeaway plus one short line on what the number means. Don't restate every number.
  - Never use Markdown tables; the answer shows in a narrow chat window.`;

function systemPrompt(ctx: AssistantToolContext & { userName?: string | null }): Anthropic.TextBlockParam[] {
  return [
    // Stable instructions first so they cache across every question.
    { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: `Today is ${new Date().toISOString().slice(0, 10)}. The person asking is ${ctx.userName || "a Hub & Spoke user"}. App base URL: ${ctx.baseUrl}`,
    },
  ];
}

const tools: Anthropic.Tool[] = ASSISTANT_TOOLS.map((t, i) =>
  i === ASSISTANT_TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
);

/**
 * The history the model sees: recent turns, bounded length, starting with the
 * person, alternating roles (back-to-back turns from one side — e.g. a retry
 * after an error — are merged), no empty turns.
 */
export function trimHistory(turns: ChatTurn[]): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of turns.slice(-12)) {
    const content = t.content.slice(0, 4000);
    if (!content.trim()) continue;
    if (out.length === 0 && t.role === "assistant") continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) prev.content = `${prev.content}\n\n${content}`;
    else out.push({ role: t.role, content });
  }
  return out;
}

export async function runAssistant(
  turns: ChatTurn[],
  ctx: AssistantToolContext & { userName?: string | null },
  emit: (e: AssistantEvent) => void,
  client: Anthropic = new Anthropic(),
): Promise<AssistantRunResult> {
  const messages = trimHistory(turns);
  const result: AssistantRunResult = { answer: "", toolCalls: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS;
    if (round > 0 && result.answer && !result.answer.endsWith("\n\n")) {
      emit({ type: "text", text: "\n\n" });
      result.answer += "\n\n";
    }
    const stream = client.messages.stream({
      model: ASSISTANT_MODEL,
      max_tokens: 1500,
      system: systemPrompt(ctx),
      tools,
      // Out of tool rounds: tools stay listed (earlier turns used them) but
      // can't be called, so it answers with what it has.
      ...(lastRound ? { tool_choice: { type: "none" as const } } : {}),
      messages,
    });
    stream.on("text", (delta) => {
      result.answer += delta;
      emit({ type: "text", text: delta });
    });
    const message = await stream.finalMessage();
    result.inputTokens += message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0);
    result.outputTokens += message.usage.output_tokens;
    result.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;

    const calls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || calls.length === 0) break;

    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      emit({ type: "status", text: toolStatus(call.name) });
      const started = Date.now();
      const out = await runAssistantTool(call.name, call.input as Record<string, unknown>, {
        ...ctx,
        onCards: (block) => emit({ type: "cards", block }),
      });
      result.toolCalls.push({ name: call.name, ok: out.ok, ms: Date.now() - started });
      results.push({ type: "tool_result", tool_use_id: call.id, content: out.text, is_error: !out.ok });
    }
    messages.push({ role: "user", content: results });
  }

  result.answer = result.answer.trim();
  return result;
}
