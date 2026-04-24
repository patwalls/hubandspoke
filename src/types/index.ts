import type { ViewPrediction } from "@/lib/services/view-predictor";

export interface ProductionItem {
  id: string;
  notionId: string | null;
  youtubeId: string | null;
  youtubeUrl: string | null;
  thumbnail: string | null;
  title: string | null;
  publishedDate: string | null;
  /** Precise publish moment (ISO string). When present, the content view
   *  uses this for sort tie-breaking within a day. */
  publishedAt: string | null;
  status: string | null;
  platform: string[] | null;
  /** Canonical post_type key (youtube_long, instagram_reel, x, …). Populated
   *  from `production_items.post_type`. Null only for legacy "other" items
   *  (SS Case Study, Paid Ad, null-platform rows). */
  postType: string | null;
  /** FK to `accounts`. Populated by the accounts backfill for every item.
   *  Joined account context is on `account`. */
  accountId: string | null;
  /** Joined account summary — platform/handle/displayName shaped for the
   *  UI badge. Populated when the row comes out of queries.ts's joined
   *  item selector. Null while old code paths are still reading the
   *  pre-join shape. */
  account: {
    id: string;
    platform: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    brandSlug: string;
    brandLabel: string;
  } | null;
  format: string | null;
  brand: string;
  campaign: string | null;
  utmCampaign: string | null;
  publishedLink: string | null;
  isExternal: boolean;
  views: number | null;
  likes: number | null;
  comments: number | null;
  clicks: number | null;
  leads: number | null;
  salesNum: number | null;
  salesAmount: number | null;
  ctrFirstHour: number | null;
  apvFirst24Hours: number | null;
  producerEmail: string | null;
  producerName: string | null;
  producerAvatarUrl: string | null;
  producerUserId: string | null;
  editorEmail: string | null;
  editorName: string | null;
  editorAvatarUrl: string | null;
  editorUserId: string | null;
  viewsEstimated: boolean | null;
  lastPerformanceSyncAt: string | null;
  descriptProjectId?: string | null;
  descriptProjectUrl?: string | null;
  descriptCompositionId?: string | null;
  descriptImportedAt?: string | null;
  pillarContentNotionId?: string | null;
  pillarContentItemId?: string | null;
  sourceType?: "original" | "repost" | "cross_post" | "clip" | null;
  repostedFromItemId?: string | null;
  mediaS3Bucket?: string | null;
  mediaS3Key?: string | null;
  mediaS3UploadedAt?: string | null;
  mediaSizeBytes?: number | null;
  mediaContentType?: string | null;
  posterS3Key?: string | null;
  /** Presigned GET URL for `posterS3Key`, regenerated server-side on each
   *  detail fetch. Prefer this over `thumbnail` when rendering a cover. */
  posterUrl?: string | null;
  /** Presigned GET URL for the primary archived media (`mediaS3Key`). */
  mediaUrl?: string | null;
  description?: string | null;
  contentBody?: string | null;
  contentBodyFetchedAt?: string | null;
  contentBodySource?: string | null;
  contentMediaUrl?: string | null;
  authorHandle?: string | null;
  authorDisplayName?: string | null;
  authorFollowerCount?: number | null;
  authorVerified?: boolean | null;
  enrichmentCompletedAt?: string | null;
  enrichmentAttempts?: number | null;
  enrichmentError?: string | null;
  /** Verbatim scroll-stopper opening. Fill paths: clip_idea promotion,
   *  LLM (hook-extract-sweep, short-form only), fallback (title / body),
   *  manual edit. */
  hook?: string | null;
  hookSource?: string | null;
  hookExtractor?: string | null;
  hookExtractedAt?: string | null;
  /** One-sentence description of the cover image produced by the vision
   *  sweep. Populated for posts with a posterS3Key. Null until processed. */
  coverDescription?: string | null;
  visionExtractedAt?: string | null;
  predictedViewsSnapshot?: number | null;
  predictedViewsSnapshotAt?: string | null;
  prediction?: ViewPrediction | null;
  /** Slug in the StarterStory short-link pool attached to this post's
   *  auto-DM. NULL = no keyword wired up. */
  shortLinkSlug?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Period {
  label: string;
  start: string;
  end: string;
}

export interface MetricData {
  [rowName: string]: {
    [periodLabel: string]: number;
  };
}

export interface PrimaryRowMeta {
  label: string;
  accountId: string;
  platform: string;
  handle: string;
  postType: string | null;
  avatarUrl: string | null;
}

export interface ContentReportData {
  periods: Period[];
  byPlatform: {
    production: MetricData;
    views: MetricData;
    leads: MetricData;
    viewsPerPost: MetricData;
    sales: MetricData;
  };
  byFormat: {
    production: MetricData;
    views: MetricData;
    leads: MetricData;
    viewsPerPost: MetricData;
  };
  items: ProductionItem[];
  weekProgress: { day: number; percent: number } | null;
  weekStartDay: number;
  platforms: string[];
  formats: string[];
  showingFormats: boolean;
  weeklyGoal: number | null;
  /** Keyed by the row's display label — same label used as the key
   *  inside `byPlatform.*`. When present the UI renders an
   *  AccountBadge instead of the raw text. */
  primaryRowMeta?: Record<string, PrimaryRowMeta>;
}

export interface SyncLog {
  id: string;
  syncType: string;
  status: string;
  itemsFetched: number | null;
  itemsCreated: number | null;
  itemsUpdated: number | null;
  itemsDeleted: number | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface Format {
  id: string;
  name: string;
  channels: string[];
  event: string | null;
  instructions: string | null;
  createdAt: string;
  updatedAt: string;
  repurposeTargets?: Format[];
}
