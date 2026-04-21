import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type {
  ContentDraftContent,
  ContentDraftSlide,
  FormatFieldSchema,
} from "@/lib/db/schema";

// Opus for copywriting judgment. Short-form copy rewards nuance more than
// speed — a weak hook sinks a post, and the cost delta vs haiku is trivial
// (~$0.03/draft) against the production value of a better tweet. Bump
// PROMPT_VERSION when prompt structure changes so clip-ideas-style audits
// can A/B the rows.
const MODEL = "claude-opus-4-7";
export const PROMPT_VERSION = 2;
export const GENERATED_BY = `${MODEL}:v${PROMPT_VERSION}`;

const SYSTEM_PROMPT = `You write platform-specific draft copy for a production team that turns long-form YouTube interviews into posts across X/Twitter, Instagram, LinkedIn, and YouTube.

You will be given:
1. The target *platform* (where the post lives) and its field schema — each field has a per-field directive telling you what to write.
2. Optional FORMAT REFERENCES & EDITORIAL NOTES — free text the team maintains per format. Use these to ground tone and style.
3. The pillar video's title and full transcript.

RULES FOR READING FORMAT REFERENCES & EDITORIAL NOTES
The editorial notes may contain a mix of useful and not-useful material:
- Reference posts (Instagram links, tweets, LinkedIn URLs) — EXTRACT tone, sentence rhythm, structure from these. If a URL looks like a live post on the target platform, treat its style as the style you should match.
- Loom / loom.com links — these are walkthrough videos for human editors; you cannot watch them. IGNORE.
- Login credentials, tool names ("Descript", "Slack"), "ask me via Slack" notes — editor-onboarding admin noise. IGNORE.
- Any free-text style guidance — FOLLOW it.

OUTPUT RULES
- Ground every field in specifics from the transcript: numbers, named people, direct quotes, concrete outcomes. No generic platitudes.
- No clickbait the content can't back up.
- No hashtag walls.
- Match the tone implied by the reference posts when any are given.
- Call the propose_draft tool exactly once with a value for every field. Never respond with plain text.`;

export interface GenerateDraftArgs {
  item: {
    id: string;
    title: string | null;
    format: string | null;
    platform: string[] | null;
    brand: string;
  };
  fieldSchema: FormatFieldSchema;
  formatInstructions: string | null;
  pillarTitle: string | null;
  transcriptSegmentsMarkdown: string;
  transcriptDurationSec: number;
}

export interface GenerateDraftResult {
  content: ContentDraftContent;
  modelUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// Build the JSON schema for the `propose_draft` tool dynamically from the
// format's fieldSchema. Every field becomes a required property — we want
// the model to fill in every field, even with empty-ish content, rather than
// silently omit one.
function buildToolSchema(
  fieldSchema: FormatFieldSchema,
): Anthropic.Tool["input_schema"] {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const field of fieldSchema.fields) {
    let prop: Record<string, unknown>;
    switch (field.type) {
      case "text":
      case "longtext":
        prop = {
          type: "string",
          description: field.prompt,
        };
        if (field.maxLength) {
          prop.maxLength = field.maxLength;
        }
        break;
      case "tags":
        prop = {
          type: "array",
          description: field.prompt,
          items: { type: "string" },
          maxItems: 15,
        };
        break;
      case "slides":
        prop = {
          type: "array",
          description: field.prompt,
          minItems: 3,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              order: { type: "integer", minimum: 1 },
              text: { type: "string" },
            },
            required: ["order", "text"],
          },
        };
        break;
    }
    properties[field.key] = prop;
    required.push(field.key);
  }
  return {
    type: "object" as const,
    properties,
    required,
  };
}

