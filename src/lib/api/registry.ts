/**
 * The one list of public endpoints. It drives three things so they can't
 * drift: the OpenAPI document (`/api/v1/openapi.json`), the reference +
 * "Try it" panel on /developers, and the test that checks every entry has a
 * route file on disk. Adding an endpoint = add a route under
 * `src/app/api/v1/**`, add its entry here, add an MCP tool if it suits a
 * model (`src/lib/mcp/server.ts`). See docs/conventions.md → Public API.
 */
import { CONTENT_SORTS, POST_TYPES, SOURCE_TYPES } from "./constants";
import { TRANSCRIPT_FORMATS } from "./transcript-format";

export type ApiGroup = "Getting started" | "Content" | "Transcripts & media" | "Workspace";

export interface ApiParam {
  name: string;
  in: "query" | "path";
  type: "string" | "integer" | "boolean";
  description: string;
  required?: boolean;
  enum?: readonly string[];
  example?: string;
}

export interface ApiEndpoint {
  /** Stable id, `group.action`. Also the MCP tool it maps to when one exists. */
  id: string;
  method: "GET";
  /** OpenAPI path, relative to `/api/v1`. */
  path: string;
  group: ApiGroup;
  summary: string;
  description: string;
  params: ApiParam[];
  /** Example response body (JSON) shown in the docs. */
  example: unknown;
  /** Non-JSON responses this endpoint can return (transcript formats). */
  alsoReturns?: string[];
  mcpTool?: string;
}

const brandParam: ApiParam = {
  name: "brand",
  in: "query",
  type: "string",
  description: "Brand slug (see GET /brands). Omit or pass `all` for every brand.",
  example: "starter-story",
};

const idParam: ApiParam = {
  name: "id",
  in: "path",
  type: "string",
  required: true,
  description: "Content item id (UUID). The same id is in the dashboard URL: /{brand}/content/{id}.",
};

const EXAMPLE_ITEM = {
  id: "7a9c1e9e-5b1c-4b61-9d4f-2f0a1a0c5d21",
  title: "How a 24-year-old built a $2M/year newsletter",
  status: "Published",
  brand: "starter-story",
  post_type: "youtube_long",
  source_type: "original",
  format: "Founder Interview",
  account: {
    id: "3b2d0c1a-7e1f-4d7c-8c4e-0c2b9a6f1e22",
    platform: "youtube",
    handle: "starterstory",
    display_name: "Starter Story",
    url: "https://www.youtube.com/@starterstory",
  },
  hub_id: null,
  reposted_from_id: null,
  url: "https://www.youtube.com/watch?v=abc123",
  thumbnail_url: "https://i.ytimg.com/vi/abc123/maxresdefault.jpg",
  body: null,
  hook: "He makes $2M a year sending one email a day.",
  description: "Full interview with …",
  angle: null,
  published_at: "2026-10-21T15:00:00.000Z",
  scheduled_at: null,
  created_at: "2026-10-20T09:12:44.102Z",
  updated_at: "2026-10-29T03:00:11.551Z",
  metrics: { views: 184203, likes: 6120, comments: 412, clicks: 1890, leads: 73 },
  editor: { id: "0f4b…", name: "Sam", email: "sam@starterstory.com" },
  has_transcript: true,
  has_media: true,
  app_url: "https://hubandspoke.example.com/starter-story/content/7a9c1e9e-5b1c-4b61-9d4f-2f0a1a0c5d21",
  links: {
    self: "https://hubandspoke.example.com/api/v1/content/7a9c1e9e-…",
    transcript: "https://hubandspoke.example.com/api/v1/content/7a9c1e9e-…/transcript",
    derivatives: "https://hubandspoke.example.com/api/v1/content/7a9c1e9e-…/derivatives",
    media: "https://hubandspoke.example.com/api/v1/content/7a9c1e9e-…/media",
    clip_ideas: "https://hubandspoke.example.com/api/v1/content/7a9c1e9e-…/clip-ideas",
  },
};

