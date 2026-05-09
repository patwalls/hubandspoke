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
// v4 (2026-05-08): added CTA RULES. Some platforms now ship a `cta` field
// (reply tweet / LinkedIn comment / pinned YouTube Community comment); the
// agent fills it only when the editorial notes include CTA guidance and
// returns "" otherwise.
// v5 (2026-05-09): the past-captions block is now split into format-scoped
// vs platform-scoped sub-blocks (see exemplars.ts v1.2), and a STRUCTURE
// RULE was added so the agent mirrors recurring patterns (timestamp
// breakdowns, listicles) when the format examples share one.
// v6 (2026-05-09): substrate becomes a discriminated input — either the
// pillar transcript (long-form derivatives, unchanged path) or the source
// post's body/title text (text-primary cross-posts: LinkedIn → X, X → Threads).
// The per-call payload renders one of two blocks (## PILLAR TRANSCRIPT or
// ## SOURCE POST BODY) and the TASK line adapts accordingly.
// v7 (2026-05-09): two refinements paired with v1.4 of the algorithm.
// (a) When the SOURCE POST BODY substrate is multi-paragraph (≥120 chars
// or contains a newline), the prompt swaps in a "pull every concrete
// element — list items, numbers, named people, the hook AND the closing"
// directive instead of the softer "adapt this." Stops the agent from
// echoing a one-line summary when it has a full post to riff on.
// (b) `MediaContext.itemAlreadyHasMedia` is rendered into the MEDIA
// CONTEXT block; when count > 0 the agent is told to pick
// `media_action: "none"` so it doesn't try to attach pillar media on
// top of source-mirrored media.
export const PROMPT_VERSION = 7;
export const GENERATED_BY = `${MODEL}:v${PROMPT_VERSION}`;

const SYSTEM_PROMPT = `You write platform-specific draft copy for a production team that turns long-form YouTube interviews into posts across X/Twitter, Instagram, LinkedIn, and YouTube.

You will be given:
1. The target *platform* (where the post lives) and its field schema — each field has a per-field directive telling you what to write.
2. Optional FORMAT REFERENCES & EDITORIAL NOTES (the format's "Skill") — free text the team maintains per format. Use these to ground tone and style AND to decide media attachment.
3. The pillar video's title and full transcript.
4. MEDIA ACTION context — what pillar media is available, and what the target platform's media rule allows.

RULES FOR READING FORMAT REFERENCES & EDITORIAL NOTES
The editorial notes may contain a mix of useful and not-useful material:
- Reference posts (Instagram links, tweets, LinkedIn URLs) — EXTRACT tone, sentence rhythm, structure from these. If a URL looks like a live post on the target platform, treat its style as the style you should match.
- Loom / loom.com links — these are walkthrough videos for human editors; you cannot watch them. IGNORE.
- Login credentials, tool names ("Descript", "Slack"), "ask me via Slack" notes — editor-onboarding admin noise. IGNORE.
- Any free-text style guidance — FOLLOW it.
- Any media directive ("attach the full video", "use the YouTube cover as the image") — translate into the media_action enum.

MEDIA ACTION RULES
Pick exactly one media_action value:
- "attach_pillar_full_video" — attach the pillar's full archived YouTube video. Pick this when the skill explicitly says to use the full video / source video / pillar video as the post's media. Only valid if the pillar has a full video AND the platform's media rule allows video.
- "attach_pillar_poster" — attach the pillar's cover image (YouTube thumbnail) as a single still image. Pick this when the skill says to use the thumbnail / cover / poster. Only valid if the pillar has a poster AND the platform's media rule allows images.
- "none" — do not attach pillar media. Pick this when the skill is silent on media, when the directive can't be fulfilled (no available pillar media of that kind, or the platform's rule rejects it), or when the post is text-only by design.

If the MEDIA CONTEXT shows the post already has media rows attached (cross-posts mirror their source's media on creation), pick "none" — the post will publish with those images/videos, you do not need to attach pillar media on top. Compose the caption assuming those attached items will be visible.

CTA RULES
Some target platforms include a "cta" field (X reply tweet, LinkedIn first comment, YouTube Community pinned comment) — the secondary post that carries the actual call-to-action.
- Look in FORMAT REFERENCES & EDITORIAL NOTES for CTA guidance: a link template, a UTM scheme, copy patterns like "always reply with the full episode link" or "pin a comment with starterstory.com/<handle>".
- If the notes specify a CTA pattern, write the cta field following that pattern. Reuse any literal links / UTM templates verbatim. Keep it short and factual — no hard sell.
- If the notes say NOTHING about a CTA, return an empty string for the cta field. Do not invent a CTA. An empty cta is the correct, expected output when the skill is silent.
- The cta is independent of media_action — a post can have a CTA reply with no media, or media on the main post with no CTA reply.

STRUCTURE RULE
When the prompt includes a "TOP-PERFORMING EXAMPLES IN THIS FORMAT" block and a recurring structural pattern shows up across those examples (e.g. opening hook + bulleted timestamp breakdown like "(2:46)", listicle with em-dashes, two-line setup + punchline, "Here's the top 1% of our chat:" + list, etc.), mirror that structure in your draft. Don't invent a structure that isn't repeated across the format examples; the platform-only examples are voice/tone reference, not structural.

OUTPUT RULES
- Ground every field in specifics from the transcript: numbers, named people, direct quotes, concrete outcomes. No generic platitudes.
- No clickbait the content can't back up.
- No hashtag walls.
- Match the tone implied by the reference posts when any are given.
- Call the propose_draft tool exactly once with a value for every content field AND a media_action. Never respond with plain text.`;

