import type { FormatFieldSchema } from "@/lib/db/schema";

// Canonical platform keys. Historical `productionItems.platform[]` values
// collapse to these via normalizePlatform() — "Twitter"/"X"/"X (Starter
// Story)" / "X (Pat Walls)" all map to `x`, the four YouTube variants to
// `youtube_long`, and so on.
export type PlatformKey =
  | "x"
  | "instagram_reel"
  | "instagram_post"
  | "instagram_story"
  | "youtube_long"
  | "youtube_shorts"
  | "linkedin"
  | "newsletter"
  | "tiktok"
  | "threads";

const SCHEMA_VERSION = 1;

// Field schemas are keyed by *platform* (where the post lives), not by
// format (the editorial template). A Reel-format item that gets cross-posted
// to X still needs tweet-shaped fields. format.instructions carries the
// editorial voice; platform carries the output shape.
export const PLATFORM_FIELD_SCHEMAS: Record<PlatformKey, FormatFieldSchema> = {
  x: {
    version: SCHEMA_VERSION,
    fields: [
      {
        key: "tweet",
        label: "Tweet",
        type: "longtext",
        maxLength: 280,
        required: true,
        prompt:
          "The full tweet text. Open with a single concrete hook drawn from the pillar transcript — a specific number, a contrarian claim, or a before/after moment. Hard cap 280 chars. No hashtags, no emojis unless one is clearly warranted. First line must stand on its own as a scroll-stopper even in a feed preview.",
      },
    ],
  },
  instagram_reel: {
    version: SCHEMA_VERSION,
    fields: [
      {
        key: "hook",
        label: "On-screen hook",
        type: "text",
        maxLength: 120,
        required: true,
        prompt:
          "The text overlay shown in the first second of the Reel. 5–10 words. Must be a verbatim or near-verbatim quote from the transcript — same rule as clip-idea hooks. The viewer will hear these words. Do not paraphrase.",
      },
      {
        key: "caption",
        label: "Caption",
        type: "longtext",
        maxLength: 2200,
        required: true,
        prompt:
          "The Reel caption. First line should repeat or paraphrase the hook. 1–3 short follow-up lines that add context the overlay can't carry. No hashtag dumps.",
      },
    ],
  },
  instagram_post: {
    version: SCHEMA_VERSION,
    fields: [
      {
        key: "caption",
        label: "Caption (first comment)",
        type: "longtext",
        maxLength: 2200,
        required: true,
        prompt:
          "The caption pinned as the first comment under the carousel. Opens with a one-line hook, then short paragraphs, ends with a clear takeaway. Reference specific story beats or data points from the pillar transcript.",
      },
      {
        key: "slides",
        label: "Slides",
        type: "slides",
        required: true,
        prompt:
          "6–10 slides covering the pillar's core story. Slide 1 is the hook — a single sentence that promises a payoff. Each remaining slide carries one specific, concrete beat — no vague summaries. Last slide is the punchline or takeaway.",
      },
    ],
  },
  instagram_story: {
    version: SCHEMA_VERSION,
    fields: [
      {
        key: "caption",
        label: "Story text",
        type: "text",
        maxLength: 200,
        required: true,
        prompt:
          "Short text overlay for the story. One line. Specific and curious. No hashtags.",
      },
    ],
  },
  youtube_long: {
    version: SCHEMA_VERSION,
    fields: [
      {
        key: "title",
        label: "Title",
        type: "text",
        maxLength: 100,
        required: true,
        prompt:
          "YouTube video title. Promise a specific payoff, not a vague topic. Favor numbers, named people, or concrete outcomes pulled from the transcript.",
      },
      {
        key: "description",
        label: "Description",
        type: "longtext",
        maxLength: 5000,
        required: true,
        prompt:
          "First 2 lines appear above the fold — make them hook + payoff. Follow with a timestamped outline derived from the transcript, then links + CTA. No generic SEO boilerplate.",
      },
      {
        key: "tags",
        label: "Tags",
        type: "tags",
        prompt:
          "5–10 search tags pulled from specific terms in the transcript (founder names, companies, niches, tools). Skip generic tags like 'business' or 'entrepreneur'.",
      },
    ],
  },
  youtube_shorts: {
    version: SCHEMA_VERSION,
    fields: [
      {
        key: "title",
        label: "Title",
        type: "text",
        maxLength: 100,
        required: true,
        prompt:
          "Title rendered on the thumbnail. Short, punchy, mirrors the hook the viewer will hear in the first second. No clickbait that the clip doesn't deliver on.",
      },
      {
        key: "description",
        label: "Description",
        type: "longtext",
        maxLength: 5000,
        prompt:
          "Brief description. 1–2 sentences of context plus a link back to the pillar video.",
      },
    ],
  },
  linkedin: {
    version: SCHEMA_VERSION,
    fields: [
      {
        key: "body",
        label: "Post body",
        type: "longtext",
        maxLength: 3000,
        required: true,
        prompt:
          "LinkedIn post. Open with a one-line hook (no 'I' or 'we' in the first line). 3–6 short paragraphs drawn from the pillar transcript — specifics over platitudes. End with a one-line takeaway. No hashtag walls.",
      },
    ],
  },
  newsletter: {
    version: SCHEMA_VERSION,
    fields: [
      {
        key: "subject",
        label: "Subject line",
        type: "text",
        maxLength: 80,
        required: true,
        prompt:
          "Email subject line. Concrete and curious. Specific over clever. Under 60 chars lands best on mobile.",
      },
      {
        key: "body",
        label: "Body",
        type: "longtext",
        required: true,
        prompt:
          "Newsletter body. Open with the hook. Short paragraphs. Tell the pillar's story as a narrative, not a bullet list. End with a single clear next step for the reader.",
      },
    ],
  },
  tiktok: {
    version: SCHEMA_VERSION,
    fields: [
      {
        key: "caption",
        label: "Caption",
        type: "longtext",
        maxLength: 2200,
        required: true,
        prompt:
          "TikTok caption. First line is the hook — one specific, curious sentence. Keep it tight.",
      },
    ],
  },
  threads: {
    version: SCHEMA_VERSION,
    fields: [
      {
        key: "post",
        label: "Post",
        type: "longtext",
        maxLength: 500,
        required: true,
        prompt:
          "Threads post. Conversational, more like X than Instagram. One concrete claim or story beat from the transcript. Under 500 chars.",
      },
    ],
  },
};

