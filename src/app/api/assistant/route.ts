import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { assistantMessages, users } from "@/lib/db/schema";
import { ASSISTANT_MODEL, runAssistant, type AssistantEvent } from "@/lib/assistant/agent";
import { ASSISTANT_DAILY_LIMIT, questionsInLastDay } from "@/lib/assistant/limits";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .min(1)
    .max(40),
});

/**
 * POST /api/assistant — the Hub & Spoke Assistant (chat panel). Any signed-in
 * user; read-only tools; ASSISTANT_DAILY_LIMIT questions per person per day.
 * Body: { messages: [{ role, content }] } (last one is the new question).
 * Response: newline-delimited JSON events (status / text / done / error).
 * Every question is logged to assistant_messages.
 */
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const userId = guard.session.user.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  const last = parsed.success ? parsed.data.messages[parsed.data.messages.length - 1] : null;
  if (!parsed.success || !last || last.role !== "user" || !last.content.trim()) {
    return NextResponse.json({ error: "Ask a question" }, { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "The assistant isn't set up here (no ANTHROPIC_API_KEY)." }, { status: 503 });
  }
  if ((await questionsInLastDay(userId)) >= ASSISTANT_DAILY_LIMIT) {
    return NextResponse.json(
      { error: `You've reached today's limit of ${ASSISTANT_DAILY_LIMIT} questions. Try again tomorrow.` },
      { status: 429 },
    );
  }

  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "localhost:3000";
  const baseUrl = `${proto}://${host}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AssistantEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      const started = Date.now();
      try {
        const result = await runAssistant(parsed.data.messages, { userId, baseUrl, userName: me?.name }, emit);
        emit({ type: "done" });
        await db.insert(assistantMessages).values({
          userId,
          question: last.content.slice(0, 8000),
          answer: result.answer,
          toolCalls: result.toolCalls,
          model: ASSISTANT_MODEL,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[assistant] failed", err);
        emit({ type: "error", message: "Something went wrong answering that. Please try again." });
        await db
          .insert(assistantMessages)
          .values({ userId, question: last.content.slice(0, 8000), model: ASSISTANT_MODEL, error: message.slice(0, 2000), durationMs: Date.now() - started })
          .catch(() => {});
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