// Validate + normalize the model's tool output. Unknown-shape values fall
// back to an empty default rather than throwing; the caller sees whatever
// shape matches the schema so the UI never renders garbage.
function normalizeContent(
  raw: unknown,
  fieldSchema: FormatFieldSchema,
): ContentDraftContent {
  const input =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: ContentDraftContent = {};
  for (const field of fieldSchema.fields) {
    const value = input[field.key];
    switch (field.type) {
      case "text":
      case "longtext":
        out[field.key] = typeof value === "string" ? value.trim() : "";
        break;
      case "tags":
        out[field.key] = Array.isArray(value)
          ? value
              .filter((v): v is string => typeof v === "string")
              .map((v) => v.trim())
              .filter(Boolean)
          : [];
        break;
      case "slides": {
        const slides: ContentDraftSlide[] = [];
        if (Array.isArray(value)) {
          value.forEach((s, i) => {
            if (typeof s !== "object" || s === null) return;
            const rec = s as Record<string, unknown>;
            const text = typeof rec.text === "string" ? rec.text.trim() : "";
            if (!text) return;
            const order =
              typeof rec.order === "number" && Number.isFinite(rec.order)
                ? Math.round(rec.order)
                : i + 1;
            const imageUrl =
              typeof rec.imageUrl === "string" && rec.imageUrl.trim()
                ? rec.imageUrl.trim()
                : undefined;
            slides.push({
              id: randomUUID(),
              order,
              text,
              ...(imageUrl ? { imageUrl } : {}),
            });
          });
        }
        slides.sort((a, b) => a.order - b.order);
        slides.forEach((s, i) => (s.order = i + 1));
        out[field.key] = slides;
        break;
      }
    }
  }
  return out;
}

export async function generateDraft(
  args: GenerateDraftArgs,
): Promise<GenerateDraftResult> {
  const client = new Anthropic();

  const tools: Anthropic.Tool[] = [
    {
      name: "propose_draft",
      description:
        "Submit a complete draft with a value for every field in the target format's schema. Follow each field's per-field instruction exactly.",
      input_schema: buildToolSchema(args.fieldSchema),
    },
  ];

  const fieldsBlock = args.fieldSchema.fields
    .map((f) => {
      const limit = f.maxLength ? ` (max ${f.maxLength} chars)` : "";
      return `- ${f.key} [${f.type}${limit}]: ${f.prompt}`;
    })
    .join("\n");

  const userMessage = [
    `Target platform: ${args.item.platform?.[0] ?? "(unspecified)"}`,
    args.item.platform && args.item.platform.length > 1
      ? `Secondary platforms (not drafting for these): ${args.item.platform.slice(1).join(", ")}`
      : null,
    args.item.format ? `Source editorial format: ${args.item.format}` : null,
    `Pillar title: ${args.pillarTitle ?? args.item.title ?? "(untitled)"}`,
    `Pillar duration: ${Math.round(args.transcriptDurationSec)}s`,
    ``,
    `## TARGET FIELDS`,
    `You must fill in every field below via the propose_draft tool.`,
    ``,
    fieldsBlock,
    ``,
    args.formatInstructions
      ? [
          `## FORMAT REFERENCES & EDITORIAL NOTES`,
          `Free text maintained by the team for this format. Apply the RULES FOR READING these from the system prompt — extract tone/style cues from reference posts, ignore admin noise (logins, Loom videos, "ask me via Slack").`,
          ``,
          args.formatInstructions,
          ``,
        ].join("\n")
      : null,
    `## PILLAR TRANSCRIPT`,
    `Transcript cues, pre-segmented with [MM:SS] timestamps. Pull specifics — numbers, names, direct quotes — from this.`,
    ``,
    args.transcriptSegmentsMarkdown,
    ``,
    `## TASK`,
    `Call propose_draft exactly once with a value for every field. Ground every field in specifics from the transcript. Match tone to any reference posts shown in the editorial notes.`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools,
    tool_choice: { type: "tool", name: "propose_draft" },
    messages: [{ role: "user", content: userMessage }],
  });

  let rawInput: unknown = null;
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "propose_draft") {
      rawInput = block.input;
      break;
    }
  }

  if (!rawInput) {
    throw new Error("draft-agent returned no tool call");
  }

  const content = normalizeContent(rawInput, args.fieldSchema);

  return {
    content,
    modelUsage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? undefined,
      cache_read_input_tokens:
        response.usage.cache_read_input_tokens ?? undefined,
    },
  };
}
