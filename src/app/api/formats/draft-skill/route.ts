import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_DESCRIPTION_LEN = 800;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image (Anthropic cap)
const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Common post type strings → suggested platform array. The drafter
// returns the postType key; we map to a sensible default platform
// label set the operator can adjust in the dialog before saving.
const POST_TYPE_DEFAULTS: Record<
  string,
  { platform: string[]; aspect: "9:16" | "16:9" }
> = {
  instagram_reel: { platform: ["Instagram Reel"], aspect: "9:16" },
  instagram_post: { platform: ["Instagram Post"], aspect: "9:16" },
  instagram_story: { platform: ["Instagram Story"], aspect: "9:16" },
  tiktok: { platform: ["TikTok"], aspect: "9:16" },
  youtube_shorts: { platform: ["YouTube Shorts"], aspect: "9:16" },
  youtube_long: { platform: ["YouTube"], aspect: "16:9" },
  x: { platform: ["X"], aspect: "16:9" },
  linkedin: { platform: ["LinkedIn"], aspect: "16:9" },
  threads: { platform: ["Threads"], aspect: "9:16" },
  newsletter: { platform: ["Newsletter"], aspect: "16:9" },
};

const ALLOWED_POST_TYPES = Object.keys(POST_TYPE_DEFAULTS);

interface DraftSkillBody {
  description: string;
  brand: string;
  parentFormatId?: string | null;
  /** Optional base64-encoded screenshots of the format. Operator uploads
   *  them in the quick-add dialog when showing-by-example is faster than
   *  describing in words. Each image is passed to Haiku as a vision block
   *  alongside the description; Haiku extracts text, layout, structure,
   *  and incorporates the visual cues into the drafted Skill. */
  images?: Array<{
    mediaType: string;
    dataB64: string;
  }>;
}

interface DraftedFormat {
  name: string;
  instructions: string;
  suggestedPostType: string;
  suggestedPlatform: string[];
  suggestedAspectRatio: "9:16" | "16:9";
  suggestedParentFormatId: string | null;
}

const tools: Anthropic.Tool[] = [
  {
    name: "submit_format_draft",
    description:
      "Submit a complete draft of the format Skill + suggested metadata.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Short format name in title case, e.g. 'Reel: Tech Stack With Hook'. Mirror the brand's existing naming conventions.",
        },
        instructions: {
          type: "string",
          description:
            "Full markdown Skill — see the system prompt for required sections.",
        },
        suggestedPostType: {
          type: "string",
          enum: ALLOWED_POST_TYPES,
          description:
            "Best-guess production_items.post_type the operator can override.",
        },
      },
      required: ["name", "instructions", "suggestedPostType"],
    },
  },
];

