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
    // Populated by the single-item detail GET (the only surface that
    // renders the simulator card). Optional so list/search queries that
    // don't need them aren't forced to expand their selectors.
    verified?: boolean | null;
    followerCount?: number | null;
    /** Free-text bio / headline (LinkedIn calls this a headline; X calls
     *  it a bio). Used as the subtitle in the social-embed header on the
     *  simulator. Optional — only the single-item detail GET expands it. */
    bio?: string | null;
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
  /** Publish-and-archive state. Drives the "rendering / rendered / failed"
   *  sub-state on the Descript pill and the inline-simulator empty UX. */
  descriptPublishJobId?: string | null;
  descriptPublishedAt?: string | null;
  descriptPublishError?: string | null;
  /** Canva autofill state for instagram_post derivatives. canvaAutofillJobId
   *  is set while the autofill is in flight and cleared on success; canvaEditUrl
   *  is the final design link the editor opens. */
  canvaAutofillJobId?: string | null;
  canvaDesignId?: string | null;
  canvaEditUrl?: string | null;
  pillarContentNotionId?: string | null;
  pillarContentItemId?: string | null;
  /** Title of the pillar production_item (when this row is a clip/repurpose
   *  with `pillarContentItemId` set). Populated by queries that self-join
   *  productionItems. The clip queue surfaces this as a column. */
  pillarContentTitle?: string | null;
  sourceType?: "original" | "repost" | "cross_post" | "repurposed" | null;
  /** FK to `clip_ideas.id` when this row was promoted from a clip-idea
   *  (sourceType='repurposed' post-consolidation). The triage modal in the
   *  queue fetches the clip-idea on click via this id and renders the
   *  clip-specific UI; absence of this id falls back to the standard
   *  TriageDialog. */
  sourceClipIdeaId?: string | null;
  /** LLM per-clip view estimate from `clip_ideas.estimated_views`. Set only
   *  on rows promoted from a clip idea; consumers prefer this over the
   *  generic format-based predictor when surfacing Est. Views in the queue. */
  clipEstimatedViews?: number | null;
  /** Friendly name + version of the clip-idea algorithm that produced this
   *  row (e.g. "Splice v6"). Computed from `clip_ideas.prompt_version` via
   *  `algorithmLabel()`. Set only on rows promoted from a clip idea. */
  clipAlgorithmLabel?: string | null;
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
  /** Server-computed: whether the cross-post action is available. False
   *  when there's nothing Descript-able to copy (no own composition, no
   *  own media, no pillar seed, no pillar media). UI uses this to disable
   *  the cross-post button. */
  canCrossPost?: boolean;
  /** Server-computed: whether the repost action is available. Same gate
   *  as `canCrossPost` — both flows duplicate a Descript composition. */
  canRepost?: boolean;
  /** When `canCrossPost === false`, the specific reason: needs the
   *  pillar's archived video, or needs Whisper word-level transcripts.
   *  Powers the dropdown tooltip's per-reason copy. Null when canCrossPost
   *  is true. */
  crossPostBlockedReason?: "needs_pillar_media" | "needs_transcript" | null;
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
  /** Verbatim burn-in text painted onto the cover/video itself (the bold
   *  overlay sentence above the speaker on a Reel). For "Reel: Repackage
   *  Section w/ Hook" the editor types this into `title` and we mirror it
   *  here on save. Null when the clip has no designed overlay. */
  overlay?: string | null;
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

export interface FormatViewBar {
  /** The percentile value (e.g. P75 lifetime views for this format). */
  p: number;
  /** Which percentile (e.g. 0.75). The Content tab labels its column "vs P75"
   *  because it asks for 0.75; the cross-post queue requests 0.60 internally. */
  percentile: number;
  cohortSize: number;
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
  weeklyViewsGoal: number | null;
  /** Keyed by the row's display label — same label used as the key
   *  inside `byPlatform.*`. When present the UI renders an
   *  AccountBadge instead of the raw text. */
  primaryRowMeta?: Record<string, PrimaryRowMeta>;
  /** Per-(format, post_type) P75 view bar (cross-brand, last 90 days).
   *  Used by the Content table's "vs P75" column. Cohort is scoped by
   *  post_type so a tweet isn't compared against a YT short. Formats
   *  with cohort < 10 within the (format, post_type) bucket are
   *  silently absent — no bar means "—" in the UI. */
  formatBars?: Record<string, Record<string, FormatViewBar>>;
  /** Week-over-week pacing comparison, prorated to the elapsed hours
   *  of the current week. `current` = published items / views in
   *  [week_start, now]. `prior` = same window in the prior week —
   *  for production a count; for views, view_snapshots-at-the-
   *  equivalent-moment with current-views fallback per item when no
   *  snapshot exists. `prior` is null only when prior-week bounds
   *  yield no comparable data. */
  weekOverWeek?: {
    production: { current: number; prior: number | null };
    views: { current: number; prior: number | null };
  };
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