export const API_ENDPOINTS: ApiEndpoint[] = [
  {
    id: "me",
    method: "GET",
    path: "/me",
    group: "Getting started",
    summary: "Check your key",
    description:
      "Returns who the API thinks you are. The first call to make after creating a key: if it comes back 200 with your email, everything else will work.",
    params: [],
    example: {
      data: {
        user: { id: "0f4b…", email: "you@starterstory.com", name: "You", role: "creator" },
        auth: "api_key",
        key: { id: "9c1e…", name: "Zapier", prefix: "hs_live_a1B2c3D4", created_at: "2026-10-30T18:00:00.000Z" },
        rate_limit: { limit: 120, remaining: 119, reset_at: 1761850860 },
      },
    },
    mcpTool: "whoami",
  },
  {
    id: "content.list",
    method: "GET",
    path: "/content",
    group: "Content",
    summary: "List content",
    description:
      "Every piece of content across platforms: YouTube videos, Shorts, reels, posts, tweets, newsletters. Newest first. Filter by brand, account, type, status, format or a date range; paginate with `cursor`. Use `updated_after` to pull only what changed since your last sync.",
    params: [
      brandParam,
      { name: "account_id", in: "query", type: "string", description: "Only this account (see GET /accounts)." },
      {
        name: "post_type",
        in: "query",
        type: "string",
        description: "Canonical post type.",
        enum: POST_TYPES,
      },
      { name: "status", in: "query", type: "string", description: "Workflow status, e.g. `Published`, `Idea`, `Scheduled`. Case-insensitive.", example: "Published" },
      { name: "format", in: "query", type: "string", description: "Format name (see GET /formats). Case-insensitive." },
      {
        name: "source_type",
        in: "query",
        type: "string",
        description: "`original` = a hub (pillar) piece; `repurposed` = a spoke cut from a hub; `cross_post` / `repost` = the same post on another account.",
        enum: SOURCE_TYPES,
      },
      { name: "hub_id", in: "query", type: "string", description: "Only spokes made from this hub item." },
      { name: "editor_id", in: "query", type: "string", description: "Only items assigned to this user id." },
      { name: "q", in: "query", type: "string", description: "Search titles, hooks and post bodies (case-insensitive substring).", example: "newsletter" },
      { name: "published_after", in: "query", type: "string", description: "ISO date or datetime, inclusive.", example: "2026-10-01" },
      { name: "published_before", in: "query", type: "string", description: "ISO date or datetime, inclusive." },
      { name: "updated_after", in: "query", type: "string", description: "Only items changed after this moment — for incremental syncs." },
      { name: "has_transcript", in: "query", type: "boolean", description: "`true` = only items with a transcript." },
      { name: "sort", in: "query", type: "string", description: "Sort order (always descending).", enum: CONTENT_SORTS },
      { name: "limit", in: "query", type: "integer", description: "Page size, 1–100. Default 25.", example: "25" },
      { name: "cursor", in: "query", type: "string", description: "`next_cursor` from the previous page." },
    ],
    example: { data: [EXAMPLE_ITEM], has_more: true, next_cursor: "eyJ0IjoiMjAyNi0xMC0yMVQxNTowMDowMC4wMDBaIiwiaWQiOiI3YTljMWU5ZS0…" },
    mcpTool: "search_content",
  },
  {
    id: "content.get",
    method: "GET",
    path: "/content/{id}",
    group: "Content",
    summary: "Get one item",
    description: "One content item with its account, editor, metrics and links to its transcript, media and derivatives.",
    params: [idParam],
    example: { data: EXAMPLE_ITEM },
    mcpTool: "get_content",
  },
  {
    id: "content.derivatives",
    method: "GET",
    path: "/content/{id}/derivatives",
    group: "Content",
    summary: "List an item's spokes",
    description:
      "Everything made from this item: clips repurposed from a long video, cross-posts to other accounts, reposts. This is the hub-and-spoke tree one level down. Walk it recursively with each spoke's own `/derivatives`.",
    params: [idParam],
    example: { data: [{ ...EXAMPLE_ITEM, source_type: "repurposed", post_type: "instagram_reel", hub_id: EXAMPLE_ITEM.id }] },
    mcpTool: "list_derivatives",
  },
  {
    id: "content.clip_ideas",
    method: "GET",
    path: "/content/{id}/clip-ideas",
    group: "Content",
    summary: "List an item's clip ideas",
    description: "AI-suggested clips for a long video: the time range, hook, angle and whether an editor accepted or killed each one.",
    params: [
      idParam,
      { name: "status", in: "query", type: "string", description: "`suggested`, `accepted` or `killed`.", enum: ["suggested", "accepted", "killed"] },
    ],
    example: {
      data: [
        {
          id: "c0ffee00-…",
          content_id: EXAMPLE_ITEM.id,
          status: "accepted",
          target_format: "Founder Clip",
          start_sec: 812.4,
          end_sec: 871.9,
          hook: "The one metric he checks before anything else",
          angle: "Daily ritual",
          rationale: "Self-contained story with a clear payoff at 0:48.",
          confidence: 0.82,
          estimated_views: 54000,
          accepted_content_id: "5d2e…",
          created_at: "2026-10-21T16:04:00.000Z",
          decided_at: "2026-10-22T09:30:00.000Z",
        },
      ],
    },
    mcpTool: "list_clip_ideas",
  },
  {
    id: "content.transcript",
    method: "GET",
    path: "/content/{id}/transcript",
    group: "Transcripts & media",
    summary: "Get a transcript",
    description:
      "The full transcript of a video or audio post: plain text plus timed segments (with speaker names when the video was diarized). Ask for `format=text`, `vtt` or `srt` to get a caption file instead of JSON. 404 until Whisper has run on the item (`has_transcript` on the item tells you).",
    params: [
      idParam,
      { name: "format", in: "query", type: "string", description: "Response format. Default `json`.", enum: TRANSCRIPT_FORMATS },
      { name: "include_words", in: "query", type: "boolean", description: "JSON only: include word-level timings (large)." },
    ],
    alsoReturns: ["text/plain (format=text or srt)", "text/vtt (format=vtt)"],
    example: {
      data: {
        content_id: EXAMPLE_ITEM.id,
        source: "whisper",
        language: "en",
        duration_sec: 1843.2,
        word_count: 5120,
        text: "So the first thing people get wrong about newsletters is…",
        segments: [
          { start_sec: 0.0, end_sec: 4.2, text: "So the first thing people get wrong about newsletters is…", speaker: "Pat" },
          { start_sec: 4.2, end_sec: 9.8, text: "They think it's about writing.", speaker: "Guest" },
        ],
        speakers: [
          { id: "spk_0", name: "Pat" },
          { id: "spk_1", name: "Guest" },
        ],
        words: null,
        fetched_at: "2026-10-21T15:40:00.000Z",
      },
    },
    mcpTool: "get_transcript",
  },
  {
    id: "content.media",
    method: "GET",
    path: "/content/{id}/media",
    group: "Transcripts & media",
    summary: "Get download links",
    description:
      "Files for an item: the archived video or image (`primary`), its poster frame, carousel slides, and any external media URL. Links to files we store are signed and expire after 15 minutes — fetch, then download.",
    params: [idParam],
    example: {
      data: [
        { kind: "primary", content_type: "video/mp4", size_bytes: 418223044, url: "https://…signed…", expires_at: "2026-10-30T18:15:00.000Z" },
        { kind: "poster", content_type: "image/jpeg", size_bytes: null, url: "https://…signed…", expires_at: "2026-10-30T18:15:00.000Z" },
        { kind: "thumbnail", content_type: null, size_bytes: null, url: "https://i.ytimg.com/vi/abc123/maxresdefault.jpg", expires_at: null },
      ],
    },
    mcpTool: "get_media_links",
  },
  {
    id: "brands.list",
    method: "GET",
    path: "/brands",
    group: "Workspace",
    summary: "List brands",
    description: "The brands in this workspace. Use `slug` as the `brand` filter elsewhere.",
    params: [{ name: "include_disabled", in: "query", type: "boolean", description: "Include brands switched off in Settings." }],
    example: {
      data: [
        { id: "b1…", slug: "starter-story", label: "Starter Story", color: "from-blue-500 to-indigo-600", avatar_url: null, parent_brand_id: null, disabled: false, created_at: "2026-04-01T00:00:00.000Z" },
      ],
    },
    mcpTool: "list_brands",
  },
  {
    id: "accounts.list",
    method: "GET",
    path: "/accounts",
    group: "Workspace",
    summary: "List accounts",
    description: "Social accounts (a YouTube channel, an X handle, an Instagram account) grouped under brands. Content items point at one of these.",
    params: [
      brandParam,
      { name: "platform", in: "query", type: "string", description: "`youtube`, `instagram`, `x`, `tiktok`, `linkedin`, `threads`, `newsletter`." },
      { name: "include_inactive", in: "query", type: "boolean", description: "Include accounts paused in Settings." },
    ],
    example: {
      data: [
        { id: "3b2d…", brand: "starter-story", platform: "youtube", handle: "starterstory", display_name: "Starter Story", url: "https://www.youtube.com/@starterstory", avatar_url: null, follower_count: 1200000, is_active: true, created_at: "2026-04-01T00:00:00.000Z", updated_at: "2026-10-30T03:00:00.000Z" },
      ],
    },
    mcpTool: "list_accounts",
  },
  {
    id: "formats.list",
    method: "GET",
    path: "/formats",
    group: "Workspace",
    summary: "List formats",
    description: "Content formats per brand (e.g. \"Founder Interview\", \"PLAYBOOK\") with the Skill instructions editors and the AI follow.",
    params: [brandParam],
    example: {
      data: [
        { id: "f1…", name: "Founder Interview", brand: "starter-story", channels: ["youtube_long"], instructions: "Open on the money number…", is_clippable: true, clip_target_post_type: "instagram_reel", parent_format_id: null, created_at: "2026-04-01T00:00:00.000Z", updated_at: "2026-10-12T00:00:00.000Z" },
      ],
    },
    mcpTool: "list_formats",
  },
];

export const API_GROUPS: ApiGroup[] = ["Getting started", "Content", "Transcripts & media", "Workspace"];

export function endpointById(id: string): ApiEndpoint | undefined {
  return API_ENDPOINTS.find((e) => e.id === id);
}

/** The route-file directory for an endpoint path: `/content/{id}/transcript` → `content/[id]/transcript`. */
export function routeDirFor(path: string): string {
  return path
    .replace(/^\//, "")
    .split("/")
    .map((seg) => seg.replace(/^\{(\w+)\}$/, "[$1]"))
    .join("/");
}
