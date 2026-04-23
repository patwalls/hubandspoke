import { cn } from "@/lib/utils";
import { PlatformIcon } from "@/components/ui/platform-icon";
import {
  PLATFORM_META,
  POST_TYPE_SHORT_LABEL,
  platformHasMultiplePostTypes,
  toPlatform,
} from "@/lib/platforms";
import type { PostType } from "@/lib/platform-field-schemas";

/**
 * Minimum shape this badge needs. `AccountWithBrand` from @/lib/db/accounts
 * satisfies it, but the narrow type keeps the component usable from
 * contexts that only have a subset of fields (e.g. a joined SELECT).
 */
export interface AccountBadgeAccount {
  platform: string;
  handle: string;
  displayName?: string | null;
}

interface AccountBadgeProps {
  account: AccountBadgeAccount | null | undefined;
  postType?: PostType | string | null;
  /** "compact" hides the post-type suffix even when the platform has
   *  multiple types — used in tight table cells where the icon alone is
   *  enough to disambiguate. */
  variant?: "default" | "compact";
  className?: string;
  size?: number;
}

/**
 * `[platform logo] @handle · Short`
 *
 * The post-type suffix only shows when (a) the platform supports more
 * than one post type AND (b) we're not in compact mode. For single-type
 * platforms (X, TikTok, LinkedIn, Threads, Newsletter) the suffix is
 * redundant with the icon.
 *
 * Renders a greyed-out fallback if `account` is null — avoids layout
 * jumps while data loads.
 */
export function AccountBadge({
  account,
  postType,
  variant = "default",
  className,
  size = 12,
}: AccountBadgeProps) {
  if (!account) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground",
          className
        )}
      >
        —
      </span>
    );
  }

  const p = toPlatform(account.platform);
  const showPostTypeSuffix =
    variant !== "compact" &&
    platformHasMultiplePostTypes(p) &&
    postType &&
    postType !== PLATFORM_META[p].defaultPostType;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground whitespace-nowrap",
        className
      )}
      title={
        showPostTypeSuffix
          ? `${account.displayName ?? account.handle} · ${PLATFORM_META[p].label} · ${POST_TYPE_SHORT_LABEL[postType as PostType] ?? ""}`
          : `${account.displayName ?? account.handle} · ${PLATFORM_META[p].label}`
      }
    >
      <PlatformIcon platform={p} size={size} />
      <span className="font-medium">@{account.handle}</span>
      {showPostTypeSuffix && (
        <span className="text-muted-foreground">
          · {POST_TYPE_SHORT_LABEL[postType as PostType]}
        </span>
      )}
    </span>
  );
}
