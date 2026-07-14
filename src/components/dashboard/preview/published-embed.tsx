"use client";

import { GlobeIcon } from "lucide-react";
import type { ProductionItem } from "@/types";
import {
  PLATFORM_FIELD_SCHEMAS,
  resolveSchemaForPlatforms,
  type PlatformKey,
} from "@/lib/platform-field-schemas";
import { Badge } from "@/components/ui/badge";
import { PreviewEmbed } from "./embed";

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
  snapchat_story: "Snapchat Story",
  snapchat_spotlight: "Snapchat Spotlight",
  facebook_post: "Facebook",
};

export function PublishedEmbed({ item }: { item: ProductionItem }) {
  const platform: PlatformKey | null =
    item.postType && item.postType in PLATFORM_FIELD_SCHEMAS
      ? (item.postType as PlatformKey)
      : resolveSchemaForPlatforms(item.platform ?? null).key;
  if (!platform || !item.publishedLink) return null;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5 sm:py-4">
        <div className="min-w-0">
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <GlobeIcon className="h-3.5 w-3.5 text-muted-foreground" />
            Live post
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Embedded from {PLATFORM_LABEL[platform]}.
          </p>
        </div>
        <Badge variant="outline" className="text-[11px] shrink-0">
          {PLATFORM_LABEL[platform]}
        </Badge>
      </div>
      <div className="border-t border-border px-4 py-4 sm:px-5">
        <PreviewEmbed
          platform={platform}
          publishedLink={item.publishedLink}
          newsletterBodyHtml={item.newsletterBodyHtml}
        />
      </div>
    </div>
  );
}
