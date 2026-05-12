import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";

const MODEL = "claude-opus-4-7";

/**
 * The Tech Stack Slideshow Brand Template has three autofill-tagged text
 * fields: hook, stack_list, cta. This module turns a pillar production_item
 * into placeholder text for each of those fields.
 *
 * The extractor is intentionally narrow: a single Anthropic call returning
 * a tool-use payload with the three strings. We do not run the full
 * draft-algorithm here — that produces post-caption copy, which is a
 * different job (caption text appears beside the post, the slideshow IS
 * the post). Different prompt, different field shape.
 *
 * Fallback shape: if the pillar has no transcript at all (e.g. a fresh
 * YouTube upload before whisper has run), we still return something
 * usable derived from the title. Better to ship a half-filled Canva
 * design than to block the editor on whisper.
 */
export interface CanvaSlideText {
  hook: string;
  stack_list: string;
  cta: string;
}

const SYSTEM_PROMPT = `You write copy for a 4-page Instagram Post slideshow about a founder's tech stack. The slideshow has three text fields that you must fill:

1. **hook** — the opening line on page 1, layered over a photo of the founder. One sentence, ~80-120 characters. Punchy and specific: a number, a result, or a startling claim. Lead with the headline number when one exists ("This guy's stupidly simple website makes $40,000 per month.", "How this guy's solo SaaS hit $34K/mo on Reddit alone.").
2. **stack_list** — page 2's body text. A bulleted list of the tools/services the founder uses, each with the cost. ALWAYS use this exact format, one per line, leading with a "• ":
\`\`\`
• <tool> — <purpose> (<cost or "free">)
• <tool> — <purpose> (<cost or "free">)
...
total estimated infra: <bold total>
\`\`\`
Aim for 4-8 line items. Include costs when the transcript mentions them; if not stated, write "free" for open-source / no-cost tools you can identify and skip the line entirely for tools where neither tool name nor cost is clear. The last line ALWAYS reads "total estimated infra: ~$XYZ/mo" or "total estimated infra: ~$0/mo" if everything's free.
3. **cta** — page 4's call-to-action. Two sentences max. Pattern: "curious what his X does?\\n\\ncomment <TRIGGER> and i'll DM you the full video." TRIGGER is a 2-4 letter all-caps word relevant to the pillar (e.g. "RDT" for a Reddit-built business, "BSC" for a basic-site SaaS). Stay lowercase except for the trigger word.

RULES
- Ground every claim in the transcript. No invented numbers, no invented stack components. If you cannot identify the founder's stack from the transcript, return stack_list as "Stack details coming soon." and the editor will fill it manually.
- Match the voice of the existing Starter Story Instagram captions: lowercase except for proper nouns, conversational, short sentences, em-dashes welcome.
- Use the propose_canva_text tool with the three fields. Never respond with plain text.`;

const TOOL_SCHEMA: Anthropic.Tool = {
  name: "propose_canva_text",
  description: "Submit the three text fields for the Canva Tech Stack Slideshow template.",
  input_schema: {
    type: "object",
    properties: {
      hook: {
        type: "string",
        description: "Page 1 hook line. 80-120 chars. One sentence.",
      },
      stack_list: {
        type: "string",
        description:
          "Page 2 body. Bulleted list ('• tool — purpose (cost)' per line). Last line is 'total estimated infra: ~$XYZ/mo' in bold via markdown asterisks.",
      },
      cta: {
        type: "string",
        description:
          "Page 4 CTA. Two lines: 'curious what his X does?\\n\\ncomment TRIGGER and i\\'ll DM you the full video.'",
      },
    },
    required: ["hook", "stack_list", "cta"],
    additionalProperties: false,
  },
};

export async function extractCanvaSlideText(
  productionItemId: string,
): Promise<CanvaSlideText> {
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
    throw new Error(`Canva text extractor: item ${productionItemId} not found`);
  }

  // The pillar transcript is what we ground on. Derivatives don't carry
  // their own transcript — we walk up to the pillar (or fall back to the
  // item itself if it IS a pillar, which it won't be for IG-post
  // derivatives but the symmetry costs nothing).
  const transcriptOwnerId = item.pillarContentItemId ?? item.id;
  const transcript = await getTranscriptForPrompt(transcriptOwnerId);
  const fallback = fallbackSlideText(item.title);

  if (!transcript || transcript.segmentsMarkdown.length < 100) {
    return fallback;
  }

  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: "propose_canva_text" },
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
      `canva-text-extractor: no tool_use in Claude response for item ${productionItemId}`,
    );
    return fallback;
  }
  const input = toolUse.input as Partial<CanvaSlideText>;
  return {
    hook: input.hook?.trim() || fallback.hook,
    stack_list: input.stack_list?.trim() || fallback.stack_list,
    cta: input.cta?.trim() || fallback.cta,
  };
}

function fallbackSlideText(title: string | null): CanvaSlideText {
  const safeTitle = title?.trim() || "Hook coming soon";
  return {
    hook: safeTitle,
    stack_list: "Stack details coming soon.",
    cta: "curious what his website does?\n\ncomment YES and i'll DM you the full video.",
  };
}
