"use client";

import { useState } from "react";
import { ChevronDownIcon, EyeIcon } from "lucide-react";
import type { ContentDraftContent } from "@/lib/db/schema";
import type { ProductionItem } from "@/types";
import {
  resolveSchemaForPlatforms,
  type PlatformKey,
} from "@/lib/platform-field-schemas";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import type { EnrichmentMedia } from "../enrichment-dialog";
import {
  PLATFORM_FIELD_MAP,
  resolvePreviewData,
} from "./resolve-preview-data";
import { PreviewEmbed } from "./embed";
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
}

export function ContentPreview({
  item,
  media,
  draftId,
  liveContent,
  onLocalEdit,
  onCommit,
}: ContentPreviewProps) {
  const resolution = resolveSchemaForPlatforms(item.platform ?? null);
  if (!resolution.key) return null;

  const platform = resolution.key;
  const Simulator = SIMULATORS[platform];
  const fieldMap = PLATFORM_FIELD_MAP[platform];
  const data = resolvePreviewData(platform, item, media, liveContent);
  const editable = draftId !== null;

  const [expanded, setExpanded] = useState(true);

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 sm:px-5 sm:py-4"
      >
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
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="text-[11px]">
            {PLATFORM_LABEL[platform]}
          </Badge>
          <ChevronDownIcon
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>

      {expanded && (
        <Tabs
          defaultValue="simulated"
          className="border-t border-border px-4 py-4 sm:px-5"
        >
          <TabsList>
            <TabsTrigger value="simulated">Simulated</TabsTrigger>
            <TabsTrigger value="embed">Embed</TabsTrigger>
          </TabsList>

          <TabsContent value="simulated" className="pt-4">
            <Simulator
              data={data}
              fieldMap={fieldMap}
              editable={editable}
              liveContent={liveContent}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
            />
          </TabsContent>

          <TabsContent value="embed" className="pt-4">
            <PreviewEmbed
              platform={platform}
              publishedLink={item.publishedLink ?? null}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