// Map any historical platform string to a canonical key. Returns null if we
// haven't wired that platform yet — callers should surface a clear
// "unsupported platform" error rather than silently falling back.
export function normalizePlatform(raw: string): PlatformKey | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // X / Twitter family. "X", "Twitter", "X (Starter Story)", "X (Pat Walls)".
  if (s === "x" || s === "twitter" || s.startsWith("x (") || s.startsWith("twitter (")) {
    return "x";
  }

  // YouTube long-form. "YouTube", "YouTube (SS)", "YouTube (SS Build)",
  // "YouTube Community". Shorts is handled separately before this check.
  if (s === "youtube shorts") return "youtube_shorts";
  if (s === "youtube" || s.startsWith("youtube (") || s === "youtube community") {
    return "youtube_long";
  }

  if (s === "instagram reel") return "instagram_reel";
  if (s === "instagram post") return "instagram_post";
  if (s === "instagram story") return "instagram_story";

  if (s === "linkedin") return "linkedin";
  if (s === "newsletter") return "newsletter";
  if (s === "tiktok") return "tiktok";
  if (s === "threads") return "threads";

  return null;
}

// Convenience lookup: given a raw platform array, return the first key we
// recognize plus the leftover raw strings. Lets callers surface a hint about
// secondary platforms (e.g. "drafting for X; also posts to LinkedIn").
export function resolveSchemaForPlatforms(
  platforms: string[] | null,
): {
  key: PlatformKey | null;
  raw: string | null;
  otherPlatforms: string[];
  schema: FormatFieldSchema | null;
} {
  if (!platforms || platforms.length === 0) {
    return { key: null, raw: null, otherPlatforms: [], schema: null };
  }
  for (let i = 0; i < platforms.length; i++) {
    const key = normalizePlatform(platforms[i]);
    if (key) {
      return {
        key,
        raw: platforms[i],
        otherPlatforms: platforms.filter((_, j) => j !== i),
        schema: PLATFORM_FIELD_SCHEMAS[key],
      };
    }
  }
  return { key: null, raw: platforms[0], otherPlatforms: platforms.slice(1), schema: null };
}
