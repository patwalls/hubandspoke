"use client";

import { MonogramAvatar } from "./avatar";
import { VerifiedBadge } from "./verified-badge";

interface Props {
  /** Bold primary text. Per-platform convention:
   *   - IG / TikTok: handle (e.g., `starter_story`)
   *   - X / LinkedIn: displayName (fall back to handle)
   *  The simulator picks. */
  name: string;
  /** Subtitle line below the name. Per-platform:
   *   - IG Reel: "Original audio"
   *   - X: "@handle"
   *   - LinkedIn: bio / headline ("Founder, Starter Story")
   *  Pass `null` to hide. */
  subtitle?: string | null;
  /** Account profile picture URL. Falls back to a deterministic monogram
   *  via MonogramAvatar's onError handling when null / 4xx. */
  avatarUrl?: string | null;
  /** Show the platform's blue checkmark. Pass `tone` to use the platform-
   *  specific style (X = blue solid, TikTok = teal). Default IG-style. */
  verified?: boolean;
  /** Inputs for the monogram fallback when avatarUrl can't load. */
  monogramSeed?: { displayName: string | null; handle: string | null };
  /** Right-aligned slot for buttons (e.g. AI regenerate, three-dot menu). */
  actions?: React.ReactNode;
}

/**
 * Shared social-embed-style header used at the top of every simulator
 * caption panel — Instagram Reel/Post, LinkedIn, X, TikTok all render the
 * same shape: avatar + bold name + verified badge + subtitle line. The
 * point isn't to be pixel-perfect with each platform's actual layout —
 * editors mostly want to see "this is who's posting + this is what the
 * post will say," and the unified header is enough.
 */
export function SocialEmbedHeader({
  name,
  subtitle,
  avatarUrl,
  verified,
  monogramSeed,
  actions,
}: Props) {
  return (
    <div className="flex items-center gap-2.5">
      <MonogramAvatar
        displayName={monogramSeed?.displayName ?? null}
        handle={monogramSeed?.handle ?? null}
        avatarUrl={avatarUrl ?? null}
        size="md"
      />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-semibold">{name}</span>
          {verified && <VerifiedBadge />}
        </div>
        {subtitle && (
          <div className="truncate text-xs text-muted-foreground">
            {subtitle}
          </div>
        )}
      </div>
      {actions}
    </div>
  );
}
