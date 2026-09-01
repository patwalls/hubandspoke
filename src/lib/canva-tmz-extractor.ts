import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";

const MODEL = "claude-haiku-4-5-20251001";

/**
 * The TMZ Brand Template is a single image (the pillar thumbnail) with one
 * bold headline overlaid on the lower third. It has one autofill-tagged
 * text field: `headline`. This module turns a pillar production_item into
 * that one string.
 *
 * The headline is a compressed narrative arc, not a caption: a punchy
 * multi-clause hook that tells the whole story in one breath (e.g. "He was
 * making $500K a month. Then AI killed it in 6 months. Now he runs 13
 * businesses making $250K/month."). The editor applies the red/green accent
 * colors to key phrases by hand in Canva after autofill — we only supply
 * the plain text.
 *
 * Fallback: if the pillar has no transcript yet (fresh YouTube upload before
 * whisper), return the title so the design still renders something the
 * editor can rewrite.
 */
export interface CanvaTmzText {
  headline: string;
}

const SYSTEM_PROMPT = `You write the single overlaid headline for a TMZ-style Instagram Post: one photo of a founder with a bold headline across the lower third. The headline IS the post — it must tell the entire story in one breath.

Write ONE headline for the \`headline\` field:
- A compressed narrative arc, usually 2-3 short clauses. Pattern: "[He did X]. Then [dramatic turn]. Now [current result]." Not every headline needs all three beats, but the best ones have a fall and a rise.
- Lead with and lean on specific numbers — revenue, timeframes, counts. The drama lives in the numbers ("$500K a month", "6 months", "13 businesses", "$250K/month").
- ALL CAPS. Return the text already uppercased.
- ~90-160 characters. Punchy. Every word earns its place. No hashtags, no emoji, no quotation marks.
- Third person ("he"/"she"/"they" or the founder's name), present the turn as a hard, almost tabloid claim.

RULES
- Ground every number and claim in the transcript. No invented figures. If the transcript has no concrete numbers, write the sharpest factual headline you can from what's there.
- Use the propose_tmz_headline tool. Never respond with plain text.`;

const TOOL_SCHEMA: Anthropic.Tool = {
  name: "propose_tmz_headline",
  description:
    "Submit the single headline for the TMZ-style Canva brand template.",
  input_schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description:
          "The overlaid headline. ALL CAPS, ~90-160 chars, 2-3 clauses, numbers-forward.",
      },
    },
    required: ["headline"],
    additionalProperties: false,
  },
};

export async function extractCanvaTmzText(
  productionItemId: string,
): Promise<CanvaTmzText> {
  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);
  if (!item) {
    throw new Error(`Canva TMZ extractor: item ${productionItemId} not found`);
  }

  const transcriptOwnerId = item.pillarContentItemId ?? item.id;
  const transcript = await getTranscriptForPrompt(transcriptOwnerId);
  const fallback = fallbackTmzText(item.title);

  if (!transcript || transcript.segmentsMarkdown.length < 100) {
    return fallback;
  }

  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: "propose_tmz_headline" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `## PILLAR TITLE`,
              item.title ?? "(no title)",
              ``,
              `## PILLAR TRANSCRIPT (segments)`,
              transcript.segmentsMarkdown,
            ].join("\n"),
          },
        ],
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    console.warn(
      `canva-tmz-extractor: no tool_use in Claude response for item ${productionItemId}`,
    );
    return fallback;
  }
  const input = toolUse.input as Partial<CanvaTmzText>;
  return {
    headline: input.headline?.trim() || fallback.headline,
  };
}

function fallbackTmzText(title: string | null): CanvaTmzText {
  return {
    headline: (title?.trim() || "Headline coming soon").toUpperCase(),
  };
}
