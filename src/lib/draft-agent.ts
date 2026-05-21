import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type {
  ContentDraftContent,
  ContentDraftSlide,
  FormatFieldSchema,
} from "@/lib/db/schema";
import type { PostType } from "@/lib/platform-field-schemas";
import {
  getPlatformProximity,
  proximityDirective,
} from "@/lib/services/draft-algorithm/platform-proximity";
import {
  renderPriorCrossPostExamples,
  type PriorCrossPostExample,
} from "@/lib/services/draft-algorithm/prior-cross-post-examples";
import { findInterestingTimestamps } from "@/lib/services/draft-algorithm/timestamp-finder";

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
// v8 (2026-05-10): agentic tool loop. The agent now picks tool calls
// itself (tool_choice: "auto"); a TOOLS section in the system prompt
// describes when to invoke specialized tools vs proposing the draft
// directly. First tool is find_interesting_timestamps — see
// src/lib/services/draft-algorithm/timestamp-finder.ts. Tool is
// registered only when substrate.kind === "transcript".
// v9 (2026-05-10): Skill-count adherence. TOOLS section now instructs
// the agent to mirror counts the Skill specifies (e.g. "4-6 timestamp
// bulletpoints") when calling find_interesting_timestamps, and to
// retry ONCE with broader focus if the tool short-returns. The tool
// result body now carries `requestedCount` + `validatedCount` so the
// agent can reason about gaps structurally rather than counting an
// array by eyeballing it.
// v10 (2026-05-10): length-from-exemplars. The X tweet field had a
// hardcoded 280-char cap baked into BOTH the JSON schema maxLength
// AND the field's per-field prompt ("Hard cap 280 chars"). That was
// the free-tier limit; @starter_story is verified and posts long-form
// X up to ~25K chars. Top-performing "Full Video On X!" tweets in the
// exemplar pool are 400-600 chars with 5-6 timestamp bullets — the
// cap was forcing the agent to truncate. Schema cap bumped to 25000
// (X's real ceiling), prompt rewritten to teach length-from-exemplars.
// New OUTPUT RULE here reinforces the same principle agent-wide:
// length comes from the exemplar pool, not from a hardcoded cap.
// v11 (2026-05-15): cross-post caption rules section. Format Skill can now
// carry a `### Cross Post Caption Rules` block that the algorithm passes
// through as a HARD OVERRIDE. Designed to fix the failure mode where the
// 231K-view long-thread exemplar at the top of a format pool teaches every
// new cross-post to expand, even when the format's other winners are
// hook-only. Section is opt-in per format — empty/missing falls through to
// pure exemplar-driven inference.
// v12 (2026-05-15): CTA reply is now always-on for platforms with a `cta`
// field (x, linkedin, youtube_community). Previous CTA RULES required the
// format Skill to spell out a pattern — agents returned "" otherwise,
// shipping every X / LinkedIn / YT Community draft with an empty "Add a
// reply with the CTA..." placeholder. CTA RULES replaced with CTA BASELINE
// TEMPLATE: fixed "If you want more stuff like this, check out\n\n<link>"
// shape, with `utm_source` + `utm_campaign` paste-from-context UTMs. Format
// Skill still wins when it specifies an explicit CTA pattern. Anthropic
// native `web_search_20250305` server tool registered (max_uses: 2) so the
// agent can find a published starterstory.com episode URL when the format
// calls for the episode rather than a lead magnet. CTA context (channel +
// utmCampaign) rendered as a per-call payload block; no schema changes.
// v13 (2026-05-20): platform-proximity rewrite directive. The v7 "rich vs
// soft" SOURCE POST BODY directive keyed off source body length (≥120 chars
// or multiline → "pull every concrete element"), which had no awareness of
// the *target* platform. Threads → X cross-posts got rewritten as if they
// were Threads → YouTube Community, even though X and Threads are
// near-identical surfaces. Replaced with three tiers driven by
// (sourcePostType, targetPostType): same_surface (x ↔ threads) → preserve
// verbatim; same_family (text-primary triad crossings, visual-primary
// caption family) → preserve spine, tighten/expand at edges; cross_family
// (everything else) → legacy "pull every concrete element." Logic lives in
// src/lib/services/draft-algorithm/platform-proximity.ts. New PROXIMITY
// RULE section in the system prompt pairs with the existing STRUCTURE
// RULE. args.item now carries postType; the per-call payload renders the
// proximity directive in the SOURCE POST BODY block when the substrate is
// a source body (transcript substrates ignore proximity — they always
// adapt cross-family).
export const PROMPT_VERSION = 13;
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