const SYSTEM_PROMPT = `You are drafting a complete format Skill for the Hub & Spoke clip-idea agent. The Skill is markdown that downstream agents (Splice section picker, per-format hook writer, Descript Underlord) read at generation time. Your job: take the operator's one-line description (and any reference screenshots attached), infer the format's shape, and produce a polished Skill that matches the brand's voice.

When screenshots are attached, treat them as authoritative examples of the finished post. Extract the visible text, on-screen overlays/captions, layout (aspect ratio, where the hook sits, where media sits, reactions row, etc.), and any structural patterns (numbered lists, blockquotes, framing line + quotables, etc.). Reflect these in the Skill — especially in **## What this format is**, **## Clip Idea Generation** (hook style + extras-schema), and **## Descript Clip & Pack Info** (composition layout).

REQUIRED SECTIONS (in this exact order):

## What this format is
One paragraph. Be concrete: what does the final post look like? Vertical 30-60s Reel? Horizontal 16:9 X clip? Carousel of 8 IG slides?

## Why it works
2-4 sentences on the algorithmic + psychological reasons this format performs. Hook latency, density of payoff, scroll-stop mechanic, etc.

## Clip guidance
3-5 bullet points the editor follows when picking the moment. Where to start, where to end, what to look for, what to skip.

## Avoid
Bullet list of format-specific anti-patterns.

## Clip Idea Generation
The agent-facing section. Required sub-sections (use **bold** prefixes, no h3s):
- **Hook style.** What the hook IS for this format (narrator overlay vs. third-person framing vs. listicle reveal vs. quote pull). Reference brand voice. 2-3 example hook patterns when useful.
- **Target runtime.** Clip length sweet spot in seconds.
- **Anti-patterns.** Format-specific things the hook must NEVER do.
- **Output extras** (optional, only when the format needs per-idea fields beyond hook/angle/rationale): declare with a fenced \`\`\`extras-schema\`\`\` JSON block. Properties become required fields on each generated idea. Example for an X-Quotables-style format:

\`\`\`extras-schema
{
  "quotables": {
    "type": "array",
    "items": { "type": "string" },
    "minItems": 3,
    "maxItems": 3,
    "description": "Three verbatim transcript pulls, each one paragraph, each inside [startSec, endSec]."
  }
}
\`\`\`

## Descript Clip & Pack Info
The Underlord-facing section. Describe the composition layout (aspect ratio, hook overlay placement, caption styling, end-card or none), filler-word handling, target export resolution. Use placeholders \`{{hook}}\`, \`{{startTimestamp}}\`, \`{{endTimestamp}}\`, \`{{durationSec}}\`, \`{{aspectRatio}}\`, \`{{quotables}}\` (only the last two are v10+; earlier formats may not use them).

## Cross Post Rules
Bullet list of how this format's clips translate to other platforms when cross-posted. Framing, caption shape, link/CTA behavior.

NAMING CONVENTION:
- Reels-style: "Reel: <Topic> With Hook" or "Reel: Repackage <Topic>"
- X-style: "X <Topic>" or "<Topic> Quotables"
- TikTok: "TikTok: <Topic>"
- Brand-specific: mirror existing sibling format names when given.

You will be given the brand's existing format names + a few sibling format Skills as voice grounding. Match the brand's tone — the Skill goes to the same agents that read sibling Skills.

OUTPUT: call submit_format_draft exactly once. Never plain text.`;

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  let body: DraftSkillBody;
  try {
    body = (await request.json()) as DraftSkillBody;
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? `Bad request: ${err.message}` : "Bad request",
      },
      { status: 400 },
    );
  }
  const description = (body.description ?? "").trim();
  const brand = (body.brand ?? "").trim();
  if (!description) {
    return NextResponse.json(
      { error: "description is required" },
      { status: 400 },
    );
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    return NextResponse.json(
      {
        error: `description too long (max ${MAX_DESCRIPTION_LEN} chars; got ${description.length})`,
      },
      { status: 400 },
    );
  }
  if (!brand) {
    return NextResponse.json(
      { error: "brand is required" },
      { status: 400 },
    );
  }

  // Validate image attachments. Reject early so a 5MB-per-image enforced
  // upstream doesn't surprise Anthropic with a 400.
  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES) {
    return NextResponse.json(
      { error: `too many images (max ${MAX_IMAGES}; got ${rawImages.length})` },
      { status: 400 },
    );
  }
  const validatedImages: { mediaType: string; dataB64: string }[] = [];
  for (const [i, img] of rawImages.entries()) {
    if (
      !img ||
      typeof img.mediaType !== "string" ||
      typeof img.dataB64 !== "string"
    ) {
      return NextResponse.json(
        { error: `image #${i + 1} malformed: expected { mediaType, dataB64 }` },
        { status: 400 },
      );
    }
    if (!ALLOWED_IMAGE_MIME.has(img.mediaType)) {
      return NextResponse.json(
        {
          error: `image #${i + 1} unsupported mediaType "${img.mediaType}" (allowed: ${[...ALLOWED_IMAGE_MIME].join(", ")})`,
        },
        { status: 400 },
      );
    }
    // base64 length × 0.75 ≈ decoded byte count.
    const approxBytes = Math.floor(img.dataB64.length * 0.75);
    if (approxBytes > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        {
          error: `image #${i + 1} too large (max ${MAX_IMAGE_BYTES} bytes; got ~${approxBytes})`,
        },
        { status: 400 },
      );
    }
    validatedImages.push(img);
  }

  // Validate parentFormatId belongs to the same brand (if provided).
  if (body.parentFormatId) {
    const [parent] = await db
      .select({ brand: formats.brand })
      .from(formats)
      .where(eq(formats.id, body.parentFormatId))
      .limit(1);
    if (!parent) {
      return NextResponse.json(
        { error: "parentFormatId not found" },
        { status: 400 },
      );
    }
    if (parent.brand !== brand) {
      return NextResponse.json(
        { error: "parentFormatId belongs to a different brand" },
        { status: 400 },
      );
    }
  }

  // Pull up to 3 sibling format Skills for brand-voice grounding. Prefer
  // clippable formats (they have the Clip Idea Generation section already).
  const siblings = await db
    .select({
      name: formats.name,
      instructions: formats.instructions,
    })
    .from(formats)
    .where(
      and(
        eq(formats.brand, brand),
        eq(formats.isClippableFormat, true),
        isNotNull(formats.instructions),
      ),
    )
    .limit(3);

  const brandVoiceBlock =
    siblings.length > 0
      ? siblings
          .map(
            (s, i) =>
              `--- Sibling #${i + 1}: "${s.name}" ---\n${(s.instructions ?? "").slice(0, 2000)}`,
          )
          .join("\n\n")
      : `(No sibling clippable formats on this brand yet. Match general voice and use sensible defaults.)`;

  const userText = [
    `Brand: ${brand}`,
    body.parentFormatId
      ? `Parent format id: ${body.parentFormatId}`
      : null,
    ``,
    `Operator's description of the format they want:`,
    description,
    validatedImages.length > 0
      ? `\n${validatedImages.length} screenshot${validatedImages.length === 1 ? "" : "s"} of the format are attached below — extract the visible text, layout, structure, and any on-screen overlays/captions. Treat the images as authoritative when they disagree with the description.`
      : null,
    ``,
    `Brand-voice grounding (existing clippable formats on this brand):`,
    brandVoiceBlock,
    ``,
    `Draft the full Skill + suggested name + suggested post_type via submit_format_draft.`,
  ]
    .filter(Boolean)
    .join("\n");

  type ContentBlock =
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      };
  const content: ContentBlock[] = [{ type: "text", text: userText }];
  for (const img of validatedImages) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.dataB64,
      },
    });
  }

  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools,
    tool_choice: { type: "tool", name: "submit_format_draft" },
    messages: [
      {
        role: "user",
        content: content as unknown as Anthropic.MessageParam["content"],
      },
    ],
  });

  type DraftedInput = {
    name?: string;
    instructions?: string;
    suggestedPostType?: string;
  };
  let drafted: DraftedInput | null = null;
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "submit_format_draft") {
      drafted = block.input as DraftedInput;
      break;
    }
  }

  if (!drafted || !drafted.name || !drafted.instructions || !drafted.suggestedPostType) {
    return NextResponse.json(
      {
        error: "drafter returned no usable result",
        stopReason: response.stop_reason,
      },
      { status: 502 },
    );
  }

  const postTypeKey = drafted.suggestedPostType.trim();
  if (!POST_TYPE_DEFAULTS[postTypeKey]) {
    return NextResponse.json(
      {
        error: `drafter returned unknown post type "${postTypeKey}". Expected one of: ${ALLOWED_POST_TYPES.join(", ")}`,
      },
      { status: 502 },
    );
  }
  const defaults = POST_TYPE_DEFAULTS[postTypeKey];

  const result: DraftedFormat = {
    name: drafted.name.trim(),
    instructions: drafted.instructions.trim(),
    suggestedPostType: postTypeKey,
    suggestedPlatform: defaults.platform,
    suggestedAspectRatio: defaults.aspect,
    suggestedParentFormatId: body.parentFormatId ?? null,
  };

  return NextResponse.json(result);
}
