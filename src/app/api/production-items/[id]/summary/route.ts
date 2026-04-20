import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, formats } from "@/lib/db/schema";
import { auth } from "@/lib/auth";

const MODEL = "claude-haiku-4-5";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Short triage brief for the Queue dialog — 2-3 sentences so Pat can decide
// who to assign without opening the full detail page.
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  const [item] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  let pillarTitle: string | null = null;
  let pillarFormat: string | null = null;
  if (item.pillarContentItemId) {
    const [p] = await db
      .select({
        title: productionItems.title,
        format: productionItems.format,
      })
      .from(productionItems)
      .where(eq(productionItems.id, item.pillarContentItemId))
      .limit(1);
    if (p) {
      pillarTitle = p.title;
      pillarFormat = p.format;
    }
  }

  let formatInstructions: string | null = null;
  if (item.format) {
    const [f] = await db
      .select({ instructions: formats.instructions })
      .from(formats)
      .where(eq(formats.name, item.format))
      .limit(1);
    if (f) formatInstructions = f.instructions;
  }

  const userPrompt = [
    `Title: ${item.title || "(Untitled)"}`,
    `Channel: ${(item.platform || []).join(", ") || "(none)"}`,
    `Format: ${item.format || "(none)"}`,
    pillarTitle ? `Pillar content: "${pillarTitle}"${pillarFormat ? ` (${pillarFormat})` : ""}` : null,
    formatInstructions
      ? `Format skill / brief:\n"""\n${formatInstructions}\n"""`
      : `No format skill configured.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 240,
      system: [
        "You're helping triage content ideas. Given a derivative post's title, format, channel, and pillar source, write a 2-3 sentence plain-English summary of what the finished post will be.",
        "Focus on: what's being made, what moment/angle of the pillar it pulls from, and (if obvious from the format skill) the tone or hook.",
        "No bullet points, no headings, no filler. Don't restate the format name. Don't editorialize about whether it's a good idea.",
      ].join(" "),
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return NextResponse.json({ summary: text || null });
  } catch (err) {
    console.error("Summary generation failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Summary failed" },
      { status: 502 }
    );
  }
}