/** v1.3: the substantive input that grounds the agent's draft. Picked by
 *  `loadDraftSubstrate` in `src/lib/services/draft-algorithm/run.ts`. */
export type DraftSubstrate =
  | { kind: "transcript"; segmentsMarkdown: string; durationSec: number }
  | { kind: "source_body"; text: string; sourcePostType: string | null };

export interface PastCaptionExample {
  /** Original post URL when known; helps the model see real published copy. */
  publishedLink?: string | null;
  /** Plain-text caption body. Required. */
  caption: string;
  /** ISO timestamp; just used as ordering hint in the prompt. */
  publishedAt?: string | null;
  /** Lifetime views, when known. Lets the model bias toward higher-performing
   *  exemplars. */
  views?: number | null;
  /** v1.2: which pool this example came from. "format" = same brand + same
   *  post_type + same format (case-insensitive); the strongest structural
   *  signal. "platform" = same brand + same post_type only — top-up rows
   *  used as voice/tone reference when the format pool is sparse. The prompt
   *  builder splits these into two labeled blocks so the agent can apply
   *  the STRUCTURE RULE selectively. */
  source: "format" | "platform";
}

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
  /** v1.3: the substantive input the agent grounds its draft in. Either a
   *  long-form transcript (pillar derivatives) or the source post's text
   *  (text-primary cross-posts where the body IS the content). The
   *  per-call payload renders one block or the other. */
  substrate: DraftSubstrate;
  /** Past captions surfaced to the model as exemplars. v1.2: each entry
   *  carries a `source` tag — "format" rows are same-format winners (the
   *  STRUCTURE RULE points at these), "platform" rows are top-up
   *  voice/tone reference when the format pool is sparse. Pre-trim to ~8
   *  entries — long lists bloat the prompt without helping. View-ranked,
   *  not recency-ranked. */
  pastCaptions?: PastCaptionExample[];
  /** What pillar media exists and what the target platform's rule allows.
   *  Drives the `media_action` field on the tool output. */
  mediaContext: MediaContext;
}

/** The action the agent picks for media attachment on this draft. The
 *  service in `src/lib/services/draft-algorithm/run.ts` translates this
 *  into a `production_item_media` row insert (or no-op for `none`). */
export type MediaAction =
  | "attach_pillar_full_video"
  | "attach_pillar_poster"
  | "none";

export interface MediaContext {
  /** Whether the pillar has an archived full video (S3-backed `mediaS3Key`). */
  pillarHasFullVideo: boolean;
  /** Whether the pillar has an archived poster image (S3-backed `posterS3Key`). */
  pillarHasPoster: boolean;
  /** The target platform's media rule mode (`photos-or-video`, `single-video`,
   *  `single-any`, `carousel-mixed`, or `none`). Mirrors `PlatformMediaRule.mode`. */
  platformMode: string;
  /** Which media kinds the platform accepts. Mirrors `PlatformMediaRule.allowedKinds`. */
  platformAllowedKinds: ReadonlyArray<"image" | "video">;
  /** v1.4: media rows that are ALREADY attached to the item (e.g. cross-posts
   *  whose source had images — `seedRepostContent` mirrors source media onto
   *  the new row before the algorithm runs). When count > 0 the agent should
   *  pick `media_action: "none"` and compose a caption that assumes those
   *  attachments are visible. Optional; defaults to no attached media. */
  itemAlreadyHasMedia?: {
    count: number;
    kinds: ReadonlyArray<"image" | "video">;
  };
}

