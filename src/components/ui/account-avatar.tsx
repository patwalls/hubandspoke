"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { displayAvatarUrl } from "@/lib/avatar-proxy";
import { PlatformIcon } from "@/components/ui/platform-icon";

interface AccountAvatarProps {
  avatarUrl: string | null | undefined;
  platform: string;
  handle: string;
  /** Pixel size of the round avatar. Badge scales off this. */
  size?: number;
  /** Overlay a small platform badge in the bottom-right corner so avatar
   *  and platform identity read in one glance. Defaults on. */
  withPlatformBadge?: boolean;
  className?: string;
}

/**
 * Round account avatar with fallback and optional platform-badge overlay.
 * Used wherever we render an account (dashboard rows, filter dropdowns,
 * settings table). When the upstream image is on a Meta CDN we route
 * through /api/image-proxy to sidestep CORP: same-origin.
 */
export function AccountAvatar({
  avatarUrl,
  platform,
  handle,
  size = 20,
  withPlatformBadge = true,
  className,
}: AccountAvatarProps) {
  const [errored, setErrored] = useState(false);
  const badgeSize = Math.max(10, Math.round(size * 0.55));
  const px = `${size}px`;

  const inner =
    avatarUrl && !errored ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={displayAvatarUrl(avatarUrl)}
        alt=""
        onError={() => setErrored(true)}
        style={{ width: px, height: px }}
        className="rounded-full object-cover bg-muted shrink-0"
      />
    ) : (
      <span
        style={{ width: px, height: px, fontSize: Math.max(9, Math.round(size * 0.45)) }}
        className="rounded-full bg-muted text-muted-foreground font-medium flex items-center justify-center shrink-0"
      >
        {(handle[0] ?? "?").toUpperCase()}
      </span>
    );

  if (!withPlatformBadge) {
    return <span className={cn("inline-block shrink-0", className)}>{inner}</span>;
  }

  return (
    <span
      className={cn("relative inline-block shrink-0", className)}
      style={{ width: px, height: px }}
    >
      {inner}
      <span
        className="absolute -bottom-0.5 -right-0.5 rounded-full bg-background ring-1 ring-background flex items-center justify-center"
        style={{ width: badgeSize, height: badgeSize }}
      >
        <PlatformIcon platform={platform} size={Math.max(8, badgeSize - 4)} />
      </span>
    </span>
  );
}
