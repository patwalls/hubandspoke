"use client";

import { EyeIcon } from "lucide-react";
import type { ContentDraftContent } from "@/lib/db/schema";
import type { ProductionItem } from "@/types";
import {
  PLATFORM_FIELD_SCHEMAS,
  resolveSchemaForPlatforms,
  type PlatformKey,
  type PostType,
} from "@/lib/platform-field-schemas";
import { Badge } from "@/components/ui/badge";
import type { EnrichmentMedia } from "../enrichment-dialog";
import {
  PLATFORM_FIELD_MAP,
  resolvePreviewData,
} from "./resolve-preview-data";
import type { SimulatorProps } from "./simulator-types";
import { InstagramPostSimulator } from "./platforms/instagram-post";
import { InstagramReelSimulator } from "./platforms/instagram-reel";
import { InstagramStorySimulator } from "./platforms/instagram-story";
import { XSimulator } from "./platforms/x";
import { LinkedInSimulator } from "./platforms/linkedin";
import { YouTubeSimulator } from "./platforms/youtube";
import { YouTubeShortsSimulator } from "./platforms/youtube-shorts";
import { YouTubeCommunitySimulator } from "./platforms/youtube-community";
import { TikTokSimulator } from "./platforms/tiktok";
import { ThreadsSimulator } from "./platforms/threads";
import { NewsletterSimulator } from "./platforms/newsletter";

const SIMULATORS: Record<PlatformKey, (props: SimulatorProps) => React.ReactNode> = {
  instagram_post: InstagramPostSimulator,
  instagram_reel: InstagramReelSimulator,
  instagram_story: InstagramStorySimulator,
  x: XSimulator,
  linkedin: LinkedInSimulator,
  youtube_long: YouTubeSimulator,
  youtube_shorts: YouTubeShortsSimulator,
  youtube_community: YouTubeCommunitySimulator,
  tiktok: TikTokSimulator,
  threads: ThreadsSimulator,
  newsletter: NewsletterSimulator,
};

const PLATFORM_LABEL: Record<PlatformKey, string> = {
  instagram_post: "Instagram Post",
  instagram_reel: "Instagram Reel",
  instagram_story: "Instagram Story",
  x: "X",
  linkedin: "LinkedIn",
  youtube_long: "YouTube",
  youtube_shorts: "YouTube Shorts",
  youtube_community: "YouTube Community",
  tiktok: "TikTok",
  threads: "Threads",
  newsletter: "Newsletter",
};

interface ContentPreviewProps {
  item: ProductionItem;
  media: EnrichmentMedia[];
  draftId: string | null;
  liveContent: ContentDraftContent | null;
  onLocalEdit: (fieldKey: string, value: string) => void;
  onCommit: (fieldKey: string) => void;
  /** Fires after a successful media upload or delete on the inline
   *  drafting surface. Parent should refetch so canonical rows replace
   *  local placeholders. */
  onMediaMutated?: () => void;
  /** Fires after a successful draft mutation (e.g. AI caption regenerate)
   *  on the inline drafting surface. Parent should refetch so the new
   *  contentDrafts row lands in `liveContent`. */
  onDraftMutated?: () => void;
  /** Descript-render state. Forwarded to the per-platform simulator so
   *  it can render an Instagram-embed-style placeholder in place of the
   *  drag-to-add empty state. See `SimulatorProps.descriptRenderState`. */
  descriptRenderState?:
    | "processing"
    | "rendering"
    | "awaiting"
    | "failed"
    | null;
  /** Phase-specific copy for the `processing` placeholder. See
   *  `SimulatorProps.descriptProcessingLabel`. */
  descriptProcessingLabel?: string | null;
  descriptProcessingDetail?: string | null;
  /** True while the Draft Algorithm is running for this item — locks the
   *  caption editor so editors don't type into a draft about to be
   *  overwritten. See `SimulatorProps.draftAlgorithmRunning`. */
  draftAlgorithmRunning?: boolean;
}

export function ContentPreview({
  item,
  media,
  draftId,
  liveContent,
  onLocalEdit,
  onCommit,
  onMediaMutated,
  onDraftMutated,
  descriptRenderState,
  descriptProcessingLabel,
  descriptProcessingDetail,
  draftAlgorithmRunning,
}: ContentPreviewProps) {
  // Prefer the canonical `postType` ("x", "instagram_reel", …) — it's the
  // accounts-rollout key and matches the simulator map directly. Fall back
  // to the legacy `platform[]` resolver for older rows that haven't been
  // backfilled. Without this prefer-postType branch, X items with a
  // platform array of `["X (Starter Story)"]` (the legacy human-readable
  // string) fall out of `normalizePlatform` and the preview renders null.
  const platform: PostType | null =
    item.postType && item.postType in PLATFORM_FIELD_SCHEMAS
      ? (item.postType as PostType)
      : resolveSchemaForPlatforms(item.platform ?? null).key;
  if (!platform) return null;

  const Simulator = SIMULATORS[platform];
  const fieldMap = PLATFORM_FIELD_MAP[platform];
  const data = resolvePreviewData(platform, item, media, liveContent);
  const editable = draftId !== null;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5 sm:py-4">
        <div className="min-w-0">
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <EyeIcon className="h-3.5 w-3.5 text-muted-foreground" />
            Preview
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            How this will look on {PLATFORM_LABEL[platform]}.
            {editable
              ? " Type directly in the mock to edit the draft."
              : " Read-only — no draft yet."}
          </p>
        </div>
        <Badge variant="outline" className="text-[11px] shrink-0">
          {PLATFORM_LABEL[platform]}
        </Badge>
      </div>

      <div className="border-t border-border px-4 py-4 sm:px-5">
        <Simulator
          data={data}
          fieldMap={fieldMap}
          editable={editable}
          liveContent={liveContent}
          onLocalEdit={onLocalEdit}
          onCommit={onCommit}
          itemId={item.id}
          onMediaMutated={onMediaMutated}
          onDraftMutated={onDraftMutated}
          descriptRenderState={descriptRenderState}
          descriptProcessingLabel={descriptProcessingLabel}
          descriptProcessingDetail={descriptProcessingDetail}
          descriptProjectUrl={item.descriptProjectUrl ?? null}
          draftAlgorithmRunning={draftAlgorithmRunning}
        />
      </div>
    </div>
  );
}