export interface GenerateDraftResult {
  content: ContentDraftContent;
  mediaAction: MediaAction;
  modelUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// Render the past-captions section of the prompt. v1.2: format-scoped and
// platform-scoped exemplars get separate blocks so the STRUCTURE RULE can
// point only at the format block. Returns null when there are no exemplars
// (caller filters nulls out of the prompt).
function renderPastCaptions(
  examples: PastCaptionExample[] | undefined,
  itemFormat: string | null,
): string | null {
  if (!examples || examples.length === 0) return null;
  const formatExamples = examples.filter((ex) => ex.source === "format");
  const platformExamples = examples.filter((ex) => ex.source === "platform");
  const renderBlock = (rows: PastCaptionExample[]): string =>
    rows
      .map((ex, i) => {
        const meta = [
          ex.views != null ? `${ex.views.toLocaleString()} views` : null,
          ex.publishedAt
            ? new Date(ex.publishedAt).toISOString().slice(0, 10)
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        const header = meta
          ? `--- example ${i + 1} (${meta}) ---`
          : `--- example ${i + 1} ---`;
        return `${header}\n${ex.caption.trim()}`;
      })
      .join("\n\n");

  const sections: string[] = [];
  if (formatExamples.length > 0 && itemFormat) {
    sections.push(
      [
        `## TOP-PERFORMING EXAMPLES IN THIS FORMAT — "${itemFormat}" (${formatExamples.length}, ranked by views)`,
        `Real published posts on the same brand + post_type + format. These are your structural template — see the STRUCTURE RULE in the system prompt. Higher-view examples are stronger signal.`,
        ``,
        renderBlock(formatExamples),
        ``,
      ].join("\n"),
    );
  }
  if (platformExamples.length > 0) {
    const titleSuffix =
      formatExamples.length > 0
        ? `OTHER STRONG EXAMPLES ON THIS PLATFORM (used as voice/tone reference, not structural)`
        : `TOP-PERFORMING EXAMPLES ON THIS PLATFORM`;
    sections.push(
      [
        `## ${titleSuffix} (${platformExamples.length}, ranked by views)`,
        formatExamples.length > 0
          ? `Top performers on the same brand + post_type but a different format. Use these for tone, sentence rhythm, voice — NOT for structure (see STRUCTURE RULE).`
          : `Real captions the team has already shipped on this platform. Match tone, rhythm, voice. Higher-view examples are stronger signal.`,
        ``,
        renderBlock(platformExamples),
        ``,
      ].join("\n"),
    );
  }
  return sections.length > 0 ? sections.join("\n") : null;
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
  // V1.1: media_action peer to the dynamic content fields. Always required
  // so the agent makes an explicit decision rather than silently omitting.
  // Service-side `resolveAttachment` re-validates against the platform rule
  // and skips if the agent picked something the platform doesn't actually
  // accept (belt-and-braces — the prompt also tells the model the rule).
  properties["media_action"] = {
    type: "string",
    enum: ["attach_pillar_full_video", "attach_pillar_poster", "none"],
    description:
      "Decide whether to attach pillar media to this post based on the format skill and the available pillar media + platform rule.",
  };
  required.push("media_action");
  return {
    type: "object" as const,
    properties,
    required,
  };
}

// Pull the media_action enum value out of the tool input. Defaults to "none"
// if missing or malformed (model should always emit it given the schema, but
// the service must never crash on a bad model output).
function normalizeMediaAction(raw: unknown): MediaAction {
  const input =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const value = input["media_action"];
  if (value === "attach_pillar_full_video" || value === "attach_pillar_poster") {
    return value;
  }
  return "none";
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

  // Stable preamble — same across every call for this format / platform.
  // Marked with a cache breakpoint so a Regenerate click within 5 minutes
  // (and any other call with the same format/platform context) reads the
  // cached prefix instead of paying full input-token cost.
  const stablePreamble = [
    `Target platform: ${args.item.platform?.[0] ?? "(unspecified)"}`,
    args.item.platform && args.item.platform.length > 1
      ? `Secondary platforms (not drafting for these): ${args.item.platform.slice(1).join(", ")}`
      : null,
    args.item.format ? `Source editorial format: ${args.item.format}` : null,
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
    renderPastCaptions(args.pastCaptions, args.item.format),
  ]
    .filter(Boolean)
    .join("\n");

  // Per-call payload — substrate + media context + task. Not cached:
  // substrate and pillar-media availability are per-item, and the task
  // block sits at the end so the cache breakpoint above it stays warm
  // across different items in the same format/platform run. v1.3: the
  // substrate block is either the pillar transcript (long-form
  // derivatives) or the source post body (text-primary cross-posts).
  const mc = args.mediaContext;
  const substrate = args.substrate;
  // v1.4: detect "rich" source bodies — multi-paragraph (newlines) or
  // long enough to carry real structure. With <120 chars and one line,
  // the agent gets the softer "adapt this" directive (sometimes there
  // genuinely isn't more to say). At ≥120 chars or multiline we know
  // there's a real post to fully ingest, so the directive turns into
  // "pull every concrete element."
  const isRichSourceBody =
    substrate.kind === "source_body" &&
    (substrate.text.length >= 120 || substrate.text.includes("\n"));
  const sourceBodyDirective = isRichSourceBody
    ? `This is the FULL source post text. Adapt it for the target platform — pull EVERY concrete element into the new post: every list item, every numbered example, every named person, the hook AND the closing. The output should feel like the same idea retold for the target platform's voice and field schema, not a one-line summary of the opener. Keep facts, numbers, and direct quotes verbatim where possible.`
    : `The original post text from the source platform. This IS the substance — there's no long-form video to transcribe; the post itself is what the team wants adapted to the target platform. Keep its concrete ideas, facts/numbers/named people, and angle. Change the format and voice to match the target platform's field schema and the past captions in this format. Don't paraphrase generically.`;
  const substrateBlock =
    substrate.kind === "transcript"
      ? [
          `Pillar title: ${args.pillarTitle ?? args.item.title ?? "(untitled)"}`,
          `Pillar duration: ${Math.round(substrate.durationSec)}s`,
          ``,
          `## PILLAR TRANSCRIPT`,
          `Transcript cues, pre-segmented with [MM:SS] timestamps. Pull specifics — numbers, names, direct quotes — from this.`,
          ``,
          substrate.segmentsMarkdown,
        ].join("\n")
      : [
          `Source post type: ${substrate.sourcePostType ?? "(unknown)"}`,
          `Source post title: ${args.pillarTitle ?? args.item.title ?? "(untitled)"}`,
          ``,
          `## SOURCE POST BODY`,
          sourceBodyDirective,
          ``,
          substrate.text,
        ].join("\n");

  const groundingPhrase =
    substrate.kind === "transcript"
      ? "Ground every field in specifics from the transcript."
      : "Ground every field in the source post's specifics; treat it as the canonical statement of the idea.";

  const alreadyAttached = mc.itemAlreadyHasMedia ?? { count: 0, kinds: [] };
  const alreadyAttachedLine =
    alreadyAttached.count > 0
      ? `Already attached on this post (mirrored from the source, will publish as-is): ${alreadyAttached.count} ${alreadyAttached.kinds.join("/") || "media"} ${alreadyAttached.count === 1 ? "item" : "items"} — pick media_action="none" and compose the caption assuming these are visible.`
      : `Already attached on this post: none.`;

  const perCallPayload = [
    substrateBlock,
    ``,
    `## MEDIA CONTEXT`,
    `Pillar media available:`,
    `- full_video: ${mc.pillarHasFullVideo ? "yes" : "no"}`,
    `- poster (cover image): ${mc.pillarHasPoster ? "yes" : "no"}`,
    alreadyAttachedLine,
    `Target platform media rule:`,
    `- mode: ${mc.platformMode}`,
    `- allowed kinds: ${mc.platformAllowedKinds.join(", ") || "(none)"}`,
    ``,
    `## TASK`,
    `Call propose_draft exactly once. Fill in every content field, AND set media_action per the MEDIA ACTION RULES. ${groundingPhrase} Match tone to any reference posts shown in the editorial notes${
      args.pastCaptions && args.pastCaptions.length > 0
        ? " AND to the past-caption exemplars"
        : ""
    }.`,
  ].join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools,
    tool_choice: { type: "tool", name: "propose_draft" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: stablePreamble,
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: perCallPayload },
        ],
      },
    ],
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
  const mediaAction = normalizeMediaAction(rawInput);

  return {
    content,
    mediaAction,
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
