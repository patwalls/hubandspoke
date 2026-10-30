/**
 * Public shapes for `/api/v1`. snake_case, ISO-8601 timestamps, nulls instead
 * of missing keys, and nothing internal (no Notion ids, Descript state, S3
 * keys, sync errors). Adding a field here is additive and safe; renaming or
 * removing one is a breaking change — bump the version path instead.
 */
import type { accounts, brands, clipIdeas, formats, productionItems, users } from "@/lib/db/schema";

type ItemRow = typeof productionItems.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;
type BrandRow = typeof brands.$inferSelect;
type FormatRow = typeof formats.$inferSelect;
type ClipIdeaRow = typeof clipIdeas.$inferSelect;
type UserRow = Pick<typeof users.$inferSelect, "id" | "name" | "email">;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

export interface ApiAccount {
  id: string;
  brand: string;
  platform: string;
  handle: string;
  display_name: string | null;
  url: string | null;
  avatar_url: string | null;
  follower_count: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function serializeAccount(row: AccountRow, brandSlug: string): ApiAccount {
  return {
    id: row.id,
    brand: brandSlug,
    platform: row.platform,
    handle: row.handle,
    display_name: row.displayName,
    url: row.url,
    avatar_url: row.avatarUrl,
    follower_count: row.followerCount,
    is_active: row.isActive && !row.deletedAt,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface ApiBrand {
  id: string;
  slug: string;
  label: string;
  color: string | null;
  avatar_url: string | null;
  parent_brand_id: string | null;
  disabled: boolean;
  created_at: string;
}

export function serializeBrand(row: BrandRow): ApiBrand {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    color: row.color,
    avatar_url: row.avatarUrl,
    parent_brand_id: row.parentBrandId,
    disabled: row.disabled,
    created_at: row.createdAt.toISOString(),
  };
}

export interface ApiFormat {
  id: string;
  name: string;
  brand: string;
  channels: string[];
  instructions: string | null;
  is_clippable: boolean;
  clip_target_post_type: string | null;
  parent_format_id: string | null;
  created_at: string;
  updated_at: string;
}

export function serializeFormat(row: FormatRow): ApiFormat {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    channels: row.channels ?? [],
    instructions: row.instructions,
    is_clippable: row.isClippableFormat,
    clip_target_post_type: row.clipTargetPostType,
    parent_format_id: row.parentFormatId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface ApiContentItem {
  id: string;
  title: string | null;
  status: string | null;
  brand: string;
  post_type: string | null;
  source_type: string;
  format: string | null;
  account: Pick<ApiAccount, "id" | "platform" | "handle" | "display_name" | "url"> | null;
  hub_id: string | null;
  reposted_from_id: string | null;
  url: string | null;
  thumbnail_url: string | null;
  body: string | null;
  hook: string | null;
  description: string | null;
  angle: string | null;
  published_at: string | null;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
  metrics: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    clicks: number | null;
    leads: number | null;
  };
  editor: { id: string; name: string | null; email: string } | null;
  has_transcript: boolean;
  has_media: boolean;
  app_url: string;
  links: { self: string; transcript: string; derivatives: string; media: string; clip_ideas: string };
}

export interface ContentJoin {
  item: ItemRow;
  account: Pick<AccountRow, "id" | "platform" | "handle" | "displayName" | "url"> | null;
  editor: UserRow | null;
  hasTranscript: boolean;
  hasMedia: boolean;
}

export function serializeContentItem(j: ContentJoin, baseUrl: string): ApiContentItem {
  const { item } = j;
  const api = `${baseUrl}/api/v1/content/${item.id}`;
  // The app shows published_date (a calendar day) when the precise moment
  // is unknown; the API does the same so a day-only item still sorts/filters.
  const publishedAt =
    item.publishedAt ?? (item.publishedDate ? new Date(`${item.publishedDate}T00:00:00Z`) : null);
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    brand: item.brand,
    post_type: item.postType,
    source_type: item.sourceType,
    format: item.format,
    account: j.account
      ? {
          id: j.account.id,
          platform: j.account.platform,
          handle: j.account.handle,
          display_name: j.account.displayName,
          url: j.account.url,
        }
      : null,
    hub_id: item.pillarContentItemId,
    reposted_from_id: item.repostedFromItemId,
    url: item.publishedLink ?? item.youtubeUrl,
    thumbnail_url: item.thumbnail,
    body: item.contentBody,
    hook: item.hook,
    description: item.description,
    angle: item.angle,
    published_at: iso(publishedAt),
    scheduled_at: iso(item.scheduledAt),
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
    metrics: {
      views: item.views,
      likes: item.likes,
      comments: item.comments,
      clicks: item.clicks,
      leads: item.leads,
    },
    editor: j.editor ? { id: j.editor.id, name: j.editor.name, email: j.editor.email } : null,
    has_transcript: j.hasTranscript,
    has_media: j.hasMedia,
    app_url: `${baseUrl}/${item.brand}/content/${item.id}`,
    links: {
      self: api,
      transcript: `${api}/transcript`,
      derivatives: `${api}/derivatives`,
      media: `${api}/media`,
      clip_ideas: `${api}/clip-ideas`,
    },
  };
}

export interface ApiClipIdea {
  id: string;
  content_id: string;
  status: string;
  target_format: string | null;
  start_sec: number;
  end_sec: number;
  hook: string;
  angle: string;
  rationale: string;
  confidence: number | null;
  estimated_views: number | null;
  accepted_content_id: string | null;
  created_at: string;
  decided_at: string | null;
}

export function serializeClipIdea(row: ClipIdeaRow): ApiClipIdea {
  return {
    id: row.id,
    content_id: row.sourceProductionItemId,
    status: row.status,
    target_format: row.targetFormat,
    start_sec: Number(row.startSec),
    end_sec: Number(row.endSec),
    hook: row.hook,
    angle: row.angle,
    rationale: row.rationale,
    confidence: num(row.confidence),
    estimated_views: row.estimatedViews,
    accepted_content_id: row.acceptedProductionItemId,
    created_at: row.createdAt.toISOString(),
    decided_at: iso(row.decidedAt),
  };
}