CTA BASELINE TEMPLATE
For platforms with a "cta" field (X reply tweet, LinkedIn first comment, YouTube Community pinned comment), you must ALWAYS write a reply CTA. The cta is independent of media_action — a post can have a CTA reply with no media, or media on the main post with no CTA reply.

Default shape — exactly two lines of copy with a blank line between (a literal "\\n\\n" separator):

  If you want more stuff like this, check out

  <link>

Where <link> is chosen in this order of preference:
1. If FORMAT REFERENCES & EDITORIAL NOTES specify a URL (a lead-magnet path like starterstory.com/<slug>, or an explicit episode-link directive), use that URL.
2. If the editorial notes say to link to "the actual episode" — or the pillar is clearly a Starter Story podcast / interview episode and the format calls for the episode URL — call the web_search tool with the pillar title to find the published starterstory.com episode URL, then use that URL. Don't invent episode URLs; if web_search returns nothing usable, fall back to the lead-magnet default in step 3.
3. Otherwise default to https://starterstory.com/micro.

Append UTM params to the chosen link, using the values in the CTA CONTEXT block verbatim:
- utm_source={channel}
- utm_campaign={utmCampaign}    (drop this param entirely when CTA CONTEXT shows utmCampaign as "(none)")
- Use "?" as the separator before the first param, then "&" between params. NEVER use "/" as a separator — that turns a query param into a path segment and breaks the link.

URL CONSTRUCTION EXAMPLES (follow these verbatim):
- channel="x", utmCampaign="hello-123", base="https://starterstory.com/micro"
  → https://starterstory.com/micro?utm_source=x&utm_campaign=hello-123
- channel="linkedin", utmCampaign="(none)", base="https://starterstory.com/solo"
  → https://starterstory.com/solo?utm_source=linkedin
- channel="ytcommunity", utmCampaign="ep-42", base="https://starterstory.com/episode/founder-burnout"
  → https://starterstory.com/episode/founder-burnout?utm_source=ytcommunity&utm_campaign=ep-42

OVERRIDE: if FORMAT REFERENCES & EDITORIAL NOTES specify a different CTA copy, link shape, or template, follow the Skill — Skill wins over the baseline. The baseline applies when the Skill is silent on CTAs.

STRUCTURE RULE
When the prompt includes a "TOP-PERFORMING EXAMPLES IN THIS FORMAT" block and a recurring structural pattern shows up across those examples (e.g. opening hook + bulleted timestamp breakdown like "(2:46)", listicle with em-dashes, two-line setup + punchline, "Here's the top 1% of our chat:" + list, etc.), mirror that structure in your draft. Don't invent a structure that isn't repeated across the format examples; the platform-only examples are voice/tone reference, not structural.

