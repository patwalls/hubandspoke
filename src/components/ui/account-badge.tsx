import { cn } from "@/lib/utils";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { AccountAvatar } from "@/components/ui/account-avatar";
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
 *
 * `avatarUrl` is optional — the "avatar" variant falls back to a handle
 * initial when it's missing, so older callers that don't select it still
 * render cleanly.
 */
export interface AccountBadgeAccount {
  platform: string;
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

interface AccountBadgeProps {
  account: AccountBadgeAccount | null | undefined;
  postType?: PostType | string | null;
  /** - "default": pill with platform icon + @handle + post-type suffix.
   *  - "compact": same pill, hides post-type suffix (table cells).
   *  - "avatar":  round avatar with platform-badge overlay + @handle;
   *               no pill, for list rows where the avatar carries the
   *               identity and we want a lighter, chromeless look. */
  variant?: "default" | "compact" | "avatar";
  className?: string;
  /** Platform icon size for the pill variants. */
  size?: number;
  /** Avatar (and overlay badge) size for variant="avatar". Defaults to 20.
   *  Bump up to ~28 in mixed-content tables where readers scan for
   *  platform at a glance. */
  avatarSize?: number;
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
  avatarSize = 20,
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

  if (variant === "avatar") {
    // Chromeless: avatar (with platform-badge overlay) + @handle. The
    // overlay carries the platform identity, so we don't need the pill
    // border or a separate icon slot. Post-type suffix still shows when
    // the platform has ambiguity (e.g. Instagram Reel vs Post).
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-xs whitespace-nowrap min-w-0",
          className
        )}
        title={
          showPostTypeSuffix
            ? `${account.displayName ?? account.handle} · ${PLATFORM_META[p].label} · ${POST_TYPE_SHORT_LABEL[postType as PostType] ?? ""}`
            : `${account.displayName ?? account.handle} · ${PLATFORM_META[p].label}`
        }
      >
        <AccountAvatar
          avatarUrl={account.avatarUrl ?? null}
          platform={account.platform}
          handle={account.handle}
          size={avatarSize}
        />
        <span className="font-medium text-foreground truncate max-w-[200px]">@{account.handle}</span>
        {showPostTypeSuffix && (
          <span className="text-muted-foreground">
            · {POST_TYPE_SHORT_LABEL[postType as PostType]}
          </span>
        )}
      </span>
    );
  }

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
