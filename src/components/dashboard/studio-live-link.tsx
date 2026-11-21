"use client";

import { useEffect, useState } from "react";
import { trackUsage } from "@/lib/usage/track";
import { liveLinkFromStudio, type DeliveryLink } from "@/lib/production/delivery-link";

export interface StudioOffer {
  /** The public link the Short / video will have (same id as the Studio link). */
  url: string;
  /** First name of the editor who left the Studio link. */
  by: string | null;
}

/**
 * A Review post the editor handed back as a YouTube Studio link: the live
 * Short will have the same video id, so the publish boxes (the post page's
 * Publish dialog, the In Production peek) offer its public link in one click
 * instead of the reviewer finding it on YouTube and pasting it
 * (liveLinkFromStudio). One small read of the delivery-link route; nothing
 * for other statuses or platforms.
 */
export function useStudioLiveLink(
  itemId: string,
  status: string | null | undefined,
  postType: string | null | undefined,
  enabled = true,
): StudioOffer | null {
  const [offer, setOffer] = useState<{ itemId: string; offer: StudioOffer | null } | null>(null);
  const wanted =
    enabled && status === "Review" && (postType === "youtube_shorts" || postType === "youtube_long");
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    fetch(`/api/production-items/${encodeURIComponent(itemId)}/delivery-link`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { link: DeliveryLink | null } | null) => {
        if (cancelled) return;
        const url = liveLinkFromStudio(d?.link?.url, postType);
        setOffer({ itemId, offer: url ? { url, by: d?.link?.by ?? null } : null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wanted, itemId, postType]);
  return wanted && offer?.itemId === itemId ? offer.offer : null;
}

/** "From <editor>'s YouTube Studio link: [Use youtube.com/shorts/…]". */
export function StudioLinkOffer({
  offer,
  brand,
  where,
  onUse,
}: {
  offer: StudioOffer;
  brand?: string | null;
  /** Usage mark suffix: publish:studio-link:<where>. */
  where: "dialog" | "peek";
  onUse: (url: string) => void;
}) {
  return (
    <p
      className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"
      data-testid="publish-studio-link"
    >
      <span>From {offer.by ? `${offer.by}'s` : "the"} YouTube Studio link:</span>
      <button
        type="button"
        className="rounded border border-border px-1.5 py-0.5 font-mono text-foreground hover:bg-muted"
        onClick={() => {
          onUse(offer.url);
          trackUsage(`publish:studio-link:${where}`, brand ?? undefined);
        }}
      >
        Use {offer.url.replace(/^https:\/\/(www\.)?/, "")}
      </button>
    </p>
  );
}
