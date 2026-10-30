/** Dependency-free constants shared by the read model, the registry and the docs UI (client-safe). */
export const CONTENT_SORTS = ["published_at", "updated_at", "views"] as const;
export type ContentSort = (typeof CONTENT_SORTS)[number];
export const SOURCE_TYPES = ["original", "repurposed", "cross_post", "repost"] as const;
export const POST_TYPES = [
  "youtube_long",
  "youtube_shorts",
  "youtube_community",
  "instagram_reel",
  "instagram_post",
  "instagram_story",
  "x",
  "tiktok",
  "linkedin",
  "threads",
  "newsletter",
] as const;
export const API_VERSION = "1.0.0";

export const API_KEY_SCOPES = ["read", "write"] as const;
export type ApiScope = (typeof API_KEY_SCOPES)[number];

/** Outgoing webhook events. Payloads are documented on /developers. */
export const WEBHOOK_EVENTS = [
  "content.created",
  "content.status_changed",
  "content.published",
  "transcript.ready",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  "content.created": "A new item appeared (added in the app, synced from a platform, created by a rule or the API).",
  "content.status_changed": "An item's workflow status moved, whoever moved it (app, Notion, a cron, the API).",
  "content.published": "An item's status became Published. Also sends content.status_changed.",
  "transcript.ready": "A transcript finished for an item (Whisper or captions).",
};
