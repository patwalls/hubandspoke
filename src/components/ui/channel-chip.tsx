import { cn } from "@/lib/utils";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { normalizePlatform } from "@/lib/platform-field-schemas";
import type { PostType } from "@/lib/platform-field-schemas";

interface ChannelChipProps {
  /** The legacy channel string as stored on `formats.channels` / passed
   *  around the formats UI (e.g. "YouTube (SS)", "X (Pat Walls)",
   *  "Instagram Reel"). */
  channel: string;
  className?: string;
  size?: number;
}

// Map a canonical post_type back to the account platform it lives on.
// Mirror of the logic in `account-post-type-picker`.
function platformForPostType(postType: PostType | null): string {
  if (!postType) return "other";
  if (postType.startsWith("youtube_")) return "youtube";
  if (postType.startsWith("instagram_")) return "instagram";
  return postType;
}

/**
 * Renders a legacy channel-name string as a small chip with its platform
 * icon prefix. Used everywhere we still hold channel-name strings (the
 * formats table, the formats list, some legacy filter pills) and want the
 * new branded visual without fully migrating the data model yet.
 */
export function ChannelChip({ channel, className, size = 12 }: ChannelChipProps) {
  const postType = normalizePlatform(channel);
  const platform = platformForPostType(postType);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground whitespace-nowrap",
        className
      )}
    >
      <PlatformIcon platform={platform} size={size} />
      <span>{channel}</span>
    </span>
  );
}