PROXIMITY RULE
Cross-post drafts (## SOURCE POST BODY substrate) include a PROXIMITY line that classifies the source-vs-target platform pair as same_surface, same_family, or cross_family. The directive on that line HARD-OVERRIDES the past-caption exemplars on the question of *how much rewriting to do*. Exemplars still teach voice and structure, but not aggressiveness. Specifically:
- same_surface (e.g. x ↔ threads): the source post and the target draft should be near-identical. Preserve the hook, the wording, the line breaks, the closing. Only adjust if the target platform's character cap forces a trim, or a token like a handle or URL must swap. Do not paraphrase, do not reorder, do not add or remove substance — even if the past-caption exemplars show longer or more elaborate posts.
- same_family (e.g. threads → linkedin, instagram_post ↔ tiktok): preserve the spine — same hook idea, same structure, same named specifics. Tighten or expand at the edges only as the past-caption exemplars demand for the target platform's length norms. Do not invent new content or restructure.
- cross_family (everything else): the legacy "pull every concrete element" behavior applies. Past-caption exemplars drive structure; the source post grounds the substance.
Transcript substrates (## PILLAR TRANSCRIPT) do not carry a PROXIMITY line — they're always cross_family by definition (long-form video → short post).

TOOLS
You have specialized tools available in this conversation. Treat them as capabilities you should USE rather than guess at. Tool calls are cheap; hallucinations are expensive.

- find_interesting_timestamps — call this whenever the format Skill mentions timestamps, real timestamps, or "pulling moments from the video." Reads the pillar transcript directly and returns N curated MM:SS picks with editor-voice labels. Never invent timestamps from your own scan of the transcript text — use this tool, then compose the draft using the timestamps it returns. You can call it multiple times if the format wants distinct lists (e.g. "5 strategy moments AND 3 funny moments").

HONORING SKILL COUNTS
If the Skill specifies a count (e.g. "4-6 timestamp bulletpoints", "top 5 sections", "exactly 3 takeaways"), pass that count to find_interesting_timestamps and write the corresponding number of items in the draft. Read the tool's response carefully — it returns { requestedCount, validatedCount, timestamps }. If validatedCount < the Skill's minimum, call find_interesting_timestamps ONE more time with a broader or different focus string before settling for fewer. After one retry, accept whatever the tool returned and compose the draft with that many items. Don't fabricate extra picks to hit the count.

When you've gathered everything you need, call propose_draft as your final tool call. Never respond with plain text.

OUTPUT RULES
- Ground every field in specifics from the transcript: numbers, named people, direct quotes, concrete outcomes. No generic platitudes.
- No clickbait the content can't back up.
- No hashtag walls.
- Match the tone implied by the reference posts when any are given.
- LENGTH: learn appropriate length from the past-caption exemplars in this format. Don't pin yourself to platform free-tier limits (e.g. 280-char tweets) — the accounts we post to are verified and post long-form. If the top exemplars run 400–600 chars with 5–6 bullets, your draft should too. A short, truncated draft that loses the bullet structure is WORSE than a longer draft that fits all the elements the format Skill calls for.
- Call the propose_draft tool exactly once with a value for every content field AND a media_action. Never respond with plain text.`;

/** v1.3: the substantive input that grounds the agent's draft. Picked by
 *  `loadDraftSubstrate` in `src/lib/services/draft-algorithm/run.ts`.
 *  v1.5: transcript variant now carries the raw segments array so the
 *  `find_interesting_timestamps` tool can ground picks in real segment
 *  text, not just the rendered markdown. Optional for back-compat with
 *  callers that only have markdown (e.g. the smoke test). */
export type DraftSubstrate =
  | {
      kind: "transcript";
      segmentsMarkdown: string;
      durationSec: number;
      segments?: ReadonlyArray<{
        startSec: number;
        endSec: number;
        text: string;
        speaker?: string;
      }>;
    }
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
    /** Target post type (where the draft is being generated for). Used by
     *  the v13 proximity rule to pick the SOURCE POST BODY directive
     *  (same_surface vs same_family vs cross_family). May be null on
     *  legacy callers (smoke tests, unsupported platforms); the proximity
     *  helper falls back to cross_family in that case. */
    postType: PostType | string | null;
  };
  fieldSchema: FormatFieldSchema;
  formatInstructions: string | null;
  /** Extracted `### Cross Post Caption Rules` body from the SOURCE format's
   *  Skill. Only set on cross_post sourceType. When present, it's rendered
   *  as a hard-rule block in the system prompt that OVERRIDES exemplar
   *  inference for caption shape — e.g. "for X: just the on-screen hook,
   *  no thread." Use this when the format's top-views exemplar is misleading
   *  (the 231K-view long thread teaching every new X cross-post to expand). */
  crossPostCaptionRules?: string | null;
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
  /** v12: CTA reply context. Set only when the target post type carries a
   *  `cta` field (x / linkedin / youtube_community). When present, the agent
   *  is told to always write a reply CTA following the CTA BASELINE TEMPLATE
   *  (system prompt) and is given the literal channel + utmCampaign values
   *  to paste into the link's UTMs. Also gates registration of the
   *  Anthropic `web_search_20250305` server tool — the agent can look up the
   *  pillar's published episode URL when the Skill calls for the episode
   *  rather than a lead magnet. Absent when the post type has no CTA slot
   *  (instagram_*, tiktok, threads, youtube_long/shorts) — same single-shot
   *  shape as v11 for those. */
  cta?: { channel: string; utmCampaign: string | null };
  /** v13: real prior cross-post pairs from the team's publishing history,
   *  scoped to the same (accountId, sourcePostType → targetPostType)
   *  direction. The agent treats these as the canonical answer to "how
   *  much rewriting is appropriate" for this direction — they HARD-OVERRIDE
   *  the past-caption exemplars on aggressiveness (exemplars still teach
   *  voice and structure). Pre-trimmed to ≤3 by the caller; absent when
   *  no pairs exist yet (then the proximity rule is the only signal). */
  priorCrossPostExamples?: PriorCrossPostExample[];
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

/**
 * v13: structured error thrown by `generateDraft` when the agent returns
 * an invalid draft after the one-shot retry. The worker task catches
 * this and records it as a failed run instead of writing an empty draft
 * to `content_drafts`. `code` is the machine-readable failure category;
 * `details` carries the offending field keys so the worker can surface
 * "YouTube Community body came back empty" in operator logs.
 */
export class DraftGenerationError extends Error {
  readonly code: "empty_required_field";
  readonly details: { emptyFields: string[] };
  constructor(
    code: "empty_required_field",
    message: string,
    details: { emptyFields: string[] },
  ) {
    super(message);
    this.name = "DraftGenerationError";
    this.code = code;
    this.details = details;
  }
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

/**
 * v13: post-call required-field validation. After the agent's
 * propose_draft call, walk the platform's field schema and report any
 * field marked `required: true` whose value normalizes to empty (empty
 * string for text/longtext, empty array for tags/slides). The agent loop
 * uses this to decide whether to ask for one corrective retry.
 *
 * Why this exists: YouTube Community has `body: required: true` (see
 * platform-field-schemas.ts) but the propose_draft tool's JSON Schema
 * doesn't enforce minLength, so the agent can return `body: ""` and the
 * draft lands in the DB with a blank placeholder. This catches that.
 */
export function findEmptyRequiredFields(
  raw: unknown,
  fieldSchema: FormatFieldSchema,
): string[] {
  const content = normalizeContent(raw, fieldSchema);
  const empty: string[] = [];
  for (const field of fieldSchema.fields) {
    if (!field.required) continue;
    const value = content[field.key];
    if (typeof value === "string") {
      if (value.trim().length === 0) empty.push(field.key);
    } else if (Array.isArray(value)) {
      if (value.length === 0) empty.push(field.key);
    } else if (value == null) {
      empty.push(field.key);
    }
  }
  return empty;
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

/**
 * Wrap `client.messages.create` with retries on Anthropic 529
 * (overloaded_error). Brief Anthropic capacity blips during peak hours
 * surface as "couldn't redraft" toasts otherwise; a short backoff covers
 * the common case where the next request lands on a less-loaded shard.
 *
 * Schedule: initial attempt + 2 retries at 1s then 3s (≤4s extra latency
 * worst case). 2026-05-19 bumped from 1 retry after a fresh 529 paged
 * Sentry. Persistent overloads still fail fast — unbounded retry would
 * stack 30s/call latency for users staring at a spinner.
 */
const OVERLOAD_RETRY_DELAYS_MS = [1000, 3000];

async function createMessagesWithOverloadRetry(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt <= OVERLOAD_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      const isOverload =
        err instanceof Anthropic.APIError &&
        (err.status === 529 ||
          ("error" in err &&
            typeof (err as { error?: { type?: string } }).error?.type ===
              "string" &&
            (err as { error: { type: string } }).error.type ===
              "overloaded_error"));
      if (!isOverload) throw err;
      if (attempt === OVERLOAD_RETRY_DELAYS_MS.length) {
        // Out of retries; let the caller surface this as a draft failure.
        throw err;
      }
      const delay = OVERLOAD_RETRY_DELAYS_MS[attempt];
      console.warn(
        `draft-agent: Anthropic 529 overloaded — retry ${attempt + 1}/${OVERLOAD_RETRY_DELAYS_MS.length} after ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error("createMessagesWithOverloadRetry: loop exited unexpectedly");
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

  // v12: register Anthropic's native web_search server tool when this draft
  // has a CTA slot. The CTA BASELINE TEMPLATE tells the agent to call it
  // ONLY when the format Skill or context implies "link to the actual
  // episode" — most drafts will skip the call and pay nothing for the tool.
  // max_uses caps the worst case at 2 searches per draft (one primary +
  // one refinement). Cast through unknown because the SDK's `Tool` type may
  // not yet cover server-tool variants in all versions; the API accepts it.
  if (args.cta) {
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 2,
    } as unknown as Anthropic.Tool);
  }

  // v1.5: register find_interesting_timestamps only when we actually have
  // transcript segments to query. Cross-posts using source-body substrate
  // have no timestamps to find — exposing the tool would just waste an
  // iteration and confuse the model.
  const transcriptSegments =
    args.substrate.kind === "transcript" && args.substrate.segments
      ? args.substrate.segments
      : null;
  if (transcriptSegments && transcriptSegments.length > 0) {
    tools.push({
      name: "find_interesting_timestamps",
      description:
        "Find N real timestamps from the pillar video's transcript matching an editorial focus. Use this when the format Skill calls for timestamps in the copy — never invent timestamps from your own scan of the transcript text. Returns an array of { mmss, label, reason } records with the start times of real segments. Multiple calls are fine when you need distinct lists.",
      input_schema: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            description:
              "What KIND of moments to find. Lift this from the format Skill where possible — e.g. 'most interesting moments for a business breakdown', 'the funniest moments', 'moments about pricing strategy'.",
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description:
              "How many timestamps to return. Default 5 unless the format Skill specifies otherwise.",
          },
        },
        required: ["focus", "count"],
      },
    });
  }

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
    args.crossPostCaptionRules
      ? [
          `## CROSS-POST RULES (HARD OVERRIDE — read carefully)`,
          `These team-authored rules are AUTHORITATIVE and OVERRIDE anything you'd otherwise infer from the past captions / exemplars block below. The exemplar pool is ranked by views, but the top performer can teach the wrong shape for this specific cross-post; these rules trump it.`,
          ``,
          `The section is shared with the Descript framing pipeline (which reads bullets about aspect ratio / orientation) — bullets that talk about CAPTION SHAPE / BODY / HOOK are for you; bullets that talk about VIDEO FRAMING / ASPECT / ORIENTATION are for the framing pipeline and you can ignore them. If a bullet is unclear, prefer following it over ignoring it.`,
          ``,
          args.crossPostCaptionRules,
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
  // v13: source body directive is driven by platform proximity, not by
  // source body length. The (sourcePostType, targetPostType) pair maps to
  // same_surface / same_family / cross_family, and each tier carries its
  // own rewrite-aggressiveness directive. Replaces the v7 rich/soft
  // length-based heuristic.
  const proximity =
    substrate.kind === "source_body"
      ? getPlatformProximity(
          (substrate.sourcePostType ?? null) as PostType | null,
          (args.item.postType ?? null) as PostType | null,
        )
      : null;
  const sourceBodyDirective =
    substrate.kind === "source_body" && proximity
      ? proximityDirective(
          proximity,
          (substrate.sourcePostType ?? null) as PostType | null,
          (args.item.postType ?? null) as PostType | null,
        )
      : null;
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

  // v12: CTA CONTEXT block. Only rendered when this post type has a `cta`
  // field. Carries the channel + utm_campaign values for the agent to
  // paste verbatim — keeps the agent from inventing UTM strings or
  // copying placeholders into the live draft.
  const ctaContextBlock = args.cta
    ? [
        `## CTA CONTEXT`,
        `Use these literal values when constructing the CTA reply's link UTMs (CTA BASELINE TEMPLATE in the system prompt explains the rules):`,
        `- channel: ${args.cta.channel}`,
        `- utmCampaign: ${args.cta.utmCampaign ?? "(none)"}`,
        ``,
      ].join("\n")
    : null;

  // v13: PRIOR CROSS-POST EXAMPLES block. Real (source → target) pairs
  // from this account's publishing history, in the same direction as the
  // current draft. Strongest signal for "how much rewriting" — the agent's
  // PROXIMITY RULE in the system prompt tells it to hard-override the
  // past-caption exemplars on aggressiveness when these are present.
  // Sits above the substrate so it lands inside the cache breakpoint
  // boundary alongside the static-per-format past-captions; it's
  // per-direction state, not per-item, so the cache benefit holds when
  // multiple drafts of the same item are kicked off.
  const priorPairsBlock =
    substrate.kind === "source_body" && args.priorCrossPostExamples
      ? renderPriorCrossPostExamples(
          args.priorCrossPostExamples,
          substrate.sourcePostType ?? null,
          (args.item.postType as string | null) ?? null,
        )
      : null;

  const perCallPayload = [
    ctaContextBlock,
    priorPairsBlock,
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
  ]
    .filter(Boolean)
    .join("\n");

  // v1.5: multi-turn agentic loop. The agent picks tool calls itself
  // (tool_choice: "auto"); we run any non-final tools (currently
  // find_interesting_timestamps), append the result, and re-call.
  // Final tool is propose_draft — when seen we extract and return.
  // MAX_ITERATIONS is a safety net; in practice a normal draft is 1–2
  // iterations (zero or one timestamp call + the propose_draft call).
  const MAX_ITERATIONS = 5;
  const messages: Anthropic.MessageParam[] = [
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
  ];

  // Cumulative token usage across iterations — modelUsage on the
  // resulting content_drafts row reports the full draft cost, not just
  // the final iteration.
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  let proposeDraftInput: unknown = null;
  // v13: one-shot retry when the agent returns a propose_draft input that
  // leaves a required field empty. Tracks whether we've already issued the
  // corrective message so the loop can throw a DraftGenerationError after
  // the second strike rather than burning all 5 iterations on the same
  // failure mode.
  let emptyRequiredFieldRetried = false;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const response = await createMessagesWithOverloadRetry(client, {
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
      tool_choice: { type: "auto" },
      messages,
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    cacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;
    cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

    if (response.stop_reason !== "tool_use") {
      // Plain-text response with no tool call. Normally the system
      // prompt forbids this but bail loud rather than silent.
      throw new Error(
        `draft-agent: model stopped without tool call (stop_reason=${response.stop_reason})`,
      );
    }

    // Append the assistant's full response so the conversation history
    // round-trips correctly to the next iteration. content blocks are
    // already in the SDK's expected shape.
    messages.push({ role: "assistant", content: response.content });

    // Find any tool_use blocks. If propose_draft is present, that's
    // terminal — extract it and exit. Otherwise run any other tool
    // calls (currently just find_interesting_timestamps), build
    // tool_result blocks, append, and loop.
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const proposeBlock = toolUses.find((b) => b.name === "propose_draft");
    if (proposeBlock) {
      // v13: validate required fields before accepting the draft. If any
      // field marked `required: true` in the platform's field schema is
      // empty, ask the agent to try again ONCE with a pointed correction
      // message. After that, throw — silently writing an empty
      // youtube_community body is the original bug we're fixing here.
      const emptyFields = findEmptyRequiredFields(
        proposeBlock.input,
        args.fieldSchema,
      );
      if (emptyFields.length === 0 || emptyRequiredFieldRetried) {
        if (emptyFields.length > 0) {
          throw new DraftGenerationError(
            "empty_required_field",
            `propose_draft returned empty required field(s) after retry: ${emptyFields.join(", ")}`,
            { emptyFields },
          );
        }
        proposeDraftInput = proposeBlock.input;
        break;
      }
      // Build the corrective tool_result + user message. Every tool_use
      // block must have a matching tool_result before the next API call,
      // including the propose_draft block we're rejecting — Anthropic
      // 400s otherwise.
      emptyRequiredFieldRetried = true;
      const fieldDetails = emptyFields
        .map((key) => {
          const fieldDef = args.fieldSchema.fields.find((f) => f.key === key);
          const label = fieldDef?.label ?? key;
          const desc = fieldDef?.prompt ?? "(no per-field directive)";
          return `- "${key}" (${label}): ${desc}`;
        })
        .join("\n");
      const correctiveText = `Your previous propose_draft call left these required fields empty:\n${fieldDetails}\n\nCall propose_draft again with non-empty values for all of those fields, grounded in the source post / transcript. Keep your previous values for the other fields unless they were also wrong.`;
      console.warn(
        `draft-agent v13: empty required field(s) ${emptyFields.join(", ")} — issuing one corrective retry`,
      );
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: proposeBlock.id,
            content: correctiveText,
            is_error: true,
          },
        ],
      });
      continue;
    }

    if (toolUses.length === 0) {
      // stop_reason was "tool_use" but no tool_use blocks. Shouldn't
      // happen but bail rather than infinite-loop.
      throw new Error("draft-agent: stop_reason=tool_use but no tool blocks");
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name === "find_interesting_timestamps") {
        const input = (tu.input ?? {}) as { focus?: unknown; count?: unknown };
        const focus = typeof input.focus === "string" ? input.focus : "";
        const rawCount =
          typeof input.count === "number" ? Math.round(input.count) : 5;
        const count = Math.max(1, Math.min(10, rawCount));
        // v1.6: log the agent's intent (focus + count) before running
        // the tool. Pat can audit Skill adherence by checking that this
        // count matches what the Skill specified.
        console.info(
          `draft-agent v1.6 tool=find_interesting_timestamps iter=${iter} focus="${focus.slice(0, 120)}" count=${count}`,
        );
        const segments = transcriptSegments ?? [];
        let resultBody: string;
        try {
          const found = await findInterestingTimestamps({
            segments,
            formatInstructions: args.formatInstructions,
            focus: focus || "most interesting moments",
            count,
          });
          // v1.6: tool_result carries structured counts so the agent
          // can decide whether to retry (validatedCount < requestedCount).
          // The HONORING SKILL COUNTS rule in the system prompt tells it
          // to retry once with a broader focus before accepting fewer.
          resultBody = JSON.stringify({
            requestedCount: count,
            validatedCount: found.length,
            timestamps: found.map((f) => ({
              mmss: f.mmss,
              label: f.label,
              reason: f.reason,
            })),
            note:
              found.length === 0
                ? "Tool returned no validated timestamps. Retry with a different focus, or compose without timestamps."
                : found.length < count
                  ? `Tool returned ${found.length} of ${count} requested. If the Skill requires more, retry ONCE with a broader focus before accepting.`
                  : undefined,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          resultBody = JSON.stringify({
            error: `find_interesting_timestamps failed: ${message}`,
          });
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: resultBody,
        });
      } else {
        // Unknown tool — surface a clear error result so the agent can
        // recover (e.g. immediately call propose_draft).
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({
            error: `Unknown tool: ${tu.name}. Call propose_draft now.`,
          }),
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  if (!proposeDraftInput) {
    throw new Error(
      `draft-agent: tool loop exceeded ${MAX_ITERATIONS} iterations without a propose_draft call`,
    );
  }

  const content = normalizeContent(proposeDraftInput, args.fieldSchema);
  const mediaAction = normalizeMediaAction(proposeDraftInput);

  return {
    content,
    mediaAction,
    modelUsage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreationTokens || undefined,
      cache_read_input_tokens: cacheReadTokens || undefined,
    },
  };
}
